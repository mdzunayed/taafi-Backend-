const mongoose = require('mongoose');

// `cashhandoverlogs` collection — the immutable audit trail for provider
// cash reconciliation. One document is appended every time an admin
// receives physical cash from a doctor/nurse and zeroes that provider's
// `Account.financial_ledger.cash_in_hand` ledger.
//
// The counterpart to this record is the collect-cash CREDIT side in
// routes/appointments.js, which `$inc`s `cash_in_hand` when a provider
// takes a door-step balance in cash. There was previously NO way to
// decrement that ledger — this collection + the settle-provider-cash
// controller (controllers/adminFinanceController.js) close that loop.
//
// Rows are append-only: written once at settlement, never updated or
// deleted. `expected_amount` is the ledger balance at the instant of
// settlement, `amount_collected` is the physical cash the admin actually
// received, and `discrepancy` (expected − collected) captures any shortfall
// or surplus so a handover is auditable even when the two don't match.

const CashHandoverLogSchema = new mongoose.Schema(
  {
    // The admin (or support_member) who received the cash. Account id.
    admin_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    // The doctor/nurse whose ledger was settled. Account id (cash lives on
    // the Account, not the Provider profile).
    provider_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    // Snapshot of the provider's role + name at settlement time so the
    // receipt/audit view renders without an extra populate.
    provider_role: {
      type: String,
      enum: ['doctor', 'nurse'],
      required: true,
    },
    provider_name: { type: String, default: '' },
    // Ledger balance (`cash_in_hand`) captured the moment the settlement ran.
    expected_amount: { type: Number, required: true, min: 0 },
    // Physical cash the admin confirms receiving. May differ from expected.
    amount_collected: { type: Number, required: true, min: 0 },
    // expected_amount − amount_collected. Positive = provider short-handed
    // the platform; negative = handed over more than the ledger showed.
    discrepancy: { type: Number, default: 0 },
    admin_notes: { type: String, default: '', maxlength: 1000, trim: true },
    // Human-facing receipt reference, unique per settlement.
    receipt_id: { type: String, required: true, unique: true, index: true },
    settled_at: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.admin_account_id = ret.admin_account_id?.toString() || null;
        ret.provider_account_id = ret.provider_account_id?.toString() || null;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Audit views: a provider's handover history, and "collected today" rollups.
CashHandoverLogSchema.index({ provider_account_id: 1, settled_at: -1 });

module.exports = mongoose.model('CashHandoverLog', CashHandoverLogSchema);
