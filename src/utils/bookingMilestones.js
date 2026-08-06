// Patient-facing booking milestone layer ("Foodpanda-style" order tracker).
//
// The canonical `care_requests.status` enum is rich (two-phase deposit
// states, provider-acceptance states, nurse hand-off, balance settlement)
// because payments, dispatch, chat gating, and the provider apps all reason
// off it. The PATIENT does not need that resolution — they need six legible
// steps. This module is the single mapping between the two, so the tracker
// UI can never drift from the lifecycle the rest of the system runs on.
//
// Nothing here mutates state; `applyMilestone` below returns the canonical
// status an admin milestone write should land on.

const {
  normalizeProviderType,
  providerTypeFromRole,
  inferProviderType,
  milestoneCopyFor,
  roleLabelFor,
  registrationLabelFor,
  preparationTipFor,
  DEFAULT_PROVIDER_TYPE,
} = require('./providerTypes');

// Ordered patient-visible lifecycle. `step` is 1-based and drives the
// segmented progress bar in the app.
//
// The labels here are the ROLE-NEUTRAL fallbacks. Steps 2–5 name whoever is
// attending ("Nurse On the Way", "Doctor Consultation in Progress") and are
// overridden per booking by `milestoneCopyFor` in utils/providerTypes.js;
// these strings only survive for a booking whose role can't be resolved.
const MILESTONES = [
  { key: 'REQUESTED', step: 1, label: 'Booking Received — Under Review' },
  { key: 'CONFIRMED', step: 2, label: 'Confirmed — Assigning Provider' },
  { key: 'SCHEDULED', step: 3, label: 'Provider Assigned — Scheduled' },
  { key: 'EN_ROUTE', step: 4, label: 'Healthcare Provider On the Way' },
  { key: 'IN_SERVICE', step: 5, label: 'Care Session in Progress' },
  { key: 'COMPLETED', step: 6, label: 'Service Complete' },
];

const TOTAL_STEPS = MILESTONES.length;

// Terminal-but-not-delivered. Deliberately outside the ordered list: it has
// no step number and the progress bar renders it as a stopped state.
const CANCELLED = { key: 'CANCELLED', step: 0, label: 'Booking Cancelled' };

const MILESTONE_BY_KEY = new Map(
  [...MILESTONES, CANCELLED].map((m) => [m.key, m]),
);

// Canonical `status` → patient milestone. Every value in the CareRequest
// status enum must appear here; `milestoneFor` falls back to REQUESTED for
// anything unmapped so a new backend state can never blank the tracker.
const MILESTONE_BY_STATUS = {
  awaiting_deposit: 'REQUESTED',
  submitted: 'REQUESTED',
  // The admin has priced the booking and the patient owes the deposit. Still
  // step 1 for the tracker: nothing is confirmed until the money lands, and
  // advancing the bar here would tell the patient their visit is booked when
  // it is waiting on them.
  deposit_required: 'REQUESTED',
  deposit_paid_admin_reviewing: 'REQUESTED',

  approved: 'CONFIRMED',
  amount_assigned_awaiting_final_payment: 'CONFIRMED',

  assigned: 'SCHEDULED',

  enroute: 'EN_ROUTE',
  on_the_way: 'EN_ROUTE',
  arrived: 'EN_ROUTE',

  in_service: 'IN_SERVICE',
  nurse_completed: 'IN_SERVICE',

  service_completed_awaiting_final_payment: 'COMPLETED',
  completed: 'COMPLETED',

  rejected: 'CANCELLED',
  cancelled: 'CANCELLED',
};

// Milestone → the canonical status an ADMIN milestone write lands on.
// This is the write-side inverse of the map above: several statuses collapse
// into one milestone, so we pick the state that best represents "the admin
// just moved the booking here".
const STATUS_BY_MILESTONE = {
  REQUESTED: 'submitted',
  CONFIRMED: 'approved',
  SCHEDULED: 'assigned',
  EN_ROUTE: 'enroute',
  IN_SERVICE: 'in_service',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

function milestoneFor(status) {
  const key = MILESTONE_BY_STATUS[String(status || '').toLowerCase()];
  return MILESTONE_BY_KEY.get(key) || MILESTONES[0];
}

function isValidMilestone(key) {
  return MILESTONE_BY_KEY.has(String(key || '').toUpperCase());
}

// Canonical status for a milestone write, or null when the key is unknown.
function statusForMilestone(key) {
  return STATUS_BY_MILESTONE[String(key || '').toUpperCase()] || null;
}

// Who is attending this booking, as the patient-facing copy should name them.
//
// Ordered by how much each source actually knows:
//   1. the dispatched provider's own role — a nursing booking escalated to a
//      doctor must say "Doctor On the Way", not "Nurse On the Way";
//   2. the booking's `provider_type`, copied from the booked service;
//   3. which legacy assignment id is filled, for bookings dispatched before
//      the snapshot existed (a doctor on the team wins: it is the more
//      specific claim, and a dual team is led by the doctor);
//   4. a read of the free-text `care_type`, for rows created before the
//      field existed at all;
//   5. NURSE, the majority of the catalog.
function resolveProviderType(doc) {
  if (!doc) return DEFAULT_PROVIDER_TYPE;
  const assigned = doc.assigned_provider || {};
  const legacyRole = doc.assigned_doctor_id
    ? 'doctor'
    : doc.assigned_nurse_id
      ? 'nurse'
      : null;
  return (
    normalizeProviderType(assigned.provider_type) ||
    normalizeProviderType(doc.provider_type) ||
    providerTypeFromRole(legacyRole) ||
    inferProviderType(doc.care_type) ||
    DEFAULT_PROVIDER_TYPE
  );
}

// Human label with the attending role and the scheduled time folded in, e.g.
// "Nurse Assigned — Scheduled for Today, 04:00 PM". Falls back to the bare
// step label when no time has been set by the admin yet.
function labelFor(milestone, scheduledTime, providerType) {
  const roleLabel = milestoneCopyFor(providerType, milestone.key) || milestone.label;
  if (milestone.key !== 'SCHEDULED') return roleLabel;
  const when = formatSchedule(scheduledTime);
  return when ? `${roleLabel} for ${when}` : roleLabel;
}

// "Today, 04:00 PM" / "Tomorrow, 09:30 AM" / "12 Aug, 03:00 PM".
// Rendered in Asia/Dhaka, the single market this product serves, so the
// string is stable regardless of where the API process runs.
const TZ = 'Asia/Dhaka';

function formatSchedule(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const dayKey = (d) =>
    d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600e3);

  const time = date.toLocaleTimeString('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  if (dayKey(date) === dayKey(now)) return `Today, ${time}`;
  if (dayKey(date) === dayKey(tomorrow)) return `Tomorrow, ${time}`;
  const day = date.toLocaleDateString('en-GB', {
    timeZone: TZ,
    day: 'numeric',
    month: 'short',
  });
  return `${day}, ${time}`;
}

// Builds the six-step vertical timeline the tracking screen renders.
//
// Each entry carries a `state` (done / current / upcoming) plus the best
// timestamp we can prove for that step. Exact stamps come from
// `status_history`; where a booking predates that field (or the step was
// reached through a flow that doesn't write history) we fall back to the
// dedicated timestamp columns the schema already keeps. Steps we genuinely
// have no time for report `timestamp: null` rather than inventing one.
function buildTimeline(doc, providerType = resolveProviderType(doc)) {
  const current = milestoneFor(doc.status);
  const cancelled = current.key === 'CANCELLED';
  const history = Array.isArray(doc.status_history) ? doc.status_history : [];

  // First recorded moment per milestone, so a bounce (enroute → arrived)
  // reports when the step was first entered.
  const stampByKey = new Map();
  const noteByKey = new Map();
  for (const entry of history) {
    if (!entry) continue;
    const key = String(entry.status || '').toUpperCase();
    if (!MILESTONE_BY_KEY.has(key)) continue;
    if (!stampByKey.has(key) && entry.timestamp) {
      stampByKey.set(key, entry.timestamp);
    }
    if (entry.note && !noteByKey.has(key)) noteByKey.set(key, entry.note);
  }

  // Derived fallbacks from columns the lifecycle already maintains.
  const derived = {
    REQUESTED: doc.created_at || null,
    CONFIRMED: doc.deposit_paid_at || null,
    SCHEDULED: doc.scheduled_time || null,
    COMPLETED: doc.completed_at || null,
  };

  return MILESTONES.map((m) => {
    let state = 'upcoming';
    if (!cancelled) {
      if (m.step < current.step) state = 'done';
      else if (m.step === current.step) state = 'current';
    }
    // A cancelled booking keeps the steps it genuinely completed marked
    // done, so the timeline still shows how far the visit actually got.
    if (cancelled && stampByKey.has(m.key)) state = 'done';

    const stamp = stampByKey.get(m.key) || derived[m.key] || null;
    return {
      key: m.key,
      step: m.step,
      total: TOTAL_STEPS,
      label: labelFor(m, doc.scheduled_time, providerType),
      state,
      // Only surface a timestamp for steps actually reached — a future
      // step must never show a time.
      timestamp: state === 'upcoming' ? null : stamp,
      note: noteByKey.get(m.key) || null,
    };
  });
}

// The full patient-facing tracker block, merged into the CareRequest
// toJSON payload. Additive: existing consumers ignore the extra keys.
function describeMilestone(doc) {
  const current = milestoneFor(doc.status);
  const providerType = resolveProviderType(doc);
  // The preparation guidance is only actionable while someone is on their way
  // or already working — showing it earlier is noise, later is too late.
  const showTip = current.key === 'EN_ROUTE' || current.key === 'IN_SERVICE';
  return {
    milestone: current.key,
    milestone_step: current.step,
    milestone_total: TOTAL_STEPS,
    milestone_label: labelFor(current, doc.scheduled_time, providerType),
    scheduled_time_label: formatSchedule(doc.scheduled_time),
    milestone_timeline: buildTimeline(doc, providerType),
    // The role the copy above is written for, echoed so the app can word its
    // own affordances ("Call Nurse") the same way without re-deriving it.
    resolved_provider_type: providerType,
    provider_role_label: roleLabelFor(providerType),
    provider_registration_label: registrationLabelFor(providerType),
    preparation_tip: showTip ? preparationTipFor(providerType) : null,
  };
}

// Appends one audit row. Returns the entry so callers can echo it.
// Keeps `status` as the MILESTONE key (not the canonical status) because
// this history exists to explain the patient-facing tracker.
function statusHistoryEntry(milestoneKey, note) {
  return {
    status: String(milestoneKey || '').toUpperCase(),
    timestamp: new Date(),
    note: (note || '').toString().trim() || null,
  };
}

module.exports = {
  MILESTONES,
  TOTAL_STEPS,
  CANCELLED,
  MILESTONE_BY_STATUS,
  STATUS_BY_MILESTONE,
  milestoneFor,
  resolveProviderType,
  isValidMilestone,
  statusForMilestone,
  formatSchedule,
  buildTimeline,
  describeMilestone,
  statusHistoryEntry,
};
