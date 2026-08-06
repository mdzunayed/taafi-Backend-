// Currency helpers. All billing amounts are BDT stored as plain Numbers,
// so every computed value must pass through roundMoney() before it is
// stored, compared, or returned — raw float arithmetic (e.g.
// 1000.1 - 100 - 0.2) otherwise leaks binary-fraction error into
// balances the patient is actually charged.

// Compiled-in fallback for the platform's SUGGESTED booking deposit — the
// amount the admin console prefills its set-deposit field with. It charges
// nobody by itself: under the four-phase flow a booking owes a deposit only
// once an admin commits one for it on the review call.
//
// NOT the source of truth — that is `Settings.booking_deposit_amount`, resolved
// through `services/pricingService`. This value is used only when the Settings
// row is unreachable (cold cache + Mongo hiccup).
//
// Deliberately NOT env-overridable like PRESCRIPTION_UNLOCK_FEE below: a second
// config surface would compete with the admin console's Finance settings, and
// whichever one lost would silently disagree with what the patient was quoted.
const DEFAULT_BOOKING_DEPOSIT = 100;

// Round a currency value to 2 decimals. Non-finite input (NaN from a bad
// cast, Infinity) normalizes to 0 so a malformed field can never poison a
// stored balance. Number.EPSILON nudges half-way cases (e.g. 1.005) that
// binary floats represent just under the true value.
function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Fixed platform fee (BDT) to unlock a newly issued prescription.
// Env-overridable so ops can retune without a deploy; snapshotted onto
// each Prescription row at issue time so a later fee change never
// re-prices an already-issued script.
const PRESCRIPTION_UNLOCK_FEE =
  roundMoney(Number(process.env.PRESCRIPTION_UNLOCK_FEE) || 100);

module.exports = { DEFAULT_BOOKING_DEPOSIT, PRESCRIPTION_UNLOCK_FEE, roundMoney };
