const mongoose = require('mongoose');
const { roundMoney } = require('../utils/money');
// Balance posture (settled?, how much is left, ONLINE vs CASH) — derived in
// exactly one place so this projection, the socket broadcast and the provider
// payloads can never disagree about whether cash is still owed.
const { paymentPostureFor } = require('../utils/paymentPosture');
const { describeMilestone } = require('../utils/bookingMilestones');
const { PROVIDER_TYPES } = require('../utils/providerTypes');
// Resolves "what deposit applies to this booking" from the paid amount, the
// quoted amount, and the admin-configured default — in that precedence.
const {
  requiredDepositFor,
  hasRequiredDeposit,
  cachedBookingDepositAmount,
} = require('../services/pricingService');

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

    // The rail the patient picked at checkout for the confirmation deposit.
    // Recorded at booking time even though nothing is charged then (the
    // deposit does not exist until the admin sets it in Phase 2) so the
    // Phase-3 payment sheet can preselect the method they already chose.
    // Always a DIGITAL rail — the deposit cannot be paid in cash, because it
    // is what confirms the visit before anyone is dispatched. The cash option
    // belongs to the REMAINING balance, and lives on `payment_preference`.
    // Null for bookings made before the checkout flow shipped.
    payment_channel: {
      type: String,
      enum: ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'CARD', null],
      default: null,
    },

    // Previous medical documents the patient attached at booking time
    // (discharge summaries, old prescriptions, lab reports) — PDFs or
    // images, uploaded via POST /patient/documents before the booking
    // exists, then carried in on the create call. `url` is a full
    // Cloudinary https URL, or a bare filename served off the /uploads
    // mount in local dev (same convention as Service.imageUrl).
    documents: {
      type: [
        {
          _id: false,
          name: { type: String, default: '' },
          url: { type: String, default: '' },
          mime: { type: String, default: '' },
          size: { type: Number, default: 0 },
          uploaded_at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

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
        // --- LEGACY deposit-first state ----------------------------------
        // Retired by the zero-cost booking flow: bookings used to be created
        // here, unpaid and invisible to triage, until a fixed ৳100 deposit
        // cleared. New bookings are created `submitted` instead. Kept in the
        // enum so in-flight rows stay readable and payable.
        'awaiting_deposit',
        // --- Four-phase lifecycle ----------------------------------------
        // Phase 2: the admin ran the review call and committed BOTH numbers
        // (total service fee + the deposit THIS booking must pay). The
        // patient now owes `required_deposit` to confirm the visit. No
        // provider may be dispatched until it clears.
        'deposit_required',
        // Phase 3: the admin-set deposit was confirmed by the gateway. The
        // booking is ready for deposit verification + team assignment.
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
    // THE total service fee for this visit, committed by the admin on the
    // Phase-2 review call. Serialized as `total_service_fee` for the clients
    // (see projectInvoice); `final_price` remains the storage name because
    // dispatch, the wallet ledger, the milestone engine and every legacy
    // route already read it. One number, two names — never two numbers.
    final_price: { type: Number, default: null },
    // Reused as the admin's onboarding-call summary (spec: adminNotes).
    admin_note: { type: String, default: null },

    // --- Dynamic deposit & dynamic invoicing -----------------------------
    // Confirmation deposit. `deposit_amount` is 0 until the gateway confirms,
    // then locked to whatever was actually PAID. The deposit is DEDUCTED from
    // the final bill:
    //   outstanding = final_price - deposit_amount - adjusted_discount.
    deposit_amount: { type: Number, default: 0 },
    // What the ADMIN decided this specific booking must deposit, set on the
    // Phase-2 review call alongside `final_price`. Null until then — which is
    // exactly what makes Phase 1 free: a booking with no `required_deposit`
    // owes nothing and shows ৳0 due at checkout.
    //
    // Per-booking by design. The platform-wide `Settings.booking_deposit_amount`
    // is now only a DEFAULT the admin console prefills the field with; a
    // cardiac post-op case and a routine dressing change do not owe the same
    // deposit, and the admin sets each one after speaking to the patient.
    required_deposit: { type: Number, default: null },
    deposit_set_at: { type: Date, default: null },
    // Who committed the fee + deposit, for the billing audit trail.
    deposit_set_by: { type: String, default: null },
    // What this booking was QUOTED. Mirrors `required_deposit` the moment the
    // admin sets it and is then immutable: an admin CORRECTING the fee must
    // never move the amount under a patient who is mid-checkout, and must
    // never make `/deposit/confirm` reject a payment opened against the old
    // number. Null on rows that never reached Phase 2.
    deposit_quoted_amount: { type: Number, default: null },
    deposit_transaction_id: { type: String, default: null },
    deposit_paid_at: { type: Date, default: null },
    // Last failed deposit attempt (gateway declined / validation rejected).
    // Purely informational: the booking stays `awaiting_deposit` and remains
    // payable, but the patient surface can say "your payment did not go
    // through" instead of the neutral "not paid yet". Cleared the moment a
    // later attempt settles, so it can never outlive the failure it records.
    deposit_failed_at: { type: Date, default: null },
    deposit_failure_reason: { type: String, default: null },
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

    // --- Phase 4: remaining-balance verification & prescription gate ------
    // Whether the money for the REMAINING balance has been verified by a
    // human, which is a stricter question than "did a payment land":
    //
    //   PENDING                     — nothing settled yet.
    //   PENDING_ADMIN_VERIFICATION  — CHANNEL B. The patient paid online; the
    //                                 transaction reference is recorded and an
    //                                 admin must confirm receipt in Finance &
    //                                 Billing. The prescription stays LOCKED.
    //   VERIFIED                    — the money is confirmed, through either
    //                                 channel, and `prescription_unlocked`
    //                                 flips true in the same write.
    //
    // CHANNEL A (cash) skips the middle state entirely: the clinician took the
    // notes in person and confirmed it on their console, so there is nothing
    // left for an admin to verify and the script unlocks instantly.
    remaining_payment_status: {
      type: String,
      enum: ['PENDING', 'PENDING_ADMIN_VERIFICATION', 'VERIFIED'],
      default: 'PENDING',
      index: true,
    },
    // Gateway/manual reference the admin reconciles against (bKash TrxID,
    // Nagad reference, card auth code). Written by the online balance
    // settlement; the admin reads it in the verification queue.
    remaining_payment_reference: { type: String, default: null },
    remaining_payment_verified_at: { type: Date, default: null },
    // Account id of the verifier, or a `system:` sentinel for the cash path
    // (the clinician's own confirmation IS the verification).
    remaining_payment_verified_by: { type: String, default: null },

    // The dual-gate latch. A prescription written for this visit stays
    // redacted until this is true, and it only ever becomes true alongside
    // `remaining_payment_status: 'VERIFIED'` — cash confirmed by the attending
    // clinician, or an online payment verified by an admin. Stored rather than
    // derived so the gate is auditable: "when did this unlock, and who did it".
    prescription_unlocked: { type: Boolean, default: false },
    prescription_unlocked_at: { type: Date, default: null },

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

// Canonical `status` → the four-phase lifecycle name the clients branch on.
//
// Derived, never stored, so the phase can never disagree with the status the
// payment and dispatch code actually runs on. The internal enum stays richer
// than four values (provider acceptance, nurse hand-off, terminal states);
// this is the projection down to the vocabulary the spec — and every client
// screen — speaks.
const PHASE_BY_STATUS = {
  // Phase 1 — placed for free, waiting on the admin's review call.
  submitted: 'REQUEST_SUBMITTED',
  awaiting_deposit: 'REQUEST_SUBMITTED', // legacy rows, never charged now
  // Phase 2 — fee + deposit committed; the patient owes the deposit.
  deposit_required: 'DEPOSIT_REQUIRED',
  // Phase 3 — deposit cleared; awaiting verification + team assignment.
  deposit_paid_admin_reviewing: 'DEPOSIT_PAID',
  approved: 'DEPOSIT_PAID',
  amount_assigned_awaiting_final_payment: 'DEPOSIT_PAID',
  // Phase 3 complete — a team is dispatched and the visit is running.
  assigned: 'ASSIGNED',
  enroute: 'ASSIGNED',
  on_the_way: 'ASSIGNED',
  arrived: 'ASSIGNED',
  in_service: 'ASSIGNED',
  nurse_completed: 'ASSIGNED',
  // Phase 4 — service delivered, remaining balance due.
  service_completed_awaiting_final_payment: 'SERVICE_COMPLETED',
  completed: 'COMPLETED',
  rejected: 'CANCELLED',
  cancelled: 'CANCELLED',
};

// Four-phase invoice projection.
//
// The stored fields are the ones the whole platform already runs on
// (`final_price`, `deposit_amount`, `adjusted_discount`,
// `payment_preference`). These derived aliases give every client the spec's
// vocabulary — total service fee, required deposit, remaining balance, and
// whether each of the three has been paid — without renaming storage under
// the admin console, the provider consoles and the milestone engine, all of
// which read the canonical names.
//
// `pricing_state` is the spec's UNDER_REVIEW / PRICE_SET progression,
// derived rather than stored so it can never drift from the money:
//   UNDER_REVIEW → admin has not committed a fee yet
//   PRICE_SET    → fee committed, a balance is still outstanding
//   SETTLED      → nothing left to collect
// Bookings whose admin-set deposit is still unpaid report AWAITING_DEPOSIT.
function projectInvoice(ret) {
  const fee = Number(ret.final_price) || 0;
  const deposit = Number(ret.deposit_amount) || 0;
  const depositPaid = Boolean(ret.deposit_paid_at) || deposit > 0;
  const posture = paymentPostureFor(ret);
  const remaining = posture.remainingBalance;
  const settled = posture.settled;

  // Has a deposit been committed for this booking yet? This — not the status,
  // and not the amount paid — is what separates Phase 1 from Phase 2, and it
  // is what makes the checkout screen legitimately free: a booking with no
  // committed deposit owes nothing.
  //
  // Reads the immutable quote as well as the admin-set amount, so a legacy
  // `awaiting_deposit` row (quoted under the retired flow, never given a
  // `required_deposit`) still correctly reports a deposit as OWED rather than
  // silently becoming free.
  const depositSet = hasRequiredDeposit(ret);

  ret.deposit_paid = depositPaid;
  // Four-state gate the patient app branches on directly, so no client ever
  // has to infer "is the deposit in?" from an amount or a status string:
  //   NOT_REQUIRED — Phase 1. The admin has not set a deposit; ৳0 is due and
  //                  no payment CTA may render. Never conflate with PENDING:
  //                  showing "Pay ৳100 deposit" on a free booking is exactly
  //                  the bug the zero-cost flow exists to remove.
  //   PENDING      — Phase 2. An amount is set and the patient owes it.
  //   FAILED       — the last attempt was declined; still owed, still payable.
  //   CONFIRMED    — the gateway settled it (money is in).
  ret.deposit_status = depositPaid
    ? 'CONFIRMED'
    : !depositSet
      ? 'NOT_REQUIRED'
      : ret.deposit_failed_at
        ? 'FAILED'
        : 'PENDING';
  // Spec alias: UNPAID | PAID, the plain answer to "has the deposit landed".
  ret.deposit_payment_status = depositPaid ? 'PAID' : 'UNPAID';
  // THE deposit figure for this booking, in one field the clients can render
  // verbatim in every state: what was paid if paid, what the admin set if not,
  // and null while no deposit has been set at all — which is what lets the
  // checkout screen show ৳0 rather than guessing at the platform default.
  ret.deposit_required_amount =
    depositPaid || depositSet
      ? requiredDepositFor(ret, cachedBookingDepositAmount())
      : null;
  // Spec name for the same number, alongside the fee it was derived from.
  ret.required_deposit = ret.deposit_required_amount;
  ret.total_service_fee = fee > 0 ? roundMoney(fee) : null;
  ret.final_service_price = ret.total_service_fee;
  ret.remaining_balance = settled ? 0 : remaining;
  // How the patient will settle what is left after the deposit, in the spec's
  // CASH | ONLINE vocabulary rather than the stored `payment_preference`
  // enum. Same normalization the provider consoles already gate on, so the
  // two can never name the same booking differently.
  ret.remaining_payment_method = posture.channel;
  // Normalized balance posture every client branches on. `payment_channel`
  // collapses the two stored enums (`payment_method` once settled, the
  // patient's `payment_preference` before that) into ONLINE | CASH, and
  // `payment_status` says whether the balance itself is PAID | PENDING.
  // `cash_collection_required` is the provider consoles' single gate for the
  // Collect Cash sheet — never re-derive it client-side.
  ret.payment_channel = posture.channel;
  ret.payment_status = posture.status;
  ret.cash_collection_required = posture.cashCollectable;

  // Where this booking sits in the four-phase lifecycle, and whether the
  // clinical payload it produced has been released. `prescription_unlocked`
  // is echoed with an explicit boolean cast so a legacy row that predates the
  // field reports `false` rather than `undefined` — a client reading
  // undefined as "not locked" would render the script it must not show.
  ret.booking_phase =
    PHASE_BY_STATUS[String(ret.status || '').toLowerCase()] ||
    'REQUEST_SUBMITTED';
  ret.prescription_unlocked = ret.prescription_unlocked === true;
  ret.remaining_payment_status = ret.remaining_payment_status || 'PENDING';

  if (!depositPaid) {
    ret.pricing_state = 'AWAITING_DEPOSIT';
  } else if (settled || remaining === 0) {
    ret.pricing_state = 'SETTLED';
  } else if (fee > 0) {
    ret.pricing_state = 'PRICE_SET';
  } else {
    ret.pricing_state = 'UNDER_REVIEW';
  }
  return ret;
}

CareRequestSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    projectInvoice(ret);
    // Derive the patient-facing tracker block (milestone key, step N of 6,
    // label, formatted schedule, and the full six-step timeline) from the
    // canonical status. Additive — every existing consumer ignores it, and
    // the patient app reads it instead of re-implementing the mapping.
    Object.assign(ret, describeMilestone(ret));
    return ret;
  },
});

module.exports = mongoose.model('CareRequest', CareRequestSchema);
