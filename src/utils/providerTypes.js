// Canonical vocabulary for WHO attends a booking, and every piece of
// role-dependent copy the patient tracker renders.
//
// A booking's provider type is not a cosmetic label — it decides the wording
// of four of the six tracker steps ("Nurse On the Way" vs "Doctor On the
// Way"), which registration number is shown on the provider card (BMDC vs
// Nursing Council), and which pre-arrival preparation tip the patient sees.
// Keeping all of it in one module means the wire enum, the timeline copy and
// the preparation guidance can never drift apart.
//
// MIRROR: frontend/lib/core/models/provider_type.dart carries a hand-kept
// copy of the enum + the label tables, for the same reason the service
// category vocabulary is duplicated (see utils/serviceCategories.js): mobile
// builds are not force-updated, and a client that could not name the role
// itself would fall back to generic copy the moment it hit an older payload.

const DOCTOR = 'DOCTOR';
const NURSE = 'NURSE';
const PHYSIOTHERAPIST = 'PHYSIOTHERAPIST';
const LAB_TECH = 'LAB_TECH';

const PROVIDER_TYPES = [DOCTOR, NURSE, PHYSIOTHERAPIST, LAB_TECH];

// The type a booking falls back to when nothing else can be derived. Home
// nursing is the majority of the catalog, so it is the least surprising
// answer for an un-tagged legacy row.
const DEFAULT_PROVIDER_TYPE = NURSE;

// Squashed alias → canonical, same convention as serviceCategories.js: keys
// have every non-alphanumeric character stripped, so one entry covers
// 'Lab Tech', 'lab_tech' and 'LAB-TECH' at once.
const ALIASES = new Map([
  ['doctor', DOCTOR],
  ['doctors', DOCTOR],
  ['dr', DOCTOR],
  ['physician', DOCTOR],
  ['consultant', DOCTOR],
  ['mbbs', DOCTOR],

  ['nurse', NURSE],
  ['nurses', NURSE],
  ['nursing', NURSE],
  ['staffnurse', NURSE],
  ['caregiver', NURSE],

  ['physiotherapist', PHYSIOTHERAPIST],
  ['physiotherapy', PHYSIOTHERAPIST],
  ['physio', PHYSIOTHERAPIST],
  ['therapist', PHYSIOTHERAPIST],
  ['physicaltherapist', PHYSIOTHERAPIST],
  ['physicaltherapy', PHYSIOTHERAPIST],

  ['labtech', LAB_TECH],
  ['lab', LAB_TECH],
  ['labtechnician', LAB_TECH],
  ['laboratorytechnician', LAB_TECH],
  ['labtest', LAB_TECH],
  ['samplecollection', LAB_TECH],
  ['phlebotomist', LAB_TECH],
  ['diagnostics', LAB_TECH],
]);

function squash(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Any input → one of PROVIDER_TYPES, or null when it maps to none. Returns
// null rather than the default on purpose: callers need to distinguish "the
// admin chose NURSE" from "nobody has said", and only the caller knows which
// fallback chain applies.
function normalizeProviderType(raw) {
  const key = squash(raw);
  if (!key) return null;
  const direct = PROVIDER_TYPES.find((t) => squash(t) === key);
  return direct || ALIASES.get(key) || null;
}

// `providers.role` ('doctor' | 'nurse' | 'helper') → provider type. A helper
// has no clinical role of its own, so it yields null and the booking's own
// type stands.
function providerTypeFromRole(role) {
  const key = squash(role);
  if (key === 'doctor') return DOCTOR;
  if (key === 'nurse') return NURSE;
  return null;
}

// Best-effort read of free text — a service title/category or a booking's
// `care_type`. Used only where no explicit type was ever stored (legacy rows
// created before this field existed). Returns null when the text says nothing
// about who attends, so the caller's own fallback applies.
function inferProviderType(...texts) {
  const haystack = texts
    .filter(Boolean)
    .map((t) => squash(t))
    .join(' ');
  if (!haystack) return null;

  // Ordered most-specific first: 'physiotherapy at home' contains both
  // 'physio' and 'home', and 'doctor consultation' contains both 'doctor'
  // and 'consultation'.
  const NEEDLES = [
    [PHYSIOTHERAPIST, ['physiotherap', 'physio', 'physicaltherap', 'rehabtherap']],
    [LAB_TECH, ['labtest', 'labtech', 'labsample', 'samplecollect', 'bloodcollect', 'phlebotom', 'diagnostic', 'pathology']],
    [DOCTOR, ['doctor', 'physician', 'mbbs', 'consultation', 'consult']],
    [NURSE, ['nurse', 'nursing', 'wounddressing', 'catheter', 'injection', 'postop', 'postsurger']],
  ];
  for (const [type, needles] of NEEDLES) {
    if (needles.some((n) => haystack.includes(n))) return type;
  }
  return null;
}

// Human role noun for badges and sentence copy ("Your Doctor", "Call Nurse").
const ROLE_LABELS = {
  [DOCTOR]: 'Doctor',
  [NURSE]: 'Nurse',
  [PHYSIOTHERAPIST]: 'Physiotherapist',
  [LAB_TECH]: 'Lab Technician',
};

function roleLabelFor(type) {
  return ROLE_LABELS[normalizeProviderType(type) || DEFAULT_PROVIDER_TYPE];
}

// Which registration body the provider's licence number belongs to. Printed
// next to the number on the assigned-provider card, so a patient can tell a
// BMDC registration from a Nursing Council one at a glance.
const REGISTRATION_LABELS = {
  [DOCTOR]: 'BMDC',
  [NURSE]: 'BNMC',
  [PHYSIOTHERAPIST]: 'BPA',
  [LAB_TECH]: 'Reg',
};

function registrationLabelFor(type) {
  return REGISTRATION_LABELS[
    normalizeProviderType(type) || DEFAULT_PROVIDER_TYPE
  ];
}

// Role-aware wording for the four tracker steps that name the attending
// provider. Steps 1 (REQUESTED) and 6 (COMPLETED) are role-neutral and keep
// the labels defined in bookingMilestones.js.
//
// PHYSIOTHERAPIST deliberately says "Specialist" rather than repeating the
// full noun — it is the wording the tracker spec calls for and it keeps the
// step from wrapping onto a third line on a narrow handset.
const MILESTONE_COPY = {
  [DOCTOR]: {
    CONFIRMED: 'Confirmed — Assigning Doctor',
    SCHEDULED: 'Doctor Assigned — Scheduled',
    EN_ROUTE: 'Doctor On the Way',
    IN_SERVICE: 'Doctor Consultation in Progress',
  },
  [NURSE]: {
    CONFIRMED: 'Confirmed — Assigning Nurse',
    SCHEDULED: 'Nurse Assigned — Scheduled',
    EN_ROUTE: 'Nurse On the Way',
    IN_SERVICE: 'Nursing Care in Progress',
  },
  [PHYSIOTHERAPIST]: {
    CONFIRMED: 'Confirmed — Assigning Specialist',
    SCHEDULED: 'Specialist Assigned — Scheduled',
    EN_ROUTE: 'Specialist On the Way',
    IN_SERVICE: 'Therapy Session in Progress',
  },
  [LAB_TECH]: {
    CONFIRMED: 'Confirmed — Assigning Lab Technician',
    SCHEDULED: 'Lab Technician Assigned — Scheduled',
    EN_ROUTE: 'Lab Technician On the Way',
    IN_SERVICE: 'Sample Collection in Progress',
  },
};

// Role-aware label for a milestone key, or null when that step carries no
// role-specific wording (REQUESTED / COMPLETED / CANCELLED).
function milestoneCopyFor(type, milestoneKey) {
  const table =
    MILESTONE_COPY[normalizeProviderType(type) || DEFAULT_PROVIDER_TYPE];
  return table[String(milestoneKey || '').toUpperCase()] || null;
}

// What the patient should have ready before the provider arrives. Shown while
// the visit is EN_ROUTE or IN_SERVICE — the only window where it can still
// change the outcome of the visit.
const PREPARATION_TIPS = {
  [DOCTOR]:
    'Please keep your past medical prescriptions and recent lab reports ready.',
  [NURSE]:
    'Ensure a clean, well-lit space and adequate water access for procedure setup.',
  [PHYSIOTHERAPIST]:
    'Clear a firm, flat space to move in and wear loose clothing. Keep any previous imaging or therapy notes at hand.',
  [LAB_TECH]:
    'Follow any fasting instructions given for your test, keep your ID and prior reports handy, and sit in a well-lit spot.',
};

function preparationTipFor(type) {
  return PREPARATION_TIPS[
    normalizeProviderType(type) || DEFAULT_PROVIDER_TYPE
  ];
}

module.exports = {
  DOCTOR,
  NURSE,
  PHYSIOTHERAPIST,
  LAB_TECH,
  PROVIDER_TYPES,
  DEFAULT_PROVIDER_TYPE,
  normalizeProviderType,
  providerTypeFromRole,
  inferProviderType,
  roleLabelFor,
  registrationLabelFor,
  milestoneCopyFor,
  preparationTipFor,
};
