#!/usr/bin/env node
/**
 * One-shot migration: turn the compiled-in Home chip rail into Category
 * documents, and mint the reserved CARE_SERVICES section.
 *
 * The rail used to be a hardcoded three-entry list ('All', 'Post-op', 'Doctor
 * in Home') duplicated in src/utils/serviceCategories.js and the Flutter app.
 * It is now read from `/api/categories`, so on an existing deployment the rail
 * comes up with nothing but the implicit "All" pill until these rows exist.
 *
 *   node backend/scripts/seedHomeCategories.js            # report only
 *   node backend/scripts/seedHomeCategories.js --apply    # write
 *
 * DRY RUN IS THE DEFAULT.
 *
 * Idempotent: categories are matched by slug and sections by sectionKey, so
 * re-running never duplicates a pill and never overwrites a name, order, or
 * layout an admin has since changed in the CMS. It only ever creates what is
 * missing.
 *
 * Also reports which slugs the live catalog actually resolves to — a service
 * stored as 'Nursing' resolves to the 'nursing' slug, which matches no pill
 * until someone creates that category. Those are listed as suggestions, not
 * created: naming a customer-facing filter is a product decision.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Category = require('../src/models/Category');
const DynamicSection = require('../src/models/DynamicSection');
const Service = require('../src/models/Service');
const {
  SERVICE_CATEGORIES,
  categorySlug,
} = require('../src/utils/serviceCategories');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';
const APPLY = process.argv.includes('--apply');

const CARE_SERVICES_KEY = 'CARE_SERVICES';

// The Bengali labels the app already shipped for these two chips.
const BENGALI = {
  'Post-op': 'পোস্ট-অপারেটিভ',
  'Doctor in Home': 'হোম ডাক্তার',
};

// Host + database only — an Atlas URI carries the password inline, and this
// script gets run in terminals whose scrollback ends up in tickets.
function safeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);

  console.log(`\n  database: ${safeUri(MONGO_URI)}`);
  console.log(`  mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

  const existing = await Category.find().select('slug nameEn').lean();
  const bySlug = new Map(existing.map((c) => [c.slug, c]));

  const planned = [];
  SERVICE_CATEGORIES.forEach((name, i) => {
    const slug = categorySlug(name);
    if (bySlug.has(slug)) {
      console.log(`  [keep]   '${slug}' already exists as "${bySlug.get(slug).nameEn}"`);
      return;
    }
    planned.push({
      nameEn: name,
      nameBn: BENGALI[name] || null,
      slug,
      displayOrder: i,
      isActive: true,
    });
    console.log(`  [create] category '${slug}' — "${name}"`);
  });

  const careSection = await DynamicSection.findOne({ sectionKey: CARE_SERVICES_KEY })
    .select('_id layoutType')
    .lean();
  if (careSection) {
    console.log(`  [keep]   CARE_SERVICES section exists (layout ${careSection.layoutType})`);
  } else {
    console.log("  [create] CARE_SERVICES section — layout 'CAROUSEL'");
  }

  // What the catalog would join to, so the operator can see which pills are
  // worth creating by hand. `''` is uncategorized and belongs to no pill.
  const services = await Service.find().select('category').lean();
  const counts = new Map();
  for (const s of services) {
    const slug = categorySlug(s.category);
    if (!slug) continue;
    counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  const plannedSlugs = new Set(planned.map((p) => p.slug));
  const unmatched = [...counts.entries()]
    .filter(([slug]) => !bySlug.has(slug) && !plannedSlugs.has(slug))
    .sort((a, b) => b[1] - a[1]);

  if (unmatched.length > 0) {
    console.log(
      '\n  Catalog slugs with no pill. Services tagged with these stay visible\n' +
        '  under "All"; create a category in the CMS to give them a filter:\n',
    );
    for (const [slug, n] of unmatched) {
      console.log(`  [suggest] '${slug}' — ${n} service${n === 1 ? '' : 's'}`);
    }
  }

  const changes = planned.length + (careSection ? 0 : 1);
  if (changes === 0) {
    console.log('\n  Nothing to do — the rail is already seeded.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\n  ${changes} document(s) would be created. Re-run with --apply to write.\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  if (planned.length > 0) await Category.insertMany(planned);
  if (!careSection) {
    await DynamicSection.create({
      sectionKey: CARE_SERVICES_KEY,
      titleEn: 'Care services',
      titleBn: 'সেবা',
      // Care Services renders through the app's adaptive layout engine rather
      // than the generic template switch, but the field is `required`.
      uiTemplate: 'HORIZONTAL_PRODUCT_CARD',
      // Above every admin-created section; the patient renderer skips this
      // document in the generic list, so the index is for the CMS's ordering.
      orderIndex: -1,
      layoutType: 'CAROUSEL',
      isActive: true,
    });
  }

  console.log(`\n  Created ${changes} document(s).\n`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n  FAILED:', err.message, '\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
