const mongoose = require('mongoose');

// `accounts` collection — login + role identity. `password_hash` is never
// emitted to the client (stripped in toJSON).
const AccountSchema = new mongoose.Schema(
  {
    full_name: { type: String, required: true, trim: true },
    // Email is no longer the primary identifier — and is no longer
    // unique either. Kept as a free-form optional string so the
    // legacy admin/doctor demo seeds (which use email) still resolve
    // when /auth/login looks them up by email. The legacy `email_1`
    // unique index in Mongo is auto-dropped on boot (see server.js).
    email: { type: String, lowercase: true, trim: true },
    // Phone is the primary identifier for the phone+password flow.
    // Required when the account is NOT Google-issued — a Google sign-in
    // creates the row before we know the phone, and we add it later via
    // a profile-completion screen. Still unique when present.
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // allow many Google accounts with no phone yet
      index: true,
      required: function () {
        return !this.google_id;
      },
    },
    // Captured during sign-up Step 1. Used for visit dispatch context
    // and rendered in the patient profile.
    address: { type: String, default: '', trim: true },
    // Password hash. Required only for phone+password accounts; Google
    // accounts have no password (they authenticate via OAuth).
    //
    // `select: false` — the credential hash is NEVER loaded on a normal
    // query, so it can't leak through a stray `.lean()`, an aggregation, or
    // a future endpoint that forgets to strip it. The password-verification
    // paths (routes/auth.js login/reset) opt back in explicitly with
    // `.select('+password_hash')`. toJSON also deletes it as belt-and-braces.
    password_hash: {
      type: String,
      default: '',
      select: false,
      required: function () {
        return !this.google_id;
      },
    },
    // Google subject id (`sub` claim from the OAuth ID token). Sparse
    // unique — many rows can have no google_id, but any two rows with
    // the same google_id collide. Set only on /auth/google sign-ups.
    google_id: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
      index: true,
    },
    // Profile photo from Google. Falls through to the patient profile
    // avatar; never required and never written by the phone flow.
    photo_url: { type: String, default: '' },
    // User-uploaded avatar. Set by POST /api/users/:id/upload-avatar.
    // The Flutter side prefers this over `photo_url` (Google) when both
    // are present — a user uploading their own picture is more recent
    // intent than the OAuth-imported one.
    profile_picture: { type: String, default: '' },
    role: {
      type: String,
      enum: ['admin', 'doctor', 'nurse', 'user', 'support_member'],
      default: 'user',
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    // Flips true after `/auth/verify-otp` accepts the code. Login is
    // gated on this — an account that registered but never completed
    // OTP is rejected with a 403 so the user is forced back through
    // the verification screen.
    is_verified: {
      type: Boolean,
      default: false,
      index: true,
    },
    // FCM device push tokens. Each entry is a single device's
    // current registration token; the array can hold multiple when a
    // user has signed in on phone + tablet + web. The token register
    // route (`POST /api/auth/fcm-token`) appends new values and dedupes
    // on save via the pre-save hook below. Cleared on logout via
    // `POST /api/auth/fcm-token` with `unregister: true`.
    fcm_tokens: {
      type: [String],
      default: [],
    },

    // Provider provisioning latch. Admin-created doctor/nurse rows land
    // with this set to `true` and an auto-generated temporary password.
    // The login handler surfaces the flag back to the Flutter client as
    // `requiresReset: true` so the session immediately routes into the
    // ForcedPasswordResetScreen — the temp credential is single-use.
    requires_password_reset: {
      type: Boolean,
      default: false,
      index: true,
    },
    // ── Real-time duty status (dispatch console) ─────────────────────────
    // Live on/off-duty presence for provider (doctor/nurse) rows, used by
    // the admin's Team Dispatch console to categorise a provider at a
    // glance. Distinct from Provider.availability_status (the provider's own
    // explicit online/offline toggle): `duty_status` is driven by real
    // presence signals — a socket connect flips it ONLINE, the last socket
    // disconnecting flips it OFFLINE, and the availability toggle keeps it in
    // sync. `ON_SERVICE` is NOT stored here; the dispatch endpoint derives it
    // dynamically from the provider's active/overlapping bookings so it can't
    // drift out of sync with the actual visit lifecycle. Only meaningful on
    // doctor/nurse rows.
    duty_status: {
      type: String,
      enum: ['ONLINE', 'ON_SERVICE', 'OFFLINE'],
      default: 'OFFLINE',
      index: true,
    },
    // Timestamp of the last presence signal (socket connect / heartbeat /
    // availability toggle). Lets the console grey out a provider whose app
    // died without a clean disconnect (stale presence) in a future pass.
    last_active_at: { type: Date, default: Date.now },
    // Latest GPS heartbeat from the Doctor app's LocationTrackingService.
    // Flat sub-doc (no enforced GeoJSON shape yet) — the POST
    // /doctor/location handler writes {latitude, longitude,
    // accuracy_meters, speed_mps, updated_at} as a single replace.
    // When the admin's "nearest doctor" feature lands, swap this for a
    // GeoJSON Point + a 2dsphere index without breaking existing rows.
    current_location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy_meters: { type: Number, default: null },
      speed_mps: { type: Number, default: null },
      updated_at: { type: Date, default: null },
    },
    // DEPRECATED — superseded by `models/Wallet.js` (`Wallet.cashInHand`).
    //
    // This was the original one-field cash ledger: the collect-cash endpoint
    // `$inc`d it and the admin clearance CAS zeroed it. The wallet/payout
    // engine needs four balances, not one, so cash moved into the Wallet
    // document and every writer/reader was repointed there.
    //
    // The field is retained (not dropped) purely as the backfill source for
    // `scripts/backfillWallets.js` and as a forensic record for rows settled
    // before the migration. NOTHING may write it any more — a second writable
    // copy of the same money is exactly the drift the migration removed.
    financial_ledger: {
      cash_in_hand: { type: Number, default: 0 },
      last_collection_at: { type: Date, default: null },
    },
    // Patient medical vault — clinical reference the Doctor Operations Hub
    // surfaces inside the Active Care Console (allergies, chronic
    // conditions, blood type, emergency notes). Populated via
    // PATCH /doctor/patients/:accountId/vault. Intentionally NOT stripped
    // in toJSON: a treating doctor must be able to read it. Only ever
    // meaningful on `role: 'user'` (patient) rows.
    medical_vault: {
      allergies: { type: [String], default: [] },
      chronic_conditions: { type: [String], default: [] },
      blood_type: {
        type: String,
        enum: ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'Unknown'],
        default: 'Unknown',
      },
      emergency_notes: { type: String, default: '', maxlength: 1000 },
      updated_at: { type: Date, default: null },
      // Account id of the doctor/nurse who last edited the vault.
      updated_by: { type: String, default: '' },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Dedupe FCM tokens on save — appends from concurrent device sign-ins
// can otherwise grow the array unboundedly. Also strips obviously
// invalid empty strings.
AccountSchema.pre('save', function (next) {
  if (Array.isArray(this.fcm_tokens) && this.isModified('fcm_tokens')) {
    const seen = new Set();
    this.fcm_tokens = this.fcm_tokens.filter((t) => {
      if (typeof t !== 'string') return false;
      const v = t.trim();
      if (!v) return false;
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
  }
  next();
});

AccountSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.password_hash; // never leak the hash to the client
    delete ret.fcm_tokens; // device push tokens are server-only
    return ret;
  },
});

module.exports = mongoose.model('Account', AccountSchema);
