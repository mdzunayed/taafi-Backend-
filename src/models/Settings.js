const mongoose = require('mongoose');

// `settings` collection — a SINGLE platform-configuration document. The admin
// console's Settings screen previously persisted these toggles only to the
// browser's SharedPreferences; this model gives them a durable, server-side
// home so operational hours and the maintenance switch actually affect the
// platform (and survive a device change).
//
// There is exactly one row, resolved via `Settings.getSingleton()`. The
// `key: 'global'` unique index makes the upsert idempotent.

const OperationalHoursSchema = new mongoose.Schema(
  {
    // 24h "HH:mm" strings. Interpreted in the platform's local timezone.
    open: { type: String, default: '08:00' },
    close: { type: String, default: '22:00' },
    // 0 = Sunday … 6 = Saturday. Days the service operates.
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, index: true },
    // Dispatch
    allow_auto_assignment: { type: Boolean, default: false },
    require_verified_doctors: { type: Boolean, default: true },
    // System
    maintenance_mode: { type: Boolean, default: false },
    beta_charts: { type: Boolean, default: false },
    // Operations
    operational_hours: { type: OperationalHoursSchema, default: () => ({}) },
    // Free-form banner shown to patients when set (empty = none).
    system_notification: { type: String, default: '', maxlength: 500, trim: true },
    // ── Finance ─────────────────────────────────────────────────────────────
    // Platform's cut of every completed visit, as a percentage of the gross
    // fee. The provider keeps the remainder. Snapshotted onto each
    // WalletTransaction at settlement time, so retuning this never re-prices
    // visits that have already settled.
    platform_commission_percent: {
      type: Number,
      default: 20,
      min: 0,
      max: 100,
    },
    // Ceiling on un-remitted physical cash a provider may hold. Crossing it
    // sets `Wallet.isPayoutLocked`, blocking withdrawals until an admin
    // records a cash handover. Rationale: a provider sitting on the
    // platform's cash shouldn't also be draining their digital balance.
    cash_in_hand_limit: { type: Number, default: 5000, min: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        return ret;
      },
    },
  }
);

// The whitelist of fields a PUT /admin/settings may write — everything the UI
// owns, never `key`/timestamps.
SettingsSchema.statics.EDITABLE = [
  'allow_auto_assignment',
  'require_verified_doctors',
  'maintenance_mode',
  'beta_charts',
  'operational_hours',
  'system_notification',
  'platform_commission_percent',
  'cash_in_hand_limit',
];

// Fetch (creating on first access) the one global settings document.
SettingsSchema.statics.getSingleton = async function getSingleton() {
  const existing = await this.findOne({ key: 'global' });
  if (existing) return existing;
  return this.create({ key: 'global' });
};

module.exports = mongoose.model('Settings', SettingsSchema);
