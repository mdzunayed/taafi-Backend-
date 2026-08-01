const mongoose = require('mongoose');
const { roundMoney } = require('../utils/money');
const { describeMilestone } = require('../utils/bookingMilestones');
const { PROVIDER_TYPES } = require('../utils/providerTypes');

// `care_requests` collection. Field names are snake_case to match the
// Flutter snake_case_json parser layer exactly (no camelCase drift). The
// toJSON transform flattens `_id` -> `id` (string) and drops `__v`, mirroring
// the Service model convention.
const CareRequestSchema = new mongoose.Schema(
  {
    patient_name: { type: String, required: true, trim: true },
    patient_account_id: { type: String, default: '', index: true },
    patient_phone: { type: String, default: '' },
    care_type: { type: String, required: true }, // free-text, e.g. "Post-surgery home care"
    // The catalog row the patient booked from, when they came through the
    // service catalog (free-text `care_type` alone can't be joined back).
    // String id, matching the `assigned_*_id` convention above — the joins in
    // utils/doctorView.js are manual, not Mongoose refs.
    service_id: { type: String, default: null },
    // WHO attends this booking. Copied from the booked Service at creation
    // time and re-derived from the assigned provider's role at serialize time
    // (utils/bookingMilestones.js), because the admin can dispatch a doctor to
    // a booking the catalog tagged as nursing care.
    //
    // Drives every role-dependent string the patient sees: four of the six
    // tracker steps, the provider card's role badge and registration label,
    // and the pre-arrival preparation tip. `null` = never tagged; the resolver
    // falls back to inferring from `care_type` and finally to NURSE, so the
    // effective default matches the majority of the catalog without pretending
    // a legacy row was explicitly tagged as nursing.
    provider_type: {
      type: String,
      enum: [...PROVIDER_TYPES, null],
      default: null,
    },
    offered_budget: { type: Number, default: 0 },
    preferred_time: { type: String, default: null }, // ISO-8601 string or null (ASAP)
    duration_hours: { type: Number, default: 1 },
    condition_note: { type: String, default: '' },
    location_text: { type: String, default: '' },
    area: { type: String, default: '' },
    // Raw GPS coordinates captured by the patient's address manager. Null
    // when the patient only provided a free-text address. The admin live
    // monitor + the responding clinician read these to route the home
    // triage with zero location ambiguity.
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    // Who the visit is actually for. Null = the booking patient themselves;
    // otherwise a saved dependent's profile snapshot, injected at booking
    // time so the responding doctor / nurse sees the recipient + their
    // critical allergies / history without a separate lookup.
    care_recipient: {
      // Link back to the source Dependent record (String id convention).
      dependent_id: { type: String, default: null },
      name: { type: String, default: null },
      relationship: { type: String, default: null },
      // Denormalised clinical context so the responding clinician sees the
      // target patient's age/sex/blood group + conditions without a lookup.
      gender: { type: String, default: null },
      date_of_birth: { type: String, default: null },
      blood_group: { type: String, default: null },
      medical_conditions: { type: [String], default: [] },
      medical_notes: { type: String, default: null },
    },
    status: {
      type: String,
      enum: [
        // --- Two-phase booking confirmation states -----------------------
        // Phase 1: the patient has created the booking but has NOT yet paid
        // the fixed ৳100 confirmation deposit. The slot is not "locked in"
        // and admins do NOT see it in triage until the deposit clears.
        'awaiting_deposit',
        // Phase 1 complete: the ৳100 deposit was confirmed by the gateway.
        // The booking is now live and sits in the admin's care-management
        // review queue (call the client, assess severity, set the fee).
        'deposit_paid_admin_reviewing',
        // LEGACY pay-before-service state: the admin set the final fee and
        // the patient had to clear the balance before dispatch (`approved`).
        // New bookings never enter this state — pricing no longer changes
        // status and the balance is collected after service completion —
        // but in-flight documents remain payable/assignable from here.
        'amount_assigned_awaiting_final_payment',
        'submitted',
        'approved',
        'assigned',
        'enroute',
        'arrived',
        'in_service',
        // Transitional state: the nurse has finished her field checklist
        // but a doctor is assigned and still owes the prescription. The
        // visit is NOT yet terminal — the doctor's "Finalize and Issue
        // Prescription" step advances it. Nurse-only visits skip this.
        'nurse_completed',
        // Service delivered at the patient's home; the outstanding balance
        // (final_price − deposit − discount) is now due. Balance settlement
        // flips the booking to `completed` and marks the visit's
        // prescriptions PAID so they enter the admin release queue.
        'service_completed_awaiting_final_payment',
        'completed',
        'rejected',
        'cancelled',
      ],
      default: 'submitted',
      index: true,
    },
    // Reused as the "final service fee" the admin assigns after the manual
    // phone review (spec: finalServiceFee). Set by both the two-phase
    // set-price gateway and the legacy provider-dispatch assign route.
    final_price: { type: Number, default: null },
    // Reused as the admin's onboarding-call summary (spec: adminNotes).
    admin_note: { type: String, default: null },

    // --- Two-phase confirmation deposit & dynamic invoicing --------------
    // Fixed ৳100 slot-confirmation deposit. `deposit_amount` is 0 until the
    // gateway confirms, then locked to 100. The deposit is DEDUCTED from the
    // final bill: outstanding = final_price - deposit_amount - adjusted_discount.
    deposit_amount: { type: Number, default: 0 },
    deposit_transaction_id: { type: String, default: null },
    deposit_paid_at: { type: Date, default: null },
    // Optional promotional adjustment / waiver applied by the admin at pricing.
    adjusted_discount: { type: Number, default: 0 },
    // Code the patient carried in from a PROMO_CODE promo-banner tap (see
    // PromoBanner.promoCode). Purely informational — the admin reads it
    // during the pricing call and manually reflects it in
    // `adjusted_discount`; there is no automated coupon-validation engine.
    promo_code: { type: String, default: null },
    // Balance (outstanding) payment settlement, stamped when the patient
    // clears the invoice and the request advances into the dispatch queue.
    final_transaction_id: { type: String, default: null },
    final_paid_at: { type: Date, default: null },
    // ── Cash reconciliation ─────────────────────────────────────────────
    // How the outstanding balance was settled. DIGITAL = SSLCommerz /
    // simulated gateway (routes/patient.js balance flow). CASH_TO_PROVIDER
    // = the assigned provider collected physical cash at the door
    // (POST /api/appointments/:id/collect-cash) and now holds company
    // money — the amount is mirrored into the collector Account's
    // `financial_ledger.cash_in_hand`. Null on legacy rows settled before
    // this field shipped.
    payment_method: {
      type: String,
      enum: ['DIGITAL', 'CASH_TO_PROVIDER', null],
      default: null,
    },
    // Account id of the provider who physically collected the cash.
    // Free-form String (not an ObjectId ref) to match the assignment id
    // convention above — doctorView.js does the manual joins.
    collected_by_provider_id: { type: String, default: null },
    collected_at: { type: Date, default: null },
    // The patient's UPFRONT choice of how they intend to settle the
    // outstanding balance, set from the tracking screen while the visit is
    // still in progress. Distinct from `payment_method` above, which records
    // how the balance was ACTUALLY settled at completion. CASH_ON_SERVICE is
    // a pre-commitment ("I'll hand cash to the provider at the door") that
    // makes the provider's collect-cash step mandatory instead of skippable.
    // Null = not chosen yet (treated as digital/default).
    payment_preference: {
      type: String,
      enum: ['DIGITAL', 'CASH_ON_SERVICE', null],
      default: null,
    },
    assigned_doctor_id: { type: String, default: null, index: true },
    assigned_doctor_name: { type: String, default: null },
    assigned_nurse_id: { type: String, default: null, index: true },
    assigned_nurse_name: { type: String, default: null },
    assigned_helper_id: { type: String, default: null },
    assigned_helper_name: { type: String, default: null },

    // --- Patient-facing provider snapshot ---------------------------------
    // Everything the tracking screen's Assigned Provider card needs, frozen
    // at dispatch time: who is coming, how to reach them, and the credential
    // that proves they are who the app says they are.
    //
    // Denormalised on purpose. `assigned_doctor_id` / `assigned_nurse_id` are
    // free-form Strings that may point at either a `providers` or an
    // `accounts` row (see utils/doctorView.js), so there is no single ref to
    // populate; and a booking's record of who attended must survive the
    // provider later editing their phone or leaving the platform. The read
    // path in doctorView.js re-resolves the live provider and prefers its
    // current photo/phone, falling back to this snapshot — so the card is
    // fresh while the audit trail stays intact.
    //
    // Written by the admin dispatch routes. Every field stays null until an
    // assignment happens; the card only renders once `name` is present.
    assigned_provider: {
      // Whichever id the admin dispatched — a Provider _id in practice, an
      // Account _id for older rows. Resolved via `loadProviderPair`.
      provider_id: { type: mongoose.Schema.Types.ObjectId, default: null },
      // Role of THIS provider, which can differ from the booking's
      // `provider_type` (a nursing booking can be escalated to a doctor).
      provider_type: {
        type: String,
        enum: [...PROVIDER_TYPES, null],
        default: null,
      },
      name: { type: String, default: null },
      photo_url: { type: String, default: null },
      phone: { type: String, default: null },
      // Free text as it should read on the card, e.g. "Senior Care Nurse",
      // "General Physician". Sourced from the provider's specialisation /
      // degrees — never invented when the profile is blank.
      designation: { type: String, default: null },
      // BMDC / Nursing Council registration number. The label that precedes
      // it on the card comes from `provider_type` (utils/providerTypes.js).
      registration_no: { type: String, default: null },
      assigned_at: { type: Date, default: null },
    },

    // --- Provider acceptance gate -----------------------------------------
    // Explicit acceptance state, DECOUPLED from the lifecycle `status`
    // above. Admin dispatch sets this to PENDING_PROVIDER_ACCEPTANCE the
    // moment a doctor/nurse is assigned; the provider's Accept flips it to
    // ACCEPTED (status → `enroute`), Decline flips it to DECLINED (status →
    // `approved`, back in the admin pool). This lets a surface show
    // "awaiting your acceptance" without overloading the lifecycle enum —
    // `assigned` + PENDING_PROVIDER_ACCEPTANCE is the "team assigned, not
    // yet accepted" state. `null` = no provider assigned yet.
    acceptance_status: {
      type: String,
      enum: ['PENDING_PROVIDER_ACCEPTANCE', 'ACCEPTED', 'DECLINED', null],
      default: null,
    },
    // Shape of the dispatched care team, derived at assignment time from
    // which provider roles were assigned. Purely descriptive — the visit
    // lifecycle still runs off `status` + `acceptance_status` above; this
    // is a reporting/label field the admin Dispatch console and analytics
    // read to distinguish a solo doctor/nurse visit from a joint team.
    // `null` until a team is assigned.
    assignment_type: {
      type: String,
      enum: ['DUAL_TEAM', 'DOCTOR_ONLY', 'NURSE_ONLY', null],
      default: null,
    },
    urgency_level: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },

    // --- Patient-facing milestone tracker ---------------------------------
    // The appointment window the ADMIN commits to when confirming the
    // booking ("Today at 3:30 PM"). Distinct from `preferred_time`, which is
    // what the PATIENT asked for at booking time — the tracker shows this
    // one, falling back to `preferred_time` until an admin sets it.
    scheduled_time: { type: Date, default: null },

    // Display name for the person actually attending, shown on the ongoing
    // care card. Usually mirrors `assigned_doctor_name` / `assigned_nurse_name`,
    // but stays writable so an admin can name a provider (e.g. an agency
    // nurse) who has no Provider record yet.
    assigned_provider_name: { type: String, default: null },

    // Append-only audit of patient-visible milestone transitions:
    // `status` holds the MILESTONE key (REQUESTED … COMPLETED / CANCELLED),
    // not the canonical lifecycle status, because this feeds the tracking
    // timeline. See utils/bookingMilestones.js.
    status_history: {
      type: [
        {
          _id: false,
          status: { type: String, required: true },
          timestamp: { type: Date, default: Date.now },
          note: { type: String, default: null },
        },
      ],
      default: [],
    },

    // Server timestamp stamped by `PATCH /api/appointments/:id/update-status`
    // when the provider flips the visit to `completed`. History card
    // timelines + the chat lockdown gate read this directly so a
    // race with `updated_at` (which moves on any save) doesn't lie
    // about the actual finish time.
    completed_at: { type: Date, default: null },

    // --- Patient ↔ provider communication channel -------------------------
    // Persisted access-control lock for the in-app chat + masked-calling
    // surface (models/Message.js appointment rows keyed by this request's
    // _id). Opens (`isLocked:false`) the moment a provider is assigned and
    // re-locks (`isLocked:true`, read-only archive) on completion/cancel.
    // The state machine is centralised in utils/bookingFlow.js
    // (`isBookingChatOpen`, `lockBookingChannel`, `unlockBookingChannel`);
    // the socket `send_message` guard + the masked-call endpoint both read
    // this as the server-of-truth so a stale client can't push into or dial
    // a closed booking. Default locked — a pre-assignment booking has no
    // active channel yet.
    communicationChannel: {
      isLocked: { type: Boolean, default: true },
      lockedAt: { type: Date, default: null },
      unlockedAt: { type: Date, default: null },
    },

    // Free-text wrap-up the provider records on the Nurse/Doctor console's
    // "Complete Care Session" step (e.g. field anomalies observed). Written
    // by POST /api/appointments/:id/complete; surfaced to admin + future
    // doctor consults alongside the vitals snapshot below.
    completion_summary: { type: String, default: '' },

    // Structured procedures the nurse performed on-site, recorded via the
    // Active Nurse Console's multi-select chips (e.g. "Dressing", "IV Fluid",
    // "Catheter Care", "Lab Collection", "Injections"). Plain label strings,
    // consistent with the free-text `care_type`. Written by
    // POST /api/appointments/:id/complete (and optionally the mid-visit
    // /vitals save); surfaced to admin + the patient's nursing report.
    procedures: { type: [String], default: [] },

    // --- Post-visit data captured at completion ----------------------------
    // These three sub-docs are populated when the doctor flips the visit
    // to `status: 'completed'`. The patient's Rating screen renders them
    // and writes back to `feedback` via POST /api/appointments/:id/feedback.

    // Vitals dashboard — what the doctor recorded on-site. Each field is
    // a free-form string so the doctor app can write either a numeric
    // ("128/82") or a qualitative ("Clean") value depending on the metric.
    vitals: {
      blood_pressure: { type: String, default: null },   // e.g. "128/82"
      blood_pressure_unit: { type: String, default: 'mmHg' },
      temperature: { type: String, default: null },      // e.g. "99.1"
      temperature_unit: { type: String, default: '°F' },
      spo2: { type: String, default: null },             // e.g. "97"
      spo2_unit: { type: String, default: '%' },
      pulse: { type: String, default: null },            // e.g. "78"
      pulse_unit: { type: String, default: 'bpm' },
      blood_sugar: { type: String, default: null },      // RBS, e.g. "6.5" / "120"
      blood_sugar_unit: { type: String, default: 'mmol/L' },
      pain_score: { type: String, default: null },       // e.g. "3/10"
      wound_status: { type: String, default: null },     // e.g. "Clean"
      recorded_by: { type: String, default: null },
      recorded_at: { type: Date, default: null },
    },

    // Final settlement structure. The Rating screen renders the line
    // items + total. Source of truth for billing / reporting too.
    // `total` is auto-recomputed by the pre('save') hook below whenever
    // any of the fee sub-fields change.
    payment: {
      doctor_fee: { type: Number, default: 0 },
      nurse_fee: { type: Number, default: 0 },
      helper_fee: { type: Number, default: 0 },
      platform_fee: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      currency: { type: String, default: 'BDT' },
      released_at: { type: Date, default: null },
    },

    // Patient feedback. `is_reviewed` is the latch the Rating screen
    // checks to avoid letting the same visit be rated twice (defensive;
    // the backend also rejects a second POST).
    feedback: {
      rating: { type: Number, min: 1, max: 5, default: null },
      tags: { type: [String], default: [] },
      comment: { type: String, default: '' },
      is_reviewed: { type: Boolean, default: false },
      submitted_at: { type: Date, default: null },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Keep `payment.total` in lockstep with the four fee sub-fields. Hook
// only fires when the payment sub-doc actually changed — untouched
// rows aren't rewritten, and an admin-overridden total stays sticky
// because manually setting `payment.total` will get re-derived on the
// next save (the assumption: the per-fee fields are the source of
// truth; if you want to override the total, write all four fee fields
// to add up the way you want).
CareRequestSchema.pre('save', function (next) {
  if (this.isModified('payment')) {
    const p = this.payment || {};
    const sum =
      (Number(p.doctor_fee) || 0) +
      (Number(p.nurse_fee) || 0) +
      (Number(p.helper_fee) || 0) +
      (Number(p.platform_fee) || 0);
    this.payment.total = roundMoney(sum);
  }
  next();
});

CareRequestSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    // Derive the patient-facing tracker block (milestone key, step N of 6,
    // label, formatted schedule, and the full six-step timeline) from the
    // canonical status. Additive — every existing consumer ignores it, and
    // the patient app reads it instead of re-implementing the mapping.
    Object.assign(ret, describeMilestone(ret));
    return ret;
  },
});

module.exports = mongoose.model('CareRequest', CareRequestSchema);
