// Builds the populated `doctor` block that the patient endpoints attach to
// a CareRequest when it has an assigned doctor. `assigned_doctor_id` is a
// free-form String (legacy schema — not an ObjectId ref), so we can't use
// Mongoose `.populate()`; this helper performs the manual join and walks
// both `providers` (the canonical doctor profile) and `accounts` (the
// signed-in identity) so the patient sees a complete profile regardless of
// which id the admin happened to assign.

const mongoose = require('mongoose');
const Provider = require('../models/Provider');
const Account = require('../models/Account');
const {
  NURSE,
  normalizeProviderType,
  providerTypeFromRole,
} = require('./providerTypes');
const { describeMilestone } = require('./bookingMilestones');

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

// Resolve a provider by id that may point at either the Provider doc or
// the signed-in Account. Mirrors the `resolveDoctor` helper in
// routes/doctor.js but is exposed for cross-route reuse AND is
// role-agnostic — the `role` arg defaults to 'doctor' for backward
// compatibility but accepts 'nurse' / 'helper' so the assign /
// populate paths can resolve any provider type uniformly.
async function loadProviderPair(providerId, role = 'doctor') {
  if (!providerId || !mongoose.isValidObjectId(providerId)) {
    return { provider: null, account: null };
  }
  let provider = await Provider.findById(providerId);
  let account = null;
  if (provider) {
    if (provider.email) {
      account = await Account.findOne({ email: provider.email });
    }
    if (!account && provider.full_name) {
      account = await Account.findOne({ full_name: provider.full_name, role });
    }
  } else {
    account = await Account.findById(providerId);
    if (account) {
      if (account.email) {
        provider = await Provider.findOne({ email: account.email, role });
      }
      if (!provider && account.full_name) {
        provider = await Provider.findOne({ full_name: account.full_name, role });
      }
    }
  }
  return { provider, account };
}

// Backward-compatible alias — every existing caller (admin assign,
// doctor profile, etc.) wants the doctor-role variant.
async function loadDoctorPair(doctorId) {
  return loadProviderPair(doctorId, 'doctor');
}

// Public read-only shape returned to patients. Snake_case on the wire to
// match the rest of the API. Phone is included so the Flutter app can do
// `tel:` deep-links. Works for both doctor and nurse roles — the caller
// decides which `assigned_*_id` to feed in, and the licence field naming
// adapts to the provider's `role`.
function buildDoctorView({ provider, account }) {
  if (!provider && !account) return null;
  const p = provider || {};
  const a = account || {};
  const role = firstNonEmpty(p.role, a.role) || 'doctor';
  const isNurse = role === 'nurse';
  return {
    id: (provider?._id || account?._id || '').toString(),
    role,
    full_name: firstNonEmpty(p.full_name, a.full_name),
    profile_picture: firstNonEmpty(
      p.profile_picture,
      a.profile_picture,
      a.photo_url,
    ),
    specialty: firstNonEmpty(p.specialty, p.specialization),
    specialization: firstNonEmpty(p.specialization, p.specialty),
    degrees: firstNonEmpty(p.degrees),
    years_experience: Number(p.years_experience) || 0,
    rating: Number(p.rating) || 0,
    review_count: Number(p.review_count) || 0,
    phone: firstNonEmpty(p.phone, a.phone),
    email: firstNonEmpty(p.email, a.email),
    bmdc_license: firstNonEmpty(p.bmdc_license),
    nursing_license: firstNonEmpty(p.nursing_license),
    license:
      firstNonEmpty(
        isNurse ? p.nursing_license : p.bmdc_license,
        p.bmdc_license,
        p.nursing_license,
      ) || '',
    hospital_affiliation: firstNonEmpty(p.hospital_affiliation),
    bio: firstNonEmpty(p.bio),
    is_verified_doctor:
      p.is_verified_doctor === true ||
      (role === 'doctor' && p.verification_status === 'verified'),
    is_verified_nurse:
      p.is_verified_nurse === true ||
      (role === 'nurse' && p.verification_status === 'verified'),
    verification_status: firstNonEmpty(p.verification_status) || 'pending',
    fee: Number(p.fee) || 0,
    service_radius_km: Number(p.service_radius_km) || 0,
    experience: Array.isArray(p.experience)
      ? p.experience.map((e) => ({
          hospital_name: firstNonEmpty(e.hospital_name),
          designation: firstNonEmpty(e.designation),
          years: Number(e.years) || 0,
          started_at: e.started_at || null,
          ended_at: e.ended_at || null,
        }))
      : [],
  };
}

// Whether a Provider row carries the minimum clinical credentials needed
// to issue a prescription. These four fields become the pad header
// (`doctor_snapshot`) frozen onto every script — an issued script with a
// blank header is worthless, so we gate creation on them. `specialization`
// and `email` are intentionally NOT required (they have sensible fallbacks
// on the pad). Kept here so the prescription gate and the profile-status
// endpoint share one definition of "complete".
function credentialsComplete(provider) {
  const p = provider || {};
  const filled = (v) => typeof v === 'string' && v.trim() !== '';
  return (
    filled(p.full_name) &&
    filled(p.degrees) &&
    filled(p.hospital_affiliation) &&
    filled(p.bmdc_license)
  );
}

// How the provider's role should read on the patient's card, e.g. "General
// Physician", "Senior Care Nurse". Built from what the provider actually
// filled in — specialisation first, then their current designation from the
// most recent experience row, then their degrees. Returns '' when the profile
// carries none of it: a blank line is honest, an invented title is not.
function designationFor({ provider, account }) {
  const p = provider || {};
  const latest = Array.isArray(p.experience) && p.experience.length
    ? p.experience[p.experience.length - 1]
    : null;
  return String(
    firstNonEmpty(
      p.specialization,
      p.specialty,
      latest && latest.designation,
      p.degrees,
      account && account.designation,
    ) || '',
  ).trim();
}

/**
 * Snapshot of the provider the patient is expecting at their door — name,
 * photo, phone, designation and registration number — in the shape the
 * `care_requests.assigned_provider` sub-document stores.
 *
 * `stored` is that sub-document as it was frozen at dispatch time. Live
 * provider fields win where they exist (a provider who changed their number
 * must be reachable on the new one), and the snapshot fills every gap, so a
 * booking whose provider has since left the platform still renders a complete
 * card. Returns null when neither source can even name the provider — the UI
 * treats that as "no provider assigned yet" and shows nothing.
 */
function buildAssignedProvider({ provider, account, stored, providerType }) {
  const p = provider || {};
  const a = account || {};
  const snapshot = stored || {};

  const type =
    normalizeProviderType(providerType) ||
    providerTypeFromRole(firstNonEmpty(p.role, a.role)) ||
    normalizeProviderType(snapshot.provider_type) ||
    null;

  const isNurse = type === NURSE;
  const name = String(
    firstNonEmpty(p.full_name, a.full_name, snapshot.name) || '',
  ).trim();
  if (!name) return null;

  const blankToNull = (v) => {
    const s = String(v == null ? '' : v).trim();
    return s === '' ? null : s;
  };

  return {
    provider_id:
      (provider && provider._id ? provider._id.toString() : null) ||
      (account && account._id ? account._id.toString() : null) ||
      (snapshot.provider_id ? snapshot.provider_id.toString() : null),
    provider_type: type,
    name,
    photo_url: blankToNull(
      firstNonEmpty(
        p.profile_picture,
        a.profile_picture,
        a.photo_url,
        snapshot.photo_url,
      ),
    ),
    phone: blankToNull(firstNonEmpty(p.phone, a.phone, snapshot.phone)),
    designation: blankToNull(
      firstNonEmpty(designationFor({ provider, account }), snapshot.designation),
    ),
    // Whichever council the provider's role answers to, falling back to the
    // other licence field so a mis-filed number still reaches the patient.
    registration_no: blankToNull(
      firstNonEmpty(
        isNurse ? p.nursing_license : p.bmdc_license,
        p.bmdc_license,
        p.nursing_license,
        snapshot.registration_no,
      ),
    ),
    assigned_at: snapshot.assigned_at || null,
  };
}

// Attach populated doctor + nurse blocks onto a serialized CareRequest.
// Returns the same JSON object, plus `doctor` and `nurse` fields (each
// may be `null` when no assignment exists yet). Swallows lookup
// failures so a busted provider row never breaks the patient's
// tracking screen — the response simply omits the extra block in that
// case. The two lookups run in parallel since they're independent.
async function attachDoctorToRequest(requestJson) {
  if (!requestJson) return requestJson;
  const doctorId = requestJson.assigned_doctor_id;
  const nurseId = requestJson.assigned_nurse_id;

  const [doctorPair, nursePair] = await Promise.all([
    doctorId
      ? loadProviderPair(doctorId, 'doctor').catch(() => null)
      : Promise.resolve(null),
    nurseId
      ? loadProviderPair(nurseId, 'nurse').catch(() => null)
      : Promise.resolve(null),
  ]);

  requestJson.doctor = doctorPair ? buildDoctorView(doctorPair) : null;
  requestJson.nurse = nursePair ? buildDoctorView(nursePair) : null;

  // The single provider the patient coordinates with directly. A dual team is
  // led by the doctor, so they are the contact; a nurse-only visit is the
  // nurse. Built live off the provider record and backfilled from the
  // dispatch-time snapshot, so it is correct for bookings dispatched before
  // the snapshot field existed too.
  const stored = requestJson.assigned_provider || null;
  const leadPair = doctorPair || nursePair;
  const assignedProvider = leadPair
    ? buildAssignedProvider({
        ...leadPair,
        stored,
        providerType: stored && stored.provider_type,
      })
    : stored && stored.name
      ? buildAssignedProvider({ provider: null, account: null, stored })
      : null;
  requestJson.assigned_provider = assignedProvider;

  // Re-derive the tracker now that the attending role is known for certain.
  // `describeMilestone` already ran inside the model's toJSON transform, but
  // it could only see the stored snapshot — a legacy booking dispatched before
  // that field existed would have been worded from `care_type` alone.
  Object.assign(requestJson, describeMilestone(requestJson));
  return requestJson;
}

/**
 * Serialize a batch of prescriptions with each row's issuing doctor
 * resolved into a full public `doctor` block (photo, specialization,
 * hospital affiliation, BMDC licence, verified flag, …). The patient's
 * Medications hub and the admin review queue render the doctor header
 * card straight off this block. One provider lookup per distinct
 * doctor, ran in parallel; best-effort — a busted provider row simply
 * omits the block.
 */
async function withDoctorBlocks(docs) {
  const ids = [
    ...new Set(docs.map((d) => d.doctor_account_id).filter(Boolean)),
  ];
  const views = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const pair = await loadProviderPair(id, 'doctor');
        const view = buildDoctorView(pair);
        if (view) views.set(id, view);
      } catch (_) {
        /* credential join is non-fatal */
      }
    }),
  );
  return docs.map((d) => {
    const out = d.toJSON();
    const view = views.get(d.doctor_account_id);
    if (view) out.doctor = view;
    return out;
  });
}

module.exports = {
  loadDoctorPair,
  loadProviderPair,
  buildDoctorView,
  buildAssignedProvider,
  designationFor,
  credentialsComplete,
  attachDoctorToRequest,
  withDoctorBlocks,
};
