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

// Any label → lowercase kebab-case. 'Doctor in Home' → 'doctor-in-home',
// 'Post-op' → 'post-op'. Used to mint a Category slug from its English name.
function slugify(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The join key between a free-text `Service.category` and a Category document.
//
// Differs from `normalizeServiceCategory` in exactly one way, and it matters:
// that function collapses anything outside the two compiled labels to '',
// which was correct when the chip rail was a fixed list — an unrecognised
// value had no pill to belong to. Now that admins mint categories at runtime,
// 'Nursing' is a perfectly good category the alias table has simply never
// heard of, so an unrecognised value slugifies as itself instead of vanishing.
//
// The alias fold still runs first, so a legacy row storing 'Recovery' resolves
// to 'post-op' and keeps matching the Post-op pill exactly as it does today.
// Returns '' for uncategorized services, which match no pill but stay visible
// under "All".
function categorySlug(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) return UNCATEGORIZED;
  const canonical = ALIASES.get(squash(trimmed));
  return slugify(canonical || trimmed);
}

// Every pill slug a service belongs under, most-significant first.
//
// A service reaches a pill two ways now:
//
//   1. `categoryIds` — the explicit multi-select an admin ticks in the CMS.
//   2. `category`    — the legacy free-text field, folded through
//                      `categorySlug` exactly as it always has been.
//
// (1) WINS OUTRIGHT when it is non-empty, rather than unioning with (2). The
// admin form seeds the checkboxes from the legacy match when a service has
// never been assigned, so an operator who then unticks a pill did so on
// purpose — unioning would have made that unticking a no-op and the CMS a lie.
// An empty `categoryIds` means "never assigned", and the legacy join stands.
//
// `categoryById` maps a category id (String) to its document; ids that resolve
// to nothing (a pill deleted since assignment) are dropped rather than emitted
// as dangling slugs. Pure and total: never throws, always returns an array.
function resolveCategorySlugs(service, categoryById) {
  const ids = Array.isArray(service && service.categoryIds)
    ? service.categoryIds
    : [];
  const out = [];
  for (const raw of ids) {
    // Tolerates a raw ObjectId, a String, and a populated document.
    const id = String((raw && (raw._id || raw.id)) || raw || '');
    const doc = id && categoryById ? categoryById.get(id) : null;
    const slug = doc && doc.slug ? String(doc.slug) : '';
    if (slug && !out.includes(slug)) out.push(slug);
  }
  if (out.length > 0) return out;

  const legacy = categorySlug(service && service.category);
  return legacy ? [legacy] : [];
}

module.exports = {
  POST_OP,
  DOCTOR_IN_HOME,
  SERVICE_CATEGORIES,
  UNCATEGORIZED,
  normalizeServiceCategory,
  slugify,
  categorySlug,
  resolveCategorySlugs,
};
