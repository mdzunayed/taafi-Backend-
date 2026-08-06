// The single source of truth for a booking's BALANCE payment posture:
// how much is still owed, whether it has been settled, and through which
// channel it is being settled.
//
// Before this module the same three questions were answered independently by
// `projectInvoice` (model), `outstandingBalanceFor` (bookingFlow), and
// `outstandingFor` (routes/patient.js) — which is exactly how the provider
// console ended up showing "Collect Cash · Required" for a booking the
// patient had already flipped to online: each surface derived the answer from
// a different subset of the fields. Everything now funnels through
// `paymentPostureFor`, so the REST projection, the socket broadcast and the
// provider-facing payloads can never disagree.

const { roundMoney } = require('./money');

// Normalized settlement channels handed to the clients. The stored
// `payment_method` enum (DIGITAL / CASH_TO_PROVIDER) and the patient's
// `payment_preference` enum (DIGITAL / CASH_ON_SERVICE) both collapse into
// this two-value vocabulary so a client only ever branches on one word.
const CHANNEL_ONLINE = 'ONLINE';
const CHANNEL_CASH = 'CASH';

const STATUS_PAID = 'PAID';
const STATUS_PENDING = 'PENDING';

// The balance is settled the moment either settlement stamp lands, whichever
// path wrote it (gateway IPN/confirm, or provider cash collection).
function isBalanceSettled(doc) {
  if (!doc) return false;
  return Boolean(doc.final_paid_at || doc.final_transaction_id);
}

// Outstanding balance on a priced booking. Never negative. Raw figure — it
// ignores settlement, which is what the collect-cash endpoint wants (it needs
// the invoice amount for the row it is about to settle).
function outstandingBalanceFor(doc) {
  const fee = Number(doc.final_price) || 0;
  const deposit = Number(doc.deposit_amount) || 0;
  const discount = Number(doc.adjusted_discount) || 0;
  return Math.max(0, roundMoney(fee - deposit - discount));
}

// Which channel this balance runs through. Once settled the answer is a fact
// (`payment_method` records what actually happened); until then it is the
// patient's stated intent (`payment_preference`), with null — never chosen —
// treated as ONLINE, matching the enum's documented default.
function paymentChannelFor(doc) {
  if (isBalanceSettled(doc)) {
    return doc.payment_method === 'CASH_TO_PROVIDER'
      ? CHANNEL_CASH
      : CHANNEL_ONLINE;
  }
  return doc.payment_preference === 'CASH_ON_SERVICE'
    ? CHANNEL_CASH
    : CHANNEL_ONLINE;
}

// The full posture for one booking.
//
//   channel          ONLINE | CASH        (normalized, see above)
//   status           PAID | PENDING       (of the outstanding balance)
//   remainingBalance number, or null when the booking has not been priced yet
//                    — the distinction the patient invoice card relies on
//                    ("nothing left to pay" vs "no price yet")
//   cashCollectable  the ONLY condition under which a provider may be shown
//                    the collect-cash action: cash channel, unsettled, and
//                    actual money left to hand over
function paymentPostureFor(doc) {
  const settled = isBalanceSettled(doc);
  const fee = Number(doc.final_price) || 0;
  const outstanding = outstandingBalanceFor(doc);
  const channel = paymentChannelFor(doc);
  return {
    channel,
    status: settled ? STATUS_PAID : STATUS_PENDING,
    remainingBalance: settled ? 0 : fee > 0 ? outstanding : null,
    outstanding,
    settled,
    cashCollectable: !settled && channel === CHANNEL_CASH && outstanding > 0,
  };
}

// --- Where a balance payment is allowed to land ------------------------------

// Statuses in which settling the balance CLOSES the booking. New flow: the
// service was delivered and the invoice is due. Legacy flow: the admin priced
// the booking up-front and payment gates dispatch.
const BALANCE_CLOSING_STATUSES = [
  'service_completed_awaiting_final_payment',
  'amount_assigned_awaiting_final_payment',
];

// Statuses in which the balance may be PRE-paid: the admin has committed a
// fee and the visit is still ahead of us. Deliberately the same live window
// in which the patient may choose their remaining-payment method, minus the
// two closing states above — paying online now is just the other half of that
// choice ("cash at the visit" vs "clear it now").
const BALANCE_PREPAY_STATUSES = [
  // NOT `deposit_required`: that booking owes its DEPOSIT, and letting the
  // balance be prepaid there would take the larger payment while leaving the
  // visit unconfirmed. Deposit first, then the balance becomes prepayable.
  'deposit_paid_admin_reviewing',
  'submitted',
  'approved',
  'assigned',
  'enroute',
  'arrived',
  'in_service',
  'nurse_completed',
];

// How a balance payment on THIS booking must be applied, or null when it
// cannot be paid at all. The one place that answers the question, so the
// init / confirm / IPN guards and `applyBalanceSettlement`'s compare-and-swap
// can never disagree about which bookings are payable.
//
//   'closing' — the service is delivered (or this is a legacy pay-first
//               booking): settling ends the booking and pays for the visit,
//               releasing prescriptions and crediting provider earnings.
//   'prepay'  — priced, but the visit has not happened yet. The money is
//               taken and held; the lifecycle is untouched and the two side
//               effects above are deferred to completion, because crediting
//               a provider (or unlocking a script) for an undelivered visit
//               would be wrong.
function balanceSettlementModeFor(doc) {
  if (!doc) return null;
  // Already settled — the callers treat this as an idempotent success rather
  // than a payable booking, so neither mode applies.
  if (isBalanceSettled(doc)) return null;
  if (BALANCE_CLOSING_STATUSES.includes(doc.status)) return 'closing';
  // Pre-payment needs a committed fee: there is no balance to pay before the
  // admin's pricing call, which is the whole point of deposit-first.
  if (!(Number(doc.final_price) > 0)) return null;
  return BALANCE_PREPAY_STATUSES.includes(doc.status) ? 'prepay' : null;
}

module.exports = {
  CHANNEL_ONLINE,
  CHANNEL_CASH,
  STATUS_PAID,
  STATUS_PENDING,
  BALANCE_CLOSING_STATUSES,
  BALANCE_PREPAY_STATUSES,
  isBalanceSettled,
  outstandingBalanceFor,
  paymentChannelFor,
  paymentPostureFor,
  balanceSettlementModeFor,
};
