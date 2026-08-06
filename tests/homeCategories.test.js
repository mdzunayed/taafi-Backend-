/**
 * Home category rail test.
 *
 * Covers the join that makes a dynamic chip rail work at all: a service
 * carries free-text `category`, a Category document carries a `slug`, and
 * `categorySlug` is the only thing connecting them. Get it wrong in either
 * direction and the symptom is identical to the bug this feature replaced —
 * pills that are present but permanently empty.
 *
 * The specific risk is the difference from `normalizeServiceCategory`, which
 * collapses anything outside the two compiled labels to ''. That was right
 * when the rail was fixed; it is wrong now, because an admin can mint
 * 'Nursing' at runtime and the fold would erase it before it ever matched.
 *
 * Runs without a database — every function under test is pure.
 *
 *   node backend/tests/homeCategories.test.js
 */

const assert = require('node:assert');

const {
  categorySlug,
  slugify,
  normalizeServiceCategory,
  resolveCategorySlugs,
} = require('../src/utils/serviceCategories');
const { _sanitizeItems: sanitizeItems, _decorate: decorate } =
  require('../src/routes/homeSections');

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`    ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`    FAIL  ${name}\n          ${err.message}`);
  }
}

console.log('\n  categorySlug: joining a service to its pill');

check('canonical labels slugify to kebab-case', () => {
  assert.strictEqual(categorySlug('Post-op'), 'post-op');
  assert.strictEqual(categorySlug('Doctor in Home'), 'doctor-in-home');
});

check('legacy aliases still fold onto the canonical slug', () => {
  // The whole point of keeping the alias table: a row stored as 'Recovery'
  // must keep matching the Post-op pill, not become its own orphan slug.
  assert.strictEqual(categorySlug('Recovery'), 'post-op');
  assert.strictEqual(categorySlug('physiotherapy'), 'post-op');
  assert.strictEqual(categorySlug('Consultation'), 'doctor-in-home');
});

check('an unrecognised category becomes its own slug, not nothing', () => {
  // normalizeServiceCategory erases these; categorySlug must not, or an
  // admin-created 'Nursing' pill could never match a service.
  assert.strictEqual(normalizeServiceCategory('Nursing'), '');
  assert.strictEqual(categorySlug('Nursing'), 'nursing');
  assert.strictEqual(categorySlug('Lab Collection'), 'lab-collection');
});

check('blank stays blank — uncategorized belongs to no pill', () => {
  assert.strictEqual(categorySlug(''), '');
  assert.strictEqual(categorySlug('   '), '');
  assert.strictEqual(categorySlug(null), '');
  assert.strictEqual(categorySlug(undefined), '');
});

check('case, spacing and punctuation collapse to one slug', () => {
  const want = 'post-op';
  for (const raw of ['Post-op', 'post op', 'POST_OP', '  Post  Op  ']) {
    assert.strictEqual(categorySlug(raw), want, `'${raw}'`);
  }
});

check('slugify trims leading and trailing separators', () => {
  assert.strictEqual(slugify('  Doctor in Home!  '), 'doctor-in-home');
  assert.strictEqual(slugify('--Nursing--'), 'nursing');
});

console.log('\n  sanitizeItems: a card\'s category tag');

const card = (over = {}) => ({
  itemId: 'srv_01',
  title: 'Doctor home visit',
  imageUrl: 'https://cdn.taafi.app/images/doctor_visit.jpg',
  targetType: 'NONE',
  ...over,
});

check('a valid categoryId is stored', () => {
  const id = '507f1f77bcf86cd799439011';
  const [item] = sanitizeItems([card({ categoryId: id })]);
  assert.strictEqual(item.categoryId, id);
});

check('a populated category object is accepted, not just a bare id', () => {
  // The CMS reads a section (categoryId comes back flattened, `category`
  // holds the snapshot) and PUTs it straight back; both shapes must survive.
  const id = '507f1f77bcf86cd799439011';
  const [item] = sanitizeItems([card({ categoryId: { id, slug: 'nursing' } })]);
  assert.strictEqual(item.categoryId, id);
});

check('absent, blank and null all mean untagged', () => {
  for (const raw of [undefined, null, '']) {
    const [item] = sanitizeItems([card({ categoryId: raw })]);
    assert.strictEqual(item.categoryId, null, JSON.stringify(raw));
  }
});

check('a malformed categoryId is rejected rather than stored', () => {
  assert.throws(
    () => sanitizeItems([card({ categoryId: 'not-an-object-id' })]),
    /categoryId must be a valid category id/,
  );
});

check('a card saved before categories existed stays untagged, not dropped', () => {
  const [item] = sanitizeItems([card()]);
  assert.strictEqual(item.categoryId, null);
  assert.strictEqual(item.title, 'Doctor home visit');
});

console.log('\n  decorate: what the client filters on');

// Stands in for a mongoose doc — decorate only calls toJSON().
const docOf = (contentData) => ({
  toJSON: () => ({
    id: 'sec1',
    sectionKey: 'CARE_SERVICES',
    layoutType: 'GRID_2_COL',
    contentData,
  }),
});

check('a populated category is flattened to an id + slug + snapshot', () => {
  const out = decorate(
    docOf([
      card({
        categoryId: {
          _id: '507f1f77bcf86cd799439011',
          slug: 'doctor-in-home',
          nameEn: 'Doctor in Home',
          nameBn: 'হোম ডাক্তার',
        },
      }),
    ]),
  );
  const [item] = out.contentData;
  assert.strictEqual(item.categoryId, '507f1f77bcf86cd799439011');
  assert.strictEqual(item.categorySlug, 'doctor-in-home');
  assert.strictEqual(item.category.nameEn, 'Doctor in Home');
  assert.strictEqual(item.category.nameBn, 'হোম ডাক্তার');
});

check('an unpopulated id still round-trips so the CMS keeps the tag', () => {
  const out = decorate(docOf([card({ categoryId: '507f1f77bcf86cd799439011' })]));
  const [item] = out.contentData;
  assert.strictEqual(item.categoryId, '507f1f77bcf86cd799439011');
  // No slug to filter on, but the tag survives the next save.
  assert.strictEqual(item.categorySlug, null);
  assert.strictEqual(item.category, null);
});

check('an untagged card reaches the client as an explicit null', () => {
  const out = decorate(docOf([card()]));
  const [item] = out.contentData;
  assert.strictEqual(item.categoryId, null);
  assert.strictEqual(item.categorySlug, null);
});

check('layoutType survives to the wire', () => {
  assert.strictEqual(decorate(docOf([])).layoutType, 'GRID_2_COL');
});


// --- resolveCategorySlugs: explicit assignment vs. the legacy fold -----------
//
// The rule this pins is the one an admin can actually feel: once a service has
// ANY explicit `categoryIds`, those decide where it appears and the free-text
// `category` stops mattering. Union the two instead and unticking a pill in the
// CMS silently does nothing, which is the worst kind of CMS bug — the screen
// says one thing and the app does another.

console.log('\n  resolveCategorySlugs: which pills a service lands on');

const CAT_A = '507f1f77bcf86cd799439011';
const CAT_B = '507f1f77bcf86cd799439012';
const byId = new Map([
  [CAT_A, { _id: CAT_A, slug: 'nursing', nameEn: 'Nursing' }],
  [CAT_B, { _id: CAT_B, slug: 'lab-tests', nameEn: 'Lab tests' }],
]);

check('no assignment falls back to the legacy free-text join', () => {
  assert.deepStrictEqual(
    resolveCategorySlugs({ category: 'Recovery', categoryIds: [] }, byId),
    ['post-op'],
  );
});

check('an explicit assignment wins outright over the legacy category', () => {
  // 'Recovery' would fold to 'post-op'; the admin said Nursing, so Nursing it
  // is — and post-op is NOT unioned in behind their back.
  assert.deepStrictEqual(
    resolveCategorySlugs({ category: 'Recovery', categoryIds: [CAT_A] }, byId),
    ['nursing'],
  );
});

check('several pills round-trip in assignment order', () => {
  assert.deepStrictEqual(
    resolveCategorySlugs({ category: '', categoryIds: [CAT_B, CAT_A] }, byId),
    ['lab-tests', 'nursing'],
  );
});

check('a populated document is accepted, not just a bare id', () => {
  const populated = { _id: CAT_A, slug: 'nursing' };
  assert.deepStrictEqual(
    resolveCategorySlugs({ categoryIds: [populated] }, byId),
    ['nursing'],
  );
});

check('an id whose category was deleted is dropped, not emitted dangling', () => {
  // Deleting a pill also $pulls it from every service, but a stale in-flight
  // write can still reference one. It must not reach the client as a slug that
  // matches nothing.
  const out = resolveCategorySlugs(
    { category: 'Recovery', categoryIds: ['507f1f77bcf86cd799439099'] },
    byId,
  );
  // Every explicit id resolved to nothing, so the legacy join stands rather
  // than the service vanishing from the rail entirely.
  assert.deepStrictEqual(out, ['post-op']);
});

check('duplicates collapse and an uncategorized service belongs nowhere', () => {
  assert.deepStrictEqual(
    resolveCategorySlugs({ categoryIds: [CAT_A, CAT_A] }, byId),
    ['nursing'],
  );
  assert.deepStrictEqual(resolveCategorySlugs({ category: '' }, byId), []);
  assert.deepStrictEqual(resolveCategorySlugs({}, byId), []);
});

check('never throws on a malformed service row', () => {
  assert.deepStrictEqual(resolveCategorySlugs(null, byId), []);
  assert.deepStrictEqual(resolveCategorySlugs({ categoryIds: null }, byId), []);
  assert.deepStrictEqual(resolveCategorySlugs({ category: 'x' }, null), ['x']);
});

// --- by-category sort vocabulary --------------------------------------------
//
// MIRROR: the same table is implemented client-side in
// `applyCategoryFilters` (frontend .../category_services_view.dart). The two
// must agree, or one category would come back in a different order depending
// on whether the server or the app did the sorting.

console.log('\n  by-category: sub-filter sort vocabulary');

const { _pickSort: pickSort, _SORTS: SORTS } = require('../src/routes/services');

check('every spelling of the price sort lands on price_asc', () => {
  for (const raw of ['price', 'Price', 'price_asc', 'priceAsc', 'PRICE-ASC']) {
    assert.strictEqual(pickSort(raw), 'price_asc', raw);
  }
});

check('rating accepts its aliases, and junk falls back to recommended', () => {
  assert.strictEqual(pickSort('rating'), 'rating');
  assert.strictEqual(pickSort('top rated'), 'rating');
  assert.strictEqual(pickSort(''), 'recommended');
  assert.strictEqual(pickSort(undefined), 'recommended');
  assert.strictEqual(pickSort('nonsense'), 'recommended');
});

check('recommended leaves the catalog order alone', () => {
  assert.strictEqual(SORTS.recommended, null);
});

check('rating ties break on review volume, then price', () => {
  const rows = [
    { price: 1500, rating: 4.9, ratingCount: 3 },
    { price: 500, rating: 4.2, ratingCount: 90 },
    { price: 3000, rating: 4.9, ratingCount: 40 },
  ];
  rows.sort(SORTS.rating);
  assert.deepStrictEqual(rows.map((r) => r.ratingCount), [40, 3, 90]);
});

console.log(
  failures === 0
    ? '\n  all passed\n'
    : `\n  ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
