const mongoose = require('mongoose');

// `wallets` collection — one row per doctor/nurse, the SINGLE source of truth
// for every balance the platform owes (or is owed by) a provider.
//
// This supersedes `Account.financial_ledger.cash_in_hand`, which used to be
// the only money field on a provider and had exactly one writer (the
// collect-cash `$inc`) plus one reader (the admin clearance CAS). That field
// is now deprecated and backfilled into `cashInHand` here — see
// `scripts/backfillWallets.js`.
//
// The four balances answer four different questions:
//   digitalBalance — what the provider may withdraw RIGHT NOW. Grows by the
//                    net share of digitally-paid visits, shrinks when a
//                    payout is requested (funds are held, not on approval)
//                    and when a cash visit's commission is debited.
//   cashInHand     — company money the provider is physically carrying after
//                    a door-step cash collection. NOT withdrawable; it is
//                    already in their pocket. Cleared by an admin handover.
//   totalEarned    — lifetime GROSS-of-nothing / net-of-commission earnings.
//                    Monotonic; never decremented, including on payout.
//   totalWithdrawn — lifetime cash actually paid out (APPROVED payouts only).
//
// EVERY mutation is an atomic `$inc` (or a guarded `findOneAndUpdate`) issued
// by `services/walletService.js`. Nothing else in the codebase may write these
// fields: a read-modify-write would silently lose concurrent credits, and
// these are real balances a provider withdraws against.

const WalletSchema = new mongoose.Schema(
  {
    // Account id of the doctor/nurse. Unique — one wallet per provider.
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      unique: true,
      index: true,
    },
    // Role snapshot so the admin cash/payout rosters can filter and label
    // without joining Account on every list query.
    providerRole: {
      type: String,
      enum: ['doctor', 'nurse'],
      required: true,
    },
    // Funds available for withdrawal. May legitimately go NEGATIVE: a
    // cash-collected visit debits the platform's commission from here, and a
    // provider whose only work has been cash visits has no digital credit to
    // absorb it. That negative is a real debt, settled when their next
    // digital visit lands or when they hand over cash.
    digitalBalance: { type: Number, default: 0 },
    // Physical cash collected from patients on the platform's behalf and not
    // yet remitted. Only ever decremented by an admin cash handover.
    cashInHand: { type: Number, default: 0, min: 0 },
    // Lifetime provider net share (post-commission), across both payment
    // methods. Monotonic — a payout does not reduce what you have earned.
    totalEarned: { type: Number, default: 0 },
    // Lifetime sum of APPROVED payouts. A PENDING request is not counted here
    // (the money has left `digitalBalance` but not yet the platform).
    totalWithdrawn: { type: Number, default: 0 },
    // Hard gate on the withdraw endpoint. Flipped true by the ledger engine
    // when `cashInHand` exceeds `Settings.cash_in_hand_limit`, cleared by an
    // admin cash clearance. Rationale: a provider sitting on the platform's
    // cash should not also be draining their digital balance.
    isPayoutLocked: { type: Boolean, default: false, index: true },
    // Timestamp of the most recent earning credit. Drives the "last activity"
    // column on the admin roster.
    lastCreditAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.providerId = ret.providerId?.toString() || null;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Admin roster: "every provider holding cash", biggest holder first.
WalletSchema.index({ cashInHand: -1 });

/**
 * Fetch (creating on first access) the wallet for a provider account.
 * Upsert-based so two concurrent settlements for a provider's first-ever
 * visit can't race into a duplicate-key error — the unique index on
 * `providerId` makes the loser retry into the winner's document.
 */
WalletSchema.statics.forProvider = async function forProvider(
  providerId,
  providerRole = 'doctor'
) {
  const role = providerRole === 'nurse' ? 'nurse' : 'doctor';
  return this.findOneAndUpdate(
    { providerId },
    {
      $setOnInsert: {
        providerId,
        providerRole: role,
        digitalBalance: 0,
        cashInHand: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        isPayoutLocked: false,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model('Wallet', WalletSchema);
