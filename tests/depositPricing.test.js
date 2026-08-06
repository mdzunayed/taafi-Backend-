/**
 * Booking-deposit resolution test.
 *
 * The deposit used to be one hardcoded ৳100. It is now four different numbers
 * that all answer to the name "deposit", and conflating any two of them is a
 * billing bug:
 *
 *   configured  — the platform DEFAULT             (Settings, moves)
 *   required    — what the ADMIN set for THIS case (Phase 2, null before then)
 *   quoted      — what THIS booking was told       (frozen at commit)
 *   snapshotted — what THIS booking PAID           (0 until the gateway settles)
 *
 * `requiredDepositFor` is the single derivation shared by the async route paths
 * and the synchronous invoice projection, so this matrix is the contract both
 * inherit.
 *
 *   node backend/tests/depositPricing.test.js
 */

const assert = require('node:assert');
const {
  requiredDepositFor,
  hasRequiredDeposit,
  cachedBookingDepositAmount,
} = require('../src/services/pricingService');
const { DEFAULT_BOOKING_DEPOSIT } = require('../src/utils/money');

const row = (over = {}) => ({
  deposit_amount: 0,
  deposit_quoted_amount: null,
  required_deposit: null,
  ...over,
});

// --- The precedence rule, stated as a matrix --------------------------------

// 1. A PAID booking reports what it actually paid — never the quote, never the
//    configured amount. A row that settled ৳100 must not later claim ৳150
//    because someone edited a quote field or retuned the platform fee.
assert.strictEqual(
  requiredDepositFor(row({ deposit_amount: 100, deposit_quoted_amount: 150 }), 200),
  100,
  'paid amount must win over both the quote and the configured value',
);

// 2. THE regression test for the whole design. An UNPAID booking reports what
//    it was QUOTED, even after an admin has moved the configured fee. This is
//    what stops a patient mid-checkout from being re-priced, and what stops
//    /deposit/confirm from rejecting a gateway session opened at the old
//    amount.
assert.strictEqual(
  requiredDepositFor(row({ deposit_quoted_amount: 150 }), 200),
  150,
  'an unpaid booking must hold the amount it was quoted, not the new configured one',
);

// 2b. The admin-set amount outranks the configured default, and is what an
//     unpaid Phase-2 booking owes. This is the number the review call produces.
assert.strictEqual(
  requiredDepositFor(row({ required_deposit: 500 }), 200),
  500,
  'the admin-set deposit wins over the platform default',
);
// A correction to the platform default must not move a booking already quoted.
assert.strictEqual(
  requiredDepositFor(row({ required_deposit: 500, deposit_quoted_amount: 500 }), 999),
  500,
  'a committed deposit is immutable against later platform-fee changes',
);

// 3. A legacy row — unpaid, never quoted — falls back to the configured value.
//    This is the only case where the live setting reaches an existing booking,
//    and scripts/backfillDepositQuotes.js exists to empty this bucket.
assert.strictEqual(
  requiredDepositFor(row(), 200),
  200,
  'a legacy unquoted row falls back to the configured amount',
);

// 4. A zero/negative quote is treated as absent, not as a free booking. An
//    older build could have written 0 here; that must not yield a ৳0 deposit.
assert.strictEqual(
  requiredDepositFor(row({ deposit_quoted_amount: 0 }), 200),
  200,
  'a zero quote is absent, not free',
);
assert.strictEqual(requiredDepositFor(row({ deposit_quoted_amount: -5 }), 200), 200);

// 5. Garbage in the configured slot clamps rather than propagating. A NaN
//    reaching a gateway session is worse than a slightly wrong number.
assert.strictEqual(requiredDepositFor(row(), NaN), DEFAULT_BOOKING_DEPOSIT);
assert.strictEqual(requiredDepositFor(row(), undefined), DEFAULT_BOOKING_DEPOSIT);
assert.strictEqual(requiredDepositFor(row(), 0), 1, 'clamps up to the ৳1 floor');
assert.strictEqual(requiredDepositFor(row(), 1e9), 100000, 'clamps to the ceiling');

// 6. A missing document must not throw — `projectInvoice` runs on every read.
assert.strictEqual(requiredDepositFor(null, 200), 200);
assert.strictEqual(requiredDepositFor(undefined, 200), 200);

// 7. Cold cache serves the compiled-in default rather than null/NaN, so the
//    synchronous projection is always renderable even before the boot warm-up.
assert.strictEqual(cachedBookingDepositAmount(), DEFAULT_BOOKING_DEPOSIT);

// --- "Is a deposit owed at all?" --------------------------------------------

// The question that separates a free Phase-1 request from a payable Phase-2
// one. It must answer NO before the review call and YES after it — reading the
// amount alone cannot tell them apart, because the fallback chain always
// produces a number.
assert.strictEqual(hasRequiredDeposit(row()), false, 'a fresh request owes nothing');
assert.strictEqual(hasRequiredDeposit(row({ required_deposit: 500 })), true);
assert.strictEqual(hasRequiredDeposit(row({ deposit_quoted_amount: 150 })), true);
assert.strictEqual(hasRequiredDeposit(row({ deposit_amount: 100 })), true);
assert.strictEqual(hasRequiredDeposit(null), false);

// --- The invariants the patient payment UI rests on -------------------------

const CareRequest = require('../src/models/CareRequest');
const booking = (over = {}) =>
  new CareRequest({
    patient_name: 'Test Patient',
    care_type: 'Post-surgery home care',
    ...over,
  }).toJSON();

// PHASE 1 — THE REGRESSION TEST FOR ZERO-COST BOOKING.
//
// A freshly submitted request owes ৳0. `deposit_required_amount` must be null,
// not the platform default: the checkout screen renders that field verbatim,
// so a number here is a charge the patient was never quoted and no admin ever
// set. `NOT_REQUIRED` is what suppresses every "Pay ৳X Deposit" CTA.
{
  const json = booking({ status: 'submitted' });
  assert.strictEqual(json.booking_phase, 'REQUEST_SUBMITTED');
  assert.strictEqual(json.deposit_status, 'NOT_REQUIRED');
  assert.strictEqual(json.deposit_payment_status, 'UNPAID');
  assert.strictEqual(
    json.deposit_required_amount,
    null,
    'a booking nobody has priced must not quote a deposit',
  );
  assert.strictEqual(json.required_deposit, null);
  assert.strictEqual(json.total_service_fee, null, 'no fee before the review call');
  assert.strictEqual(json.prescription_unlocked, false);
  assert.strictEqual(json.remaining_payment_status, 'PENDING');
}

// PHASE 2 — the admin committed both numbers. Now a deposit is owed, and the
// remaining balance is the fee minus that deposit.
{
  const json = booking({
    status: 'deposit_required',
    final_price: 2500,
    required_deposit: 500,
    deposit_quoted_amount: 500,
  });
  assert.strictEqual(json.booking_phase, 'DEPOSIT_REQUIRED');
  assert.strictEqual(json.deposit_status, 'PENDING');
  assert.strictEqual(json.deposit_payment_status, 'UNPAID');
  assert.strictEqual(json.deposit_required_amount, 500);
  assert.strictEqual(json.total_service_fee, 2500);
  // Nothing is paid yet, so the whole fee is still outstanding — the deposit
  // is only deducted once it has actually been collected.
  assert.strictEqual(json.remaining_balance, 2500);
  assert.ok(json.deposit_required_amount > 0, 'never 0 — the UI renders this verbatim');
}

// PHASE 3 — the deposit cleared. The spec's worked example: ৳2,500 fee,
// ৳500 deposit, ৳2,000 remaining.
{
  const json = booking({
    status: 'deposit_paid_admin_reviewing',
    final_price: 2500,
    required_deposit: 500,
    deposit_quoted_amount: 500,
    deposit_amount: 500,
    deposit_paid_at: new Date(),
  });
  assert.strictEqual(json.booking_phase, 'DEPOSIT_PAID');
  assert.strictEqual(json.deposit_status, 'CONFIRMED');
  assert.strictEqual(json.deposit_payment_status, 'PAID');
  assert.strictEqual(json.deposit_required_amount, 500);
  assert.strictEqual(json.remaining_balance, 2000, 'fee − deposit − discount');
  assert.strictEqual(json.prescription_unlocked, false, 'locked until settled');
}

// PHASE 4 — the dual gate. An online payment lands but stays UNVERIFIED, so
// the prescription must remain locked until an admin confirms receipt. This is
// the assertion that stops Channel B degrading into an auto-unlock.
{
  const json = booking({
    status: 'completed',
    final_price: 2500,
    required_deposit: 500,
    deposit_amount: 500,
    deposit_paid_at: new Date(),
    final_paid_at: new Date(),
    final_transaction_id: 'BAL-123',
    remaining_payment_status: 'PENDING_ADMIN_VERIFICATION',
  });
  assert.strictEqual(json.remaining_payment_status, 'PENDING_ADMIN_VERIFICATION');
  assert.strictEqual(
    json.prescription_unlocked,
    false,
    'paid online is not the same as verified — the script stays locked',
  );
  assert.strictEqual(json.remaining_balance, 0, 'the money did arrive');
}

// PHASE 4 — verified through either channel: the script is open.
{
  const json = booking({
    status: 'completed',
    final_price: 2500,
    deposit_amount: 500,
    deposit_paid_at: new Date(),
    final_paid_at: new Date(),
    final_transaction_id: 'CASH-123',
    payment_method: 'CASH_TO_PROVIDER',
    remaining_payment_status: 'VERIFIED',
    prescription_unlocked: true,
  });
  assert.strictEqual(json.booking_phase, 'COMPLETED');
  assert.strictEqual(json.prescription_unlocked, true);
  assert.strictEqual(json.remaining_payment_method, 'CASH');
}

// A legacy `awaiting_deposit` row (quoted under the retired flow, never given
// a `required_deposit`) still owes its deposit — the zero-cost change must not
// silently make in-flight bookings free.
{
  const json = booking({ status: 'awaiting_deposit', deposit_quoted_amount: 150 });
  assert.strictEqual(json.deposit_amount, 0, 'unpaid booking has no settled amount');
  assert.strictEqual(json.deposit_status, 'PENDING');
  assert.strictEqual(json.deposit_required_amount, 150);
}

console.log('depositPricing.test.js — all assertions passed');
