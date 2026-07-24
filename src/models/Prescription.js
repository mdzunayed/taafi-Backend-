const mongoose = require('mongoose');

// One prescription = one digital script issued by a doctor at the
// end of a visit. Contains N medication line items + structural
// timing metadata so the patient-side medication timeline can render
// per-slot reminders. `appointment_id` ties it back to the
// CareRequest the script came out of.

const FrequencySlotSchema = new mongoose.Schema(
  {
    morning: { type: Boolean, default: false },
    afternoon: { type: Boolean, default: false },
    night: { type: Boolean, default: false },
  },
  { _id: false }
);

// Doctor credentials frozen at issue time so an old script keeps
// rendering the pad header correctly even after the doctor edits
// their profile (degrees, registration, etc.).
const DoctorSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    degrees: { type: String, default: '', trim: true },
    // Current hospital/clinic or college affiliation printed under the
    // degrees line. Fed from Provider.hospital_affiliation.
    hospital_or_college: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    registration_number: { type: String, default: '', trim: true },
    specialization: { type: String, default: '', trim: true },
  },
  { _id: false }
);

// Platform branding frozen at issue time so the pad header keeps its
// historical wordmark/tagline even if we rebrand later. Null on legacy
// rows — readers fall back to the live 'Taafi' / tagline constants.
const BrandingSnapshotSchema = new mongoose.Schema(
  {
    brand_name: { type: String, default: 'Taafi', trim: true },
    tagline: {
      type: String,
      default: 'Your Trusted Home Healthcare Partner',
      trim: true,
    },
  },
  { _id: false }
);

// Patient metrics captured on the pad. Blood pressure is copied from
// the CareRequest's on-visit vitals; weight/height are entered by the
// doctor while prescribing.
const VitalsSnapshotSchema = new mongoose.Schema(
  {
    weight_kg: { type: Number, default: null, min: 0, max: 500 },
    height_cm: { type: Number, default: null, min: 0, max: 300 },
    blood_pressure: { type: String, default: '', trim: true },
  },
  { _id: false }
);

// Target-patient identity frozen at issue time. Null on a self-booking (the
// account holder) or legacy rows — readers then fall back to the account's
// own name. Populated from the CareRequest's care_recipient when the visit
// was booked for a dependent, so the printed pad shows the right person.
const PatientSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    age: { type: Number, default: null },
    gender: { type: String, default: '', trim: true },
    relationship: { type: String, default: '', trim: true },
    blood_group: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const PrescriptionItemSchema = new mongoose.Schema(
  {
    // Dosage form printed before the drug name on the pad ("Tab. Napa").
    // '' means unspecified (legacy rows / clients that don't send it) —
    // it must stay in the enum or re-saving old docs fails validation.
    form: {
      type: String,
      enum: ['TAB', 'CAP', 'SYR', 'INJ', 'CRM', 'DROP', ''],
      default: '',
    },
    drug_name: { type: String, required: true, trim: true, maxlength: 200 },
    dosage: { type: String, required: true, trim: true, maxlength: 120 },
    // Bilingual UX maps to a single canonical enum so the timeline
    // can group by slot.
    frequency: { type: FrequencySlotSchema, default: () => ({}) },
    // Meal context — one of 'before' | 'after' | 'either'. Deliberately
    // NOT extended for the prescription pad: the pad's instruction
    // column is a display mapping (before → "Before Meal", after →
    // "After Meal", either → "With/Without Meal"); "as needed" wording
    // belongs in `notes`.
    meal_context: {
      type: String,
      enum: ['before', 'after', 'either'],
      default: 'either',
    },
    duration_days: { type: Number, min: 1, max: 365, default: 7 },
    notes: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { _id: true }
);

const PrescriptionSchema = new mongoose.Schema(
  {
    appointment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CareRequest',
      required: true,
      index: true,
    },
    patient_account_id: {
      type: String,
      required: true,
      index: true,
    },
    doctor_account_id: {
      type: String,
      default: '',
    },
    doctor_name: { type: String, default: '', trim: true },
    // Pad header credentials frozen at issue time. Null on legacy rows —
    // readers fall back to the live `withDoctorBlocks` enrichment.
    doctor_snapshot: { type: DoctorSnapshotSchema, default: null },
    // Pad header branding frozen at issue time. Null on legacy rows.
    branding_snapshot: { type: BrandingSnapshotSchema, default: null },
    // Pad vitals bar. Null when nothing was captured.
    vitals_snapshot: { type: VitalsSnapshotSchema, default: null },
    // Target patient (dependent) identity frozen at issue time. Null = the
    // script is for the account holder themselves.
    patient_snapshot: { type: PatientSnapshotSchema, default: null },
    diagnosis: { type: String, default: '', trim: true, maxlength: 600 },
    // "Advice Given" free-text block on the pad footer.
    advice: { type: String, default: '', trim: true, maxlength: 1000 },
    // Next-appointment timeline shown in the pad footer.
    follow_up_date: { type: Date, default: null },
    items: {
      type: [PrescriptionItemSchema],
      validate: [(v) => v.length >= 1, 'At least one medication is required'],
      default: [],
    },
    issued_at: { type: Date, default: Date.now, index: true },
    // ── Secure release gate ─────────────────────────────────────────
    // A newly issued script stays LOCKED (server-side redacted) for the
    // patient until the platform unlock fee is PAID *and* an admin
    // APPROVES it. The issuing doctor, treating doctors and staff always
    // see full content. Rows created before this pipeline shipped are
    // grandfathered PAID+APPROVED by the boot-time self-heal in
    // server.js — schema defaults alone would retro-lock them on read.
    payment_status: {
      type: String,
      enum: ['PENDING', 'PAID', 'FAILED'],
      default: 'PENDING',
    },
    admin_approval_status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
    },
    // BDT fee snapshotted at issue time so a later env re-tune never
    // re-prices an already-issued script. 0 on grandfathered rows.
    unlock_fee_amount: { type: Number, default: 0 },
    unlock_transaction_id: { type: String, default: '' },
    paid_at: { type: Date, default: null },
    // Audit trail for the admin decision (covers approve AND reject).
    approved_by: { type: String, default: '' },
    approved_at: { type: Date, default: null },
    rejection_reason: { type: String, default: '', trim: true, maxlength: 500 },
    // Patient-side adherence tracking. Each `dose_log` entry is one
    // "Mark as Taken" tap. `prescription_item_id` references a row
    // inside `items`; `slot` is one of 'morning' | 'afternoon' |
    // 'night'; `taken_at` is the local timestamp.
    dose_log: {
      type: [
        new mongoose.Schema(
          {
            prescription_item_id: { type: mongoose.Schema.Types.ObjectId },
            slot: {
              type: String,
              enum: ['morning', 'afternoon', 'night'],
            },
            taken_at: { type: Date, default: Date.now },
            // YYYY-MM-DD bucket the dose belongs to. Stored
            // explicitly so the timeline can summarise per day
            // without re-deriving from `taken_at`.
            day_key: { type: String },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Admin review queue reads PAID+PENDING sorted oldest-paid-first.
PrescriptionSchema.index({
  payment_status: 1,
  admin_approval_status: 1,
  paid_at: 1,
});

PrescriptionSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id?.toString();
    ret.appointmentId = ret.appointment_id?.toString();
    ret.patientAccountId = ret.patient_account_id;
    delete ret._id;
    delete ret.appointment_id;
    delete ret.patient_account_id;
    return ret;
  },
});

module.exports = mongoose.model('Prescription', PrescriptionSchema);
