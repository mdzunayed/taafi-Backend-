#!/usr/bin/env node
/**
 * One-shot migration: fold every stored `Service.category` onto the canonical
 * vocabulary in src/utils/serviceCategories.js ('Post-op', 'Doctor in Home',
 * or '' for uncategorized).
 *
 * `category` was a free-text field for its whole life, so production holds a
 * vocabulary nobody designed — 'Recovery', 'Rehabilitation', 'Consultation',
 * 'Nursing', 'Diagnostics'. The patient Home screen now filters on an exact
 * match against two canonical labels, so until these rows are rewritten both
 * the Post-op and the Doctor-in-Home chip come up empty and the feature looks
 * broken.
 *
 *   node backend/scripts/normalizeServiceCategories.js            # report only
 *   node backend/scripts/normalizeServiceCategories.js --apply    # write
 *
 * DRY RUN IS THE DEFAULT. Read the CLEARED list before applying: those are
 * rows whose category maps to neither canonical value and will be blanked.
 * A blanked service is not hidden — it still appears under the 'All' chip —
 * but if one of them genuinely belongs to a category, re-tag it in the admin
 * console first and re-run.
 *
 * !! REDIS !! This script writes to Mongo directly and cannot purge the
 * running Express process's `cache('services')` entries. After --apply,
 * restart the API or wait out CACHE_TTL_SECONDS (300s), or GET /api/services
 * keeps serving the old categories and it looks like nothing happened.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Service = require('../src/models/Service');
const { normalizeServiceCategory } = require('../src/utils/serviceCategories');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';
const APPLY = process.argv.includes('--apply');

// Host + database only. The operator needs to see WHICH database they are
// about to rewrite — an Atlas URI carries the password inline, and this script
// gets run in terminals whose scrollback ends up in screenshots and tickets.
function safeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
}

// UNCHANGED  already exactly canonical (including a deliberate '')
// REMAPPED   a legacy/typo value that folds onto a canonical label
// CLEARED    a non-empty value that maps to neither → becomes ''
function classify(raw, next) {
  if (raw === next) return 'UNCHANGED';
  return next === '' ? 'CLEARED' : 'REMAPPED';
}

async function main() {
  await mongoose.connect(MONGO_URI);

  const docs = await Service.find().select('_id title category').lean();
  const buckets = { UNCHANGED: [], REMAPPED: [], CLEARED: [] };

  for (const doc of docs) {
    const raw = String(doc.category == null ? '' : doc.category);
    const next = normalizeServiceCategory(raw);
    buckets[classify(raw, next)].push({
      id: doc._id.toString(),
      title: doc.title,
      raw,
      next,
    });
  }

  const changes = [...buckets.REMAPPED, ...buckets.CLEARED];

  console.log(`\n  ${docs.length} service(s) in ${safeUri(MONGO_URI)}`);
  console.log(`  mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

  console.log(`  UNCHANGED  ${buckets.UNCHANGED.length}`);
  console.log(`  REMAPPED   ${buckets.REMAPPED.length}`);
  console.log(`  CLEARED    ${buckets.CLEARED.length}\n`);

  for (const r of buckets.REMAPPED) {
    console.log(`  [remap]  ${r.title}`);
    console.log(`           '${r.raw}' -> '${r.next}'`);
  }

  // Listed individually and last, because this is the bucket a human has to
  // make a judgement call on.
  if (buckets.CLEARED.length > 0) {
    console.log(
      '\n  These map to neither category and will be blanked. They stay\n' +
        "  visible under the 'All' chip. Re-tag any that belong somewhere:\n",
    );
    for (const r of buckets.CLEARED) {
      console.log(`  [clear]  ${r.title}`);
      console.log(`           '${r.raw}' -> '' (uncategorized)`);
    }
    console.log('');
  }

  if (changes.length === 0) {
    console.log('  Nothing to do — every category is already canonical.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!APPLY) {
    console.log(
      `  ${changes.length} row(s) would change. Re-run with --apply to write.\n`,
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  // bulkWrite/updateOne rather than doc.save(): a legacy row must not be put
  // through full-document validation on its way to being fixed, and this is
  // one round trip instead of N.
  const result = await Service.bulkWrite(
    changes.map((r) => ({
      updateOne: {
        filter: { _id: r.id },
        update: { $set: { category: r.next } },
      },
    })),
  );

  console.log(`  Updated ${result.modifiedCount} of ${changes.length} row(s).`);
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
