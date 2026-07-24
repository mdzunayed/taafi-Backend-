const mongoose = require('mongoose');

const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Settings = require('../models/Settings');
const { roundMoney } = require('../utils/money');
const { loadProviderPair } = require('../utils/doctorView');
const { userRoomFor } = require('./notificationService');

// ─────────────────────────────────────────────────────────────────────────────
// The ledger engine. THE single place provider money moves.
//
// Every balance in `models/Wallet.js` is written here and nowhere else. Routes
// call into these functions; they never `$inc` a wallet themselves. That rule
// is what makes the invariants below auditable in one file.
//
// Invariants:
//   1. Balances move only by atomic `$inc` — never read-modify-write. Two
//      concurrent settlements for the same provider must both land.
//   2. Every balance movement writes a WalletTransaction in the same call.
//   3. A visit credits a provider AT MOST ONCE, enforced by the partial unique
//      index on WalletTransaction (bookingId, providerAccountId, type) rather
//      than by per-call-site checks. See `creditVisitEarnings`.
// ─────────────────────────────────────────────────────────────────────────────

const CASH_ROLES = ['doctor', 'nurse'];

/** Platform finance knobs, admin-editable via the Settings singleton. */
async function financeSettings() {
  const s = await Settings.getSingleton();
  const raw = Number(s.platform_commission_percent);
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 20;
  const limitRaw = Number(s.cash_in_hand_limit);
  return {
    commissionPercent: pct,
    cashLimit: Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : 5000,
  };
}

/**
 * Split a gross visit amount into the platform's fee and the provider's net.
 * `providerNet` is derived by SUBTRACTION rather than by a second percentage
 * so the two halves always re-add to exactly `gross` — computing both as
 * independent percentages leaks a paisa on amounts that don't divide evenly.
 */
function splitCommission(gross, commissionPercent) {
  const grossAmount = roundMoney(Math.max(0, gross));
  const platformFee = roundMoney((grossAmount * commissionPercent) / 100);
  const providerNet = roundMoney(grossAmount - platformFee);
  return { grossAmount, commissionPercent, platformFee, providerNet };
}

/** Gross value of a visit: what the patient actually owes, post-discount. */
function grossValueOf(careRequest) {
  const fee = Number(careRequest.final_price) || 0;
  const discount = Number(careRequest.adjusted_discount) || 0;
  return roundMoney(Math.max(0, fee - discount));
}

/**
 * Resolve an assignment id to an Account id. `assigned_doctor_id` /
 * `assigned_nurse_id` may hold EITHER a Provider `_id` or an Account `_id`
 * (the admin assign path writes whichever it was handed), and wallets are
 * keyed by Account. `loadProviderPair` already walks both collections.
 */
async function resolveAccountId(rawId, role) {
  if (!rawId || !mongoose.isValidObjectId(rawId)) return null;
  const { account } = await loadProviderPair(rawId, role);
  return account && account._id ? account._id.toString() : null;
}

/**
 * Who earned what on this visit → `[{ accountId, role, gross }]`.
 *
 * Preferred: the invoice's own breakdown. When `payment.doctor_fee` /
 * `payment.nurse_fee` are populated, each provider's gross is their line's
 * proportional share of the total — that is the admin's explicit statement of
 * who did what, so we honour it rather than inventing a split.
 *
 * Fallback (no line items): a single provider takes the whole gross, resolved
 * in precedence order `collected_by_provider_id` → doctor → nurse. The cash
 * collector wins because on a cash visit they are, by definition, the one who
 * showed up. Amounts are never divided by a guess.
 */
async function resolveEarningShares(careRequest, collectorAccountId = null) {
  const gross = grossValueOf(careRequest);
  if (gross <= 0) return [];

  const pay = careRequest.payment || {};
  const doctorFee = Number(pay.doctor_fee) || 0;
  const nurseFee = Number(pay.nurse_fee) || 0;

  const [doctorAccountId, nurseAccountId] = await Promise.all([
    resolveAccountId(careRequest.assigned_doctor_id, 'doctor'),
    resolveAccountId(careRequest.assigned_nurse_id, 'nurse'),
  ]);

  // ── Line-item split ───────────────────────────────────────────────────────
  const lines = [];
  if (doctorAccountId && doctorFee > 0) {
    lines.push({ accountId: doctorAccountId, role: 'doctor', fee: doctorFee });
  }
  if (nurseAccountId && nurseFee > 0) {
    lines.push({ accountId: nurseAccountId, role: 'nurse', fee: nurseFee });
  }
  if (lines.length > 0) {
    const lineTotal = lines.reduce((sum, l) => sum + l.fee, 0);
    const shares = lines.map((l) => ({
      accountId: l.accountId,
      role: l.role,
      gross: roundMoney((gross * l.fee) / lineTotal),
    }));
    // Rounding remainder (at most a paisa or two) goes to the first line so
    // the shares re-add to `gross` exactly — otherwise the platform quietly
    // keeps or loses the difference on every multi-provider visit.
    const allocated = shares.reduce((sum, s) => sum + s.gross, 0);
    const remainder = roundMoney(gross - allocated);
    if (remainder !== 0 && shares.length > 0) {
      shares[0].gross = roundMoney(shares[0].gross + remainder);
    }
    return shares;
  }

  // ── Single-provider fallback ──────────────────────────────────────────────
  const candidates = [
    { accountId: collectorAccountId, role: null },
    { accountId: doctorAccountId, role: 'doctor' },
    { accountId: nurseAccountId, role: 'nurse' },
  ];
  for (const c of candidates) {
    if (!c.accountId) continue;
    let role = c.role;
    if (!role) {
      // The collector's role isn't implied by the field it came from.
      role = c.accountId === nurseAccountId ? 'nurse' : 'doctor';
    }
    return [{ accountId: c.accountId, role, gross }];
  }
  return [];
}

/** Broadcast a fresh wallet snapshot to the provider's private room. */
function emitWalletUpdate(io, providerId, wallet) {
  if (!io || !wallet) return;
  try {
    io.to(userRoomFor(String(providerId))).emit('wallet_updated', {
      providerId: String(providerId),
      digitalBalance: roundMoney(wallet.digitalBalance),
      cashInHand: roundMoney(wallet.cashInHand),
      totalEarned: roundMoney(wallet.totalEarned),
      totalWithdrawn: roundMoney(wallet.totalWithdrawn),
      isPayoutLocked: !!wallet.isPayoutLocked,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {
    /* socket fan-out is never allowed to fail a ledger write */
  }
}

/**
 * Re-evaluate the cash ceiling and flip `isPayoutLocked` if it disagrees with
 * reality. Idempotent, and only writes when the flag actually changes.
 */
async function evaluatePayoutLock(wallet, cashLimit) {
  if (!wallet) return wallet;
  const shouldLock = roundMoney(wallet.cashInHand) > roundMoney(cashLimit);
  if (shouldLock === !!wallet.isPayoutLocked) return wallet;
  return Wallet.findByIdAndUpdate(
    wallet._id,
    { $set: { isPayoutLocked: shouldLock } },
    { new: true }
  );
}

/**
 * Settle one completed visit into its provider wallet(s).
 *
 * Called from all three paths a visit can take to `completed` (digital
 * settlement in routes/patient.js, cash collection and the legacy pre-paid
 * `/complete` in routes/appointments.js). Safe to call from all of them, and
 * safe to call twice — see the idempotency note below.
 *
 * ── The arithmetic, and why it is not a flat 20% debit ──────────────────────
 * The literal brief says a cash visit debits the platform's full 20% from the
 * provider's digital balance. That holds only if the provider collected 100%
 * of the fee. In this product they never do: the patient always pays the ৳100
 * deposit digitally up front, so the provider takes home only
 * `final_price − deposit − discount`. Debiting a flat 20% would charge the
 * provider for a deposit the platform is already holding, shorting them by
 * exactly the deposit on every single cash visit.
 *
 * So the engine reasons in terms of the end state instead of a fixed fee:
 *
 *     digitalDelta = providerNet − cashAlreadyInTheirPocket
 *
 * A provider must end up holding exactly `providerNet` across both ledgers.
 * If they are holding less than that, the platform credits the difference; if
 * more, the platform debits it. That is one rule for both payment methods, and
 * it degenerates to the brief's flat-20% debit precisely when the cash
 * collected equals the gross fee (no deposit).
 *
 *     Digital visit, ৳1000:  cash 0    → delta = +800  → VISIT_EARNING  ৳800
 *     Cash visit,    ৳1000:  cash 900  → delta = −100  → COMMISSION_DEBIT ৳100
 *       (provider holds ৳900, is owed ৳800, platform holds the ৳100 deposit
 *        and is owed ৳200 total — so ৳100 more comes back from the provider)
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * Transaction rows are inserted BEFORE the wallet `$inc`, deliberately. They
 * are the gate: the partial unique index on
 * (bookingId, providerAccountId, type) makes a second insert for the same
 * visit throw E11000, which we swallow and return early — leaving the balance
 * untouched. Doing the `$inc` first would double-credit on a retry, because a
 * failed insert cannot un-move money.
 *
 * @returns {Promise<{credited: boolean, alreadySettled?: boolean, shares?: Array}>}
 */
async function creditVisitEarnings(io, careRequest, options = {}) {
  const opts = options || {};
  const isCash = String(opts.method || '').toUpperCase() === 'CASH';
  const collectorId = opts.collectorId ? String(opts.collectorId) : null;
  const cashCollected = roundMoney(Math.max(0, Number(opts.cashCollected) || 0));

  if (!careRequest || !careRequest._id) return { credited: false };

  const bookingId = careRequest._id;
  const { commissionPercent, cashLimit } = await financeSettings();
  const shares = await resolveEarningShares(
    careRequest,
    isCash ? collectorId : null
  );
  if (shares.length === 0) {
    // Unpriced or unassigned visit — nothing to settle. Not an error: legacy
    // rows and ৳0 bookings both land here.
    return { credited: false, shares: [] };
  }

  const results = [];
  for (const share of shares) {
    const isCollector = isCash && collectorId === String(share.accountId);
    const cashHeld = isCollector ? cashCollected : 0;
    const breakdown = splitCommission(share.gross, commissionPercent);
    const digitalDelta = roundMoney(breakdown.providerNet - cashHeld);

    const wallet = await Wallet.forProvider(share.accountId, share.role);

    // ── Build this provider's rows for this visit ──────────────────────────
    const base = {
      walletId: wallet._id,
      providerAccountId: share.accountId,
      bookingId,
      patientName: careRequest.patient_name || '',
      careType: careRequest.care_type || '',
      breakdown,
    };
    const rows = [];
    if (cashHeld > 0) {
      rows.push({
        ...base,
        type: 'CASH_COLLECTION',
        direction: 'CREDIT',
        ledger: 'cash',
        amount: cashHeld,
        description: `Cash collected at the door — ৳${cashHeld}`,
      });
    }
    if (digitalDelta >= 0) {
      rows.push({
        ...base,
        type: 'VISIT_EARNING',
        direction: 'CREDIT',
        ledger: 'digital',
        amount: digitalDelta,
        description:
          `Visit earnings — ৳${breakdown.providerNet} net of ` +
          `${commissionPercent}% platform fee`,
      });
    } else {
      rows.push({
        ...base,
        type: 'COMMISSION_DEBIT',
        direction: 'DEBIT',
        ledger: 'digital',
        amount: roundMoney(Math.abs(digitalDelta)),
        description:
          `Platform commission on a cash visit — ${commissionPercent}% ` +
          `of ৳${breakdown.grossAmount}`,
      });
    }

    // ── Gate: insert first, move money only if the insert won ─────────────
    let inserted;
    try {
      inserted = await WalletTransaction.insertMany(rows, { ordered: true });
    } catch (err) {
      if (err && err.code === 11000) {
        // This visit already settled for this provider. Nothing to do.
        results.push({ accountId: share.accountId, alreadySettled: true });
        continue;
      }
      throw err;
    }

    // ── Apply the balance movement, atomically ────────────────────────────
    const inc = { totalEarned: breakdown.providerNet };
    if (cashHeld > 0) inc.cashInHand = cashHeld;
    if (digitalDelta !== 0) inc.digitalBalance = digitalDelta;

    let updated = await Wallet.findByIdAndUpdate(
      wallet._id,
      { $inc: inc, $set: { lastCreditAt: new Date() } },
      { new: true }
    );

    // Backfill `balanceAfter` on the digital row now that the balance is
    // known. Only the reconciliation view reads it, so a crash between the
    // two writes costs an audit convenience, never a balance.
    const digitalRow = inserted.find((r) => r.ledger === 'digital');
    if (digitalRow) {
      await WalletTransaction.updateOne(
        { _id: digitalRow._id },
        { $set: { balanceAfter: roundMoney(updated.digitalBalance) } }
      );
    }

    updated = await evaluatePayoutLock(updated, cashLimit);
    emitWalletUpdate(io, share.accountId, updated);

    results.push({
      accountId: share.accountId,
      role: share.role,
      credited: true,
      breakdown,
      cashHeld,
      digitalDelta,
      cashInHand: roundMoney(updated.cashInHand),
      digitalBalance: roundMoney(updated.digitalBalance),
      isPayoutLocked: !!updated.isPayoutLocked,
    });
  }

  return { credited: results.some((r) => r.credited), shares: results };
}

/**
 * Reserve funds for a payout request. The decrement and its guards are ONE
 * atomic statement: a provider firing two withdrawals for their whole balance
 * at once must have exactly one succeed, and no read-then-write can promise
 * that. A null return means one of the guards failed — the caller inspects the
 * wallet to say which.
 */
async function holdPayoutFunds(providerId, amount) {
  const amt = roundMoney(amount);
  return Wallet.findOneAndUpdate(
    {
      providerId,
      isPayoutLocked: false,
      digitalBalance: { $gte: amt },
    },
    { $inc: { digitalBalance: -amt } },
    { new: true }
  );
}

/** Write the PAYOUT_HOLD row for a reservation made by `holdPayoutFunds`. */
async function recordPayoutHold(wallet, payoutRequest) {
  return WalletTransaction.create({
    walletId: wallet._id,
    providerAccountId: payoutRequest.providerAccountId,
    type: 'PAYOUT_HOLD',
    direction: 'DEBIT',
    ledger: 'digital',
    amount: roundMoney(payoutRequest.amount),
    balanceAfter: roundMoney(wallet.digitalBalance),
    payoutRequestId: payoutRequest._id,
    description:
      `Withdrawal requested — ৳${roundMoney(payoutRequest.amount)} via ` +
      `${payoutRequest.method}`,
  });
}

/**
 * Admin approved a payout. The money already left `digitalBalance` at hold
 * time, so this moves no balance — it only makes the withdrawal lifetime-
 * visible and stamps the bank/MFS reference onto the audit trail.
 */
async function settlePayout(io, payoutRequest, referenceId) {
  const wallet = await Wallet.forProvider(
    payoutRequest.providerAccountId,
    payoutRequest.providerRole
  );
  const amount = roundMoney(payoutRequest.amount);
  const updated = await Wallet.findByIdAndUpdate(
    wallet._id,
    { $inc: { totalWithdrawn: amount } },
    { new: true }
  );
  await WalletTransaction.create({
    walletId: wallet._id,
    providerAccountId: payoutRequest.providerAccountId,
    type: 'PAYOUT_PAID',
    direction: 'NONE',
    ledger: 'none',
    amount,
    balanceAfter: roundMoney(updated.digitalBalance),
    payoutRequestId: payoutRequest._id,
    referenceId: referenceId || '',
    description: `Payout paid — ৳${amount} via ${payoutRequest.method}`,
  });
  emitWalletUpdate(io, payoutRequest.providerAccountId, updated);
  return updated;
}

/** Admin rejected a payout — return the held funds to the provider. */
async function revertPayout(io, payoutRequest, reason) {
  const wallet = await Wallet.forProvider(
    payoutRequest.providerAccountId,
    payoutRequest.providerRole
  );
  const amount = roundMoney(payoutRequest.amount);
  const updated = await Wallet.findByIdAndUpdate(
    wallet._id,
    { $inc: { digitalBalance: amount } },
    { new: true }
  );
  await WalletTransaction.create({
    walletId: wallet._id,
    providerAccountId: payoutRequest.providerAccountId,
    type: 'PAYOUT_REVERSAL',
    direction: 'CREDIT',
    ledger: 'digital',
    amount,
    balanceAfter: roundMoney(updated.digitalBalance),
    payoutRequestId: payoutRequest._id,
    description: `Withdrawal rejected — ৳${amount} returned to your balance`,
  });
  emitWalletUpdate(io, payoutRequest.providerAccountId, updated);
  return updated;
}

/**
 * Admin received physical cash from a provider. Zeroes `cashInHand` with a
 * compare-and-swap on the exact balance read by the caller — if a collection
 * lands mid-settlement the CAS misses and the caller 409s rather than wiping
 * the fresh cash. Clears the payout lock in the same write.
 *
 * Returns null when the CAS missed.
 */
async function applyCashClearance(io, {
  providerId,
  providerRole,
  expectedBalance,
  amountCollected,
  receiptId,
  adminNotes,
}) {
  const wallet = await Wallet.forProvider(providerId, providerRole);
  const cleared = await Wallet.findOneAndUpdate(
    { _id: wallet._id, cashInHand: expectedBalance },
    { $set: { cashInHand: 0, isPayoutLocked: false } },
    { new: true }
  );
  if (!cleared) return null;

  await WalletTransaction.create({
    walletId: wallet._id,
    providerAccountId: providerId,
    type: 'CASH_CLEARANCE',
    direction: 'DEBIT',
    ledger: 'cash',
    amount: roundMoney(amountCollected),
    payoutRequestId: null,
    referenceId: receiptId || '',
    description:
      `Cash handed to the office — ৳${roundMoney(amountCollected)}` +
      (adminNotes ? ` (${adminNotes})` : ''),
  });
  emitWalletUpdate(io, providerId, cleared);
  return cleared;
}

module.exports = {
  CASH_ROLES,
  financeSettings,
  // Pure helpers — internal to the settlement path, exported so tests and any
  // future reconciliation script can re-derive a split without duplicating
  // the arithmetic.
  splitCommission,
  grossValueOf,
  resolveEarningShares,
  creditVisitEarnings,
  evaluatePayoutLock,
  emitWalletUpdate,
  holdPayoutFunds,
  recordPayoutHold,
  settlePayout,
  revertPayout,
  applyCashClearance,
};
