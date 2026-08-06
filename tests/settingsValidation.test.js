/**
 * Settings schema bounds.
 *
 * The admin console writes these three money knobs straight through
 * `PUT /api/admin/settings`. The schema validators are the last line before a
 * bad value reaches a payment gateway — a ৳0 deposit would open a zero-amount
 * session and defeat the confirmation gate entirely.
 *
 * `validateSync()` needs no Mongo connection, so this runs anywhere.
 *
 *   node backend/tests/settingsValidation.test.js
 */

const assert = require('node:assert');
const Settings = require('../src/models/Settings');

const errFor = (over) => new Settings({ key: 'global', ...over }).validateSync();

// --- booking_deposit_amount -------------------------------------------------

// A free deposit is not a deposit. Rejecting 0 is the point of `min: 1`.
assert.ok(
  errFor({ booking_deposit_amount: 0 })?.errors?.booking_deposit_amount,
  'a ৳0 deposit must be rejected',
);
assert.ok(errFor({ booking_deposit_amount: -1 })?.errors?.booking_deposit_amount);
assert.ok(
  errFor({ booking_deposit_amount: 100000.01 })?.errors?.booking_deposit_amount,
  'above the ceiling must be rejected',
);

// The realistic range an admin actually operates in.
assert.strictEqual(errFor({ booking_deposit_amount: 1 }), undefined);
assert.strictEqual(errFor({ booking_deposit_amount: 250 }), undefined);
assert.strictEqual(errFor({ booking_deposit_amount: 100000 }), undefined);

// Default matches the compiled-in fallback, so a fresh install and an
// unreachable Settings row agree on the number.
const { DEFAULT_BOOKING_DEPOSIT } = require('../src/utils/money');
assert.strictEqual(
  new Settings({ key: 'global' }).booking_deposit_amount,
  DEFAULT_BOOKING_DEPOSIT,
  'schema default must match the compiled-in fallback',
);

// --- the other two knobs the Finance section now exposes --------------------

assert.ok(errFor({ platform_commission_percent: -1 })?.errors?.platform_commission_percent);
assert.ok(errFor({ platform_commission_percent: 101 })?.errors?.platform_commission_percent);
assert.strictEqual(errFor({ platform_commission_percent: 0 }), undefined);
assert.strictEqual(errFor({ platform_commission_percent: 100 }), undefined);

assert.ok(errFor({ cash_in_hand_limit: -1 })?.errors?.cash_in_hand_limit);
assert.strictEqual(errFor({ cash_in_hand_limit: 0 }), undefined);

// --- the write whitelist ----------------------------------------------------

// Every field the Finance UI edits must be writable through PUT, or the save
// silently no-ops and the admin's change appears to vanish on refresh.
for (const field of [
  'booking_deposit_amount',
  'platform_commission_percent',
  'cash_in_hand_limit',
]) {
  assert.ok(Settings.EDITABLE.includes(field), `${field} must be in Settings.EDITABLE`);
}
// `key` must never be writable — it is the singleton's identity.
assert.ok(!Settings.EDITABLE.includes('key'));

console.log('settingsValidation.test.js — all assertions passed');
