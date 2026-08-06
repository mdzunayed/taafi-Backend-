const express = require('express');
const mongoose = require('mongoose');
const Prescription = require('../models/Prescription');
const CareRequest = require('../models/CareRequest');
const Account = require('../models/Account');
const { requireAccountId } = require('../middleware/auth');
const { safeEmitNotification } = require('../services/notificationService');
// Push dispatch is offloaded to the BullMQ background queue (identical
// signature to the old fcmService call, so nothing else changes). Falls
// back to inline send when Redis is disabled.
const { enqueuePush: sendHighPriorityPush } = require('../queues/notificationQueue');
const {
  withDoctorBlocks,
  loadProviderPair,
  buildDoctorView,
  credentialsComplete,
} = require('../utils/doctorView');
const {
  isUnlockedFor,
  presentPrescription,
} = require('../utils/prescriptionRelease');
const {
  lockBookingChannel,
  releasePrescriptionsForSettledBooking,
} = require('../utils/bookingFlow');
// Commission split + wallet ledger. The ONLY writer of provider balances.
const walletService = require('../services/walletService');
const { PRESCRIPTION_UNLOCK_FEE, roundMoney } = require('../utils/money');
const { renderPrescriptionPdf } = require('../utils/prescriptionPdf');
const { ageFromDob } = require('../utils/age');

const router = express.Router();

const MEAL_CONTEXT = new Set(['before', 'after', 'either']);

// Dosage forms printed on the prescription pad ("Tab. Napa 500mg").
// Optional — an omitted/empty form is stored as '' and the pad simply
// skips the prefix.
const MED_FORMS = new Set(['TAB', 'CAP', 'SYR', 'INJ', 'CRM', 'DROP']);

// Roles that may read any prescription unredacted (review/support work).
const STAFF_ROLES = new Set(['admin', 'support_member']);

// Resolve the caller into the viewer shape the release gate consumes.
// `requireAccountId`'s x-account-id header fallback carries no role, so
// fall back to a live Account lookup — same pattern as the staff
// override in routes/patient.js.
async function resolveViewer(req) {
  let role = req.accountRole || null;
  if (!role) {
    try {
      const acc = await Account.findById(req.accountId, 'role');
      role = acc?.role || null;
    } catch (_) {
      role = null;
    }
  }
  return { accountId: req.accountId, role, privileged: STAFF_ROLES.has(role) };
}

// Statuses during which a doctor may issue a prescription: the visit is
// either still actively in care, or the nurse has handed off and the
// doctor owes the finalize step (`nurse_completed`). Terminal states
// (`completed`, `cancelled`, `rejected`) are rejected with a 409 so the
// doctor's screen can surface a clear status-lock message instead of
// silently appending a script to a closed visit.
const PRESCRIBABLE_STATUSES = new Set([
  'assigned',
  'enroute',
  'arrived',
  'in_service',
  'nurse_completed',
]);

/**
 * Normalise + validate a medication line item before it lands in
 * Mongo. Throws an Error with a 400-friendly message on the first
 * problem so the route's try/catch can surface it.
 */
function normaliseItem(raw, idx) {
  const out = {};
  const form = (raw?.form ?? '').toString().trim().toUpperCase();
  if (form && !MED_FORMS.has(form)) {
    throw new Error(
      `items[${idx}].form must be one of: ${[...MED_FORMS].join(', ')}`,
    );
  }
  out.form = form;
  const drug = (raw?.drug_name ?? raw?.drugName ?? '').toString().trim();
  if (!drug) throw new Error(`items[${idx}].drug_name is required`);
  out.drug_name = drug;
  const dosage = (raw?.dosage ?? '').toString().trim();
  if (!dosage) throw new Error(`items[${idx}].dosage is required`);
  out.dosage = dosage;
  const freq = raw?.frequency ?? {};
  const morning = !!(freq.morning ?? raw?.morning);
  const afternoon = !!(freq.afternoon ?? raw?.afternoon);
  const night = !!(freq.night ?? raw?.night);
  if (!morning && !afternoon && !night) {
    throw new Error(`items[${idx}] must select at least one time slot`);
  }
  out.frequency = { morning, afternoon, night };
  const meal = (raw?.meal_context ?? raw?.mealContext ?? 'either')
    .toString()
    .toLowerCase();
  if (!MEAL_CONTEXT.has(meal)) {
    throw new Error(
      `items[${idx}].meal_context must be one of: before, after, either`,
    );
  }
  out.meal_context = meal;
  const dur = Number(raw?.duration_days ?? raw?.durationDays ?? 7);
  if (!Number.isFinite(dur) || dur < 1 || dur > 365) {
    throw new Error(`items[${idx}].duration_days must be 1..365`);
  }
  out.duration_days = Math.floor(dur);
  out.notes = (raw?.notes ?? '').toString().trim().slice(0, 500);
  return out;
}

// POST /api/prescriptions
//   { appointmentId, patientAccountId?, diagnosis?, items: [{...}] }
//
// Doctor flow: at "Care Completed" the doctor's prescription form
// fires this with the medication list. The route validates each
// line item, links the script to the originating CareRequest, and
// fans out the in-app + FCM push so the patient sees the new
// prescription on the medication timeline.
router.post('/', requireAccountId, async (req, res) => {
  try {
    const body = req.body || {};
    const appointmentId = body.appointmentId || body.appointment_id;
    if (!appointmentId || !mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Valid appointmentId is required' });
    }
    // Validate the medication payload BEFORE we touch the visit's
    // state. Running validation up-front guarantees a malformed request
    // can never win the finalize race and strand the visit in
    // `completed` with no script attached.
    //
    // Role guard is intentionally light here — production should enforce
    // `assigned_doctor_id` ⇔ requireAccountId match; for this route the
    // doctor is identified by their account id.
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one medication line item is required',
      });
    }
    const normalised = [];
    for (let i = 0; i < items.length; i++) {
      normalised.push(normaliseItem(items[i], i));
    }

    // Pad extras — validated up-front for the same reason as the items:
    // a malformed request must never win the finalize race below.
    const advice = (body.advice || '').toString().trim().slice(0, 1000);
    const followUpRaw = body.followUpDate ?? body.follow_up_date ?? null;
    let followUpDate = null;
    if (followUpRaw) {
      followUpDate = new Date(followUpRaw);
      if (isNaN(followUpDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'followUpDate must be a valid date',
        });
      }
    }
    const numOrNull = (v, max) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 && n <= max ? n : null;
    };
    const weightKg = numOrNull(body.weightKg ?? body.weight_kg, 500);
    const heightCm = numOrNull(body.heightCm ?? body.height_cm, 300);

    // Pad "Patient:" line. The doctor confirms/corrects the booked name
    // on the prescribing form, so a supplied name outranks the booking's
    // care-recipient / account-holder name below.
    const patientNameInput = (body.patientName ?? body.patient_name ?? '')
      .toString()
      .trim()
      .slice(0, 200);
    const patientAgeInput = numOrNull(body.patientAge ?? body.patient_age, 130);
    const patientGenderInput = (body.patientGender ?? body.patient_gender ?? '')
      .toString()
      .trim()
      .slice(0, 40);

    // Credential gate — resolve the issuing doctor's Provider row BEFORE we
    // touch the visit's state. A script's `doctor_snapshot` (pad header) is
    // frozen from these credentials, so an incomplete profile would produce
    // a blank-header script. We reject up-front, for the same reason the
    // payload validation runs first: a rejected request must never win the
    // finalize race and strand the visit in the payment-due state. The
    // resolved `view` is reused below for the snapshot — no second lookup.
    let doctorView = null;
    try {
      doctorView = buildDoctorView(
        await loadProviderPair(req.accountId, 'doctor'),
      );
    } catch (_) {
      doctorView = null;
    }
    if (!credentialsComplete(doctorView)) {
      return res.status(400).json({
        success: false,
        message:
          'Please complete your profile credentials before issuing prescriptions.',
      });
    }

    // Atomic finalize gate — issuing the prescription IS the doctor's
    // "Finalize and Issue Prescription" action, which ends the at-home
    // service. We collapse the old read-then-write (which let two
    // simultaneous taps both pass the status check and both issue a
    // script) into a single isolated transition: only a visit still in
    // a prescribable state can be claimed, and the matched document
    // flips out of it in the same round-trip — so exactly one
    // concurrent request can ever win. The visit parks in the
    // payment-due state; balance settlement (routes/patient.js) later
    // flips it to `completed` and stamps `payment.released_at`. We
    // don't touch the fee fields, so `payment.total` is unaffected.
    const now = new Date();
    let claimed = await CareRequest.findOneAndUpdate(
      { _id: appointmentId, status: { $in: [...PRESCRIBABLE_STATUSES] } },
      {
        $set: {
          status: 'service_completed_awaiting_final_payment',
          completed_at: now,
        },
      },
      { new: true, runValidators: true },
    );

    // Bookings whose balance is ALREADY settled when the doctor finalizes:
    // legacy pay-before-service rows, and deposit-first bookings whose
    // patient pre-paid the balance online after the admin's pricing call.
    // Nothing is left to collect, so they go straight to `completed`.
    // Idempotent second write; the single-winner claim above still guards
    // the race. `preSettled` drives the two side effects that a normal
    // booking gets at settlement time and this one therefore never had:
    // releasing the script we are about to write, and crediting the
    // provider — both deferred to here precisely because the visit had not
    // happened when the money landed.
    const preSettled = !!(
      claimed &&
      (claimed.final_paid_at || claimed.final_transaction_id)
    );
    if (preSettled) {
      claimed = await CareRequest.findOneAndUpdate(
        { _id: appointmentId, status: 'service_completed_awaiting_final_payment' },
        { $set: { status: 'completed', 'payment.released_at': now } },
        { new: true },
      ) || claimed;
    }

    // A null result means we either targeted a non-existent visit or
    // lost the race / collided with a duplicate finalize. Disambiguate
    // with a cheap existence probe so the client still gets 404 vs 409.
    if (!claimed) {
      const exists = await CareRequest.exists({ _id: appointmentId });
      if (!exists) {
        return res
          .status(404)
          .json({ success: false, message: 'Appointment not found' });
      }
      return res.status(409).json({
        success: false,
        error: 'CONFLICT',
        message: 'This care prescription has already been finalized.',
      });
    }

    // Past this point we are the sole winner of the finalize transition,
    // so the script creation and every downstream side effect below run
    // exactly once for this visit.
    const patientAccountId =
      body.patientAccountId ||
      body.patient_account_id ||
      claimed.patient_account_id ||
      '';

    // Freeze the issuing doctor's pad credentials at issue time so the
    // rendered script survives later profile edits. `doctorView` was
    // resolved (and gated as complete) before the finalize claim above,
    // so we just map it here — no second provider lookup.
    let doctorSnapshot = null;
    if (doctorView) {
      doctorSnapshot = {
        name: doctorView.full_name || '',
        // Agreed fallback: specialization stands in until the doctor
        // fills the dedicated degrees profile field.
        degrees: doctorView.degrees || doctorView.specialization || '',
        hospital_or_college: doctorView.hospital_affiliation || '',
        email: doctorView.email || '',
        registration_number: doctorView.bmdc_license || '',
        specialization: doctorView.specialization || '',
      };
    }

    // Pad vitals bar: BP comes from the on-visit CareRequest vitals;
    // weight/height are doctor-entered on the prescription form.
    const bloodPressure = (claimed.vitals?.blood_pressure || '').toString();
    const vitalsSnapshot =
      weightKg !== null || heightCm !== null || bloodPressure
        ? {
            weight_kg: weightKg,
            height_cm: heightCm,
            blood_pressure: bloodPressure,
          }
        : null;

    // Target-patient identity frozen onto the script so the pad always
    // prints who it is for. Name precedence: what the doctor typed on the
    // form → the booking's care recipient (dependent) → the account
    // holder. Age/sex ride along from the dependent block, or from the
    // form when the doctor's client sent them for a self-booking.
    const cr =
      claimed.care_recipient && claimed.care_recipient.name
        ? claimed.care_recipient
        : null;
    const patientName =
      patientNameInput || (cr && cr.name) || claimed.patient_name || '';
    const patientSnapshot = patientName
      ? {
          name: patientName,
          age: (cr ? ageFromDob(cr.date_of_birth) : null) ?? patientAgeInput,
          gender: (cr && cr.gender) || patientGenderInput || '',
          relationship: (cr && cr.relationship) || '',
          blood_group: (cr && cr.blood_group) || '',
        }
      : null;

    const doc = await Prescription.create({
      appointment_id: appointmentId,
      patient_account_id: patientAccountId,
      doctor_account_id: req.accountId,
      doctor_name:
        body.doctorName ||
        body.doctor_name ||
        claimed.assigned_doctor_name ||
        '',
      diagnosis: (body.diagnosis || '').toString().trim().slice(0, 600),
      doctor_snapshot: doctorSnapshot,
      // Freeze the platform brand block alongside the doctor credentials.
      branding_snapshot: {
        brand_name: 'Taafi',
        tagline: 'Your Trusted Home Healthcare Partner',
      },
      vitals_snapshot: vitalsSnapshot,
      patient_snapshot: patientSnapshot,
      advice,
      follow_up_date: followUpDate,
      items: normalised,
      // Release gate: every new script starts locked and snapshots the
      // current platform fee so a later env re-tune never re-prices it.
      payment_status: 'PENDING',
      admin_approval_status: 'PENDING',
      unlock_fee_amount: PRESCRIPTION_UNLOCK_FEE,
    });

    const ioFinalize = req.app.get('io');

    // The visit was paid for before it happened, so this freshly issued
    // script has no balance left to gate it. Run the same post-settlement
    // work the balance flow would have run, now that there is finally a
    // script to run it on: mark it PAID and hand it to the admin release
    // queue, then credit the providers for the visit they just delivered.
    // Both are idempotent (the `payment_status` filter and the wallet
    // ledger's transaction guard), and both are best-effort — the
    // prescription itself is already committed.
    if (preSettled) {
      const settlementTran =
        claimed.final_transaction_id || `PRESETTLED-${claimed._id}`;
      try {
        await releasePrescriptionsForSettledBooking(
          ioFinalize,
          claimed,
          settlementTran,
        );
      } catch (_) {
        /* release fan-out failure must not fail the issuance */
      }
      try {
        await walletService.creditVisitEarnings(ioFinalize, claimed, {
          method: claimed.payment_method === 'CASH_TO_PROVIDER'
            ? 'CASH'
            : 'DIGITAL',
        });
      } catch (_) {
        /* earnings credit failure must not fail the issuance */
      }
    }

    if (ioFinalize) {
      ioFinalize.to(appointmentId.toString()).emit('appointment_status_change', {
        appointmentId: appointmentId.toString(),
        status: claimed.status,
        dbStatus: claimed.status,
        updatedBy: req.accountId,
        updatedRole: 'doctor',
        timestamp: new Date().toISOString(),
      });
    }

    // Finalizing the prescription ends the at-home service — lock the chat
    // into a read-only archive on both apps.
    await lockBookingChannel(ioFinalize, claimed);

    // Patient fan-out — bell badge + OS-level push so the medication
    // timeline lights up immediately. Best-effort: a failed push
    // doesn't tank the issuance.
    if (patientAccountId) {
      const io = req.app.get('io');
      // The balance-due prompt only applies to the new flow; legacy
      // bookings already settled the balance up-front and the script
      // just awaits the admin release review.
      const balanceDue =
        claimed.status === 'service_completed_awaiting_final_payment';
      const outstanding = Math.max(
        0,
        roundMoney(
          (Number(claimed.final_price) || 0) -
            (Number(claimed.deposit_amount) || 0) -
            (Number(claimed.adjusted_discount) || 0),
        ),
      );
      const medCount =
        `${normalised.length} medication${normalised.length === 1 ? '' : 's'}`;
      const title = balanceDue
        ? 'New prescription — service balance due'
        : 'New prescription issued';
      const body2 = balanceDue
        ? `Your doctor issued a prescription with ${medCount}. ` +
          `Pay your outstanding service balance of ৳${outstanding} to ` +
          'unlock it after admin review.'
        : `Your doctor issued a prescription with ${medCount}. ` +
          'It unlocks once an admin approves its release.';
      const deepLink = balanceDue ? 'invoice' : 'medication_timeline';
      try {
        await safeEmitNotification(io, {
          recipientId: patientAccountId,
          senderId: req.accountId,
          title,
          body: body2,
          type: 'system_broadcast',
          payload: {
            prescriptionId: doc._id.toString(),
            appointmentId: appointmentId.toString(),
            deepLink,
          },
        });
      } catch (_) {
        /* in-app fan-out failure is non-fatal */
      }
      // eslint-disable-next-line no-floating-promises
      sendHighPriorityPush(patientAccountId, title, body2, {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        prescriptionId: doc._id.toString(),
        appointmentId: appointmentId.toString(),
        deepLink,
      });
    }

    return res.status(201).json({
      success: true,
      // Issuing doctor's view — never redacted for them.
      prescription: presentPrescription(doc.toJSON(), doc, {
        accountId: req.accountId,
      }),
      appointmentStatus: claimed.status,
    });
  } catch (err) {
    const msg = err.message || 'Server error';
    const isValidation =
      msg.includes('required') ||
      msg.includes('must be') ||
      msg.includes('select at least');
    return res
      .status(isValidation ? 400 : 500)
      .json({ success: false, message: msg });
  }
});

// GET /api/prescriptions/my-active
//
// Lists every prescription whose calendar window (`issued_at` +
// `max(duration_days)` across items) overlaps the current day. The
// patient's medication timeline reads off this surface. Bearer or
// `?account_id=` identity required.
router.get('/my-active', requireAccountId, async (req, res) => {
  try {
    const all = await Prescription.find({
      patient_account_id: req.accountId,
    }).sort({ issued_at: -1 });

    const now = Date.now();
    const active = all.filter((p) => {
      const maxDays = p.items.reduce(
        (m, it) => Math.max(m, Number(it.duration_days) || 0),
        0,
      );
      if (maxDays <= 0) return true; // be permissive
      const endAt =
        new Date(p.issued_at).getTime() + maxDays * 24 * 60 * 60 * 1000;
      return endAt >= now;
    });
    // Locked scripts stay in the list, redacted — the vault renders them
    // as locked entries with a pay/pending chip instead of hiding them.
    const viewer = await resolveViewer(req);
    const rows = await withDoctorBlocks(active);
    res.json({
      success: true,
      prescriptions: rows.map((json, i) =>
        presentPrescription(json, active[i], viewer),
      ),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/prescriptions/by-patient/:accountId
//
// Every prescription issued to a given patient, newest-first. Backs the
// Doctor Operations Hub's Patient Records detail and the Active Care
// Console's "past prescription history" disclosure. Registered before
// the `/:id` route so the literal `by-patient` segment wins. Access:
// the patient themself, admin/support staff, or a doctor with a
// verified treating relationship — anyone else gets a 403. (This route
// previously let ANY signed-in account read ANY patient's history.)
router.get('/by-patient/:accountId', requireAccountId, async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, message: 'accountId is required' });
    }
    const viewer = await resolveViewer(req);
    if (accountId !== req.accountId && !viewer.privileged) {
      // Treating relationship: the caller has (or had) this patient
      // assigned on a visit, or has previously issued them a script.
      const isTreatingDoctor =
        (await CareRequest.exists({
          patient_account_id: accountId,
          assigned_doctor_id: req.accountId,
        })) ||
        (await Prescription.exists({
          patient_account_id: accountId,
          doctor_account_id: req.accountId,
        }));
      if (!isTreatingDoctor) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
      // A treating doctor reads the full clinical history, including
      // scripts other doctors issued — the release gate is a patient
      // monetisation/QA gate, not doctor-vs-doctor secrecy.
      viewer.privileged = true;
    }
    const docs = await Prescription.find({
      patient_account_id: accountId,
    }).sort({ issued_at: -1 });
    const rows = await withDoctorBlocks(docs);
    res.json({
      success: true,
      prescriptions: rows.map((json, i) =>
        presentPrescription(json, docs[i], viewer),
      ),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/prescriptions/:id  — single prescription read.
router.get('/:id', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid prescription id' });
    }
    const doc = await Prescription.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Prescription not found' });
    }
    // Ownership check — patient, issuing doctor, or admin/support staff
    // (the review queue's detail read lands here too).
    const viewer = await resolveViewer(req);
    if (
      doc.patient_account_id !== req.accountId &&
      doc.doctor_account_id !== req.accountId &&
      !viewer.privileged
    ) {
      return res
        .status(403)
        .json({ success: false, message: 'Forbidden' });
    }

    // Enrich for the patient's prescription vault: resolve the issuing
    // doctor into the full public profile block (credentials + photo +
    // affiliation) and surface the originating visit's reported condition
    // as "symptoms". Best-effort — the script still returns even if the
    // joins miss. The presenter strips `symptoms` again when the viewer
    // is locked out.
    const [out] = await withDoctorBlocks([doc]);
    try {
      if (doc.appointment_id) {
        const appt = await CareRequest.findById(doc.appointment_id).lean();
        if (appt) out.symptoms = appt.condition_note || '';
      }
    } catch (_) {
      /* symptoms join is non-fatal */
    }

    res.json({
      success: true,
      prescription: presentPrescription(out, doc, viewer),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/prescriptions/:id/download — server-rendered A4 PDF of the
// prescription pad, streamed as a binary attachment.
//
// Same ownership rules as GET /:id, PLUS an explicit release gate: a
// locked script 409s for the patient so the PDF endpoint can never be
// used to read clinical content around the paywall. The issuing doctor
// and staff pass automatically inside `isUnlockedFor`.
router.get('/:id/download', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid prescription id' });
    }
    const doc = await Prescription.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Prescription not found' });
    }
    const viewer = await resolveViewer(req);
    if (
      doc.patient_account_id !== req.accountId &&
      doc.doctor_account_id !== req.accountId &&
      !viewer.privileged
    ) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    if (!isUnlockedFor(doc, viewer)) {
      return res.status(409).json({
        success: false,
        error: 'PRESCRIPTION_LOCKED',
        message:
          'This prescription is locked until payment and admin approval ' +
          'are complete.',
      });
    }

    let pdf;
    try {
      pdf = await renderPrescriptionPdf(doc);
    } catch (err) {
      console.error('[prescription-pdf] render failed:', err.message);
      return res.status(503).json({
        success: false,
        error: 'PDF_RENDERER_UNAVAILABLE',
        message:
          'PDF generation is temporarily unavailable. Please try again ' +
          'shortly.',
      });
    }

    const careId = doc.appointment_id
      ? doc.appointment_id.toString()
      : doc._id.toString();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Taafi_Prescription_${careId}.pdf"`,
    );
    return res.send(pdf);
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// PATCH /api/prescriptions/:id/dose
//   { itemId, slot, dayKey?, taken: bool }
//
// Toggles the "Mark as Taken" state for one (item, slot, day)
// triple. Idempotent — appending the same triple twice on the same
// day collapses to a single log row; `taken: false` removes the
// most recent matching row.
router.patch('/:id/dose', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid prescription id' });
    }
    const { itemId, slot, dayKey, taken } = req.body || {};
    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Valid itemId is required' });
    }
    if (!['morning', 'afternoon', 'night'].includes(slot)) {
      return res
        .status(400)
        .json({ success: false, message: "slot must be morning|afternoon|night" });
    }
    const today = new Date();
    const day = (dayKey || today.toISOString().slice(0, 10)).toString();

    const doc = await Prescription.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Prescription not found' });
    }
    if (doc.patient_account_id !== req.accountId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    // A locked script exposes no medication content, so adherence
    // logging against it is meaningless — and would leak item ids.
    // 409 matches the repo's status-lock convention (see the finalize
    // CONFLICT above).
    if (!isUnlockedFor(doc, { accountId: req.accountId })) {
      return res.status(409).json({
        success: false,
        error: 'PRESCRIPTION_LOCKED',
        message:
          'This prescription is locked until payment and admin approval are complete.',
      });
    }
    const item = doc.items.id(itemId);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: 'Medication item not found' });
    }
    const matches = doc.dose_log.filter(
      (d) =>
        d.prescription_item_id?.toString() === itemId &&
        d.slot === slot &&
        d.day_key === day,
    );
    if (taken === false) {
      // Remove the most recent matching dose.
      if (matches.length > 0) {
        const target = matches[matches.length - 1];
        doc.dose_log = doc.dose_log.filter(
          (d) => d._id.toString() !== target._id.toString(),
        );
      }
    } else {
      // Default `taken: true` — only append if not already logged today.
      if (matches.length === 0) {
        doc.dose_log.push({
          prescription_item_id: itemId,
          slot,
          day_key: day,
          taken_at: new Date(),
        });
      }
    }
    await doc.save();
    // Only the owning patient of an UNLOCKED script reaches this point,
    // so nothing gets redacted — the presenter just keeps the wire
    // shape consistent (releaseStatus etc.) with every other surface.
    res.json({
      success: true,
      prescription: presentPrescription(doc.toJSON(), doc, {
        accountId: req.accountId,
      }),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
