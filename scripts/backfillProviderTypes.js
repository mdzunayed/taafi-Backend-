#!/usr/bin/env node
/**
 * One-shot backfill: give every untagged `Service` and every in-flight
 * `CareRequest` an explicit `provider_type` (DOCTOR / NURSE /
 * PHYSIOTHERAPIST / LAB_TECH — see src/utils/providerTypes.js).
 *
 * The patient tracker words four of its six steps after whoever is attending
 * ("Nurse On the Way" vs "Doctor On the Way"), and picks the pre-arrival
 * preparation tip the same way. Rows created before the field existed carry
 * nothing, so the API infers a type from their title / category / care_type on
 * every read. That inference is correct but invisible: nobody can see it in the
 * admin console, and nobody can correct it. This script persists it once so the
 * value becomes reviewable data instead of a permanent guess.
 *
 *   node backend/scripts/backfillProviderTypes.js            # report only
 *   node backend/scripts/backfillProviderTypes.js --apply    # write
 *
 * DRY RUN IS THE DEFAULT. Read the report before applying: anything listed as
 * UNRESOLVED could not be inferred from its text at all and is left untagged
 * (the API keeps falling back to NURSE for it). Tag those in the admin console
 * — a lab-collection service silently worded as nursing care is exactly the
 * kind of thing this field exists to prevent.
 *
 * Rows that already carry a type are never touched, in either collection.
 *
 * !! REDIS !! Services are served through `cache('services')`. After --apply,
 * restart the API or wait out CACHE_TTL_SECONDS (300s), or GET /api/services
 * keeps serving the old payloads and it looks like nothing happened.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Service = require('../src/models/Service');
const CareRequest = require('../src/models/CareRequest');
const {
  normalizeProviderType,
  inferProviderType,
} = require('../src/utils/providerTypes');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';
const APPLY = process.argv.includes('--apply');

// Host + database only — an Atlas URI carries its password inline and this
// output ends up in screenshots and tickets.
function safeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
}

// Split rows into: already tagged / inferable / not inferable.
function plan(rows, label) {
  const tagged = [];
  const resolved = [];
  const unresolved = [];
  for (const row of rows) {
    if (normalizeProviderType(row.stored)) {
      tagged.push(row);
      continue;
    }
    const next = inferProviderType(...row.texts);
    if (next) resolved.push({ ...row, next });
    else unresolved.push(row);
  }
  return { label, tagged, resolved, unresolved };
}

function report({ label, tagged, resolved, unresolved }) {
  console.log(`\n  ${label}`);
  console.log(`    already tagged  ${tagged.length}`);
  console.log(`    inferable       ${resolved.length}`);
  console.log(`    UNRESOLVED      ${unresolved.length}\n`);

  for (const r of resolved) {
    console.log(`    [tag]    ${r.name}`);
    console.log(`             -> ${r.next}`);
  }
  if (unresolved.length) {
    console.log(
      '\n    No role could be read from these. They stay untagged and the\n' +
        '    API will keep wording their tracker as nursing care — tag any\n' +
        '    that are not, in the admin console:\n',
    );
    for (const r of unresolved) console.log(`    [skip]   ${r.name}`);
    console.log('');
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);

  const services = await Service.find()
    .select('_id title category provider_type')
    .lean();
  const servicePlan = plan(
    services.map((d) => ({
      id: d._id,
      name: d.title,
      stored: d.provider_type,
      texts: [d.title, d.category],
    })),
    `SERVICES (${services.length}) in ${safeUri(MONGO_URI)}`,
  );

  // Only bookings still in flight. A finished visit's wording is history —
  // rewriting it would change what a patient was told after the fact.
  const TERMINAL = ['completed', 'cancelled', 'rejected'];
  const requests = await CareRequest.find({ status: { $nin: TERMINAL } })
    .select('_id care_type provider_type assigned_doctor_id assigned_nurse_id')
    .lean();
  const requestPlan = plan(
    requests.map((d) => ({
      id: d._id,
      name: `${d.care_type} (${d._id})`,
      stored: d.provider_type,
      // The dispatched role outranks the free text: a doctor on the team means
      // the tracker should say "Doctor", whatever the service was called.
      texts: d.assigned_doctor_id
        ? ['doctor']
        : d.assigned_nurse_id
          ? ['nurse']
          : [d.care_type],
    })),
    `ACTIVE BOOKINGS (${requests.length})`,
  );

  console.log(`\n  mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  report(servicePlan);
  report(requestPlan);

  const total = servicePlan.resolved.length + requestPlan.resolved.length;
  if (total === 0) {
    console.log('  Nothing to do — nothing inferable is untagged.\n');
    await mongoose.disconnect();
    process.exit(0);
  }
  if (!APPLY) {
    console.log(`  ${total} row(s) would change. Re-run with --apply to write.\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // bulkWrite/updateOne rather than doc.save(): a legacy row must not be put
  // through full-document validation on its way to being fixed.
  const writes = async (Model, rows) =>
    rows.length
      ? (
          await Model.bulkWrite(
            rows.map((r) => ({
              updateOne: {
                filter: { _id: r.id },
                update: { $set: { provider_type: r.next } },
              },
            })),
          )
        ).modifiedCount
      : 0;

  const changedServices = await writes(Service, servicePlan.resolved);
  const changedRequests = await writes(CareRequest, requestPlan.resolved);

  console.log(`  Updated ${changedServices} service(s), ${changedRequests} booking(s).`);
  console.log(
    '\n  Redis: restart the API (or wait 300s) before checking\n' +
      '  GET /api/services — this script cannot purge its read cache.\n',
  );

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
