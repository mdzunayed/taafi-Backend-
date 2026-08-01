// Canonical vocabulary for `Service.category`.
//
// The patient Home screen filters the care catalog with exactly three chips:
// All / Post-op / Doctor in Home. That only works if every stored category is
// one of two strings — historically it was a free-text field, so the database
// accumulated a third vocabulary of its own ('Recovery', 'Consultation',
// 'Diagnostics', …) that matched no chip at all.
//
// This module is the single source of truth for those strings and for the
// mapping that folds any legacy / hand-typed value onto them. Writes go
// through `normalizeServiceCategory` in routes/services.js, so the field is
// canonical by construction from that point on.
//
// MIRROR: frontend/lib/core/models/service_category.dart holds a hand-kept
// copy of the alias table below. The client normalizes too, because mobile
// builds are not force-updated and may talk to an API whose database has not
// been migrated yet — a client that trusted the raw value would silently show
// two empty chips. Keep the two tables in sync when adding an alias.

const POST_OP = 'Post-op';
const DOCTOR_IN_HOME = 'Doctor in Home';

// Ordered — this is also the chip order on the patient Home screen.
const SERVICE_CATEGORIES = [POST_OP, DOCTOR_IN_HOME];

// The empty string is a first-class value, not a failure: lab collection and
// nurse-on-call are neither post-op care nor a doctor visit. Uncategorized
// services stay visible under the 'All' chip.
const UNCATEGORIZED = '';

// Squashed alias → canonical. Keys have had every non-alphanumeric character
// stripped (see `squash`), so one entry covers 'Post-op', 'post op',
// 'POST_OP' and 'Post  Op' at once.
const ALIASES = new Map([
  // --- Post-op ---
  ['postop', POST_OP],
  ['postoperative', POST_OP],
  ['postopcare', POST_OP],
  ['postsurgery', POST_OP],
  ['postsurgical', POST_OP],
  ['postsurgerycare', POST_OP],
  ['recovery', POST_OP],
  ['rehabilitation', POST_OP],
  ['rehab', POST_OP],
  ['physiotherapy', POST_OP],
  ['physio', POST_OP],
  ['wound', POST_OP],
  ['woundcare', POST_OP],
  ['surgery', POST_OP],
  ['surgicalcare', POST_OP],

  // --- Doctor in Home ---
  ['doctorinhome', DOCTOR_IN_HOME],
  ['doctorathome', DOCTOR_IN_HOME],
  ['doctorhome', DOCTOR_IN_HOME],
  ['homedoctor', DOCTOR_IN_HOME],
  ['doctorhomevisit', DOCTOR_IN_HOME],
  ['doctorvisit', DOCTOR_IN_HOME],
  ['homevisit', DOCTOR_IN_HOME],
  ['consultation', DOCTOR_IN_HOME],
  ['doctorconsultation', DOCTOR_IN_HOME],
  ['physicianathome', DOCTOR_IN_HOME],
  ['gpvisit', DOCTOR_IN_HOME],
]);

// Collapses case, whitespace, hyphens and underscores into one lookup key.
function squash(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Any input → one of SERVICE_CATEGORIES, or '' when it maps to neither.
// Total and side-effect free: never throws, never returns null/undefined.
function normalizeServiceCategory(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) return UNCATEGORIZED;
  return ALIASES.get(squash(trimmed)) || UNCATEGORIZED;
}

module.exports = {
  POST_OP,
  DOCTOR_IN_HOME,
  SERVICE_CATEGORIES,
  UNCATEGORIZED,
  normalizeServiceCategory,
};
