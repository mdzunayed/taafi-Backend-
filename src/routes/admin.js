const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const CareRequest = require('../models/CareRequest');
const Provider = require('../models/Provider');
const Account = require('../models/Account');
const Prescription = require('../models/Prescription');
const Settings = require('../models/Settings');
const {
  loadDoctorPair,
  loadProviderPair,
  attachDoctorToRequest,
  buildAssignedProvider,
  withDoctorBlocks,
} = require('../utils/doctorView');
const {
  releaseStateFor,
  presentPrescription,
} = require('../utils/prescriptionRelease');
const {
  safeEmitNotification,
  userRoomFor,
} = require('../services/notificationService');
// Push dispatch is offloaded to the BullMQ background queue (identical
// signature to the old fcmService call, so nothing else changes). Falls
// back to inline send when Redis is disabled.
const { enqueuePush: sendHighPriorityPush } = require('../queues/notificationQueue');
const { requireRole } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');
const { DEPOSIT_AMOUNT, roundMoney } = require('../utils/money');
const {
  lockBookingChannel,
  unlockBookingChannel,
} = require('../utils/bookingFlow');
const {
  MILESTONES,
  MILESTONE_BY_STATUS,
  isValidMilestone,
  statusForMilestone,
  statusHistoryEntry,
  formatSchedule,
} = require('../utils/bookingMilestones');
const { haversineKm, readLatLng } = require('../utils/geo');
const { providerTypeFromRole } = require('../utils/providerTypes');
const adminController = require('../controllers/admin.controller');
const adminFinanceController = require('../controllers/adminFinanceController');

const BCRYPT_ROUNDS = 10;

// Terminal states a request can never be (re)assigned out of. Used as the
// guard in the atomic compare-and-swap assignment writes below so a
// completed/cancelled/rejected visit can't be silently re-dispatched by a
// late or concurrent admin action.
const TERMINAL = ['completed', 'cancelled', 'rejected'];

// States a team may be assigned FROM. Assignment IS the admin's approval
// step: a booking leaves review only through here (with a positive fee).
//   deposit_paid_admin_reviewing — the normal path out of review
//   approved                     — needs (re-)assignment (doctor declined,
//                                  or a legacy balance payment landed)
//   assigned                     — team change on an un-accepted dispatch
//   amount_assigned_awaiting_final_payment / submitted — legacy in-flight
//                                  documents predating the current flow
// Everything else (deposit unpaid, service already delivered, terminal)
// is rejected with a 409.
const ASSIGNABLE = [
  'deposit_paid_admin_reviewing',
  'approved',
  'assigned',
  'amount_assigned_awaiting_final_payment',
  'submitted',
];

// Folds the four fee sub-fields into `payment.total`, mirroring the
// CareRequest `pre('save')` hook. We need it inline because the atomic
// `findOneAndUpdate` assignment path below bypasses Mongoose middleware.
function withPaymentTotal(payment) {
  const merged = { ...payment };
  merged.total = roundMoney(
    (Number(merged.doctor_fee) || 0) +
      (Number(merged.nurse_fee) || 0) +
      (Number(merged.helper_fee) || 0) +
      (Number(merged.platform_fee) || 0),
  );
  return merged;
}

// Cryptographically-secure ten-character alphanumeric password used as
// the one-shot temporary credential for admin-provisioned doctors and
// nurses. Excludes ambiguous glyphs (0/O, 1/I/l) so the admin can read
// it aloud over the phone without spelling it letter-by-letter.
function generateTemporaryPassword(length = 10) {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

const router = express.Router();

// Shared notification fan-out for both assign paths. Writes a row to
// the patient AND to each freshly-assigned provider (doctor, nurse)
// whose account id can be resolved so every bell badge updates in
// real time. `pairs` carries the resolved {provider, account} pair for
// each role so we don't re-walk Mongo here.
//
// `opts.notifyDoctor` / `opts.notifyNurse` gate each provider fan-out
// so a re-save that re-sends an UNCHANGED provider id (e.g. admin adds
// a nurse to a visit that already has a doctor) doesn't double-ping the
// already-assigned provider. Both default to `true` so any other caller
// keeps the original "notify whoever resolved" behavior. When BOTH are
// false the patient summary is skipped too — nothing actually changed.
async function notifyAssignment(io, careRequestDoc, pairs = {}, opts = {}) {
  if (!careRequestDoc) return;
  const notifyDoctor = opts.notifyDoctor !== false;
  const notifyNurse = opts.notifyNurse !== false;
  if (!notifyDoctor && !notifyNurse) return;
  const apptId = careRequestDoc._id.toString();
  const doctorPair = pairs.doctor || { provider: null, account: null };
  const nursePair = pairs.nurse || { provider: null, account: null };

  const doctorName =
    careRequestDoc.assigned_doctor_name ||
    (doctorPair.provider && doctorPair.provider.full_name) ||
    (doctorPair.account && doctorPair.account.full_name) ||
    null;
  const nurseName =
    careRequestDoc.assigned_nurse_name ||
    (nursePair.provider && nursePair.provider.full_name) ||
    (nursePair.account && nursePair.account.full_name) ||
    null;

  // Patient notification — single message summarising who showed up.
  if (careRequestDoc.patient_account_id) {
    let title;
    let body;
    if (doctorName && nurseName) {
      title = 'Care team assigned';
      body = `${doctorName} and nurse ${nurseName} are on the way for your ${careRequestDoc.care_type || 'visit'}.`;
    } else if (nurseName && !doctorName) {
      title = 'Nurse assigned';
      body = `Nurse ${nurseName} is on the way for your ${careRequestDoc.care_type || 'visit'}.`;
    } else if (doctorName) {
      title = 'Doctor Assigned';
      body = `${doctorName} is on the way for your ${careRequestDoc.care_type || 'visit'}.`;
    } else {
      title = 'Care team assigned';
      body = `Your ${careRequestDoc.care_type || 'visit'} is on the way.`;
    }
    await safeEmitNotification(io, {
      recipientId: careRequestDoc.patient_account_id,
      senderId: null,
      title,
      body,
      type: 'appointment',
      payload: { appointmentId: apptId, deepLink: 'tracking' },
    });
  }

  // Doctor notification — the resolved Account id is what the doctor
  // session uses to identify itself for the socket room.
  const doctorAccountId =
    doctorPair.account && doctorPair.account._id
      ? doctorPair.account._id.toString()
      : null;
  if (doctorAccountId && notifyDoctor) {
    const title = 'New visit assigned';
    const body = `${careRequestDoc.patient_name || 'A patient'} was just assigned to you for ${careRequestDoc.care_type || 'a visit'}.`;
    await safeEmitNotification(io, {
      recipientId: doctorAccountId,
      senderId: null,
      title,
      body,
      type: 'appointment',
      payload: { appointmentId: apptId, deepLink: 'doctor_dashboard' },
    });
    // FCM device push — fires the OS-level high-priority notification
    // so the doctor's app rings through even when suspended. Best-
    // effort: gracefully no-ops when Firebase Admin isn't configured.
    // eslint-disable-next-line no-floating-promises
    sendHighPriorityPush(doctorAccountId, title, body, {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      appointmentId: apptId,
      deepLink: 'doctor_dashboard',
    });
    // High-priority real-time dispatch event — the Flutter socket manager
    // catches this and paints the intrusive incoming-dispatch overlay
    // (haptic + actionable card) without any poll/refresh.
    if (io) {
      io.to(userRoomFor(doctorAccountId)).emit('dispatch:incoming', {
        appointmentId: apptId,
        patientName: careRequestDoc.patient_name || 'A patient',
        careType: careRequestDoc.care_type || 'a visit',
        role: 'doctor',
        deepLink: 'doctor_dashboard',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Nurse notification — symmetric to the doctor branch above.
  const nurseAccountId =
    nursePair.account && nursePair.account._id
      ? nursePair.account._id.toString()
      : null;
  if (nurseAccountId && notifyNurse) {
    const title = 'New nursing visit assigned';
    const body = `${careRequestDoc.patient_name || 'A patient'} was just assigned to you for ${careRequestDoc.care_type || 'a visit'}.`;
    await safeEmitNotification(io, {
      recipientId: nurseAccountId,
      senderId: null,
      title,
      body,
      type: 'appointment',
      payload: { appointmentId: apptId, deepLink: 'nurse_dashboard' },
    });
    // eslint-disable-next-line no-floating-promises
    sendHighPriorityPush(nurseAccountId, title, body, {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      appointmentId: apptId,
      deepLink: 'nurse_dashboard',
    });
    // Real-time intrusive dispatch overlay (see doctor branch).
    if (io) {
      io.to(userRoomFor(nurseAccountId)).emit('dispatch:incoming', {
        appointmentId: apptId,
        patientName: careRequestDoc.patient_name || 'A patient',
        careType: careRequestDoc.care_type || 'a visit',
        role: 'nurse',
        deepLink: 'nurse_dashboard',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// Build the `payment` sub-doc patch from any fee fields the admin
// supplied on the assign call. Returned object is `{}` when nothing was
// supplied — caller then skips the `payment` write entirely so the
// pre('save') hook doesn't recompute totals on an untouched row.
function pickPaymentPatch(b, currentPayment) {
  const out = {};
  const carry = currentPayment || {};
  const fields = ['doctor_fee', 'nurse_fee', 'helper_fee', 'platform_fee'];
  const aliases = {
    doctor_fee: ['doctorFee'],
    nurse_fee: ['nurseFee'],
    helper_fee: ['helperFee'],
    platform_fee: ['platformFee'],
  };
  let touched = false;
  for (const f of fields) {
    const rawSnake = b[f];
    const rawCamel = aliases[f].map((k) => b[k]).find((v) => v !== undefined);
    const raw = rawSnake !== undefined ? rawSnake : rawCamel;
    if (raw === undefined || raw === null || raw === '') {
      out[f] = Number(carry[f]) || 0;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out[f] = roundMoney(n);
    touched = true;
  }
  return touched ? out : {};
}

// POST /admin/create-provider  { name, email, phone, role }
//
// Provisioning rail for doctors and nurses. The public signup path
// refuses to mint these roles (see `routes/auth.js`) — only an admin
// session can land them in the DB, and only with the strict
// allow-list of {'doctor', 'nurse'}.
//
// On success:
//   1. A linked Account row is created (login identity) with a
//      cryptographically-random 10-char temp password (hashed with
//      bcrypt; the plaintext is returned in the response ONCE so the
//      admin can hand it to the hired provider).
//   2. A matching Provider row is created (professional profile)
//      pre-stamped with the role so the existing dashboard surfaces
//      find it.
//   3. Both rows carry `is_verified: false` + the Account carries
//      `requires_password_reset: true` so the provider's first login
//      detours into the ForcedPasswordResetScreen.
router.post(
  '/create-provider',
  requireRole('admin'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const fullName = (b.name || b.fullName || b.full_name || '').toString().trim();
      const email = (b.email || '').toString().toLowerCase().trim();
      const phoneIn = (b.phone || '').toString().trim();
      const role = (b.role || '').toString().toLowerCase().trim();

      if (!fullName) {
        return res
          .status(400)
          .json({ success: false, message: 'name is required' });
      }
      if (!phoneIn) {
        return res
          .status(400)
          .json({ success: false, message: 'phone is required' });
      }
      if (role !== 'doctor' && role !== 'nurse') {
        return res.status(400).json({
          success: false,
          message: "role must be 'doctor' or 'nurse'",
        });
      }
      const cleanPhone = normalizePhone(phoneIn);
      if (!cleanPhone) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid phone number' });
      }

      // Duplicate guards — admin shouldn't be able to silently overwrite
      // an existing account. Email is optional but if supplied must not
      // collide; phone is required + must be unique.
      const phoneDupe = await Account.findOne({ phone: cleanPhone });
      if (phoneDupe) {
        return res.status(409).json({
          success: false,
          message: 'An account with that phone already exists.',
        });
      }
      if (email) {
        const emailDupe = await Account.findOne({ email });
        if (emailDupe) {
          return res.status(409).json({
            success: false,
            message: 'An account with that email already exists.',
          });
        }
      }

      const tempPassword = generateTemporaryPassword(10);
      const password_hash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

      const account = await Account.create({
        full_name: fullName,
        email: email || undefined,
        phone: cleanPhone,
        password_hash,
        role,
        status: 'active',
        // Provider rows are admin-vetted up-front, but the first-login
        // password reset still has to land before the account is
        // considered fully verified.
        is_verified: false,
        requires_password_reset: true,
      });

      // Mirror the identity onto the Provider collection so the doctor /
      // nurse dashboards immediately find the professional row when
      // the provider logs in. The 5-step onboarding sheet fills in
      // BMDC / nursing license + specialty + payout later.
      const provider = await Provider.create({
        full_name: fullName,
        email: email || '',
        phone: cleanPhone,
        role,
        verification_status: 'pending',
        availability_status: 'offline',
      });

      console.log(
        `[admin] ${role} provisioned by admin=${req.accountId}: account=${account._id} provider=${provider._id}`,
      );

      return res.status(201).json({
        success: true,
        message: `${role.charAt(0).toUpperCase()}${role.slice(1)} created.`,
        account: account.toJSON(),
        providerId: provider._id.toString(),
        // The plaintext password is returned exactly once — the
        // admin UI is responsible for showing it inside the
        // copy-credentials card. We never read this value from
        // anywhere else; the DB only stores its bcrypt hash.
        temporaryPassword: tempPassword,
        requiresPasswordReset: true,
      });
    } catch (err) {
      console.error('[admin/create-provider] error:', err);
      // Duplicate-key race-condition fallback.
      if (err && err.code === 11000 && err.keyValue) {
        return res.status(409).json({
          success: false,
          message: 'An account with those identifiers already exists.',
          duplicateFields: Object.keys(err.keyValue),
        });
      }
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// GET /admin/requests — full care-request list, newest first.
//
// Returns every patient's care requests, so it MUST be admin-only —
// guarded by `requireRole('admin')` like every other write/read on this
// router. Without the guard this was an unauthenticated full dump of all
// patients' bookings.
router.get('/requests', requireRole('admin'), async (_req, res) => {
  try {
    const docs = await CareRequest.find().sort({ created_at: -1 });
    res.json(docs.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/requests/:id/set-price
//   { final_service_fee, adjusted_discount?, admin_note? }
//
// Pricing gateway. After the admin reviews the paid booking and calls the
// client, they commit the assessed base service fee here. Pricing is a
// SILENT invoice update — it never changes the booking status and never
// prompts the patient to pay. The booking leaves review only via team
// assignment (`/assign` below, which requires a positive fee), and the
// patient is first asked for the balance after the service completes
// (`service_completed_awaiting_final_payment`). Re-pricing a booking
// already awaiting payment (new or legacy state) DOES re-notify with the
// corrected outstanding amount.
router.post('/requests/:id/set-price', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const feeRaw = Number(b.final_service_fee ?? b.finalServiceFee ?? b.final_price);
    if (!Number.isFinite(feeRaw) || feeRaw <= 0) {
      return res.status(400).json({
        message: 'A final service fee greater than 0 is required.',
      });
    }
    const fee = roundMoney(feeRaw);
    const discountRaw = b.adjusted_discount ?? b.adjustedDiscount ?? 0;
    const discount = roundMoney(Number(discountRaw) || 0);
    if (discount < 0) {
      return res.status(400).json({ message: 'Discount cannot be negative.' });
    }
    // The deposit + discount can never exceed the base fee — that would
    // make the outstanding balance negative (patient owed money).
    if (roundMoney(fee - DEPOSIT_AMOUNT - discount) < 0) {
      return res.status(400).json({
        message:
          'The service fee must be at least the ৳100 deposit plus any discount.',
      });
    }
    const note = typeof b.admin_note === 'string' ? b.admin_note.trim() : undefined;

    const update = {
      final_price: fee,
      adjusted_discount: discount,
    };
    if (note !== undefined) update.admin_note = note;

    // Atomic compare-and-swap. Price a booking under review, RE-price one
    // whose balance is currently payable (new post-service state or the
    // legacy pre-dispatch one) — the admin can correct a fee the patient
    // hasn't settled yet. Status is intentionally NOT part of the update.
    const PRICEABLE = [
      'deposit_paid_admin_reviewing',
      'service_completed_awaiting_final_payment',
      'amount_assigned_awaiting_final_payment',
    ];
    // `new: false` returns the PRE-update doc (atomically, or null if no CAS
    // match) so we can tell an in-review pricing from a correction while the
    // invoice is already payable. We then read back the fresh doc.
    const prior = await CareRequest.findOneAndUpdate(
      { _id: req.params.id, status: { $in: PRICEABLE } },
      { $set: update },
      { new: false },
    );
    if (!prior) {
      const exists = await CareRequest.exists({ _id: req.params.id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? 'This booking cannot be priced (deposit unpaid, or already settled/closed).'
          : 'Request not found',
      });
    }
    // Only when the invoice is ALREADY payable does a price change concern
    // the patient — re-notify with the corrected outstanding amount. An
    // in-review pricing stays silent: the patient is first prompted after
    // the service completes.
    const invoicePayable =
      prior.status === 'service_completed_awaiting_final_payment' ||
      prior.status === 'amount_assigned_awaiting_final_payment';
    const result = await CareRequest.findById(req.params.id);

    const io = req.app.get('io');
    const patientId = result.patient_account_id;
    if (patientId) {
      const outstanding = Math.max(0, roundMoney(fee - DEPOSIT_AMOUNT - discount));
      if (invoicePayable) {
        const title = 'Your booking fee was updated';
        const body =
          `Your care team updated the fee for ` +
          `${result.care_type || 'your booking'}. ` +
          `Outstanding balance: ৳${outstanding}. Review & pay to settle.`;
        const payload = {
          appointmentId: result._id.toString(),
          requestId: result._id.toString(),
          deepLink: 'invoice',
        };
        await safeEmitNotification(io, {
          recipientId: patientId,
          senderId: null,
          title,
          body,
          type: 'payment',
          payload,
        });
        // eslint-disable-next-line no-floating-promises
        sendHighPriorityPush(patientId, title, body, {
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          appointmentId: result._id.toString(),
          deepLink: 'invoice',
        });
      }
      // Live invoice refresh fires either way so an open invoice card
      // re-renders the fee lines.
      if (io) {
        io.to(userRoomFor(patientId)).emit('invoice:updated', {
          appointmentId: result._id.toString(),
          finalServiceFee: fee,
          adjustedDiscount: discount,
          outstanding,
          timestamp: new Date().toISOString(),
        });
      }
    }

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Prescription release gate (phase 2 of 2: admin approval) ────────────

// GET /admin/prescriptions/review-queue[?status=approved|rejected]
//
// Default: every PAID script still awaiting a decision, oldest-paid
// first (FIFO fairness). `?status=` swaps in the decided sets so the
// tab's filter chips can page through history. Admins review script
// legitimacy, so rows arrive UNREDACTED, enriched with the issuing
// doctor's public block and a minimal patient contact block.
router.get(
  '/prescriptions/review-queue',
  requireRole('admin'),
  async (req, res) => {
    try {
      const status = (req.query.status || '').toString().toLowerCase();
      const filter =
        status === 'approved' || status === 'rejected'
          ? { admin_approval_status: status.toUpperCase() }
          : { payment_status: 'PAID', admin_approval_status: 'PENDING' };
      const docs = await Prescription.find(filter).sort({
        paid_at: 1,
        issued_at: 1,
      });
      const rows = await withDoctorBlocks(docs);
      // One batched lookup for the patient contact blocks.
      const patientIds = [
        ...new Set(docs.map((d) => d.patient_account_id).filter(Boolean)),
      ].filter((id) => mongoose.isValidObjectId(id));
      const patients = patientIds.length
        ? await Account.find({ _id: { $in: patientIds } }, 'full_name phone').lean()
        : [];
      const byId = new Map(patients.map((p) => [p._id.toString(), p]));
      const viewer = { privileged: true };
      res.json({
        success: true,
        prescriptions: rows.map((json, i) => {
          const acc = byId.get(docs[i].patient_account_id);
          if (acc) {
            json.patient = { name: acc.full_name || '', phone: acc.phone || '' };
          }
          return presentPrescription(json, docs[i], viewer);
        }),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

// PATCH /admin/prescriptions/:id/approval   { action: 'approve'|'reject', reason? }
//
// The explicit admin gate. Atomic compare-and-swap: only a PAID script
// still awaiting a decision can be decided — a double-tap, a stale tab,
// or an unpaid row all fall through to 409/404 instead of silently
// re-deciding. On approve the patient's script unlocks instantly (the
// socket event below live-refreshes their open screens).
router.patch(
  '/prescriptions/:id/approval',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ message: 'Invalid prescription id' });
      }
      const action = (req.body?.action || '').toString().toLowerCase();
      if (action !== 'approve' && action !== 'reject') {
        return res
          .status(400)
          .json({ message: "action must be 'approve' or 'reject'" });
      }
      const approve = action === 'approve';
      const set = {
        admin_approval_status: approve ? 'APPROVED' : 'REJECTED',
        approved_by: req.accountId,
        approved_at: new Date(),
      };
      if (!approve) {
        set.rejection_reason = (req.body?.reason || '')
          .toString()
          .trim()
          .slice(0, 500);
      }
      const decided = await Prescription.findOneAndUpdate(
        { _id: id, payment_status: 'PAID', admin_approval_status: 'PENDING' },
        { $set: set },
        { new: true },
      );
      if (!decided) {
        const exists = await Prescription.exists({ _id: id });
        return res.status(exists ? 409 : 404).json({
          message: exists
            ? 'This prescription is not awaiting review (unpaid or already decided).'
            : 'Prescription not found',
        });
      }

      // Patient fan-out — bell badge + OS push + live socket unlock.
      // Best-effort: a failed notification never rolls back the decision.
      const io = req.app.get('io');
      const patientId = decided.patient_account_id;
      if (patientId) {
        const title = approve
          ? 'Your prescription is unlocked'
          : 'Prescription review update';
        const body = approve
          ? 'An admin approved your prescription. Your medications are now available.'
          : 'Your prescription could not be approved. Please contact support.';
        const payload = {
          prescriptionId: decided._id.toString(),
          deepLink: 'prescription_detail',
        };
        try {
          await safeEmitNotification(io, {
            recipientId: patientId,
            senderId: req.accountId,
            title,
            body,
            type: 'payment',
            payload,
          });
        } catch (_) {
          /* in-app fan-out failure is non-fatal */
        }
        // eslint-disable-next-line no-floating-promises
        sendHighPriorityPush(patientId, title, body, {
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          prescriptionId: decided._id.toString(),
          deepLink: 'prescription_detail',
        });
        if (io) {
          io.to(userRoomFor(patientId)).emit('prescription:release_updated', {
            prescriptionId: decided._id.toString(),
            releaseStatus: releaseStateFor(decided),
            timestamp: new Date().toISOString(),
          });
        }
      }

      res.json({
        success: true,
        prescription: presentPrescription(decided.toJSON(), decided, {
          privileged: true,
        }),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
);

// POST /admin/requests/:id/cancel   { reason? }
//
// Administrative cancellation. Unlike the patient self-cancel
// (`patient.js` — restricted to the pre-assignment `submitted`/`approved`
// states), an admin can pull the plug on a request at ANY point in its
// lifecycle short of a terminal state. Guarded by `requireRole('admin')`,
// which also admits `support_member` and rejects everyone else with 403.
//
// Cancelling atomically:
//   1. flips `status` → 'cancelled',
//   2. RELEASES the locked provider/team assignment (clears all six
//      `assigned_*` fields) so the request stops occupying a dispatch, and
//   3. records who/why in the free-text `admin_note` (same field the
//      patient/reject flows overload — no dedicated schema field).
router.post('/requests/:id/cancel', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid request id' });
    }
    const reason =
      typeof (req.body && req.body.reason) === 'string'
        ? req.body.reason.trim()
        : '';

    // Atomic compare-and-swap guarded on non-terminal states. `new: false`
    // returns the PRE-update doc so we can notify whoever was assigned at
    // the moment of cancellation (their assignment is about to be cleared).
    const prior = await CareRequest.findOneAndUpdate(
      { _id: id, status: { $nin: TERMINAL } },
      {
        $set: {
          status: 'cancelled',
          admin_note: reason
            ? `Cancelled by admin: ${reason}`
            : 'Cancelled by admin',
          assigned_doctor_id: null,
          assigned_doctor_name: null,
          assigned_nurse_id: null,
          assigned_nurse_name: null,
          assigned_helper_id: null,
          assigned_helper_name: null,
          // The patient must not be left with a call/WhatsApp card for a
          // provider who is no longer coming. Cleared leaf by leaf:
          // `assigned_provider` is a nested path, not a sub-schema, so
          // nulling the parent would be cast against the object shape.
          'assigned_provider.provider_id': null,
          'assigned_provider.provider_type': null,
          'assigned_provider.name': null,
          'assigned_provider.photo_url': null,
          'assigned_provider.phone': null,
          'assigned_provider.designation': null,
          'assigned_provider.registration_no': null,
          'assigned_provider.assigned_at': null,
        },
      },
      { new: false },
    );

    if (!prior) {
      // Distinguish "gone" (404) from "already terminal" (409) so the UI
      // can explain why the cancel didn't take.
      const exists = await CareRequest.exists({ _id: id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? 'This request can no longer be cancelled — it is already completed, cancelled or rejected.'
          : 'Request not found',
      });
    }

    const result = await CareRequest.findById(id);

    // Best-effort realtime + notifications. A notification failure must
    // never tank the state transition that already committed above.
    const io = req.app.get('io');
    const apptId = id.toString();

    // Live tracking room — flips the patient's tracking screen instantly.
    if (io) {
      io.to(apptId).emit('appointment_status_change', {
        appointmentId: apptId,
        status: 'cancelled',
        dbStatus: 'cancelled',
        updatedBy: req.accountId,
        updatedRole: req.accountRole,
        timestamp: new Date().toISOString(),
      });
    }

    // Lock the communication channel — the cancelled visit's chat becomes a
    // read-only archive on both apps.
    await lockBookingChannel(io, result);

    // Patient notification.
    const patientId = result && result.patient_account_id;
    if (patientId) {
      const title = 'Your booking was cancelled';
      const body = `Your ${result.care_type || 'booking'} was cancelled by the care team.`;
      await safeEmitNotification(io, {
        recipientId: patientId,
        senderId: null,
        title,
        body,
        type: 'appointment',
        payload: { appointmentId: apptId, requestId: apptId, deepLink: 'tracking' },
      });
      // eslint-disable-next-line no-floating-promises
      sendHighPriorityPush(patientId, title, body, {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        appointmentId: apptId,
      });
    }

    // Notify each provider who was assigned at cancel time. The
    // `assigned_*_id` fields are Provider ids; a provider session identifies
    // itself by its Account id, which `loadProviderPair` resolves.
    const releases = [
      { id: prior.assigned_doctor_id, role: 'doctor' },
      { id: prior.assigned_nurse_id, role: 'nurse' },
      { id: prior.assigned_helper_id, role: 'helper' },
    ].filter((r) => r.id);
    for (const rel of releases) {
      try {
        const { account } = await loadProviderPair(rel.id, rel.role);
        const accountId = account && account._id ? account._id.toString() : null;
        if (!accountId) continue;
        const title = 'A dispatch was cancelled';
        const body = `Your assignment for ${result.patient_name || 'a patient'}'s ${result.care_type || 'visit'} was cancelled by an administrator.`;
        await safeEmitNotification(io, {
          recipientId: accountId,
          senderId: null,
          title,
          body,
          type: 'appointment',
          payload: { appointmentId: apptId },
        });
        // eslint-disable-next-line no-floating-promises
        sendHighPriorityPush(accountId, title, body, {
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          appointmentId: apptId,
        });
      } catch (_) {
        // Swallow per-provider notification failures — the cancel stands.
      }
    }

    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Freeze the patient-facing provider snapshot at dispatch time.
//
// The tracking screen's Assigned Provider card calls and WhatsApps this
// person directly, so the booking has to carry the contact details itself
// rather than depending on a provider row that can be edited or deactivated
// afterwards. A dual team is led by the doctor — they are who the patient
// coordinates arrival and directions with — so the doctor's pair wins.
//
// Returns `undefined` when neither pair resolved to a real record, which
// leaves whatever snapshot the booking already had untouched.
function assignedProviderPatch({ doctorPair, nursePair }) {
  const lead =
    (doctorPair && (doctorPair.provider || doctorPair.account) && doctorPair) ||
    (nursePair && (nursePair.provider || nursePair.account) && nursePair) ||
    null;
  if (!lead) return undefined;

  const role =
    (lead.provider && lead.provider.role) ||
    (lead.account && lead.account.role) ||
    (lead === doctorPair ? 'doctor' : 'nurse');

  const snapshot = buildAssignedProvider({
    provider: lead.provider,
    account: lead.account,
    stored: null,
    providerType: providerTypeFromRole(role),
  });
  if (!snapshot) return undefined;
  return { ...snapshot, assigned_at: new Date() };
}

// POST /admin/requests/:id/assign
//   { doctor_id, doctor_name, helper_id?, helper_name?,
//     nurse_id?, nurse_name?, final_price?,
//     doctor_fee?, nurse_fee?, helper_fee?, platform_fee? }
router.post('/requests/:id/assign', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.doctor_id && !b.nurse_id) {
      return res
        .status(400)
        .json({ message: 'doctor_id or nurse_id is required' });
    }

    // Manual-pricing gateway. Pricing authority now lives entirely with the
    // admin (the patient no longer offers a budget), so a positive final
    // service fee is mandatory at assignment time — reject null/empty/zero.
    const amount = roundMoney(Number(b.final_price));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        message: 'A final service fee greater than 0 is required to assign.',
      });
    }

    // Load the existing row so we can build a clean `payment` patch on
    // top of the current fees (the pre-save hook recomputes total).
    const existing = await CareRequest.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Request not found' });
    }

    // Snapshot the prior assignments BEFORE mutating so we only notify a
    // provider whose id actually changed on this call — re-sending an
    // unchanged doctor id alongside a new nurse must not re-ping the
    // doctor (the duplicate-notification defect).
    const prevDoctorId = (existing.assigned_doctor_id || '').toString();
    const prevNurseId = (existing.assigned_nurse_id || '').toString();

    // Resolved before the write so the patient-facing provider snapshot
    // (name/photo/phone/registration) lands in the SAME atomic update as the
    // assignment itself — a booking must never be `assigned` with a card the
    // patient can't call.
    const [doctorPair, nursePair] = await Promise.all([
      b.doctor_id
        ? loadProviderPair(b.doctor_id, 'doctor')
        : Promise.resolve({ provider: null, account: null }),
      b.nurse_id
        ? loadProviderPair(b.nurse_id, 'nurse')
        : Promise.resolve({ provider: null, account: null }),
    ]);

    const update = {
      status: 'assigned',
      // Dispatch opens the provider acceptance gate — the assigned
      // doctor/nurse must Accept before the visit advances to `enroute`.
      acceptance_status: 'PENDING_PROVIDER_ACCEPTANCE',
    };
    const providerSnapshot = assignedProviderPatch({ doctorPair, nursePair });
    if (providerSnapshot) {
      update.assigned_provider = providerSnapshot;
      // The role the patient's tracker words its steps with follows whoever is
      // actually coming, overriding the type the booked service carried.
      if (providerSnapshot.provider_type) {
        update.provider_type = providerSnapshot.provider_type;
      }
    }
    if (b.doctor_id) {
      update.assigned_doctor_id = b.doctor_id;
      update.assigned_doctor_name = b.doctor_name || null;
    }
    if (b.nurse_id) {
      update.assigned_nurse_id = b.nurse_id;
      update.assigned_nurse_name = b.nurse_name || null;
    }
    if (b.helper_id !== undefined) {
      update.assigned_helper_id = b.helper_id || null;
      update.assigned_helper_name = b.helper_name || null;
    }
    // Derive the team shape from the RESULTING assignment — a call that adds
    // only a nurse to a visit that already has a doctor is still a DUAL_TEAM.
    // Falls back to the prior id when this call didn't touch that role.
    const resultingDoctorId = b.doctor_id || prevDoctorId;
    const resultingNurseId = b.nurse_id || prevNurseId;
    update.assignment_type =
      resultingDoctorId && resultingNurseId
        ? 'DUAL_TEAM'
        : resultingDoctorId
          ? 'DOCTOR_ONLY'
          : 'NURSE_ONLY';
    update.final_price = amount;
    const paymentPatch = pickPaymentPatch(b, existing.payment);
    if (Object.keys(paymentPatch).length) {
      const cur = existing.payment
        ? (existing.payment.toObject ? existing.payment.toObject() : existing.payment)
        : {};
      update.payment = withPaymentTotal({ ...cur, ...paymentPatch });
    }

    // Atomic compare-and-swap: write the assignment in a single round-trip
    // guarded on the request still being in an ASSIGNABLE state. This
    // closes the read-then-write window where two concurrent admin assigns
    // (or a double-tap) could clobber each other or re-dispatch a finished
    // visit. `findOneAndUpdate` bypasses the pre('save') hook, so
    // `payment.total` is folded in above.
    const result = await CareRequest.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ASSIGNABLE } },
      { $set: update },
      { new: true },
    );
    if (!result) {
      return res.status(409).json({
        message:
          'This request cannot be assigned — deposit unpaid, service already delivered, or booking closed.',
      });
    }

    await notifyAssignment(
      req.app.get('io'),
      result,
      { doctor: doctorPair, nurse: nursePair },
      {
        notifyDoctor: !!b.doctor_id && b.doctor_id.toString() !== prevDoctorId,
        notifyNurse: !!b.nurse_id && b.nurse_id.toString() !== prevNurseId,
      },
    );
    // Assignment IS approval — open the patient↔provider communication
    // channel now that a team is dispatched.
    await unlockBookingChannel(req.app.get('io'), result);
    // Same populated shape the patient's tracker reads, so the assigning
    // admin can confirm the provider card resolved (photo, phone, licence).
    res.json(await attachDoctorToRequest(result.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/appointments/assign  { appointmentId, doctorId, helperId?,
//                                     helperName?, finalPrice? }
//
// Spec-named alias for the existing `POST /admin/requests/:id/assign`
// route. Body keys are camelCase per the production-spec contract;
// snake_case keys are also accepted so the existing admin web tools
// don't break. On success returns the updated appointment with the
// freshly-populated `doctor` block (full_name, profile_picture, …) so
// the assigning admin can confirm the join landed correctly.
router.post('/appointments/assign', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const appointmentId = b.appointmentId || b.appointment_id || b.request_id;
    const doctorId = b.doctorId || b.doctor_id || null;
    const nurseId = b.nurseId || b.nurse_id || null;
    if (!appointmentId) {
      return res.status(400).json({ message: 'appointmentId is required' });
    }
    if (!doctorId && !nurseId) {
      return res
        .status(400)
        .json({ message: 'doctorId or nurseId is required' });
    }
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointmentId' });
    }
    // Manual-pricing gateway — same contract as POST /requests/:id/assign:
    // a positive final service fee is mandatory at assignment time.
    const amount = roundMoney(Number(b.finalPrice ?? b.final_price));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        message: 'A final service fee greater than 0 is required to assign.',
      });
    }

    // Resolve each provider up-front so we can store the human-readable
    // name alongside the id — and so the request fails 404 instead of
    // silently assigning a bogus pointer.
    const [doctorPair, nursePair] = await Promise.all([
      doctorId ? loadProviderPair(doctorId, 'doctor') : Promise.resolve({ provider: null, account: null }),
      nurseId ? loadProviderPair(nurseId, 'nurse') : Promise.resolve({ provider: null, account: null }),
    ]);
    if (doctorId && !doctorPair.provider && !doctorPair.account) {
      return res.status(404).json({ message: 'Doctor not found' });
    }
    if (nurseId && !nursePair.provider && !nursePair.account) {
      return res.status(404).json({ message: 'Nurse not found' });
    }
    const doctorName =
      b.doctorName ||
      b.doctor_name ||
      (doctorPair.provider && doctorPair.provider.full_name) ||
      (doctorPair.account && doctorPair.account.full_name) ||
      null;
    const nurseName =
      b.nurseName ||
      b.nurse_name ||
      (nursePair.provider && nursePair.provider.full_name) ||
      (nursePair.account && nursePair.account.full_name) ||
      null;

    const existing = await CareRequest.findById(appointmentId);
    if (!existing) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Snapshot prior assignments before mutating — only the role whose
    // id actually changed should be notified (see notifyAssignment).
    const prevDoctorId = (existing.assigned_doctor_id || '').toString();
    const prevNurseId = (existing.assigned_nurse_id || '').toString();

    const update = {
      status: 'assigned',
      accepted_at: new Date(),
      // Dispatch opens the provider acceptance gate (see /requests/:id/assign).
      acceptance_status: 'PENDING_PROVIDER_ACCEPTANCE',
    };
    const providerSnapshot = assignedProviderPatch({ doctorPair, nursePair });
    if (providerSnapshot) {
      update.assigned_provider = providerSnapshot;
      if (providerSnapshot.provider_type) {
        update.provider_type = providerSnapshot.provider_type;
      }
    }
    if (doctorId) {
      update.assigned_doctor_id = doctorId;
      update.assigned_doctor_name = doctorName;
    }
    if (nurseId) {
      update.assigned_nurse_id = nurseId;
      update.assigned_nurse_name = nurseName;
    }
    if (b.helperId || b.helper_id) {
      update.assigned_helper_id = b.helperId || b.helper_id;
    }
    if (b.helperName || b.helper_name) {
      update.assigned_helper_name = b.helperName || b.helper_name;
    }
    update.final_price = amount;
    const paymentPatch = pickPaymentPatch(b, existing.payment);
    if (Object.keys(paymentPatch).length) {
      const cur = existing.payment
        ? (existing.payment.toObject ? existing.payment.toObject() : existing.payment)
        : {};
      update.payment = withPaymentTotal({ ...cur, ...paymentPatch });
    }

    // Atomic compare-and-swap (see /requests/:id/assign for rationale):
    // single guarded round-trip so concurrent assigns can't clobber each
    // other and only an ASSIGNABLE booking can be dispatched.
    const result = await CareRequest.findOneAndUpdate(
      { _id: appointmentId, status: { $in: ASSIGNABLE } },
      { $set: update },
      { new: true },
    );
    if (!result) {
      return res.status(409).json({
        success: false,
        message:
          'This appointment cannot be assigned — deposit unpaid, service already delivered, or booking closed.',
      });
    }

    await notifyAssignment(
      req.app.get('io'),
      result,
      { doctor: doctorPair, nurse: nursePair },
      {
        notifyDoctor: !!doctorId && doctorId.toString() !== prevDoctorId,
        notifyNurse: !!nurseId && nurseId.toString() !== prevNurseId,
      },
    );
    // Open the patient↔provider communication channel on dispatch.
    await unlockBookingChannel(req.app.get('io'), result);
    const body = await attachDoctorToRequest(result.toJSON());
    res.json({ success: true, appointment: body });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================================
// 2-Step OTP gate for admin edits to a provider profile
// ===========================================================================
//
// Flow:
//   1. Admin taps the Edit icon on the providers table → POST
//      /admin/providers/:id/request-update-otp generates a 6-digit
//      code, stamps a 5-minute expiry on the provider doc, and
//      logs / mock-SMSes the code.
//   2. Admin types the code + the field changes into the verification
//      dialog → PATCH /admin/providers/:id/update-profile compares
//      the code against the stored value, refuses on mismatch /
//      expiry, applies the change, and clears the OTP latch.
//
// Both endpoints are gated by `requireRole('admin')` so only an
// authenticated admin session can reach them.

// Allowlist of provider fields the verified-update endpoint will
// persist. Any other key on the payload is silently dropped — this is
// the seam where a malicious admin can't sneak in a `verification_status`
// flip alongside a benign rename, for example.
const PROVIDER_EDITABLE_VIA_OTP = new Set([
  'full_name',
  'fullName',
  'phone',
  'email',
  'specialization',
  'specialty',
  'years_experience',
  'fee',
  'service_radius_km',
  'hospital_affiliation',
  'bio',
]);

// Camel-to-snake aliasing so the Flutter side can keep camelCase keys
// (the existing admin UI vocabulary) while the schema stays snake_case.
const PROVIDER_OTP_FIELD_ALIASES = {
  fullName: 'full_name',
  yearsExperience: 'years_experience',
  serviceRadiusKm: 'service_radius_km',
  hospitalAffiliation: 'hospital_affiliation',
};

function generateNumericOtp(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += (bytes[i] % 10).toString();
  }
  return out;
}

// POST /admin/providers/:id/request-update-otp
//
// Stage 1 — generate the code, persist it, log it. Returns the
// expiry so the dialog can render a countdown. In non-strict dev
// mode we ALSO surface the code in the response under `dev_otp` so
// the QA loop doesn't need to watch the server console; production
// (`AUTH_STRICT=1`) strips that field.
router.post(
  '/providers/:id/request-update-otp',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid provider id' });
      }
      const provider = await Provider.findById(id);
      if (!provider) {
        return res
          .status(404)
          .json({ success: false, message: 'Provider not found' });
      }

      const otp = generateNumericOtp(6);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      provider.update_authorization_otp = otp;
      provider.update_authorization_otp_expires = expiresAt;
      await provider.save();

      // Mock SMS interceptor. A production rollout swaps this for a
      // real provider — the `console.log` call site is the seam.
      console.log(
        `[OTP Sent to Provider] id=${provider._id} name="${provider.full_name}" code=${otp} expires=${expiresAt.toISOString()}`,
      );

      return res.json({
        success: true,
        message: 'Verification code dispatched to the provider.',
        providerId: provider._id.toString(),
        providerName: provider.full_name,
        expiresAt: expiresAt.toISOString(),
        // Non-strict dev only — strip the code from the production
        // response so an admin client can't bypass the SMS step.
        dev_otp: process.env.AUTH_STRICT === '1' ? undefined : otp,
      });
    } catch (err) {
      console.error('[providers/request-update-otp] error:', err);
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// PATCH /admin/providers/:id/update-profile
//
// Stage 2 — verify the OTP, apply the field changes, clear the
// latch. Failures (missing / mismatched / expired) all return a
// single uniform 401 so the client can't probe whether the code
// expired vs. was wrong vs. was missing.
router.patch(
  '/providers/:id/update-profile',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid provider id' });
      }
      const body = req.body || {};
      const otp = (body.otp || '').toString().trim();
      if (!otp) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired provider verification token.',
        });
      }

      const provider = await Provider.findById(id);
      if (!provider) {
        return res
          .status(404)
          .json({ success: false, message: 'Provider not found' });
      }

      const stored = provider.update_authorization_otp;
      const expiresAt = provider.update_authorization_otp_expires;
      const expired =
        !expiresAt || new Date().getTime() > new Date(expiresAt).getTime();
      // Constant-time compare to make a brute-force timing attack on
      // the 6-digit code marginally harder. Length mismatch short-
      // circuits to a uniform failure response below.
      let matches = false;
      if (stored && otp.length === stored.length) {
        try {
          matches = crypto.timingSafeEqual(
            Buffer.from(otp),
            Buffer.from(stored),
          );
        } catch (_) {
          matches = false;
        }
      }
      if (!stored || expired || !matches) {
        // Defensive: if the code was expired, clear the latch so the
        // admin can request a fresh one. A genuine mismatch keeps the
        // current code intact (up to its existing expiry) so a
        // mis-type doesn't burn the whole 5-minute window.
        if (stored && expired) {
          provider.update_authorization_otp = null;
          provider.update_authorization_otp_expires = null;
          await provider.save();
        }
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired provider verification token.',
        });
      }

      // OTP cleared — pick the editable fields off the body and
      // apply. Camel-cased aliases land on their snake-case
      // counterparts; everything else outside the allowlist is
      // silently dropped.
      let touched = false;
      for (const [key, raw] of Object.entries(body)) {
        if (key === 'otp') continue;
        if (!PROVIDER_EDITABLE_VIA_OTP.has(key)) continue;
        const targetKey = PROVIDER_OTP_FIELD_ALIASES[key] || key;
        let value = raw;
        if (typeof value === 'string') value = value.trim();
        provider.set(targetKey, value);
        touched = true;
      }

      // Clear the OTP latch regardless of whether any field actually
      // changed — the verification has been consumed.
      provider.update_authorization_otp = null;
      provider.update_authorization_otp_expires = null;
      await provider.save();

      console.log(
        `[OTP verified] admin=${req.accountId} updated provider=${provider._id} touched=${touched}`,
      );

      return res.json({
        success: true,
        message: 'Provider profile updated.',
        provider: provider.toJSON(),
      });
    } catch (err) {
      console.error('[providers/update-profile] error:', err);
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// POST /admin/requests/bulk-status  { ids: [], status }
//
// Deliberately restricted to the two decline outcomes. Approval is NOT a
// standalone status flip anymore — a booking is approved by assigning a
// team (`/requests/:id/assign`), which enforces the pricing + provider
// gates a raw status write would bypass.
const BULK_STATUSES = new Set(['rejected', 'cancelled']);

router.post('/requests/bulk-status', requireRole('admin'), async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids[] is required' });
    }
    if (!status || !BULK_STATUSES.has(status)) {
      return res.status(400).json({
        message:
          'status must be one of: rejected, cancelled. Approve bookings by assigning a team.',
      });
    }
    // Terminal rows stay closed — a bulk action can't reopen or re-flip
    // an already completed/cancelled/rejected booking.
    const result = await CareRequest.updateMany(
      { _id: { $in: ids }, status: { $nin: TERMINAL } },
      { status }
    );
    res.json({ updated: result.modifiedCount ?? 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/bookings/:id/status
//   { milestone?, status?, scheduled_time?, assigned_provider_name?, note? }
//
// The admin-side driver for the patient's step-by-step tracker. Accepts a
// patient-facing MILESTONE key (REQUESTED … COMPLETED / CANCELLED) and maps
// it onto the canonical lifecycle `status` — see utils/bookingMilestones.js
// for why the two vocabularies are kept apart. A raw canonical `status` is
// also accepted so existing admin tooling can call this endpoint directly.
//
// Every accepted call:
//   1. writes the canonical status (guarded — terminal bookings stay closed),
//   2. sets/edits the admin-committed `scheduled_time` and provider name,
//   3. appends a `status_history` row for the timeline,
//   4. opens/closes the patient↔provider channel to match the new phase, and
//   5. broadcasts `booking:status_updated` + a push so the card re-renders
//      without a manual refresh.
router.patch('/bookings/:id/status', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const b = req.body || {};
    const rawMilestone = (b.milestone || '').toString().trim().toUpperCase();
    const rawStatus = (b.status || '').toString().trim().toLowerCase();

    // Resolve the target milestone from either vocabulary.
    let milestoneKey = null;
    if (rawMilestone) {
      if (!isValidMilestone(rawMilestone)) {
        return res.status(400).json({
          message: `milestone must be one of: ${[...MILESTONES.map((m) => m.key), 'CANCELLED'].join(', ')}`,
        });
      }
      milestoneKey = rawMilestone;
    } else if (rawStatus) {
      if (!MILESTONE_BY_STATUS[rawStatus]) {
        return res.status(400).json({ message: `Unknown status "${rawStatus}"` });
      }
      milestoneKey = MILESTONE_BY_STATUS[rawStatus];
    }

    // Optional schedule edit — an explicit null clears it.
    let scheduledTime;
    const rawSchedule =
      b.scheduled_time !== undefined ? b.scheduled_time : b.scheduledTime;
    if (rawSchedule !== undefined) {
      if (rawSchedule === null || rawSchedule === '') {
        scheduledTime = null;
      } else {
        const parsed = new Date(rawSchedule);
        if (Number.isNaN(parsed.getTime())) {
          return res
            .status(400)
            .json({ message: 'scheduled_time must be a valid date' });
        }
        scheduledTime = parsed;
      }
    }

    const rawProvider =
      b.assigned_provider_name !== undefined
        ? b.assigned_provider_name
        : b.assignedProviderName;

    if (milestoneKey === null && scheduledTime === undefined && rawProvider === undefined) {
      return res.status(400).json({
        message:
          'Nothing to update — supply milestone, status, scheduled_time or assigned_provider_name.',
      });
    }

    const update = {};
    if (milestoneKey) {
      // A raw canonical status is written through verbatim so callers can
      // reach states the coarse milestone map collapses (e.g. `arrived`).
      update.status =
        rawStatus && MILESTONE_BY_STATUS[rawStatus]
          ? rawStatus
          : statusForMilestone(milestoneKey);
    }
    if (scheduledTime !== undefined) update.scheduled_time = scheduledTime;
    if (rawProvider !== undefined) {
      update.assigned_provider_name =
        rawProvider === null ? null : rawProvider.toString().trim() || null;
    }

    // Atomic compare-and-swap guarded on the booking not already being
    // terminal — a late or duplicated admin action can't reopen a closed
    // visit. Schedule-only edits are held to the same rule.
    const push = milestoneKey
      ? { status_history: statusHistoryEntry(milestoneKey, b.note) }
      : undefined;

    const updated = await CareRequest.findOneAndUpdate(
      { _id: id, status: { $nin: TERMINAL } },
      push ? { $set: update, $push: push } : { $set: update },
      { new: true, runValidators: true },
    );

    if (!updated) {
      const exists = await CareRequest.exists({ _id: id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? 'This booking is already completed, cancelled or rejected.'
          : 'Booking not found',
      });
    }

    const io = req.app.get('io');

    // Keep the communication channel consistent with the new phase. Both
    // helpers are best-effort and must never fail the transition above.
    if (milestoneKey) {
      if (['SCHEDULED', 'EN_ROUTE', 'IN_SERVICE'].includes(milestoneKey)) {
        await unlockBookingChannel(io, updated);
      } else if (['COMPLETED', 'CANCELLED'].includes(milestoneKey)) {
        await lockBookingChannel(io, updated);
      }
    }

    const body = await attachDoctorToRequest(updated.toJSON());
    const patientId = updated.patient_account_id;

    if (patientId) {
      const apptId = updated._id.toString();
      const when = formatSchedule(updated.scheduled_time);
      const payload = {
        appointmentId: apptId,
        requestId: apptId,
        milestone: body.milestone,
        milestoneStep: body.milestone_step,
        milestoneTotal: body.milestone_total,
        scheduledTime: updated.scheduled_time
          ? updated.scheduled_time.toISOString()
          : null,
        scheduledTimeLabel: when,
        deepLink: 'tracking',
      };

      // Only announce an actual milestone move. A quiet schedule edit still
      // broadcasts below (so the time pill refreshes) but doesn't push.
      if (milestoneKey) {
        const title = body.milestone_label || 'Booking update';
        const bodyText = when
          ? `${updated.care_type || 'Your booking'} · ${when}`
          : `${updated.care_type || 'Your booking'} — tap to view your tracker.`;
        try {
          await safeEmitNotification(io, {
            recipientId: patientId,
            senderId: null,
            title,
            body: bodyText,
            type: 'appointment',
            payload,
          });
          // eslint-disable-next-line no-floating-promises
          sendHighPriorityPush(patientId, title, bodyText, {
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            appointmentId: apptId,
            deepLink: 'tracking',
          });
        } catch (_) {
          /* notification failure must not fail the committed transition */
        }
      }

      if (io) {
        try {
          // Patient's personal room drives the home card; the booking room
          // drives any open tracking screen (patient AND assigned provider).
          io.to(userRoomFor(patientId)).emit('booking:status_updated', payload);
          io.to(apptId).emit('booking:status_updated', payload);
        } catch (_) {
          /* live fan-out is best-effort */
        }
      }
    }

    res.json(body);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Real-time dispatch roster ──────────────────────────────────────────────
// Visit lifecycle states where a provider is physically executing a visit
// (as opposed to merely holding a future slot). A provider in one of these
// on ANY booking is ON_SERVICE right now regardless of scheduled time.
const ON_VISIT_STATES = ['enroute', 'on_the_way', 'arrived', 'in_service', 'nurse_completed'];
// Every non-terminal state that occupies a provider's calendar — used to
// build the overlap set and the active-job count.
const OCCUPYING_STATES = ['assigned', ...ON_VISIT_STATES];
// ± envelope (ms) around the requested visit window within which an
// existing booking is considered a scheduling conflict (spec: ±2 hours).
const DISPATCH_OVERLAP_MS = 2 * 60 * 60 * 1000;

// Builds one role's dispatch roster for a target CareRequest: every
// VERIFIED provider of that role, each enriched with a live duty
// categorisation (AVAILABLE / ON_SERVICE / OFFLINE), straight-line
// distance to the patient, active-job count, and — when on service — the
// end time of the conflicting visit. Rows are sorted AVAILABLE-first, then
// by rating so the best dispatchable provider surfaces at the top.
async function buildDispatchRoster(request, role) {
  const idField = role === 'nurse' ? 'assigned_nurse_id' : 'assigned_doctor_id';

  const [providers, occupying] = await Promise.all([
    Provider.find({ role, verification_status: 'verified' }).sort({ rating: -1 }),
    CareRequest.find({
      status: { $in: OCCUPYING_STATES },
      [idField]: { $ne: null },
    }).select(`${idField} preferred_time duration_hours status`),
  ]);

  // Index every occupying booking by the provider id it's pinned to,
  // skipping the request currently being dispatched (re-assigning it must
  // not make its own provider look busy).
  const bookingsByProvider = new Map();
  for (const b of occupying) {
    if (String(b._id) === String(request._id)) continue;
    const pid = String(b[idField] || '');
    if (!pid) continue;
    if (!bookingsByProvider.has(pid)) bookingsByProvider.set(pid, []);
    bookingsByProvider.get(pid).push(b);
  }

  // Requested visit window. Null when the booking is ASAP (no preferred_time).
  const reqStart = request.preferred_time ? new Date(request.preferred_time) : null;
  const reqDur = Number(request.duration_hours) > 0 ? Number(request.duration_hours) : 1;
  const reqEnd = reqStart ? new Date(reqStart.getTime() + reqDur * 3600e3) : null;
  const patientLoc = readLatLng({
    latitude: request.latitude,
    longitude: request.longitude,
  });

  const rows = await Promise.all(
    providers.map(async (p) => {
      const json = p.toJSON();
      const pid = String(p._id);
      const bookings = bookingsByProvider.get(pid) || [];

      // Resolve the linked Account for live presence (duty_status) + GPS.
      // Best-effort — a missing join simply falls back to the Provider's
      // own availability_status + stored distance_km.
      let account = null;
      try {
        const pair = await loadProviderPair(pid, role);
        account = pair.account;
      } catch (_) {
        /* presence join is non-fatal */
      }

      // Distance: live haversine when both endpoints have a fix, else the
      // Provider's stored distance_km.
      let distanceKm = Number(json.distance_km) || 0;
      const provLoc = account ? readLatLng(account.current_location) : null;
      if (patientLoc && provLoc) {
        const d = haversineKm(patientLoc.lat, patientLoc.lng, provLoc.lat, provLoc.lng);
        if (d != null) distanceKm = Math.round(d * 10) / 10;
      }

      // Walk the provider's bookings for a schedule conflict / active visit.
      let onServiceUntil = null;
      let busy = false;
      for (const b of bookings) {
        const onVisit = ON_VISIT_STATES.includes(b.status);
        const bStart = b.preferred_time ? new Date(b.preferred_time) : null;
        const bDur = Number(b.duration_hours) > 0 ? Number(b.duration_hours) : 1;
        const bEnd = bStart ? new Date(bStart.getTime() + bDur * 3600e3) : null;

        let conflicts = false;
        if (reqStart && reqEnd && bStart && bEnd) {
          // Timed overlap within the ±2h envelope of the requested window.
          conflicts =
            bStart.getTime() - DISPATCH_OVERLAP_MS < reqEnd.getTime() &&
            bEnd.getTime() + DISPATCH_OVERLAP_MS > reqStart.getTime();
        } else if (onVisit) {
          // ASAP / untimed booking that's an in-flight visit — the provider
          // is physically occupied right now.
          conflicts = true;
        }
        if (conflicts || onVisit) {
          busy = true;
          if (bEnd && (!onServiceUntil || bEnd > onServiceUntil)) {
            onServiceUntil = bEnd;
          }
        }
      }

      // Online = provider's explicit toggle OR a live socket presence.
      const isOnline =
        json.availability_status === 'online' ||
        (account && account.duty_status && account.duty_status !== 'OFFLINE');

      let dispatchStatus;
      if (!isOnline) dispatchStatus = 'OFFLINE';
      else if (busy) dispatchStatus = 'ON_SERVICE';
      else dispatchStatus = 'AVAILABLE';

      json.distance_km = distanceKm;
      json.active_job_count = bookings.length;
      json.dispatch_status = dispatchStatus;
      json.on_service_until = onServiceUntil ? onServiceUntil.toISOString() : null;
      json.duty_status =
        account && account.duty_status
          ? account.duty_status
          : isOnline
            ? 'ONLINE'
            : 'OFFLINE';
      return json;
    }),
  );

  // AVAILABLE first, then ON_SERVICE, then OFFLINE; within a tier, rating-DESC.
  const rank = { AVAILABLE: 0, ON_SERVICE: 1, OFFLINE: 2 };
  rows.sort((a, b) => {
    const r = (rank[a.dispatch_status] ?? 3) - (rank[b.dispatch_status] ?? 3);
    if (r !== 0) return r;
    return (Number(b.rating) || 0) - (Number(a.rating) || 0);
  });
  return rows;
}

// Load the target request or send a 404. Shared by the roster endpoints so
// the ±2h window + patient GPS are always resolved from a real booking.
async function loadRequestOr404(id, res) {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: 'Invalid request id' });
    return null;
  }
  const request = await CareRequest.findById(id);
  if (!request) {
    res.status(404).json({ message: 'Request not found' });
    return null;
  }
  return request;
}

// GET /admin/requests/:id/doctors — verified doctors, dispatch-categorised
// against this request's schedule window + patient location.
router.get('/requests/:id/doctors', async (req, res) => {
  try {
    const request = await loadRequestOr404(req.params.id, res);
    if (!request) return;
    res.json(await buildDispatchRoster(request, 'doctor'));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/nurses — verified nurses, dispatch-categorised.
router.get('/requests/:id/nurses', async (req, res) => {
  try {
    const request = await loadRequestOr404(req.params.id, res);
    if (!request) return;
    res.json(await buildDispatchRoster(request, 'nurse'));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/helpers — available medical helpers. Helpers have
// no duty-status funnel yet, so this stays the simple fee-sorted roster.
router.get('/requests/:id/helpers', async (_req, res) => {
  try {
    const docs = await Provider.find({ role: 'helper' }).sort({ fee: 1 });
    res.json(docs.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/team-pool
//
// Returns the verified doctor and nurse rosters in a single segregated
// payload so the admin Dispatch console renders the dual-list view without
// firing two roundtrips. Each provider carries live dispatch metadata
// (`dispatch_status`, `distance_km`, `active_job_count`, `on_service_until`)
// computed against this request's ±2h schedule window and patient GPS.
// Both arrays are sorted AVAILABLE-first, then rating-DESC.
router.get('/requests/:id/team-pool', async (req, res) => {
  try {
    const request = await loadRequestOr404(req.params.id, res);
    if (!request) return;
    const [doctors, nurses] = await Promise.all([
      buildDispatchRoster(request, 'doctor'),
      buildDispatchRoster(request, 'nurse'),
    ]);
    res.json({ success: true, doctors, nurses });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// Statuses that count as "currently in flight". Used by both /admin/stats
// and /admin/dashboard so the Overview KPI matches the Live Monitor count.
const ACTIVE_SERVICE_STATUSES = [
  'assigned',
  'enroute',
  'on_the_way',
  'arrived',
  'in_service',
];

// Builds the [start, end) UTC bounds for the calendar day a Date falls in.
// The admin's "daily revenue" rolls over at local midnight server-side; we
// approximate that with UTC midnight for now and let the Flutter side
// render whatever the server returns.
function dayBounds(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

// Aggregates `final_price` for completed visits in the window. Falls
// back to `offered_budget` when `final_price` is null so admins still
// see revenue from older requests that finished before the price
// negotiation flow shipped.
async function revenueIn(start, end) {
  const result = await CareRequest.aggregate([
    {
      $match: {
        status: 'completed',
        created_at: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        revenue: {
          $sum: {
            $ifNull: ['$final_price', '$offered_budget'],
          },
        },
        visits: { $sum: 1 },
      },
    },
  ]);
  if (!result.length) return { revenue: 0, visits: 0 };
  return {
    revenue: roundMoney(Number(result[0].revenue) || 0),
    visits: Number(result[0].visits) || 0,
  };
}

// Shared handler — the Overview tab polls this every 15 s, so it must
// be cheap. Five count/aggregate queries; every one is indexed
// (status, created_at).
async function adminStatsHandler(_req, res) {
  try {
    const today = dayBounds();
    const yesterday = (() => {
      const y = new Date(today.start);
      y.setDate(y.getDate() - 1);
      return dayBounds(y);
    })();

    const [active, pending, emergency, todayRev, yesterdayRev] =
      await Promise.all([
        CareRequest.countDocuments({
          status: { $in: ACTIVE_SERVICE_STATUSES },
        }),
        CareRequest.countDocuments({ status: 'submitted' }),
        CareRequest.countDocuments({
          urgency_level: 'critical',
          status: { $nin: ['completed', 'cancelled', 'rejected'] },
        }),
        revenueIn(today.start, today.end),
        revenueIn(yesterday.start, yesterday.end),
      ]);

    // Percentage change vs. yesterday — clamps the divide-by-zero case
    // to a flat 0 so the UI doesn't render "Infinity%" on slow days.
    let revenueDelta = 0;
    if (yesterdayRev.revenue > 0) {
      revenueDelta =
        ((todayRev.revenue - yesterdayRev.revenue) / yesterdayRev.revenue) *
        100;
    }

    res.json({
      active_services: active,
      pending_approvals: pending,
      emergency_alerts: emergency,
      daily_revenue: todayRev.revenue,
      revenue_delta: Math.round(revenueDelta * 10) / 10, // 1 decimal
      today_visits: todayRev.visits,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /admin/stats  — canonical KPI route, polled every 15 s.
// GET /admin/dashboard — legacy alias. Same handler so the existing
//   Flutter `getAdminKpi()` keeps working until the next deploy flips it.
router.get('/stats', adminStatsHandler);
router.get('/dashboard', adminStatsHandler);

// GET /api/admin/dashboard-telemetry — real-time operations telemetry for
// the Overview cards, computed via a single $facet aggregation (see
// controllers/admin.controller.js). Protected: admin-only.
router.get(
  '/dashboard-telemetry',
  requireRole('admin'),
  adminController.getDashboardTelemetry,
);

// GET /api/admin/live-services — real-time in-flight dispatches for the
// Live Monitor. Admin-only.
router.get(
  '/live-services',
  requireRole('admin'),
  adminController.getLiveServices,
);

// PATCH /api/admin/providers/:id/verify — flip a provider's verification
// status (pending ⇄ verified). Admin-only.
router.patch(
  '/providers/:id/verify',
  requireRole('admin'),
  adminController.toggleProviderVerification,
);

// POST /api/admin/register-sub-admin — root-admin-only creation of a
// secondary admin account (bcrypt password, role: 'admin').
router.post(
  '/register-sub-admin',
  requireRole('admin'),
  adminController.registerSubAdmin,
);

// GET /api/admin/finance/cash-in-hand — every doctor/nurse holding
// un-remitted physical cash + field-wide rollups for the Cash Clearance
// terminal. Admin-only.
router.get(
  '/finance/cash-in-hand',
  requireRole('admin'),
  adminFinanceController.getCashInHand,
);

// POST /api/admin/finance/settle-provider-cash — record a cash handover and
// zero the provider's cash_in_hand ledger (immutable CashHandoverLog +
// `cash_ledger_cleared` socket to the provider). Admin-only.
router.post(
  '/finance/settle-provider-cash',
  requireRole('admin'),
  adminFinanceController.settleProviderCash,
);

// GET /api/admin/finance/payouts?status=PENDING|APPROVED|REJECTED|all —
// the provider withdrawal queue plus pending-count/total rollups. Admin-only.
router.get(
  '/finance/payouts',
  requireRole('admin'),
  adminFinanceController.listPayouts,
);

// POST /api/admin/finance/payouts/:id/approve  { referenceId }
// Marks a withdrawal paid (bank/MFS reference required) and bumps the
// provider's lifetime `totalWithdrawn`. The funds already left their balance
// at request time, so this moves no money. Admin-only.
router.post(
  '/finance/payouts/:id/approve',
  requireRole('admin'),
  adminFinanceController.approvePayout,
);

// POST /api/admin/finance/payouts/:id/reject  { reason }
// Declines a withdrawal and returns the held funds to the provider's
// available balance. Admin-only.
router.post(
  '/finance/payouts/:id/reject',
  requireRole('admin'),
  adminFinanceController.rejectPayout,
);

// GET /api/admin/settings — the single global platform-configuration doc
// (dispatch toggles, maintenance mode, operational hours, system notice).
// Admin-only; creates the row on first access.
router.get('/settings', requireRole('admin'), async (_req, res) => {
  try {
    const settings = await Settings.getSingleton();
    return res.json({ success: true, settings: settings.toJSON() });
  } catch (err) {
    console.error('[admin/settings GET] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// PUT /api/admin/settings — patch the global settings. Only whitelisted
// fields (Settings.EDITABLE) are applied; unknown keys are ignored. Admin-only.
router.put('/settings', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const settings = await Settings.getSingleton();
    for (const field of Settings.EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        settings[field] = body[field];
      }
    }
    await settings.save();
    return res.json({ success: true, settings: settings.toJSON() });
  } catch (err) {
    console.error('[admin/settings PUT] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /admin/chart-data
// 7-day rollup for the Overview tab's BarChart. Returns one bucket per
// calendar day with `approved` (= approved | completed) and `declined`
// (= rejected | cancelled) counts. Days with zero rows still appear so
// the BarChart always renders exactly 7 bars in chronological order.
router.get('/chart-data', async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 6); // 7-day inclusive window

    const rows = await CareRequest.aggregate([
      { $match: { created_at: { $gte: start } } },
      {
        $group: {
          // Local-time day-of-year bucket. `$dateTrunc` keeps DST jitter
          // out of the rollup — same docs always land in the same bucket.
          _id: {
            $dateTrunc: { date: '$created_at', unit: 'day' },
          },
          approved: {
            $sum: {
              $cond: [
                { $in: ['$status', ['approved', 'completed']] },
                1,
                0,
              ],
            },
          },
          declined: {
            $sum: {
              $cond: [
                { $in: ['$status', ['rejected', 'cancelled']] },
                1,
                0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Index by ISO date for O(1) merge against the 7-slot template.
    const byDay = new Map();
    for (const r of rows) {
      const key = new Date(r._id).toISOString().slice(0, 10);
      byDay.set(key, {
        approved: r.approved || 0,
        declined: r.declined || 0,
        total: r.total || 0,
      });
    }

    // Build the canonical 7-day series so consumers don't have to fill
    // gaps client-side. Mon/Tue/Wed labels mirror the Flutter mockup.
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const series = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const cell = byDay.get(key) || { approved: 0, declined: 0, total: 0 };
      series.push({
        date: key,
        label: days[d.getDay()],
        approved: cell.approved,
        declined: cell.declined,
        total: cell.total,
      });
    }

    res.json({ series });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/patients — accounts where role:'user', newest first.
// Powers the new "Patients" sidebar screen.
router.get('/patients', async (_req, res) => {
  try {
    const rows = await Account.find({ role: 'user' })
      .sort({ created_at: -1 })
      .limit(500);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/patients/:id — a single patient's clinical drill-down for the
// admin Patients directory: their account (incl. medical_vault) plus their
// full care-request history, newest first. Admin-only — this exposes the
// medical vault, so unlike the list endpoints above it is guarded.
router.get('/patients/:id', requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid patient id' });
    }
    const patient = await Account.findOne({ _id: id, role: 'user' });
    if (!patient) {
      return res
        .status(404)
        .json({ success: false, message: 'Patient not found' });
    }
    const requests = await CareRequest.find({ patient_account_id: id })
      .sort({ created_at: -1 })
      .limit(200);
    return res.json({
      success: true,
      patient: patient.toJSON(),
      careRequests: requests.map((d) => d.toJSON()),
    });
  } catch (err) {
    console.error('[admin/patients/:id] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /admin/providers — full provider list (doctors + helpers), newest
// first. Powers the new "Providers" sidebar screen.
router.get('/providers', async (_req, res) => {
  try {
    const rows = await Provider.find()
      .sort({ created_at: -1 })
      .limit(500);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/billing?startDate=&endDate= — completed care_requests with
// their final price, newest first. Optional ISO date params truncate the
// ledger to a [startDate, endDate] window (inclusive of the end day) so the
// admin's date-range picker can scope the report server-side.
router.get('/billing', async (req, res) => {
  try {
    const filter = { status: 'completed' };
    const start = req.query.startDate
      ? new Date(String(req.query.startDate))
      : null;
    const end = req.query.endDate ? new Date(String(req.query.endDate)) : null;
    const range = {};
    if (start && !Number.isNaN(start.getTime())) range.$gte = start;
    if (end && !Number.isNaN(end.getTime())) {
      // Make the end bound inclusive of the whole calendar day.
      const endOfDay = new Date(end);
      endOfDay.setHours(23, 59, 59, 999);
      range.$lte = endOfDay;
    }
    if (Object.keys(range).length) filter.updated_at = range;

    const rows = await CareRequest.find(filter)
      .sort({ updated_at: -1 })
      .limit(500);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/activity — recent activity feed (newest requests as events).
router.get('/activity', async (_req, res) => {
  try {
    const docs = await CareRequest.find().sort({ created_at: -1 }).limit(8);
    res.json(
      docs.map((d) => {
        const o = d.toJSON();
        return {
          id: `ev_${o.id}`,
          message: `${o.patient_name} — ${o.care_type} (${o.status})`,
          timestamp: o.created_at,
          event_type: 'system',
          request_id: o.id,
        };
      })
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
