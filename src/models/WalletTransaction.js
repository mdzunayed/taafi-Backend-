const mongoose = require('mongoose');

// `wallettransactions` collection — the append-only double-entry ledger behind
// every balance in `models/Wallet.js`. One row per money movement, written in
// the same call that `$inc`s the wallet. Rows are NEVER updated or deleted:
// a correction is a new compensating row, exactly like `CashHandoverLog`.
//
// It serves two readers:
//   • the provider's Wallet page history list (green credit / red debit cards)
//   • admin/audit reconciliation — `balanceAfter` lets you replay the digital
//     balance forward and catch any drift from a stray write.
//
// ── The seven movement types ────────────────────────────────────────────────
//   VISIT_EARNING    CREDIT  digital  Net share of a digitally-paid visit.
//   CASH_COLLECTION  CREDIT  cash     Full fee the provider took at the door.
//   COMMISSION_DEBIT DEBIT   digital  Platform's cut of a CASH visit, which
//                                     the patient never paid us directly.
//   PAYOUT_HOLD      DEBIT   digital  Funds reserved when a payout is
//                                     REQUESTED (not when it is approved).
//   PAYOUT_PAID      —       —        Marker row when an admin approves; the
//                                     money already left at HOLD time, so this
//                                     moves no balance (amount is recorded for
//                                     the receipt/audit trail).
//   PAYOUT_REVERSAL  CREDIT  digital  Refund of a rejected payout's hold.
//   CASH_CLEARANCE   DEBIT   cash     Provider handed physical cash to admin.

const TX_TYPES = [
  'VISIT_EARNING',
  'CASH_COLLECTION',
  'COMMISSION_DEBIT',
  'PAYOUT_HOLD',
  'PAYOUT_PAID',
  'PAYOUT_REVERSAL',
  'CASH_CLEARANCE',
];

// The three types that are settlement-of-a-visit rows. These carry a
// `bookingId` and are the ones guarded by the idempotency index below.
const VISIT_TX_TYPES = ['VISIT_EARNING', 'CASH_COLLECTION', 'COMMISSION_DEBIT'];

const WalletTransactionSchema = new mongoose.Schema(
  {
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Wallet',
      required: true,
      index: true,
    },
    // Denormalised from the wallet so the provider's history query never
    // needs a join, and so an admin can pull one provider's whole ledger.
    providerAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    type: { type: String, enum: TX_TYPES, required: true, index: true },
    // Which side of the ledger this row moves. `PAYOUT_PAID` is a marker
    // (the balance moved at HOLD time) and carries direction 'NONE'.
    direction: {
      type: String,
      enum: ['CREDIT', 'DEBIT', 'NONE'],
      required: true,
    },
    // Which balance moved. Lets the UI badge a cash row differently from a
    // withdrawable-funds row.
    ledger: {
      type: String,
      enum: ['digital', 'cash', 'none'],
      default: 'digital',
    },
    // Always POSITIVE — `direction` carries the sign. Storing a signed amount
    // here would make the sums in the UI depend on getting the sign right in
    // seven places.
    amount: { type: Number, required: true, min: 0 },
    // `digitalBalance` immediately after this row was applied. Null for rows
    // that don't touch the digital ledger (CASH_COLLECTION, CASH_CLEARANCE).
    balanceAfter: { type: Number, default: null },

    // ── Visit context (settlement rows only) ────────────────────────────────
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CareRequest',
      default: null,
      index: true,
    },
    // Snapshots so a history card renders without populating CareRequest.
    patientName: { type: String, default: '' },
    careType: { type: String, default: '' },

    // The commission arithmetic, frozen at settlement time. `commissionPercent`
    // is snapshotted from `Settings.platform_commission_percent` so a later
    // rate change never retroactively re-prices a settled visit.
    breakdown: {
      grossAmount: { type: Number, default: 0 },
      commissionPercent: { type: Number, default: 0 },
      platformFee: { type: Number, default: 0 },
      providerNet: { type: Number, default: 0 },
    },

    // ── Payout / clearance context ──────────────────────────────────────────
    payoutRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PayoutRequest',
      default: null,
      index: true,
    },
    // Bank/MFS reference on approval, or the handover receipt id on a
    // CASH_CLEARANCE row.
    referenceId: { type: String, default: '' },

    // Human-facing one-liner rendered on the history card.
    description: { type: String, default: '', maxlength: 300 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.walletId = ret.walletId?.toString() || null;
        ret.providerAccountId = ret.providerAccountId?.toString() || null;
        ret.bookingId = ret.bookingId?.toString() || null;
        ret.payoutRequestId = ret.payoutRequestId?.toString() || null;
        delete ret._id;
        return ret;
      },
    },
  }
);

// The provider's history list: newest first, scoped to one wallet.
WalletTransactionSchema.index({ providerAccountId: 1, createdAt: -1 });

// ── Idempotency guard ───────────────────────────────────────────────────────
// A visit can reach `completed` through three code paths (digital settlement
// in routes/patient.js, cash collection in routes/appointments.js, and the
// legacy pre-paid `/complete`). Rather than defend each call site with its own
// "did we already credit this?" check — which is a race, not a guarantee —
// this index makes a second credit for the same (booking, provider, type)
// physically impossible. The ledger engine catches the resulting E11000 and
// treats it as "already settled".
//
// PARTIAL, not sparse: a compound *sparse* index only omits a document that is
// missing EVERY indexed field, so payout rows (bookingId: null) would still be
// indexed and a provider's second PAYOUT_HOLD would collide with their first.
// The partial filter restricts the index to genuine visit-settlement rows.
WalletTransactionSchema.index(
  { bookingId: 1, providerAccountId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { bookingId: { $type: 'objectId' } },
    name: 'visit_settlement_idempotency',
  }
);

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
module.exports.TX_TYPES = TX_TYPES;
module.exports.VISIT_TX_TYPES = VISIT_TX_TYPES;
