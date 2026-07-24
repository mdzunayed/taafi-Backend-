const mongoose = require('mongoose');

// `payoutrequests` collection — a provider's request to move money out of
// `Wallet.digitalBalance` into their bKash / Nagad / bank account.
//
// Funds are held at REQUEST time, not at approval: the withdraw endpoint
// decrements `digitalBalance` and writes a PAYOUT_HOLD transaction in the same
// guarded update. That way a provider can never request the same ৳5,000 twice
// while the first request sits in the admin queue. Approval therefore moves no
// balance (it only bumps `totalWithdrawn`); rejection refunds the hold.
//
// Status is terminal once it leaves PENDING — both admin actions CAS on
// `status: 'PENDING'`, so a double-clicked Approve pays out exactly once.

const PAYOUT_METHODS = ['bKash', 'Nagad', 'Bank'];

const PayoutRequestSchema = new mongoose.Schema(
  {
    providerAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    // Name/role snapshots so the admin queue table renders without a populate
    // and stays accurate even if the provider later renames themselves.
    providerName: { type: String, default: '' },
    providerRole: { type: String, enum: ['doctor', 'nurse'], required: true },
    providerPhone: { type: String, default: '' },

    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: PAYOUT_METHODS, required: true },

    // Destination captured at REQUEST time. Snapshotted rather than read from
    // `Provider.payout_details` at approval, so editing the saved payout
    // profile can never redirect an in-flight request to a new account.
    //
    // NOTE: `accountNumber` is stored in full — the admin has to key it into
    // bKash/the bank to actually pay. It is masked on the provider-facing read
    // path via utils/payout.js, and admin routes are already role-guarded.
    accountDetails: {
      accountNumber: { type: String, default: '', trim: true },
      accountName: { type: String, default: '', trim: true },
      bankName: { type: String, default: '', trim: true },
      branch: { type: String, default: '', trim: true },
    },

    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },
    // Bank/MFS transaction reference the admin keys in on approval. Required
    // by the endpoint (not the schema) so the audit trail always points at a
    // real transfer.
    referenceId: { type: String, default: '', trim: true },
    rejectionReason: { type: String, default: '', maxlength: 500, trim: true },

    // Admin account that actioned it, and when.
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    processedAt: { type: Date, default: null },
    requestedAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.providerAccountId = ret.providerAccountId?.toString() || null;
        ret.processedBy = ret.processedBy?.toString() || null;
        delete ret._id;
        return ret;
      },
    },
  }
);

// The admin queue: pending first, oldest request at the top.
PayoutRequestSchema.index({ status: 1, requestedAt: 1 });
// A provider's own payout history, newest first.
PayoutRequestSchema.index({ providerAccountId: 1, requestedAt: -1 });

module.exports = mongoose.model('PayoutRequest', PayoutRequestSchema);
module.exports.PAYOUT_METHODS = PAYOUT_METHODS;
