const mongoose = require('mongoose');
const Account = require('../models/Account');
const Wallet = require('../models/Wallet');
const PayoutRequest = require('../models/PayoutRequest');
const CashHandoverLog = require('../models/CashHandoverLog');
const { roundMoney } = require('../utils/money');
const walletService = require('../services/walletService');
const {
  userRoomFor,
  roleRoomFor,
  safeEmitNotification,
} = require('../services/notificationService');

// Admin finance console — two desks sharing one file:
//
//   1. Cash reconciliation. Providers accumulate physical cash from door-step
//      collections; these handlers list who is holding what and settle (zero)
//      a provider's balance against an immutable CashHandoverLog.
//   2. Payout approval. Providers request withdrawals against their digital
//      balance; these handlers approve (marking paid with a bank/MFS
//      reference) or reject (refunding the held funds).
//
// Balances are never written here directly — every movement goes through
// services/walletService.js, which owns the ledger invariants.

// Roles that can hold cash / own a wallet. Sourced from the ledger engine so
// the two can never disagree about who is a provider.
const { CASH_ROLES } = walletService;

// [start, end) bounds for the calendar day a Date falls in. Mirrors the
// helper in admin.controller.js so "collected today" lines up with the
// other admin day-scoped metrics.
function dayBounds(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

// Short, collision-resistant-enough handover receipt reference.
function makeReceiptId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RCPT-${Date.now()}-${rand}`;
}

/**
 * GET /api/admin/finance/cash-in-hand
 *
 * Every doctor/nurse currently holding un-remitted physical cash, plus the
 * field-wide rollups the Cash Clearance terminal's summary cards need.
 *
 * Sourced from `Wallet.cashInHand` (the ledger of record since the wallet
 * migration; it was previously `Account.financial_ledger.cash_in_hand`).
 * `collectedToday` still sums today's settlements from CashHandoverLog.
 */
async function getCashInHand(_req, res) {
  try {
    const today = dayBounds();

    const [wallets, todayAgg] = await Promise.all([
      Wallet.find({ cashInHand: { $gt: 0 } })
        .sort({ cashInHand: -1 })
        .populate('providerId', 'full_name role phone'),
      CashHandoverLog.aggregate([
        { $match: { settled_at: { $gte: today.start, $lt: today.end } } },
        { $group: { _id: null, total: { $sum: '$amount_collected' } } },
      ]),
    ]);

    const providers = wallets
      // A wallet whose Account was deleted has nothing to render or settle.
      .filter((w) => w.providerId)
      .map((w) => ({
        accountId: w.providerId._id.toString(),
        name: w.providerId.full_name || 'Unknown provider',
        role: w.providerId.role || w.providerRole,
        phone: w.providerId.phone || '',
        cashInHand: roundMoney(w.cashInHand),
        lastCollectionAt: w.lastCreditAt || null,
        isPayoutLocked: !!w.isPayoutLocked,
      }));

    const totalCashInField = roundMoney(
      providers.reduce((sum, p) => sum + p.cashInHand, 0),
    );
    const collectedToday = roundMoney(
      Array.isArray(todayAgg) && todayAgg.length ? todayAgg[0].total : 0,
    );

    return res.json({
      success: true,
      providers,
      totalCashInField,
      collectedToday,
      outstandingProvidersCount: providers.length,
    });
  } catch (err) {
    console.error('[admin/finance/cash-in-hand] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * POST /api/admin/finance/settle-provider-cash
 * Body: { providerId, amountCollected, adminNotes? }
 *
 * Records the admin receiving physical cash from a provider and zeroes that
 * provider's `Wallet.cashInHand`. The reset is a race-safe compare-and-swap on
 * the exact balance we read: if a concurrent collect-cash lands between the
 * read and the write, the CAS misses and we 409 rather than silently wiping
 * the fresh collection. Per the locked design the ledger ALWAYS zeroes; any
 * gap between the expected balance and the cash actually received is stored
 * on the immutable CashHandoverLog as `discrepancy`.
 *
 * Clearing the cash also lifts any payout lock the balance had triggered.
 */
async function settleProviderCash(req, res) {
  try {
    const b = req.body || {};
    const providerId = String(b.providerId || '').trim();
    if (!mongoose.isValidObjectId(providerId)) {
      return res
        .status(400)
        .json({ success: false, message: 'A valid providerId is required' });
    }

    const rawAmount = Number(b.amountCollected);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      return res.status(400).json({
        success: false,
        message: 'amountCollected must be a non-negative number',
      });
    }
    const amountCollected = roundMoney(rawAmount);
    const adminNotes = String(b.adminNotes || '').trim().slice(0, 1000);

    const provider = await Account.findById(providerId);
    if (!provider || !CASH_ROLES.includes(provider.role)) {
      return res
        .status(404)
        .json({ success: false, message: 'Provider not found' });
    }

    const wallet = await Wallet.forProvider(providerId, provider.role);
    const currentBalance = wallet.cashInHand;
    const expected = roundMoney(currentBalance);
    if (expected <= 0) {
      return res.status(409).json({
        success: false,
        message: 'This provider has no outstanding cash to settle.',
      });
    }

    const now = new Date();
    const receiptId = makeReceiptId();

    // Compare-and-swap on the exact balance we just read. A concurrent
    // collect-cash `$inc` changes cashInHand and makes this miss → 409.
    const cleared = await walletService.applyCashClearance(
      req.app.get('io'),
      {
        providerId,
        providerRole: provider.role,
        expectedBalance: currentBalance,
        amountCollected,
        receiptId,
        adminNotes,
      },
    );
    if (!cleared) {
      return res.status(409).json({
        success: false,
        message:
          'The provider ledger changed during settlement (a new collection landed). Refresh and try again.',
      });
    }

    const log = await CashHandoverLog.create({
      admin_account_id: req.accountId,
      provider_account_id: providerId,
      provider_role: provider.role,
      provider_name: provider.full_name || '',
      expected_amount: expected,
      amount_collected: amountCollected,
      discrepancy: roundMoney(expected - amountCollected),
      admin_notes: adminNotes,
      receipt_id: receiptId,
      settled_at: now,
    });

    const io = req.app.get('io');
    if (io) {
      // Instant ledger reset on the provider's mobile app (workspace cash
      // card drops to ৳0 without a manual refresh). Kept alongside the
      // wallet-wide `wallet_updated` emit for backward compatibility with
      // the shipped `_CashLedgerCard` listener.
      io.to(userRoomFor(providerId)).emit('cash_ledger_cleared', {
        providerId,
        newBalance: 0,
        receiptId,
        amountCollected,
        settledAt: now.toISOString(),
      });
    }

    // Bell-feed acknowledgement for the provider. Non-fatal on failure.
    await safeEmitNotification(io, {
      recipientId: providerId,
      senderId: req.accountId,
      title: 'Cash handover recorded',
      body:
        `The office recorded a ৳${amountCollected} cash handover. ` +
        'Your cash-in-hand ledger is now settled to ৳0.',
      type: 'payment',
      payload: { receiptId },
    });

    return res.json({
      success: true,
      receiptId,
      log: log.toJSON(),
      provider: { accountId: providerId, cashInHand: 0 },
    });
  } catch (err) {
    console.error('[admin/finance/settle-provider-cash] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * GET /api/admin/finance/payouts?status=PENDING
 *
 * The withdrawal queue. Defaults to PENDING (what the console acts on);
 * pass `status=all` for the full history. Rows carry the FULL account number
 * — the admin has to key it into bKash/the bank to actually pay, and this
 * route is admin-guarded.
 */
async function listPayouts(req, res) {
  try {
    const raw = String(req.query.status || 'PENDING').toUpperCase();
    const filter =
      raw === 'ALL' ? {} : { status: ['APPROVED', 'REJECTED', 'PENDING'].includes(raw) ? raw : 'PENDING' };

    const [items, pendingAgg] = await Promise.all([
      PayoutRequest.find(filter).sort({ requestedAt: -1 }).limit(200),
      PayoutRequest.aggregate([
        { $match: { status: 'PENDING' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const agg = Array.isArray(pendingAgg) && pendingAgg.length ? pendingAgg[0] : null;

    return res.json({
      success: true,
      items: items.map((p) => p.toJSON()),
      pendingCount: agg ? agg.count : 0,
      pendingTotal: roundMoney(agg ? agg.total : 0),
    });
  } catch (err) {
    console.error('[admin/finance/payouts] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * POST /api/admin/finance/payouts/:id/approve
 * Body: { referenceId }
 *
 * Marks the withdrawal paid. The money already left `digitalBalance` when the
 * provider requested it, so approving moves no balance — it bumps
 * `totalWithdrawn` and stamps the bank/MFS reference onto the audit trail.
 *
 * The status CAS is what makes a double-clicked Approve pay out exactly once.
 */
async function approvePayout(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid payout id' });
    }
    const referenceId = String((req.body || {}).referenceId || '').trim();
    if (!referenceId) {
      return res.status(400).json({
        success: false,
        message:
          'A bank/MFS transaction reference is required so the payout is auditable.',
      });
    }

    // Single-winner transition. A second click matches nothing → 409.
    const payout = await PayoutRequest.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      {
        $set: {
          status: 'APPROVED',
          referenceId,
          processedBy: req.accountId,
          processedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!payout) {
      const fresh = await PayoutRequest.findById(id);
      if (!fresh) {
        return res
          .status(404)
          .json({ success: false, message: 'Payout request not found' });
      }
      return res.status(409).json({
        success: false,
        message: `This request is already ${fresh.status.toLowerCase()}.`,
      });
    }

    const io = req.app.get('io');
    await walletService.settlePayout(io, payout, referenceId);

    await safeEmitNotification(io, {
      recipientId: payout.providerAccountId,
      senderId: req.accountId,
      title: 'Withdrawal paid',
      body:
        `Your ৳${roundMoney(payout.amount)} withdrawal via ${payout.method} ` +
        `has been paid. Reference: ${referenceId}.`,
      type: 'payment',
      payload: { payoutId: payout._id.toString(), referenceId },
    });

    if (io) {
      try {
        io.to(roleRoomFor('admin')).emit('payout:resolved', {
          payoutId: payout._id.toString(),
          status: 'APPROVED',
          timestamp: new Date().toISOString(),
        });
      } catch (_) {
        /* non-fatal */
      }
    }

    return res.json({ success: true, payoutRequest: payout.toJSON() });
  } catch (err) {
    console.error('[admin/finance/payouts/approve] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * POST /api/admin/finance/payouts/:id/reject
 * Body: { reason }
 *
 * Declines the withdrawal and returns the held funds to `digitalBalance`.
 * Same single-winner CAS as approve, so a rejected request can never be
 * refunded twice.
 */
async function rejectPayout(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid payout id' });
    }
    const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A rejection reason is required — the provider is told why.',
      });
    }

    const payout = await PayoutRequest.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      {
        $set: {
          status: 'REJECTED',
          rejectionReason: reason,
          processedBy: req.accountId,
          processedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!payout) {
      const fresh = await PayoutRequest.findById(id);
      if (!fresh) {
        return res
          .status(404)
          .json({ success: false, message: 'Payout request not found' });
      }
      return res.status(409).json({
        success: false,
        message: `This request is already ${fresh.status.toLowerCase()}.`,
      });
    }

    const io = req.app.get('io');
    // Refund the hold. Only reachable once, because the CAS above already won.
    await walletService.revertPayout(io, payout, reason);

    await safeEmitNotification(io, {
      recipientId: payout.providerAccountId,
      senderId: req.accountId,
      title: 'Withdrawal rejected',
      body:
        `Your ৳${roundMoney(payout.amount)} withdrawal was not approved: ` +
        `${reason}. The amount is back in your available balance.`,
      type: 'payment',
      payload: { payoutId: payout._id.toString() },
    });

    if (io) {
      try {
        io.to(roleRoomFor('admin')).emit('payout:resolved', {
          payoutId: payout._id.toString(),
          status: 'REJECTED',
          timestamp: new Date().toISOString(),
        });
      } catch (_) {
        /* non-fatal */
      }
    }

    return res.json({ success: true, payoutRequest: payout.toJSON() });
  } catch (err) {
    console.error('[admin/finance/payouts/reject] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  getCashInHand,
  settleProviderCash,
  listPayouts,
  approvePayout,
  rejectPayout,
};
