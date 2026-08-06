const Settings = require('../models/Settings');
const { DEFAULT_BOOKING_DEPOSIT, roundMoney } = require('../utils/money');

// ─────────────────────────────────────────────────────────────────────────────
// Booking-deposit pricing. THE single place the slot-confirmation deposit is
// resolved.
//
// Four DIFFERENT numbers wear the name "deposit", and conflating any two of
// them is a billing bug:
//
//   configured  — the platform DEFAULT the admin console prefills the
//                 set-deposit field with. `Settings.booking_deposit_amount`,
//                 admin-editable, moves. Under the four-phase flow this
//                 charges nobody by itself: a booking owes a deposit only
//                 once an admin commits one for it.
//   required    — what the ADMIN decided THIS booking must deposit, on the
//                 Phase-2 review call. `CareRequest.required_deposit`. Null
//                 until then, which is what makes Phase 1 cost ৳0.
//   quoted      — what THIS booking was told it owes, stamped when the admin
//                 committed. `CareRequest.deposit_quoted_amount`. Immutable
//                 thereafter, so a later correction can never re-price a
//                 checkout the patient is already standing in.
//   snapshotted — what THIS booking actually PAID.
//                 `CareRequest.deposit_amount`, 0 until the gateway settles.
//
// Same discipline `PRESCRIPTION_UNLOCK_FEE` and `platform_commission_percent`
// already follow: snapshot money at the moment of commitment.
//
// Dependency direction is one-way — this module requires `models/Settings` and
// NOTHING else from the model layer. `models/CareRequest` requires this. Adding
// a `require('../models/CareRequest')` here would close a cycle.
// ─────────────────────────────────────────────────────────────────────────────

// Bounds mirror the schema validators on `Settings.booking_deposit_amount`, so
// a row written before those validators existed can't poison the cache.
const MIN_DEPOSIT = 1;
const MAX_DEPOSIT = 100000;

// 30s TTL. The deposit changes a handful of times a year but is read on every
// booking read, so this trades a negligible staleness window for not hitting
// Mongo on each `toJSON`. `PUT /admin/settings` invalidates explicitly, so an
// admin edit is visible on the very next request rather than up to 30s later.
const CACHE_TTL_MS = 30_000;

let _cached = null;
let _cachedAt = 0;

function clampDeposit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BOOKING_DEPOSIT;
  return roundMoney(Math.min(MAX_DEPOSIT, Math.max(MIN_DEPOSIT, n)));
}

/**
 * The configured deposit, fresh (subject to the TTL). Use this on any path that
 * can await — booking creation, `/deposit/init`, the public config endpoint.
 */
async function getBookingDepositAmount() {
  const now = Date.now();
  if (_cached !== null && now - _cachedAt < CACHE_TTL_MS) return _cached;
  try {
    const s = await Settings.getSingleton();
    _cached = clampDeposit(s.booking_deposit_amount);
    _cachedAt = now;
  } catch (err) {
    // A Settings read failure must never break a booking read. Serve the last
    // known-good value, or the compiled-in default on a cold cache.
    console.error('[pricingService] settings read failed:', err.message);
    if (_cached === null) return DEFAULT_BOOKING_DEPOSIT;
  }
  return _cached;
}

/**
 * The configured deposit WITHOUT a round trip — last resolved value, else the
 * compiled-in default.
 *
 * Exists for exactly one caller: `CareRequest.projectInvoice()` runs inside a
 * synchronous `toJSON` transform and cannot await. Everywhere else, prefer
 * `getBookingDepositAmount()`.
 */
function cachedBookingDepositAmount() {
  return _cached === null ? DEFAULT_BOOKING_DEPOSIT : _cached;
}

/**
 * The deposit figure for a booking: what it PAID if it has paid, what the
 * ADMIN set for it if not, and the configured amount only for legacy rows that
 * predate per-booking deposits.
 *
 * Pure — `configured` is passed in rather than read, so the async route paths
 * and the sync projection share one derivation and cannot drift. This is the
 * same rule `paymentPostureFor` enforces for balance posture.
 *
 * Callers that must distinguish "no deposit set yet" (Phase 1 — the patient
 * owes ৳0) from "a deposit is owed" must check `required_deposit` themselves
 * BEFORE calling this: the platform-default fallback at the bottom would
 * otherwise turn an un-reviewed booking into one that appears to owe money.
 * `projectInvoice` and `/deposit/init` both gate on that.
 */
function requiredDepositFor(doc, configured) {
  const paid = Number(doc?.deposit_amount) || 0;
  if (paid > 0) return roundMoney(paid);
  // What the admin committed on the review call — the Phase-2 number.
  const required = Number(doc?.required_deposit) || 0;
  if (required > 0) return roundMoney(required);
  // The immutable quote stamped when that commitment was made.
  const quoted = Number(doc?.deposit_quoted_amount) || 0;
  if (quoted > 0) return roundMoney(quoted);
  return clampDeposit(configured);
}

/**
 * Whether the admin has actually committed a deposit for this booking. The one
 * question that separates "free to place" from "owes a deposit", asked in the
 * same module that answers "how much" so the two can never disagree.
 */
function hasRequiredDeposit(doc) {
  return (
    Number(doc?.required_deposit) > 0 ||
    Number(doc?.deposit_quoted_amount) > 0 ||
    Number(doc?.deposit_amount) > 0
  );
}

/** `requiredDepositFor` against the live configured amount. */
async function resolveRequiredDeposit(doc) {
  return requiredDepositFor(doc, await getBookingDepositAmount());
}

/** Drop the cache. Called by `PUT /admin/settings` after a successful save. */
function invalidatePricingCache() {
  _cached = null;
  _cachedAt = 0;
}

/**
 * Populate the cache at boot so `cachedBookingDepositAmount()` is correct from
 * the first request instead of reporting the compiled default for 30s.
 * Best-effort: a failure here is already handled by the fallback chain.
 */
async function warmPricingCache() {
  await getBookingDepositAmount();
}

module.exports = {
  getBookingDepositAmount,
  cachedBookingDepositAmount,
  requiredDepositFor,
  hasRequiredDeposit,
  resolveRequiredDeposit,
  invalidatePricingCache,
  warmPricingCache,
  MIN_DEPOSIT,
  MAX_DEPOSIT,
};
