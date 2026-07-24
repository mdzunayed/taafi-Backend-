// Secure prescription release gate — the single decision point for
// whether a viewer may see a script's clinical content. A newly issued
// prescription is LOCKED for the patient until the booking's service
// balance is PAID *and* an admin APPROVES it; every read surface
// (my-active, by-patient, /:id, the admin queue) and the dose-log guard
// route their visibility decision through here so the rules can never
// drift apart.

const Account = require('../models/Account');
const { PRESCRIPTION_UNLOCK_FEE } = require('./money');
const {
  safeEmitNotification,
  roleRoomFor,
} = require('../services/notificationService');

// Patient-facing release state machine, in precedence order: a REJECTED
// script stays terminal even though it was paid; FAILED is treated the
// same as PENDING (the SSLCommerz return flow doesn't reliably mark
// failures — the enum value exists for manual ops only).
function releaseStateFor(doc) {
  if (doc.admin_approval_status === 'REJECTED') return 'REJECTED';
  if (doc.payment_status !== 'PAID') return 'PAYMENT_REQUIRED';
  if (doc.admin_approval_status !== 'APPROVED') return 'PENDING_ADMIN_REVIEW';
  return 'UNLOCKED';
}

// viewer: { accountId, privileged } — `privileged` covers admin/support
// staff AND doctors with a verified treating relationship (the routes
// compute that once per request). The issuing doctor always sees their
// own script; the gate is a patient monetisation/QA gate, not
// doctor-vs-doctor secrecy.
function isUnlockedFor(doc, viewer) {
  if (viewer?.privileged) return true;
  if (doc.doctor_account_id && doc.doctor_account_id === viewer?.accountId) {
    return true;
  }
  return releaseStateFor(doc) === 'UNLOCKED';
}

// Presenter applied to the (possibly doctor-enriched) `doc.toJSON()`
// output before it leaves the API. Always attaches the gate metadata so
// the client renders the pipeline off `releaseStatus` alone; when the
// viewer is locked out it strips the clinical content server-side —
// the paywall card can render, the script itself can never leak.
// `itemCount` survives redaction so the vault card can still say
// "3 medications · locked". The doctor block / doctor_name / issued_at
// intentionally survive too — the gate card shows who issued it, when.
function presentPrescription(json, doc, viewer) {
  json.releaseStatus = releaseStateFor(doc);
  json.paymentStatus = doc.payment_status;
  json.adminApprovalStatus = doc.admin_approval_status;
  json.unlockFeeAmount =
    Number(doc.unlock_fee_amount) || PRESCRIPTION_UNLOCK_FEE;
  json.locked = !isUnlockedFor(doc, viewer);
  if (!viewer?.privileged) {
    // Internal audit trail; the "contact support" copy lives client-side.
    delete json.approved_by;
    delete json.rejection_reason;
  }
  if (json.locked) {
    json.itemCount = Array.isArray(json.items) ? json.items.length : 0;
    json.items = [];
    json.dose_log = [];
    json.diagnosis = '';
    // Pad clinical content is gated too; doctor_snapshot stays visible
    // (identity, like doctor_name) so the gate card can show who issued.
    json.advice = '';
    json.vitals_snapshot = null;
    json.follow_up_date = null;
    delete json.symptoms;
  }
  return json;
}

// Fan out to every admin that a script has been paid for (the patient
// settled their booking's outstanding service balance) and is now
// awaiting release review. Called by the balance settlement in
// routes/patient.js. Best-effort — a notification failure must never
// tank the settlement.
async function notifyAdminsPrescriptionPaid(io, doc) {
  try {
    const admins = await Account.find({ role: 'admin' }, '_id').lean();
    const title = 'Balance settled — prescription review needed';
    const body =
      'A patient settled their service balance. The prescription by ' +
      `${doc.doctor_name || 'a doctor'} is awaiting release approval.`;
    const payload = {
      prescriptionId: doc._id.toString(),
      patientAccountId: doc.patient_account_id,
      deepLink: 'admin_prescription_queue',
    };
    await Promise.all(
      admins.map((a) =>
        safeEmitNotification(io, {
          recipientId: a._id,
          senderId: doc.patient_account_id || null,
          title,
          body,
          type: 'payment',
          payload,
        }),
      ),
    );
    // Live refresh for any admin session sitting on the Rx Approvals tab.
    if (io) {
      io.to(roleRoomFor('admin')).emit('prescription:paid', {
        prescriptionId: doc._id.toString(),
        paidAt: doc.paid_at,
      });
    }
  } catch (e) {
    console.warn(
      '[notifications] admin prescription-paid fan-out skipped:',
      e.message,
    );
  }
}

module.exports = {
  releaseStateFor,
  isUnlockedFor,
  presentPrescription,
  notifyAdminsPrescriptionPaid,
};
