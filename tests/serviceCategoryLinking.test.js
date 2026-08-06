/**
 * Service ↔ category write-boundary test.
 *
 * The published spec links a service to its category with a singular
 * `category_id`; this API stores a `categoryIds` ARRAY, because a service
 * genuinely sits on several pills (post-operative physiotherapy delivered by a
 * visiting doctor belongs under both Post-op and Doctor in Home). `pickCategoryIds`
 * is the single place those two shapes are reconciled, so the risk it carries is
 * asymmetric: fold too eagerly and a multi-pill assignment is silently truncated
 * to one; fold too timidly and a spec-shaped payload creates a service that
 * appears under no pill at all, with nothing in the response to say so.
 *
 * The `undefined` vs `[]` distinction is the other half. `undefined` means "not
 * sent, leave the assignment alone" and `[]` means "clear every assignment" —
 * PUT /api/services/:id branches on exactly that, so collapsing them would make
 * unticking the last pill a no-op.
 *
 * Runs without a database — every function under test is pure.
 *
 *   node backend/tests/serviceCategoryLinking.test.js
 */

const assert = require('node:assert');

const {
  _pickCategoryIds: pickCategoryIds,
  _pickTitle: pickTitle,
} = require('../src/routes/services');

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

// Two syntactically valid ObjectIds — `pickCategoryIds` validates the shape.
const A = '6a63d6c08ca80a370309c65d';
const B = '5f1d7d9e2b4c8a1234567890';

console.log('\n  pickCategoryIds: one stored array, several accepted spellings');

check('the spec\'s singular category_id becomes a one-entry array', () => {
  assert.deepStrictEqual(pickCategoryIds({ category_id: A }), [A]);
  assert.deepStrictEqual(pickCategoryIds({ categoryId: A }), [A]);
});

check('the plural array is taken as-is', () => {
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: [A, B] }), [A, B]);
  assert.deepStrictEqual(pickCategoryIds({ category_ids: [A, B] }), [A, B]);
});

check('plural wins over singular when a client sends both', () => {
  // Truncating to the singular here is the failure this guards: it is the
  // richer statement, and a client that sent both meant the array.
  assert.deepStrictEqual(
    pickCategoryIds({ categoryIds: [A, B], category_id: A }),
    [A, B],
  );
});

check('a JSON-string array still parses (multipart can not carry an array)', () => {
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: JSON.stringify([A, B]) }), [A, B]);
});

check('a comma-separated string still parses', () => {
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: `${A},${B}` }), [A, B]);
});

check('omitting every spelling means "leave the assignment alone"', () => {
  // Must be undefined, NOT []: PUT branches on this to avoid clearing pills
  // that the request never mentioned.
  assert.strictEqual(pickCategoryIds({}), undefined);
  assert.strictEqual(pickCategoryIds({ title: 'Doctor Home Visit' }), undefined);
});

check('an explicit empty value clears every assignment', () => {
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: [] }), []);
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: '' }), []);
  assert.deepStrictEqual(pickCategoryIds({ category_id: '' }), []);
});

check('a non-id is dropped rather than 400-ing an otherwise valid save', () => {
  // Coerce-don't-reject, same as `category` and `provider_type`: a stale client
  // sending a deleted pill must not fail the whole write.
  assert.deepStrictEqual(pickCategoryIds({ category_id: 'ALL' }), []);
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: ['nonsense', A] }), [A]);
});

check('duplicates collapse', () => {
  assert.deepStrictEqual(pickCategoryIds({ categoryIds: [A, A, B] }), [A, B]);
});

console.log('\n  pickTitle: one stored field, both spec spellings');

check('title_en is accepted alongside title', () => {
  assert.strictEqual(pickTitle({ title_en: 'Doctor Home Visit' }), 'Doctor Home Visit');
  assert.strictEqual(pickTitle({ titleEn: 'Doctor Home Visit' }), 'Doctor Home Visit');
  assert.strictEqual(pickTitle({ title: 'Doctor Home Visit' }), 'Doctor Home Visit');
});

check('title wins when several spellings arrive together', () => {
  assert.strictEqual(pickTitle({ title: 'Kept', title_en: 'Ignored' }), 'Kept');
});

check('an absent title stays undefined, so PUT leaves it alone', () => {
  // PUT branches on `title !== undefined`; returning '' here would let a
  // price-only edit blank the service's name.
  assert.strictEqual(pickTitle({ price: 1500 }), undefined);
});

console.log(
  failures === 0
    ? '\n  All service ↔ category linking checks passed.\n'
    : `\n  ${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
