const mongoose = require('mongoose');

const Account = require('../models/Account');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const PayoutRequest = require('../models/PayoutRequest');
const { PAYOUT_METHODS } = require('../models/PayoutRequest');
const { roundMoney } = require('../utils/money');
const { maskAccountNumber } = require('../utils/payout');
const walletService = require('../services/walletService');
const {
  roleRoomFor,
  safeEmitNotification,
} = require('../services/notificationService');

// Provider-facing wallet surface: balances, ledger history, and the withdrawal
// request that hands off to the admin finance queue. Every money movement here
// goes through `services/walletService.js` — this file only validates input and
// shapes responses.

// Smallest withdrawal we will process. Below this the MFS/bank transfer fee
// costs more than the payout is worth.
const MIN_WITHDRAWAL = 100;

/** Resolve the signed-in provider's Account + role, or null. */
async function sessionProvider(accountId) {
  if (!accountId || !mongoose.isValidObjectId(accountId)) return null;
  const account = await Account.findById(accountId);
  if (!account || !walletService.CASH_ROLES.includes(account.role)) return null;
  return account;
}

/**
 * The saved payout destination from the provider's Provider row, used to
 * prefill the withdrawal sheet. Returns the FULL account number only to the
 * request handler (which snapshots it onto the PayoutRequest); the read path
 * masks it.
 */
async function loadPayoutDetails(accountId, role) {
  const { loadProviderPair } = require('../utils/doctorView');
  const { provider } = await loadProviderPair(accountId, role);
  const d = (provider && provider.payout_details) || {};
  return {
    method: d.method || null,
    accountNumber: d.account_number || '',
    accountName: d.account_name || '',
    bankName: d.bank_name || '',
    branch: d.branch || '',
  };
}

/**
 * GET /api/provider/wallet
 *
 * Everything the Wallet page renders above the history list: the four
 * balances, the cash ceiling driving the lock, the saved (masked) payout
 * destination, and any in-flight request.
 */
async function getWallet(req, res) {
  try {
    const account = await sessionProvider(req.accountId);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: 'Provider not found' });
    }

    const [wallet, settings, payoutDetails, pending] = await Promise.all([
      Wallet.forProvider(account._id, account.role),
      walletService.financeSettings(),
      loadPayoutDetails(account._id, account.role),
      PayoutRequest.findOne({
        providerAccountId: account._id,
        status: 'PENDING',
      }).sort({ requestedAt: -1 }),
    ]);

    const cashInHand = roundMoney(wallet.cashInHand);
    const overLimit = cashInHand > settings.cashLimit;

    return res.json({
      success: true,
      wallet: {
        digitalBalance: roundMoney(wallet.digitalBalance),
        cashInHand,
        totalEarned: roundMoney(wallet.totalEarned),
        totalWithdrawn: roundMoney(wallet.totalWithdrawn),
        isPayoutLocked: !!wallet.isPayoutLocked,
        currency: 'BDT',
      },
      limits: {
        cashInHandLimit: settings.cashLimit,
        minWithdrawal: MIN_WITHDRAWAL,
        commissionPercent: settings.commissionPercent,
        isOverCashLimit: overLimit,
      },
      // Why the withdraw button is disabled, in words the app can show
      // verbatim rather than re-deriving the rule client-side.
      lockReason: wallet.isPayoutLocked
        ? `You are holding ৳${cashInHand} in company cash, above the ` +
          `৳${settings.cashLimit} limit. Hand it over to the office to ` +
          're-enable withdrawals.'
        : '',
      payoutDetails: {
        ...payoutDetails,
        accountNumber: maskAccountNumber(payoutDetails.accountNumber),
        accountNumberLast4: payoutDetails.accountNumber
          ? payoutDetails.accountNumber.slice(-4)
          : '',
      },
      pendingRequest: pending ? pending.toJSON() : null,
    });
  } catch (err) {
    console.error('[provider/wallet] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * GET /api/provider/wallet/transactions?page=&limit=
 * The chronological ledger behind the history list.
 */
async function getTransactions(req, res) {
  try {
    const account = await sessionProvider(req.accountId);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: 'Provider not found' });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));

    const filter = { providerAccountId: account._id };
    const [items, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      WalletTransaction.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      items: items.map((t) => t.toJSON()),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error('[provider/wallet/transactions] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * POST /api/provider/wallet/withdraw
 * Body: { amount, method, accountNumber?, accountName?, bankName?, branch? }
 *
 * Holds the funds and queues the request for admin approval. The hold is a
 * single guarded update inside walletService — this handler only decides what
 * to tell the provider when that guard rejects them.
 */
async function requestWithdrawal(req, res) {
  try {
    const account = await sessionProvider(req.accountId);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: 'Provider not found' });
    }
    const b = req.body || {};

    const amount = roundMoney(Number(b.amount));
    if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL) {
      return res.status(400).json({
        success: false,
        message: `The minimum withdrawal is ৳${MIN_WITHDRAWAL}.`,
      });
    }

    const method = String(b.method || '').trim();
    if (!PAYOUT_METHODS.includes(method)) {
      return res.status(400).json({
        success: false,
        message: `Choose a payout method: ${PAYOUT_METHODS.join(', ')}.`,
      });
    }

    // Destination: what the provider typed, falling back to their saved
    // payout profile so the common case needs no re-entry.
    const saved = await loadPayoutDetails(account._id, account.role);
    const accountNumber = String(b.accountNumber || saved.accountNumber || '')
      .trim();
    if (!accountNumber) {
      return res.status(400).json({
        success: false,
        message:
          method === 'Bank'
            ? 'Enter the bank account number to withdraw to.'
            : `Enter the ${method} account number to withdraw to.`,
      });
    }
    const bankName = String(b.bankName || saved.bankName || '').trim();
    const branch = String(b.branch || saved.branch || '').trim();
    if (method === 'Bank' && !bankName) {
      return res
        .status(400)
        .json({ success: false, message: 'Enter the bank name.' });
    }

    // One in-flight request at a time. Without this a provider could split
    // their balance across several PENDING rows and make the admin queue
    // impossible to reconcile.
    const existing = await PayoutRequest.findOne({
      providerAccountId: account._id,
      status: 'PENDING',
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message:
          `You already have a ৳${roundMoney(existing.amount)} withdrawal ` +
          'awaiting approval. Wait for it to be processed before requesting ' +
          'another.',
      });
    }

    // Atomic hold. Null = a guard failed; re-read to say which.
    const held = await walletService.holdPayoutFunds(account._id, amount);
    if (!held) {
      const wallet = await Wallet.forProvider(account._id, account.role);
      if (wallet.isPayoutLocked) {
        const settings = await walletService.financeSettings();
        return res.status(409).json({
          success: false,
          message:
            `Withdrawals are locked while you hold ৳${roundMoney(wallet.cashInHand)} ` +
            `in company cash (limit ৳${settings.cashLimit}). Hand it over to ` +
            'the office to unlock.',
        });
      }
      return res.status(409).json({
        success: false,
        message:
          `Insufficient balance — you have ৳${roundMoney(wallet.digitalBalance)} ` +
          'available for withdrawal.',
      });
    }

    let payout;
    try {
      payout = await PayoutRequest.create({
        providerAccountId: account._id,
        providerName: account.full_name || '',
        providerRole: account.role,
        providerPhone: account.phone || '',
        amount,
        method,
        accountDetails: {
          accountNumber,
          accountName: String(b.accountName || saved.accountName || '').trim(),
          bankName,
          branch,
        },
        status: 'PENDING',
        requestedAt: new Date(),
      });
    } catch (err) {
      // The hold already moved money. If the request row can't be written we
      // MUST give it back, or the provider silently loses the balance.
      await Wallet.findByIdAndUpdate(held._id, {
        $inc: { digitalBalance: amount },
      });
      throw err;
    }

    await walletService.recordPayoutHold(held, payout);

    const io = req.app.get('io');
    walletService.emitWalletUpdate(io, account._id, held);

    // Nudge the admin finance queue.
    if (io) {
      try {
        io.to(roleRoomFor('admin')).emit('payout:requested', {
          payoutId: payout._id.toString(),
          providerId: account._id.toString(),
          providerName: account.full_name || '',
          amount,
          method,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {
        /* non-fatal */
      }
    }
    // Bell-feed fan-out to every admin. `emitNotification` is per-recipient
    // (there is no role-addressed variant), so we mirror the fan-out pattern
    // in routes/patient.js `notifyAdminsBookingReady`.
    try {
      const admins = await Account.find({ role: 'admin' }, '_id').lean();
      await Promise.all(
        admins.map((a) =>
          safeEmitNotification(io, {
            recipientId: a._id,
            senderId: account._id.toString(),
            title: 'New withdrawal request',
            body:
              `${account.full_name || 'A provider'} requested ৳${amount} via ` +
              `${method}.`,
            type: 'payment',
            payload: {
              payoutId: payout._id.toString(),
              deepLink: '/admin/finance',
            },
          })
        )
      );
    } catch (_) {
      /* bell-feed failure never fails the request */
    }

    return res.json({
      success: true,
      payoutRequest: payout.toJSON(),
      wallet: {
        digitalBalance: roundMoney(held.digitalBalance),
        cashInHand: roundMoney(held.cashInHand),
        totalEarned: roundMoney(held.totalEarned),
        totalWithdrawn: roundMoney(held.totalWithdrawn),
        isPayoutLocked: !!held.isPayoutLocked,
      },
    });
  } catch (err) {
    console.error('[provider/wallet/withdraw] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

/**
 * GET /api/provider/wallet/payouts
 * The provider's own withdrawal history (all statuses), newest first.
 */
async function getPayoutHistory(req, res) {
  try {
    const account = await sessionProvider(req.accountId);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: 'Provider not found' });
    }
    const items = await PayoutRequest.find({ providerAccountId: account._id })
      .sort({ requestedAt: -1 })
      .limit(50);
    return res.json({
      success: true,
      items: items.map((p) => {
        const j = p.toJSON();
        // The provider doesn't need their own account number echoed back in
        // full — masking keeps it out of logs and screenshots.
        if (j.accountDetails) {
          j.accountDetails.accountNumber = maskAccountNumber(
            j.accountDetails.accountNumber
          );
        }
        return j;
      }),
    });
  } catch (err) {
    console.error('[provider/wallet/payouts] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  MIN_WITHDRAWAL,
  getWallet,
  getTransactions,
  requestWithdrawal,
  getPayoutHistory,
};
