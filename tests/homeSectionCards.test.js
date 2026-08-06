/**
 * Home-section card CMS test.
 *
 * Covers the two pure transforms behind the per-card CMS fields:
 *
 *   sanitizeItems — what an admin's payload becomes on disk. The risk it
 *   guards is a payload from an older admin build that has never heard of
 *   `isActive`: defaulting that to false would hide every existing card on
 *   the first save from a stale client.
 *
 *   decorate — what each audience is allowed to see. The patient feed must
 *   drop cards an admin switched off, while the admin console must keep them,
 *   because "hidden" is only meaningfully different from "deleted" if the
 *   card is still there to switch back on.
 *
 * Runs without a database: `decorate` only needs `toJSON`, so a plain stub
 * stands in for the mongoose document.
 *
 *   node backend/tests/homeSectionCards.test.js
 */

const assert = require('node:assert');

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

// A minimal valid card; each test overrides just the fields it cares about.
const card = (over = {}) => ({
  itemId: 'srv_post_op_01',
  title: 'Post-surgery care',
  imageUrl: 'https://cdn.taafi.app/icons/post-op.png',
  targetType: 'NONE',
  ...over,
});

// Stands in for a mongoose doc — decorate only calls toJSON().
const docOf = (contentData) => ({
  toJSON: () => ({ id: 'sec1', sectionKey: 'CARE_SERVICES', contentData }),
});

console.log('\n  sanitizeItems: the new per-card fields');

check('bilingual text and badge are carried through', () => {
  const [item] = sanitizeItems([
    card({
      titleBn: 'পোস্ট-সার্জারি কেয়ার',
      subtitle: 'Post-op wound care',
      subtitleBn: 'অপারেশন পরবর্তী সেবা',
      badgeText: 'Popular',
    }),
  ]);

  assert.strictEqual(item.titleBn, 'পোস্ট-সার্জারি কেয়ার');
  assert.strictEqual(item.subtitleBn, 'অপারেশন পরবর্তী সেবা');
  assert.strictEqual(item.badgeText, 'Popular');
});

check('blank and whitespace-only optional text collapse to null', () => {
  const [item] = sanitizeItems([
    card({ subtitle: '   ', badgeText: '', titleBn: undefined }),
  ]);

  // Null, not '' — so "cleared in the CMS" and "never set" reach the client
  // as the same absent value.
  assert.strictEqual(item.subtitle, null);
  assert.strictEqual(item.badgeText, null);
  assert.strictEqual(item.titleBn, null);
});

check('optional text is trimmed', () => {
  const [item] = sanitizeItems([card({ badgeText: '  Popular  ' })]);

  assert.strictEqual(item.badgeText, 'Popular');
});

check('a payload with no isActive keeps the card visible', () => {
  // The regression that matters: an older admin build saving a section must
  // not switch off every card in it.
  const [item] = sanitizeItems([card()]);

  assert.strictEqual(item.isActive, true);
});

check('isActive false is honoured, including as the string "false"', () => {
  const [a] = sanitizeItems([card({ isActive: false })]);
  const [b] = sanitizeItems([card({ isActive: 'false' })]);

  assert.strictEqual(a.isActive, false);
  assert.strictEqual(b.isActive, false);
});

console.log('\n  decorate: who sees a hidden card');

check('the patient feed drops cards the admin switched off', () => {
  const out = decorate(
    docOf([
      { itemId: 'a', title: 'Visible', imageUrl: 'x', isActive: true },
      { itemId: 'b', title: 'Hidden', imageUrl: 'y', isActive: false },
    ]),
    { publicOnly: true }
  );

  assert.deepStrictEqual(out.contentData.map((i) => i.itemId), ['a']);
});

check('the admin console still sees them, so they can be switched back on', () => {
  const out = decorate(
    docOf([
      { itemId: 'a', title: 'Visible', imageUrl: 'x', isActive: true },
      { itemId: 'b', title: 'Hidden', imageUrl: 'y', isActive: false },
    ])
  );

  assert.deepStrictEqual(out.contentData.map((i) => i.itemId), ['a', 'b']);
  assert.strictEqual(out.contentData[1].isActive, false);
});

check('a card stored before isActive existed stays in the public feed', () => {
  // Documents written before the field shipped have no `isActive` at all;
  // only an explicit false may hide a card.
  const out = decorate(
    docOf([{ itemId: 'legacy', title: 'Nursing', imageUrl: 'x' }]),
    { publicOnly: true }
  );

  assert.strictEqual(out.contentData.length, 1);
});

check('a section whose cards are all hidden decorates to an empty array', () => {
  const out = decorate(
    docOf([{ itemId: 'a', title: 'Hidden', imageUrl: 'x', isActive: false }]),
    { publicOnly: true }
  );

  assert.deepStrictEqual(out.contentData, []);
});

if (failures > 0) {
  console.log(`\n  ${failures} failed\n`);
  process.exit(1);
}
console.log('\n  all passed\n');
