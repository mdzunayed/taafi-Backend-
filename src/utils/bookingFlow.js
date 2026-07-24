// Shared booking-lifecycle decisions so the three completion surfaces
// (doctor finalize-with-prescription, provider console complete, legacy
// visit-status PATCH) can never disagree on where a finished visit lands.

const CareRequest = require('../models/CareRequest');
const Prescription = require('../models/Prescription');
const {
  safeEmitNotification,
  userRoomFor,
} = require('../services/notificationService');
// Push dispatch is offloaded to the BullMQ background queue (identical
// signature to the old fcmService call, so nothing else changes). Falls
// back to inline send when Redis is disabled.
const { enqueuePush: sendHighPriorityPush } = require('../queues/notificationQueue');
const { roundMoney } = require('./money');
const {
  releaseStateFor,
  notifyAdminsPrescriptionPaid,
} = require('./prescriptionRelease');

// --- Patient ↔ provider communication channel -------------------------------
// The single source of truth for whether the in-app chat + masked-calling
// surface is OPEN for a booking. Extends the client-side `canSendMessages`
// gate (which reasons off the same status set) into a server-of-truth used
// by the socket `send_message` guard, the masked-call endpoint, and the
// lifecycle lock/unlock hooks below.

// Booking statuses during which the patient and the assigned provider may
// talk: assignment through the active field visit. Everything else — pending
// payment/review, and every terminal state — is a read-only archive.
const OPEN_CHAT_STATUSES = new Set([
  'assigned',
  'enroute',
  'on_the_way',
  'arrived',
  'in_service',
  'nurse_completed',
]);

function isBookingChatOpen(status) {
  return OPEN_CHAT_STATUSES.has(String(status || '').toLowerCase());
}

// Persist + broadcast a channel-open transition. Called the moment a provider
// is assigned. Best-effort: a notification/emit failure must never tank the
// assignment write that triggered it. `doc` may be a Mongoose doc or a lean
// object — we patch by `_id` so either works.
async function unlockBookingChannel(io, doc) {
  if (!doc || !doc._id) return;
  const now = new Date();
  try {
    await CareRequest.updateOne(
      { _id: doc._id },
      {
        $set: {
          'communicationChannel.isLocked': false,
          'communicationChannel.unlockedAt': now,
        },
      },
    );
  } catch (_) {
    /* lock-state write failure is non-fatal to the assignment */
  }
  try {
    if (io) {
      io.to(String(doc._id)).emit('channel_unlocked', {
        appointmentId: doc._id.toString(),
        isLocked: false,
        timestamp: now.toISOString(),
      });
    }
  } catch (_) {
    /* emit failure is non-fatal */
  }
}

// Persist + broadcast a channel-locked transition. Called on completion and
// cancellation so both apps flip their input bars to the read-only archive
// banner without a manual refresh. Best-effort, same rationale as above.
async function lockBookingChannel(io, doc) {
  if (!doc || !doc._id) return;
  const now = new Date();
  try {
    await CareRequest.updateOne(
      { _id: doc._id },
      {
        $set: {
          'communicationChannel.isLocked': true,
          'communicationChannel.lockedAt': now,
        },
      },
    );
  } catch (_) {
    /* lock-state write failure is non-fatal to the completion */
  }
  try {
    if (io) {
      io.to(String(doc._id)).emit('channel_locked', {
        appointmentId: doc._id.toString(),
        isLocked: true,
        timestamp: now.toISOString(),
      });
    }
  } catch (_) {
    /* emit failure is non-fatal */
  }
}

// Where a visit goes when the provider marks the service done. Legacy
// bookings collected the balance up-front (`amount_assigned_awaiting_
// final_payment` → paid → `approved`), so if the balance is already
// settled the visit is terminal; otherwise it parks in the payment-due
// state until the patient clears the outstanding invoice.
function completionStatusFor(doc) {
  return doc.final_paid_at || doc.final_transaction_id
    ? 'completed'
    : 'service_completed_awaiting_final_payment';
}

// Outstanding balance for a priced request. Never negative. Mirrors
// `outstandingFor` in routes/patient.js — assignment requires a
// positive `final_price`, so every serviced booking is priced.
function outstandingBalanceFor(doc) {
  const fee = Number(doc.final_price) || 0;
  const deposit = Number(doc.deposit_amount) || 0;
  const discount = Number(doc.adjusted_discount) || 0;
  return Math.max(0, roundMoney(fee - deposit - discount));
}

// The moment the patient is FIRST prompted for the outstanding balance:
// the visit just parked in `service_completed_awaiting_final_payment`.
// Best-effort — a notification failure must never tank the completion.
async function notifyPatientBalanceDue(io, doc) {
  const patientAccountId = doc.patient_account_id;
  if (!patientAccountId) return;
  const outstanding = outstandingBalanceFor(doc);
  const title = 'Care visit complete — balance due';
  const body =
    'Your home care visit is complete. Pay the outstanding balance of ' +
    `৳${outstanding} to settle your booking.`;
  const payload = {
    requestId: doc._id.toString(),
    deepLink: 'invoice',
  };
  try {
    await safeEmitNotification(io, {
      recipientId: patientAccountId,
      senderId: null,
      title,
      body,
      type: 'payment',
      payload,
    });
  } catch (_) {
    /* in-app fan-out failure is non-fatal */
  }
  try {
    sendHighPriorityPush(patientAccountId, title, body, {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      ...payload,
    });
  } catch (_) {
    /* push failure is non-fatal */
  }
}

// Post-settlement side effects shared by BOTH balance-settlement paths
// (digital gateway in routes/patient.js, cash-to-provider in
// routes/appointments.js): the balance payment is what pays for the
// visit's prescriptions, so flip them PAID and hand them to the admin
// release queue. Idempotent — the `payment_status` guard means a
// duplicate settlement matches zero scripts and never re-notifies.
// Best-effort: a notification failure must never tank the settlement
// (the payment IS applied at this point).
async function releasePrescriptionsForSettledBooking(io, booking, tranId) {
  const now = new Date();
  await Prescription.updateMany(
    {
      appointment_id: booking._id,
      payment_status: { $in: ['PENDING', 'FAILED'] },
      admin_approval_status: { $ne: 'REJECTED' },
    },
    {
      $set: {
        payment_status: 'PAID',
        unlock_transaction_id: tranId,
        paid_at: now,
      },
    },
  );
  // Re-read only the scripts THIS settlement paid (tranId is unique per
  // settlement) so the fan-out below runs exactly once per script.
  const paidScripts = await Prescription.find({
    appointment_id: booking._id,
    payment_status: 'PAID',
    unlock_transaction_id: tranId,
  });
  for (const script of paidScripts) {
    // Admin queue entry + `prescription:paid` live refresh.
    await notifyAdminsPrescriptionPaid(io, script);
    // An open Rx detail screen flips PAYMENT_REQUIRED →
    // PENDING_ADMIN_REVIEW without a manual refresh.
    if (io && script.patient_account_id) {
      io.to(userRoomFor(script.patient_account_id)).emit(
        'prescription:release_updated',
        {
          prescriptionId: script._id.toString(),
          releaseStatus: releaseStateFor(script),
          timestamp: new Date().toISOString(),
        },
      );
    }
  }
  // Receipt + what-happens-next for the patient.
  try {
    const title = 'Payment received — booking complete';
    const body =
      paidScripts.length > 0
        ? 'Your booking is settled. Your prescription is with our admin ' +
          "team for release — you'll be notified the moment it unlocks."
        : 'Your booking is settled. Thank you for choosing Taafi.';
    await safeEmitNotification(io, {
      recipientId: booking.patient_account_id,
      senderId: null,
      title,
      body,
      type: 'payment',
      payload: { requestId: booking._id.toString() },
    });
  } catch (_) {
    /* in-app fan-out failure is non-fatal */
  }
}

module.exports = {
  completionStatusFor,
  outstandingBalanceFor,
  notifyPatientBalanceDue,
  releasePrescriptionsForSettledBooking,
  isBookingChatOpen,
  lockBookingChannel,
  unlockBookingChannel,
};
