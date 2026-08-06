// Real-time fan-out for every change to a booking's balance-payment posture.
//
// One event, one payload shape, emitted from every write that can change the
// answer to "does someone still have to hand this provider cash?":
//   • the patient picking / switching their remaining-balance method
//     (PATCH /patient/requests/:id/payment-preference)
//   • the gateway settling the balance online (routes/patient.js)
//   • the provider collecting the balance in cash (routes/appointments.js)
//
// It reaches the patient's own devices, the appointment room (admin live
// console), the assigned doctor AND nurse, and the admin role room — the
// provider consoles being the reason this exists: without it a doctor whose
// console was opened while the booking said CASH keeps a stale "Collect
// Cash · Required" sheet on screen after the patient pays online, and the
// confirm tap then 409s with "this booking is not awaiting its balance
// payment".

const { paymentPostureFor } = require('./paymentPosture');
const { loadProviderPair } = require('./doctorView');
const { userRoomFor, roleRoomFor } = require('../services/notificationService');

// Socket event name. The payload additionally carries `event:
// 'BOOKING_PAYMENT_UPDATED'` so a client that multiplexes events through one
// handler can switch on the body alone.
const BOOKING_PAYMENT_UPDATED = 'booking:payment_updated';

// Resolve the user-room ids for a booking's assigned providers so a payment
// change reaches whoever is (or will be) collecting. Best-effort — the stored
// ids may point at a Provider or an Account row; the pair loader normalizes
// both to the signed-in Account whose _id is the room.
async function assignedProviderRooms(doc) {
  const rooms = [];
  const pairs = await Promise.all([
    doc.assigned_doctor_id
      ? loadProviderPair(doc.assigned_doctor_id, 'doctor').catch(() => null)
      : null,
    doc.assigned_nurse_id
      ? loadProviderPair(doc.assigned_nurse_id, 'nurse').catch(() => null)
      : null,
  ]);
  for (const pair of pairs) {
    const accId = pair?.account?._id;
    if (accId) rooms.push(userRoomFor(accId));
  }
  return rooms;
}

// The wire payload. Deliberately flat and self-contained: a console that
// receives it can re-render its payment card without a refetch, and still
// calls `fetchBookingDetails()` afterwards for the authoritative document.
function bookingPaymentPayload(doc, { reason = null } = {}) {
  const posture = paymentPostureFor(doc);
  const bookingId = doc._id.toString();
  return {
    event: 'BOOKING_PAYMENT_UPDATED',
    bookingId,
    // Same id under the key every other socket event on this platform uses,
    // so existing client routing (`payload.appointmentId === myId`) works.
    appointmentId: bookingId,
    paymentMethod: posture.channel, // ONLINE | CASH
    paymentStatus: posture.status, // PAID | PENDING
    remainingBalance: posture.remainingBalance,
    // Whether a provider may collect cash. The consoles gate their sheet on
    // this single boolean rather than re-deriving it from the three fields.
    cashCollectable: posture.cashCollectable,
    // Raw stored values, for any surface that speaks the canonical vocabulary.
    preference: doc.payment_preference ?? null,
    bookingStatus: doc.status,
    // What moved the posture: 'preference' | 'online_settlement' |
    // 'cash_settlement'. Purely informational (drives the toast wording).
    reason,
    timestamp: new Date().toISOString(),
  };
}

// Emit the posture to every surface that renders it. Best-effort by design:
// the money write has already committed by the time this runs, so a socket
// failure must never fail the request.
async function emitBookingPaymentUpdated(io, doc, { reason = null } = {}) {
  if (!io || !doc || !doc._id) return null;
  const payload = bookingPaymentPayload(doc, { reason });
  try {
    if (doc.patient_account_id) {
      io.to(userRoomFor(doc.patient_account_id)).emit(
        BOOKING_PAYMENT_UPDATED,
        payload,
      );
    }
    io.to(payload.bookingId).emit(BOOKING_PAYMENT_UPDATED, payload);
    const rooms = await assignedProviderRooms(doc);
    for (const room of rooms) {
      io.to(room).emit(BOOKING_PAYMENT_UPDATED, payload);
    }
    io.to(roleRoomFor('admin')).emit(BOOKING_PAYMENT_UPDATED, payload);
  } catch (_) {
    /* live fan-out is best-effort — the settlement itself already landed */
  }
  return payload;
}

module.exports = {
  BOOKING_PAYMENT_UPDATED,
  assignedProviderRooms,
  bookingPaymentPayload,
  emitBookingPaymentUpdated,
};
