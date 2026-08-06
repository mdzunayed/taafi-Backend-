const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const CareRequest = require('../models/CareRequest');
const Account = require('../models/Account');
const Service = require('../models/Service');
const {
  normalizeProviderType,
  inferProviderType,
} = require('../utils/providerTypes');
const { attachDoctorToRequest } = require('../utils/doctorView');
const {
  releasePrescriptionsForSettledBooking,
  pendingVerificationPatch,
} = require('../utils/bookingFlow');
// Balance posture + its real-time fan-out. Every write below that can change
// "does the provider still have to collect cash?" ends in an
// `emitBookingPaymentUpdated`, which is what keeps the clinical console's
// payment card in step with the patient's choices.
const {
  outstandingBalanceFor,
  balanceSettlementModeFor,
  BALANCE_PREPAY_STATUSES,
} = require('../utils/paymentPosture');
const {
  assignedProviderRooms,
  emitBookingPaymentUpdated,
} = require('../utils/paymentBroadcast');
const {
  safeEmitNotification,
  userRoomFor,
} = require('../services/notificationService');
// Push dispatch is offloaded to the BullMQ background queue (identical
// signature to the old fcmService call, so nothing else changes). Falls
// back to inline send when Redis is disabled.
const { enqueuePush: sendHighPriorityPush } = require('../queues/notificationQueue');
const { requireAccountId, attachAccountId } = require('../middleware/auth');
const { documentUpload, storeDocument } = require('../middleware/upload');
const { uploadErrorHandler } = require('../middleware/uploadErrors');
// Turns a stored upload value (Cloudinary URL or bare disk filename) into an
// absolute URL the app can open.
const { toAbsolute } = require('../utils/publicUrl');
// Origin allow-list for stored attachment URLs — see pickDocuments below.
const { isStorableDocumentUrl } = require('../utils/bookingAttachments');
const paymentService = require('../services/paymentService');
// Commission split + wallet ledger. The ONLY writer of provider balances.
const walletService = require('../services/walletService');
// Resolves the deposit for a booking. Never hardcode the amount here — the
// per-booking value is set by an admin on the review call and stamped.
const {
  resolveRequiredDeposit,
  hasRequiredDeposit,
} = require('../services/pricingService');

const router = express.Router();

// Base URL used to build gateway success/fail/cancel/IPN callbacks.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:5000';

// Fan out an in-app + push notification to every admin that a new booking is
// awaiting the care-management review CALL. This is the Phase-1 → Phase-2
// handoff: nothing has been charged, so what the admin owes the patient is a
// phone call and the two numbers that come out of it. Best-effort: a
// notification failure must never tank the booking that triggered it.
async function notifyAdminsBookingReady(io, doc) {
  try {
    const admins = await Account.find({ role: 'admin' }, '_id').lean();
    const title = 'New booking — call & set deposit';
    const body =
      `${doc.patient_name} requested ${doc.care_type}` +
      (doc.location_text ? ` in ${doc.location_text}` : '') +
      '. Call to assess the case, then set the service fee and deposit.';
    const payload = {
      requestId: doc._id.toString(),
      patientName: doc.patient_name,
      careType: doc.care_type,
      deepLink: `/admin/booking-review/${doc._id.toString()}`,
    };
    await Promise.all(
      admins.map((a) =>
        safeEmitNotification(io, {
          recipientId: a._id,
          senderId: doc.patient_account_id || null,
          title,
          body,
          type: 'system_broadcast',
          payload,
        }),
      ),
    );
  } catch (e) {
    // Notification fan-out is best-effort — log and move on.
    console.warn('[notifications] admin booking-ready fan-out skipped:', e.message);
  }
}

// Fan out to every admin that a booking's deposit has CLEARED. Distinct from
// `notifyAdminsBookingReady` above, which asks for the review call: this one
// says the money is in and the booking is ready for deposit verification and
// team assignment (Phase 3). Best-effort, same rationale.
async function notifyAdminsDepositCleared(io, doc) {
  try {
    const admins = await Account.find({ role: 'admin' }, '_id').lean();
    const title = 'Deposit received — assign the care team';
    const body =
      // The amount actually settled on this row, never the currently
      // configured default — an admin retuning it must not rewrite history.
      `${doc.patient_name} paid the ৳${doc.deposit_amount} deposit for ` +
      `${doc.care_type}` +
      (doc.location_text ? ` in ${doc.location_text}` : '') +
      '. Verify and dispatch a provider.';
    const payload = {
      requestId: doc._id.toString(),
      patientName: doc.patient_name,
      careType: doc.care_type,
      deepLink: `/admin/booking-review/${doc._id.toString()}`,
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
  } catch (e) {
    console.warn(
      '[notifications] admin deposit-cleared fan-out skipped:',
      e.message,
    );
  }
}

// Fields the patient profile screen is allowed to mutate. Anything else in
// the PATCH body (role, status, password_hash, etc.) is dropped before we
// hit Mongoose so a malicious or buggy client can't escalate privileges.
const PATIENT_EDITABLE_FIELDS = ['full_name', 'email', 'phone'];

function pickPatientFields(body) {
  const out = {};
  for (const k of PATIENT_EDITABLE_FIELDS) {
    if (body[k] !== undefined && body[k] !== null) {
      out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    }
  }
  return out;
}

const TERMINAL = ['completed', 'cancelled', 'rejected'];

// One-active-booking rule. A patient may hold exactly one non-terminal
// CareRequest at a time; the next one is only creatable once the current
// booking reaches `completed` / `cancelled` / `rejected`.
//
// "Active" is defined as `status NOT IN TERMINAL` — the same predicate
// `GET /requests/active` and `GET /home` use to pick the booking the app
// renders in its Ongoing-care card. Keeping the two in lockstep is what
// makes the client guard honest: anything the patient can SEE as ongoing
// is exactly what blocks a new request here. That deliberately includes the
// pre-payment states (`submitted`, `deposit_required`) — those still occupy
// the tracker, so letting them stack would reintroduce the duplicate bookings
// this guard exists to prevent. The escape hatch is
// `POST /requests/:id/cancel`, which accepts every pre-dispatch state
// precisely so an abandoned booking can't lock a patient out permanently.
const ACTIVE_BOOKING_MESSAGE =
  'You currently have an active booking in progress. Please wait until your ' +
  'current session is completed or cancelled before requesting a new service.';

async function findActiveBooking(accountId) {
  if (!accountId) return null;
  return CareRequest.findOne({
    patient_account_id: String(accountId),
    status: { $nin: TERMINAL },
  }).sort({ created_at: -1 });
}

// Derive a coarse area from free-text location ("House 42, Dhanmondi" -> "Dhanmondi").
function areaFromLocation(location) {
  if (!location) return '';
  const parts = String(location).split(',');
  return parts[parts.length - 1].trim();
}

// Coerce an incoming coordinate to a finite Number, or null. Guards against
// an explicit `null` / '' becoming a bogus 0,0 (Gulf-of-Guinea) fix.
function coordOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalise the optional care-recipient (dependent) block on a booking.
// Returns null for a self-booking; otherwise a clean snapshot the provider
// surfaces. A missing name collapses the whole block to null.
function pickCareRecipient(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = (raw.name ?? '').toString().trim();
  if (!name) return null;
  const str = (v) => {
    const s = (v ?? '').toString().trim();
    return s || null;
  };
  const list = (v) =>
    Array.isArray(v)
      ? v.map((x) => (x ?? '').toString().trim()).filter(Boolean)
      : [];
  return {
    dependent_id: str(raw.dependent_id),
    name,
    relationship: str(raw.relationship),
    gender: str(raw.gender),
    date_of_birth: str(raw.date_of_birth),
    blood_group: str(raw.blood_group),
    medical_conditions: list(raw.medical_conditions),
    medical_notes: str(raw.medical_notes),
  };
}

// Rails the ৳100 confirmation deposit may be paid on. Deliberately excludes
// cash: the deposit is what unlocks admin review, so it has to clear online
// before anyone is dispatched. Cash is a choice for the REMAINING balance
// only (see PATCH /requests/:id/payment-preference).
const DEPOSIT_CHANNELS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CARD'];
function pickPaymentChannel(raw) {
  const v = (raw ?? '').toString().trim().toUpperCase();
  return DEPOSIT_CHANNELS.includes(v) ? v : null;
}

// Normalise the attached medical documents carried in on a booking. Each
// entry must already have been uploaded through POST /patient/documents —
// this only validates the returned descriptors, so a client cannot inject an
// arbitrary URL as an "attachment" beyond what it could already display to
// itself. Capped so a malformed client can't write an unbounded array.
const MAX_DOCUMENTS = 10;
function pickDocuments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = (item.url ?? '').toString().trim();
    if (!url) continue;
    // Origin allow-list — the admin console reads these back through a
    // server-side fetch (GET /admin/documents/:token), so an unconstrained
    // URL here would be a stored SSRF: a client could point an "attachment"
    // at an internal address and have the admin API read it back out. Only
    // locations `storeDocument` actually produces are storable.
    if (!isStorableDocumentUrl(url)) continue;
    const size = Number(item.size);
    out.push({
      name: (item.name ?? '').toString().trim() || 'Document',
      url,
      mime: (item.mime ?? '').toString().trim(),
      size: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
      uploaded_at: new Date(),
    });
    if (out.length >= MAX_DOCUMENTS) break;
  }
  return out;
}

// Resolve WHO will attend this booking, at creation time.
//
// The booked catalog row is the authority — that is where the admin tags a
// service as doctor / nurse / physiotherapist / lab-tech work. When the
// client didn't send a `service_id` (or the row is untagged) we fall back to
// reading the service title and the free-text `care_type`, and finally to
// null, which lets the tracker's own resolver decide rather than freezing a
// guess onto the booking. Never throws: a lookup failure must not block a
// booking, it only costs the tracker its role-specific wording.
async function resolveBookingProviderType({ serviceId, careType }) {
  let service = null;
  if (serviceId && mongoose.isValidObjectId(serviceId)) {
    try {
      service = await Service.findById(serviceId).lean();
    } catch (_) {
      /* best-effort: an unreachable catalog must not fail the booking */
    }
  }
  return (
    normalizeProviderType(service && service.provider_type) ||
    inferProviderType(service && service.title, service && service.category) ||
    inferProviderType(careType)
  );
}

// POST /patient/documents (multipart, field `file`) — upload one previous
// medical document (PDF or image) and return its descriptor:
//   { name, url, mime, size }
//
// Deliberately NOT scoped to a booking id: the patient attaches documents on
// the service step, before the booking exists (it is only created once they
// confirm at checkout). The descriptors ride along in the create payload's
// `documents` array. An abandoned checkout therefore leaves an orphaned
// upload — cheap, and the alternative (creating the booking early just to
// own the file) would put unpaid rows in front of admins, which the
// two-phase deposit design exists to prevent.
router.post(
  '/documents',
  requireAccountId,
  documentUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ message: 'No file was uploaded.' });
      }
      const original = String(req.file.originalname || 'document');
      const ext = (original.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      // Namespaced per account so one patient's upload can never overwrite
      // another's, and timestamped so re-uploading the same filename doesn't
      // clobber the copy already attached to an earlier booking.
      //
      // The random suffix is the security half: `<account>-<ms>` is a
      // guessable object name, and a Cloudinary asset is readable by anyone
      // holding its URL. 96 bits of entropy makes the storage location
      // unenumerable even for someone who knows the account id — the
      // presigned grant (utils/documentAccess.js) is the access control, this
      // just removes the way around it.
      const suffix = crypto.randomBytes(12).toString('hex');
      const publicId = `patient-docs/${req.accountId}-${Date.now()}-${suffix}`;
      const stored = await storeDocument(req.file.buffer, publicId, {
        mime: req.file.mimetype,
        ext,
      });
      // Cloudinary hands back a full https URL; the disk fallback hands back a
      // bare filename served off the /uploads mount. `toAbsolute` normalises
      // both, so the client always persists something it can actually open.
      const document = {
        id: publicId,
        name: original,
        url: toAbsolute(stored),
        mime: req.file.mimetype || '',
        size: req.file.size || 0,
      };
      // Flat descriptor (what the Flutter client parses) plus the spec's
      // `{ success, document }` envelope, so either shape works for callers.
      res.status(201).json({ success: true, document, ...document });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  // Multer rejects (wrong type, over 8 MB) never reach the handler above —
  // this turns them into a 415/413 instead of the generic 500.
  uploadErrorHandler,
);

// POST /patient/requests — create a care request. Returns 201 + the row,
// or 409 when the caller already holds an active booking (see the
// one-active-booking rule above).
router.post('/requests', attachAccountId, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.patient_name || !String(b.patient_name).trim()) {
      return res.status(400).json({ message: 'patient_name is required' });
    }
    if (!b.care_type || !String(b.care_type).trim()) {
      return res.status(400).json({ message: 'care_type is required' });
    }

    // Prefer the verified identity from the bearer token over the body's
    // `patient_account_id`, which is client-controlled and could otherwise
    // be swapped to a stranger's id to sidestep the duplicate-booking
    // check. The body value is only a fallback for the legacy unauthenticated
    // callers this route has always accepted.
    const accountId = req.accountId || b.patient_account_id || '';

    // One active booking per patient. Skipped when we can't attribute the
    // request to an account at all — there is nothing to scope the lookup to,
    // and an unscoped query would block every patient off one stranger's
    // in-flight booking.
    const existing = await findActiveBooking(accountId);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: ACTIVE_BOOKING_MESSAGE,
        active_request_id: existing.id,
        active_request_status: existing.status,
      });
    }

    const serviceId = b.service_id || b.serviceId || null;
    const paymentChannel = pickPaymentChannel(b.payment_channel);
    const providerType =
      normalizeProviderType(b.provider_type || b.providerType) ||
      (await resolveBookingProviderType({
        serviceId,
        careType: b.care_type,
      }));

    const doc = await CareRequest.create({
      patient_name: String(b.patient_name).trim(),
      patient_account_id: accountId,
      patient_phone: b.patient_phone || '',
      care_type: String(b.care_type).trim(),
      // The catalog row this booking came from, and who it says attends —
      // both drive the patient tracker's role-aware wording. Null when the
      // booking was created outside the catalog flow.
      service_id: serviceId ? String(serviceId) : null,
      provider_type: providerType,
      offered_budget: Number(b.offered_budget) || 0,
      // PHASE 1 — ZERO-COST SUBMISSION.
      //
      // Nothing is charged here and NO deposit is stamped: `required_deposit`
      // and `deposit_quoted_amount` both stay null, so the row projects
      // `deposit_status: 'NOT_REQUIRED'` and ৳0 due. Quoting a deposit at
      // creation is precisely what this flow removes — the amount depends on
      // the case, and the case has not been reviewed yet.
      //
      // `payment_channel` is the rail the patient picked at checkout, kept so
      // the Phase-3 deposit sheet can preselect it. It authorises nothing.
      // `payment_preference` (how the REMAINING balance gets settled) is
      // deliberately left null — the patient chooses cash or online once they
      // know the amount.
      payment_channel: paymentChannel,
      // Previous medical documents attached on the service step.
      documents: pickDocuments(b.documents),
      preferred_time: b.preferred_time || null,
      duration_hours: Number(b.duration_hours) || 1,
      condition_note: b.condition_note || '',
      location_text: b.location_text || '',
      area: b.area || areaFromLocation(b.location_text),
      latitude: coordOrNull(b.latitude),
      longitude: coordOrNull(b.longitude),
      care_recipient: pickCareRecipient(b.care_recipient),
      promo_code: b.promo_code ? String(b.promo_code).trim() || null : null,
      // The booking is live IMMEDIATELY. There is no payment gate in front of
      // the triage queue any more: the admin has to see the case before they
      // can price it, so gating visibility on a payment would deadlock the
      // flow it is supposed to start.
      status: 'submitted',
      urgency_level: b.urgency_level || (b.preferred_time ? 'medium' : 'high'),
    });

    // Hand it to the admins now — this is the event that starts the review
    // call. Best-effort inside the helper; a notification failure must never
    // fail a booking the patient has already committed to.
    await notifyAdminsBookingReady(req.app.get('io'), doc);

    res.status(201).json(doc.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/cancel  { reason? }
//
// Patient-initiated cancellation from the "Under Review" queue. Only allowed
// BEFORE a field coordinator claims the dispatch — once it's `assigned` (or
// further), the patient can no longer pull it back unilaterally. Implemented
// as an atomic compare-and-swap guarded on the pre-assignment states so a
// cancel racing an admin assignment can't strand the request in a bad state.
//
// The pre-payment states are cancellable for a reason: the one-active-booking
// rule on POST /requests counts them as active, so without this a patient who
// placed a free request and then decided against the quoted deposit would be
// locked out of booking anything, forever, with no self-serve way out.
// Nothing is at stake in those states — no money has moved — so letting the
// patient drop them is free. `deposit_required` is the important addition:
// declining the admin's quote is a legitimate outcome of the review call, and
// it must not need a support ticket. States where the deposit HAS cleared stay
// non-cancellable here; those involve a refund decision and are the admin's
// call.
const PATIENT_CANCELLABLE = [
  'awaiting_deposit',
  'submitted',
  'deposit_required',
  'approved',
];

router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid request id' });
    }
    const reason =
      typeof (req.body && req.body.reason) === 'string'
        ? req.body.reason.trim()
        : '';

    const cancelled = await CareRequest.findOneAndUpdate(
      { _id: id, status: { $in: PATIENT_CANCELLABLE } },
      {
        $set: {
          status: 'cancelled',
          admin_note: reason
            ? `Cancelled by patient: ${reason}`
            : 'Cancelled by patient',
        },
      },
      { new: true },
    );

    if (!cancelled) {
      // Distinguish "gone" from "too late to cancel" so the UI can explain.
      const exists = await CareRequest.exists({ _id: id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? 'This request can no longer be cancelled — a coordinator has already started working on it.'
          : 'Request not found',
      });
    }

    res.json(cancelled.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Two-phase confirmation payments (SSLCommerz, with simulated fallback).
// ---------------------------------------------------------------------------

// Ownership guard shared by every payment endpoint. Loads the request and
// rejects if the caller is not the booking patient. A request with a blank
// `patient_account_id` (legacy/anonymous) is treated as caller-owned so the
// flow still works in dev/seed data.
// Roles permitted to act on a booking they don't own (staff testing /
// operating a patient's checkout). NOTE: this intentionally lets admins and
// support members initiate/settle payments against ANY patient's booking in
// all environments — a deliberate access-control trade-off requested by the
// product owner. Every such cross-account access is logged below.
const STAFF_ROLES = new Set(['admin', 'support_member']);

// Resolve the caller's role. `attachAccountId` populates `req.accountRole`
// from the bearer token; fall back to a live DB lookup for header/query
// callers so a freshly-demoted account can't slip through on a stale token.
async function callerRole(req) {
  if (req.accountRole) return req.accountRole;
  if (!req.accountId) return null;
  const acct = await Account.findById(req.accountId, 'role');
  return acct ? acct.role : null;
}

async function loadOwnedRequest(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: 'Invalid request id' });
    return null;
  }
  const doc = await CareRequest.findById(id);
  if (!doc) {
    res.status(404).json({ message: 'Request not found' });
    return null;
  }
  const isForeign =
    doc.patient_account_id &&
    req.accountId &&
    doc.patient_account_id.toString() !== req.accountId.toString();
  if (isForeign) {
    const role = await callerRole(req);
    if (!STAFF_ROLES.has(role)) {
      res.status(403).json({ message: 'Not your booking' });
      return null;
    }
    // Staff override — audit the cross-account access.
    console.warn(
      `[audit] staff cross-account booking access: role=${role} ` +
        `account=${req.accountId} booking=${doc._id} ` +
        `owner=${doc.patient_account_id} ${req.method} ${req.originalUrl}`,
    );
  }
  return doc;
}

// Build the SSLCommerz customer block from a request row.
function customerFromRequest(doc) {
  return {
    name: doc.patient_name,
    phone: doc.patient_phone || undefined,
    address: doc.location_text || undefined,
  };
}

// Statuses from which a deposit payment may land: the Phase-2 state the admin
// puts the booking in, plus the retired Phase-1 state for rows created before
// the zero-cost flow shipped (they were quoted a deposit and must stay
// payable). Anything else is either already paid or was never priced.
const DEPOSIT_PAYABLE_STATUSES = ['deposit_required', 'awaiting_deposit'];

// Atomically settle the admin-set deposit: deposit_required -> deposit paid.
// Idempotent — a duplicate IPN/confirm after the CAS window returns the
// already-settled row rather than double-firing notifications.
//
// `amount` is the figure the gateway session was opened with and validated
// against, so `deposit_amount` records what was ACTUALLY paid. Two concurrent
// settlements cannot disagree about it: it derives from the immutable
// `deposit_quoted_amount`, and the CAS on `status` still admits only one.
async function applyDepositSettlement(io, id, tranId, amount) {
  const settled = await CareRequest.findOneAndUpdate(
    { _id: id, status: { $in: DEPOSIT_PAYABLE_STATUSES } },
    {
      $set: {
        status: 'deposit_paid_admin_reviewing',
        deposit_amount: amount,
        deposit_transaction_id: tranId,
        deposit_paid_at: new Date(),
        // A settled deposit erases any earlier decline — otherwise the
        // patient app would keep reporting FAILED on a paid booking.
        deposit_failed_at: null,
        deposit_failure_reason: null,
      },
    },
    { new: true },
  );
  if (settled) {
    await notifyAdminsDepositCleared(io, settled);
  }
  return settled;
}

// Record a declined deposit attempt so `deposit_status` can report FAILED.
// Only ever stamped while the booking is still awaiting the deposit — a
// late/duplicate failure callback must not mark a settled booking failed.
// Best-effort: the caller is already returning an error to the payer.
async function recordDepositFailure(id, reason) {
  try {
    await CareRequest.updateOne(
      { _id: id, status: { $in: DEPOSIT_PAYABLE_STATUSES } },
      {
        $set: {
          deposit_failed_at: new Date(),
          deposit_failure_reason: (reason || 'Payment could not be verified.')
            .toString()
            .slice(0, 300),
        },
      },
    );
  } catch (_) {
    /* the failure stamp is informational — never fail the response on it */
  }
}

// Atomically settle the outstanding balance. Three CAS attempts with
// divergent targets:
//   1. New flow: service already delivered → the booking closes
//      (`completed`) and the visit's prescriptions become PAID,
//      entering the admin release queue.
//   2. Legacy pay-before-service flow: payment advances the booking
//      into the dispatch queue (`approved`).
//   3. Pre-payment: the admin priced the booking and the patient chose to
//      clear the balance before the visit. Money only — see below.
// Idempotent — a duplicate IPN/confirm matches no status and returns null
// without double-firing side effects.
async function applyBalanceSettlement(io, id, tranId) {
  const now = new Date();
  const completed = await CareRequest.findOneAndUpdate(
    { _id: id, status: 'service_completed_awaiting_final_payment' },
    {
      $set: {
        status: 'completed',
        payment_method: 'DIGITAL',
        final_transaction_id: tranId,
        final_paid_at: now,
        'payment.released_at': now,
        // CHANNEL B of the dual prescription gate. The money has arrived, but
        // nobody has RECONCILED it yet — so the booking parks here with the
        // transaction reference and the script stays locked until an admin
        // verifies receipt in Finance & Billing
        // (POST /api/admin/bookings/:id/verify-payment).
        //
        // The asymmetry with cash is deliberate: a clinician confirming cash
        // is holding the notes, whereas an online settlement is a gateway
        // callback that ops still reconcile against the payment provider.
        ...pendingVerificationPatch(tranId),
      },
    },
    { new: true },
  );
  if (completed) {
    await releasePrescriptionsForSettledBooking(io, completed, tranId);
    // The patient paid in full digitally, so the platform is holding all the
    // money: credit each earning provider their post-commission net share.
    // Idempotent at the ledger level — a duplicate IPN that somehow got past
    // the CAS above still cannot credit twice.
    await walletService.creditVisitEarnings(io, completed, {
      method: 'DIGITAL',
    });
    // Any screen sitting on the appointment room (admin live console,
    // provider views) sees the booking close without a refetch.
    if (io) {
      io.to(completed._id.toString()).emit('appointment_status_change', {
        appointmentId: completed._id.toString(),
        status: 'completed',
        dbStatus: 'completed',
        timestamp: new Date().toISOString(),
      });
    }
    // Balance is PAID online: tell the assigned doctor/nurse directly, in
    // their own user room. Without this the console only learns of the
    // settlement if it happens to be joined to the appointment room, and a
    // Collect Cash sheet opened moments earlier stays on screen until the
    // provider taps Confirm and eats a 409.
    await emitBookingPaymentUpdated(io, completed, {
      reason: 'online_settlement',
    });
    return completed;
  }
  const approved = await CareRequest.findOneAndUpdate(
    { _id: id, status: 'amount_assigned_awaiting_final_payment' },
    {
      $set: {
        status: 'approved',
        payment_method: 'DIGITAL',
        final_transaction_id: tranId,
        final_paid_at: now,
        'payment.released_at': now,
      },
    },
    { new: true },
  );
  if (approved) {
    await emitBookingPaymentUpdated(io, approved, {
      reason: 'online_settlement',
    });
  }
  if (approved) return approved;

  // 3. Pre-payment, while the visit is still ahead of us.
  //
  // This branch stamps MONEY ONLY. It deliberately does not touch `status`,
  // release prescriptions, or credit provider wallets:
  //   • the lifecycle belongs to dispatch and service delivery — a paid
  //     booking still has to be assigned, travelled to and performed;
  //   • there is no prescription yet, and the one the doctor writes later
  //     is released by the finalize path, which reads the same settlement
  //     stamps this sets;
  //   • crediting earnings here would pay a provider for an undelivered
  //     visit. Completion credits them (routes/appointments.js and the
  //     prescription finalize), which is where the work actually lands.
  //
  // What it DOES do is exactly what the spec's State C needs: the settlement
  // stamps flip `paymentPostureFor` to PAID / `cashCollectable: false`, so
  // every provider console drops its Collect Cash sheet the moment this
  // commits, and the patient's ledger turns green.
  const prepaid = await CareRequest.findOneAndUpdate(
    {
      _id: id,
      status: { $in: BALANCE_PREPAY_STATUSES },
      final_price: { $gt: 0 },
      // Re-assert unsettled inside the CAS so two concurrent confirms (or a
      // confirm racing its own IPN) cannot both win and double-charge.
      final_paid_at: null,
      final_transaction_id: null,
    },
    {
      $set: {
        payment_method: 'DIGITAL',
        final_transaction_id: tranId,
        final_paid_at: now,
      },
    },
    { new: true },
  );
  if (prepaid) {
    await emitBookingPaymentUpdated(io, prepaid, {
      reason: 'online_settlement',
    });
  }
  return prepaid;
}

// Outstanding balance for a priced request. Never negative. Thin alias over
// the shared derivation so this file cannot drift from the invoice
// projection or the provider console.
const outstandingFor = outstandingBalanceFor;

// POST /patient/requests/:id/deposit/init — open the gateway session for the
// deposit an admin set on this booking (Phase 3).
router.post('/requests/:id/deposit/init', requireAccountId, async (req, res) => {
  try {
    const doc = await loadOwnedRequest(req, res);
    if (!doc) return;
    if (!DEPOSIT_PAYABLE_STATUSES.includes(doc.status)) {
      return res.status(409).json({
        message: 'This booking is not awaiting a confirmation deposit.',
      });
    }
    // A deposit can only be charged once an admin has COMMITTED one. Without
    // this guard `resolveRequiredDeposit` would fall through to the platform
    // default and bill a patient an amount nobody set for their case — the
    // exact charge the zero-cost flow exists to eliminate.
    if (!hasRequiredDeposit(doc)) {
      return res.status(409).json({
        message:
          'No deposit has been set for this booking yet. Our care team will ' +
          'call you to review your case and confirm the amount.',
      });
    }
    // What the admin set for THIS booking, snapshotted at commit time.
    const quoted = await resolveRequiredDeposit(doc);
    // Backfill the immutable quote for legacy rows so confirm/ipn validate
    // against the SAME number this session was opened with, even if an admin
    // corrects the fee in between. Guarded so a concurrent init can never move
    // an existing quote — the amount is immutable once set.
    await CareRequest.updateOne(
      {
        _id: doc._id,
        status: { $in: DEPOSIT_PAYABLE_STATUSES },
        $or: [
          { deposit_quoted_amount: null },
          { deposit_quoted_amount: { $lte: 0 } },
        ],
      },
      { $set: { deposit_quoted_amount: quoted } },
    );
    const tranId = paymentService.makeTranId('DEP');
    const base = `${PUBLIC_BASE_URL}/patient/requests/${doc._id}/deposit`;
    const session = await paymentService.initSession({
      amount: quoted,
      tranId,
      productName: `Booking confirmation deposit — ${doc.care_type}`,
      customer: customerFromRequest(doc),
      successUrl: `${base}/return?result=success`,
      failUrl: `${base}/return?result=fail`,
      cancelUrl: `${base}/return?result=cancel`,
      ipnUrl: `${base}/ipn`,
    });
    res.json({
      amount: quoted,
      tranId: session.tranId,
      simulated: session.simulated === true,
      gatewayUrl: session.gatewayUrl || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/deposit/confirm — settle after gateway return
// (or immediately, in simulated mode). Body: { tranId, valId? }.
router.post('/requests/:id/deposit/confirm', requireAccountId, async (req, res) => {
  try {
    const doc = await loadOwnedRequest(req, res);
    if (!doc) return;
    const b = req.body || {};
    const tranId = b.tranId || paymentService.makeTranId('DEP');
    // Same guard as init: no admin-set deposit, no charge. A confirm arriving
    // for a booking that was never priced can only be a stale client or a
    // forged call, and settling it would bill an amount nobody committed to.
    if (!hasRequiredDeposit(doc)) {
      return res.status(409).json({
        message: 'No deposit has been set for this booking yet.',
      });
    }
    // Validate against what THIS booking was quoted. Using the live configured
    // amount here would reject a perfectly good payment whenever an admin
    // corrected the fee between init and confirm.
    const expected = await resolveRequiredDeposit(doc);
    const valid = await paymentService.validate({
      valId: b.valId,
      expectedAmount: expected,
    });
    if (!valid) {
      await recordDepositFailure(doc._id, 'Deposit payment could not be verified.');
      return res.status(402).json({ message: 'Deposit payment could not be verified.' });
    }
    const settled = await applyDepositSettlement(
      req.app.get('io'),
      doc._id,
      tranId,
      expected,
    );
    if (!settled) {
      // Either already settled (idempotent) or no longer awaiting deposit.
      const fresh = await CareRequest.findById(doc._id);
      if (fresh && !DEPOSIT_PAYABLE_STATUSES.includes(fresh.status)) {
        return res.json(fresh.toJSON());
      }
      return res.status(409).json({ message: 'Deposit could not be applied.' });
    }
    res.json(settled.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/deposit/ipn — SSLCommerz server-to-server IPN.
// Public (the gateway posts here); the val_id is validated before we trust it.
router.post('/requests/:id/deposit/ipn', async (req, res) => {
  try {
    const b = req.body || {};
    // Unlike confirm, this route has no owned-request load — but it still needs
    // the row to know what amount to validate against, since the expected
    // figure is per-booking now rather than a constant.
    const doc = await CareRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Booking not found.' });
    // No committed deposit means there is nothing this IPN can legitimately be
    // settling — refuse rather than fall back to the platform default.
    if (!hasRequiredDeposit(doc)) {
      return res.status(400).json({ message: 'Invalid IPN' });
    }
    const expected = await resolveRequiredDeposit(doc);
    const valid = await paymentService.validate({
      valId: b.val_id,
      expectedAmount: expected,
    });
    if (!valid) {
      await recordDepositFailure(req.params.id, b.failedreason || 'Gateway reported a failed deposit.');
      return res.status(400).json({ message: 'Invalid IPN' });
    }
    await applyDepositSettlement(
      req.app.get('io'),
      req.params.id,
      b.tran_id || b.val_id,
      expected,
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/balance/init — open a gateway session for the
// outstanding balance (final fee − deposit − discount).
router.post('/requests/:id/balance/init', requireAccountId, async (req, res) => {
  try {
    const doc = await loadOwnedRequest(req, res);
    if (!doc) return;
    // Payable either because the visit is done (closing) or because the
    // patient chose to clear the priced balance ahead of the visit (prepay).
    if (!balanceSettlementModeFor(doc)) {
      return res.status(409).json({
        message: 'This booking has no outstanding balance to pay.',
      });
    }
    const amount = outstandingFor(doc);
    const tranId = paymentService.makeTranId('BAL');
    if (amount <= 0) {
      // Fully covered by the deposit/discount — settle straight through.
      const settled = await applyBalanceSettlement(req.app.get('io'), doc._id, tranId);
      return res.json({
        amount: 0,
        tranId,
        simulated: true,
        gatewayUrl: null,
        settled: !!settled,
      });
    }
    const base = `${PUBLIC_BASE_URL}/patient/requests/${doc._id}/balance`;
    const session = await paymentService.initSession({
      amount,
      tranId,
      productName: `Balance payment — ${doc.care_type}`,
      customer: customerFromRequest(doc),
      successUrl: `${base}/return?result=success`,
      failUrl: `${base}/return?result=fail`,
      cancelUrl: `${base}/return?result=cancel`,
      ipnUrl: `${base}/ipn`,
    });
    res.json({
      amount,
      tranId: session.tranId,
      simulated: session.simulated === true,
      gatewayUrl: session.gatewayUrl || null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/balance/confirm — settle the balance. Body:
// { tranId, valId? }. Advances the request into the dispatch queue.
router.post('/requests/:id/balance/confirm', requireAccountId, async (req, res) => {
  try {
    const doc = await loadOwnedRequest(req, res);
    if (!doc) return;
    const b = req.body || {};
    const tranId = b.tranId || paymentService.makeTranId('BAL');
    const valid = await paymentService.validate({
      valId: b.valId,
      expectedAmount: outstandingFor(doc),
    });
    if (!valid) {
      return res.status(402).json({ message: 'Balance payment could not be verified.' });
    }
    const settled = await applyBalanceSettlement(req.app.get('io'), doc._id, tranId);
    if (!settled) {
      // Already settled elsewhere (idempotent success) unless the
      // booking is somehow still sitting in a payable state.
      const fresh = await CareRequest.findById(doc._id);
      if (fresh && !balanceSettlementModeFor(fresh)) {
        return res.json(fresh.toJSON());
      }
      return res.status(409).json({ message: 'Balance could not be applied.' });
    }
    res.json(settled.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/balance/ipn — SSLCommerz server-to-server IPN.
router.post('/requests/:id/balance/ipn', async (req, res) => {
  try {
    const b = req.body || {};
    const doc = await CareRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Request not found' });
    const valid = await paymentService.validate({
      valId: b.val_id,
      expectedAmount: outstandingFor(doc),
    });
    if (!valid) return res.status(400).json({ message: 'Invalid IPN' });
    await applyBalanceSettlement(req.app.get('io'), doc._id, b.tran_id || b.val_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Statuses in which the patient may still choose HOW they'll pay the
// outstanding balance: the booking is priced and live, but the balance has
// not yet been settled. Once the visit is `completed` (or terminal) the
// choice is moot. Deposit-review is included so the choice can be made as
// soon as the admin prices the booking, before dispatch.
const PREFERENCE_SELECTABLE_STATUSES = new Set([
  'deposit_paid_admin_reviewing',
  'submitted',
  'approved',
  'assigned',
  'enroute',
  'arrived',
  'in_service',
  'nurse_completed',
  'service_completed_awaiting_final_payment',
  'amount_assigned_awaiting_final_payment',
]);

// PATCH /patient/requests/:id/payment-preference — the patient pre-commits
// to how they'll settle the balance. Body: { preference: 'CASH_ON_SERVICE'
// | 'DIGITAL' }. This does NOT move money or change booking status; it only
// records intent so the provider's collect-cash step becomes mandatory
// (CASH_ON_SERVICE) or stays optional (DIGITAL). The actual settlement still
// runs through the digital gateway or the collect-cash endpoint.
router.patch(
  '/requests/:id/payment-preference',
  requireAccountId,
  async (req, res) => {
    try {
      const doc = await loadOwnedRequest(req, res);
      if (!doc) return;
      const preference = (req.body || {}).preference;
      if (preference !== 'CASH_ON_SERVICE' && preference !== 'DIGITAL') {
        return res.status(400).json({
          message: "preference must be 'CASH_ON_SERVICE' or 'DIGITAL'.",
        });
      }
      if (doc.final_paid_at || doc.final_transaction_id) {
        return res.status(409).json({
          message: 'This booking is already settled.',
        });
      }
      if (!PREFERENCE_SELECTABLE_STATUSES.has(doc.status)) {
        return res.status(409).json({
          message: 'A payment method cannot be chosen for this booking yet.',
        });
      }
      if (!(Number(doc.final_price) > 0)) {
        return res.status(409).json({
          message: 'This booking has not been priced yet.',
        });
      }

      doc.payment_preference = preference;
      await doc.save();

      const io = req.app.get('io');
      if (io) {
        const payload = {
          appointmentId: doc._id.toString(),
          preference,
          outstanding: outstandingFor(doc),
          timestamp: new Date().toISOString(),
        };
        // The patient's other devices + anyone on the appointment room
        // (admin live console) + the assigned provider(s) so their job
        // card can flip its "cash on service" badge before completion.
        try {
          io.to(userRoomFor(doc.patient_account_id)).emit(
            'payment_preference_updated',
            payload,
          );
          io.to(doc._id.toString()).emit('payment_preference_updated', payload);
          const rooms = await assignedProviderRooms(doc);
          for (const room of rooms) {
            io.to(room).emit('payment_preference_updated', payload);
          }
        } catch (_) {
          /* live fan-out is best-effort */
        }
        // Canonical posture event. `payment_preference_updated` above stays
        // for the surfaces already listening to it (provider job card badge);
        // THIS is the one the clinical console gates its Collect Cash sheet
        // on, so a switch to Online tears the sheet down mid-visit.
        await emitBookingPaymentUpdated(io, doc, { reason: 'preference' });
      }

      const body = await attachDoctorToRequest(doc.toJSON());
      res.json(body);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

// GET /patient/requests/active  — the caller's newest non-terminal request.
//
// Scoped strictly to the authenticated account. `attachAccountId` resolves
// identity from the bearer token (canonical), falling back to the
// `x-account-id` header / `account_id` query for legacy callers. We must
// NEVER run an unscoped query: with no `patient_account_id` filter,
// `findOne` returns the newest active booking of ANY patient, leaking a
// stranger's request into this feed (and then the payment ownership guard
// correctly rejects it with "Not your booking").
router.get('/requests/active', attachAccountId, async (req, res) => {
  try {
    if (!req.accountId) {
      return res.status(404).json({ message: 'No active request' });
    }
    const doc = await CareRequest.findOne({
      status: { $nin: TERMINAL },
      patient_account_id: req.accountId,
    }).sort({ created_at: -1 });
    if (!doc) return res.status(404).json({ message: 'No active request' });
    const body = await attachDoctorToRequest(doc.toJSON());
    res.json(body);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/home  — minimal home-feed shape, scoped to the caller.
router.get('/home', attachAccountId, async (req, res) => {
  try {
    // Same rule as /requests/active: only ever the authenticated patient's
    // own active request, never a fallback unscoped cross-patient query.
    const active = req.accountId
      ? await CareRequest.findOne({
          status: { $nin: TERMINAL },
          patient_account_id: req.accountId,
        }).sort({ created_at: -1 })
      : null;
    const activeJson = active
      ? await attachDoctorToRequest(active.toJSON())
      : null;
    res.json({
      active_request: activeJson,
      recent_providers: [],
      unread_notification_count: 0,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/profile
// Returns the Account document for the signed-in patient. Strictly scoped to
// `req.accountId` from the verified JWT — a client-supplied `account_id` is
// ignored so no caller can read another patient's account. Passwords are
// stripped automatically by the Account model's toJSON transform.
router.get('/profile', requireAccountId, async (req, res) => {
  try {
    const acct = await Account.findById(req.accountId);
    if (!acct) return res.status(404).json({ message: 'Account not found' });
    res.json(acct.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /patient/profile  { full_name?, email?, phone? }
// Partial update via findByIdAndUpdate so a save touching only `phone`
// does not wipe `email` or `full_name`. Strictly scoped to `req.accountId`
// from the verified JWT — a client-supplied `account_id` in the body is
// ignored so no caller can mutate another patient's account. Returns the
// updated document.
router.patch('/profile', requireAccountId, async (req, res) => {
  try {
    const body = req.body || {};
    const updates = pickPatientFields(body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No editable fields supplied' });
    }
    const acct = await Account.findByIdAndUpdate(
      req.accountId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!acct) return res.status(404).json({ message: 'Account not found' });
    res.json(acct.toJSON());
  } catch (err) {
    // Duplicate email surfaces as a Mongo 11000 — translate to 409 so the
    // Flutter side can show a friendly "Email already in use" SnackBar.
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'Email is already in use' });
    }
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/requests/history
// Closed (terminal) requests, newest first — powers the "View past requests"
// row on the Patient Profile screen. Scoped to the authenticated caller so
// it can't enumerate other patients' history.
router.get('/requests/history', attachAccountId, async (req, res) => {
  try {
    if (!req.accountId) return res.json([]);
    const rows = await CareRequest.find({
      status: { $in: TERMINAL },
      patient_account_id: req.accountId,
    })
      .sort({ created_at: -1 })
      .limit(50);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
