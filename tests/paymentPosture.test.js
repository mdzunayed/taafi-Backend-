/**
 * Balance-payment posture test.
 *
 * The provider console used to decide "is cash owed?" from
 * `payment_preference` alone, which is why a booking the patient had switched
 * to Online — or already paid online — still rendered "Collect Cash ·
 * Required" and then 409'd on confirm. `paymentPostureFor` is now the single
 * derivation behind the invoice projection, the `booking:payment_updated`
 * socket payload and the provider read endpoints, so the matrix below is the
 * contract all three inherit.
 *
 *   node backend/tests/paymentPosture.test.js
 */

const assert = require('node:assert');
const {
  paymentPostureFor,
  balanceSettlementModeFor,
} = require('../src/utils/paymentPosture');
const { bookingPaymentPayload } = require('../src/utils/paymentBroadcast');

const booking = (over = {}) => ({
  _id: { toString: () => '652f1a0000000000000000aa' },
  status: 'service_completed_awaiting_final_payment',
  final_price: 1200,
  deposit_amount: 100,
  adjusted_discount: 0,
  payment_preference: null,
  payment_method: null,
  final_paid_at: null,
  final_transaction_id: null,
  ...over,
});

// --- The bug, stated as a matrix -------------------------------------------

// 1. Patient committed to cash, balance open → the ONLY collectable case.
{
  const p = paymentPostureFor(
    booking({ payment_preference: 'CASH_ON_SERVICE' }),
  );
  assert.strictEqual(p.channel, 'CASH');
  assert.strictEqual(p.status, 'PENDING');
  assert.strictEqual(p.remainingBalance, 1100);
  assert.strictEqual(p.cashCollectable, true);
}

// 2. Patient switched the remaining method to Online mid-visit. The balance
//    is still open, but no provider may collect it.
{
  const p = paymentPostureFor(booking({ payment_preference: 'DIGITAL' }));
  assert.strictEqual(p.channel, 'ONLINE');
  assert.strictEqual(p.status, 'PENDING');
  assert.strictEqual(p.remainingBalance, 1100);
  assert.strictEqual(p.cashCollectable, false);
}

// 3. Never chose → treated as online, matching the enum's documented default.
{
  const p = paymentPostureFor(booking({ payment_preference: null }));
  assert.strictEqual(p.channel, 'ONLINE');
  assert.strictEqual(p.cashCollectable, false);
}

// 4. Paid online AFTER pre-committing to cash — the settlement is the fact,
//    the stale preference must not win.
{
  const p = paymentPostureFor(
    booking({
      payment_preference: 'CASH_ON_SERVICE',
      payment_method: 'DIGITAL',
      final_paid_at: new Date(),
      final_transaction_id: 'TXN-1',
      status: 'completed',
    }),
  );
  assert.strictEqual(p.channel, 'ONLINE');
  assert.strictEqual(p.status, 'PAID');
  assert.strictEqual(p.remainingBalance, 0);
  assert.strictEqual(p.cashCollectable, false);
}

// 5. Settled in cash at the door → PAID via CASH, nothing left to collect.
{
  const p = paymentPostureFor(
    booking({
      payment_preference: 'CASH_ON_SERVICE',
      payment_method: 'CASH_TO_PROVIDER',
      final_paid_at: new Date(),
      final_transaction_id: 'CASH-1',
      status: 'completed',
    }),
  );
  assert.strictEqual(p.channel, 'CASH');
  assert.strictEqual(p.status, 'PAID');
  assert.strictEqual(p.cashCollectable, false);
}

// 6. Not priced yet → remaining balance is null (unknown), not 0 (settled).
{
  const p = paymentPostureFor(
    booking({ final_price: null, status: 'deposit_paid_admin_reviewing' }),
  );
  assert.strictEqual(p.remainingBalance, null);
  assert.strictEqual(p.cashCollectable, false);
}

// 7. Discount wipes out the balance → priced, unsettled, nothing to hand over.
{
  const p = paymentPostureFor(
    booking({
      payment_preference: 'CASH_ON_SERVICE',
      adjusted_discount: 1100,
    }),
  );
  assert.strictEqual(p.remainingBalance, 0);
  assert.strictEqual(p.cashCollectable, false);
}

// --- Wire payload -----------------------------------------------------------

{
  const payload = bookingPaymentPayload(
    booking({ payment_preference: 'DIGITAL' }),
    { reason: 'preference' },
  );
  assert.strictEqual(payload.event, 'BOOKING_PAYMENT_UPDATED');
  assert.strictEqual(payload.bookingId, '652f1a0000000000000000aa');
  // Same id under the key the rest of the socket layer already uses, so
  // client-side routing doesn't need a special case.
  assert.strictEqual(payload.appointmentId, payload.bookingId);
  assert.strictEqual(payload.paymentMethod, 'ONLINE');
  assert.strictEqual(payload.paymentStatus, 'PENDING');
  assert.strictEqual(payload.cashCollectable, false);
  assert.strictEqual(payload.reason, 'preference');
  assert.ok(payload.timestamp);
}

// --- Where a balance payment may land ---------------------------------------
//
// Deposit-first lets the patient clear the balance as soon as the admin's
// pricing call lands, long before the visit. That payment must NOT be applied
// the way a post-service one is (it would credit a provider and unlock a
// prescription for an undelivered visit), so the mode is decided here and the
// settlement CAS branches on it.

// A delivered visit closes on payment — the original flow.
assert.strictEqual(balanceSettlementModeFor(booking()), 'closing');
assert.strictEqual(
  balanceSettlementModeFor(
    booking({ status: 'amount_assigned_awaiting_final_payment' }),
  ),
  'closing',
);

// Priced and live: payable, but money-only.
for (const status of [
  'deposit_paid_admin_reviewing',
  'assigned',
  'enroute',
  'in_service',
  'nurse_completed',
]) {
  assert.strictEqual(
    balanceSettlementModeFor(booking({ status })),
    'prepay',
    `${status} should be pre-payable once priced`,
  );
}

// Unpriced: there is nothing to pay yet. This is the deposit-first invariant —
// the admin's fee is what creates a balance at all, so a patient sitting in
// review cannot pre-pay their way past it.
assert.strictEqual(
  balanceSettlementModeFor(
    booking({ status: 'deposit_paid_admin_reviewing', final_price: null }),
  ),
  null,
);

// Awaiting its ৳100 deposit: not a balance-payment surface at all.
assert.strictEqual(
  balanceSettlementModeFor(
    booking({ status: 'awaiting_deposit', final_price: null }),
  ),
  null,
);

// Already settled → null in EVERY status, which is what makes a duplicate
// confirm or a confirm racing its own IPN an idempotent no-op rather than a
// second charge.
for (const status of ['assigned', 'service_completed_awaiting_final_payment']) {
  assert.strictEqual(
    balanceSettlementModeFor(
      booking({ status, final_paid_at: new Date(), payment_method: 'DIGITAL' }),
    ),
    null,
  );
  assert.strictEqual(
    balanceSettlementModeFor(booking({ status, final_transaction_id: 'BAL-1' })),
    null,
  );
}

// Terminal bookings are never payable.
for (const status of ['completed', 'cancelled', 'rejected']) {
  assert.strictEqual(balanceSettlementModeFor(booking({ status })), null);
}

// A pre-paid booking reads as fully settled to every surface — which is the
// whole point: this is what drops the clinician's Collect Cash sheet and
// turns the patient's ledger green before the visit even starts.
{
  const p = paymentPostureFor(
    booking({
      status: 'assigned',
      payment_preference: 'CASH_ON_SERVICE', // pre-committed to cash, then paid online
      payment_method: 'DIGITAL',
      final_paid_at: new Date(),
      final_transaction_id: 'BAL-9',
    }),
  );
  assert.strictEqual(p.status, 'PAID');
  assert.strictEqual(p.channel, 'ONLINE');
  assert.strictEqual(p.remainingBalance, 0);
  assert.strictEqual(p.cashCollectable, false);
}

console.log('paymentPosture: all assertions passed');
