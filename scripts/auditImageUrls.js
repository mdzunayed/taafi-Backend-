#!/usr/bin/env node
/**
 * Read-only audit of every stored image URL. Mutates NOTHING.
 *
 * Two failure modes leave dead URLs in the database, and neither is visible
 * from the admin console — a broken image looks the same either way:
 *
 *   1. PUBLIC_BASE_URL was unset (it is `sync: false` on Render), so a
 *      successful upload returned an absolute URL pointing at *localhost*.
 *      Fine from the dev machine that wrote it, unreachable from a phone.
 *   2. Cloudinary was off, so bytes went to Render's ephemeral disk and were
 *      wiped on the next sleep/redeploy. The row still holds a filename; the
 *      file behind it is gone.
 *
 * This reports which rows are in which state so the re-upload list is a fact
 * rather than a guess. Rows are classified, then each resolved URL is probed
 * with a HEAD request.
 *
 *   node backend/scripts/auditImageUrls.js
 *   node backend/scripts/auditImageUrls.js --no-probe   (classify only, offline)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Service = require('../src/models/Service');
const PromoBanner = require('../src/models/PromoBanner');
const AppOpenAd = require('../src/models/AppOpenAd');
const DynamicSection = require('../src/models/DynamicSection');
const { toAbsolute, PUBLIC_BASE_URL, isConfigured } = require('../src/utils/publicUrl');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';
const PROBE = !process.argv.includes('--no-probe');

const CLOUDINARY = /^https?:\/\/res\.cloudinary\.com\//i;
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/)/i;

function classify(raw) {
  if (!raw) return 'EMPTY';
  if (CLOUDINARY.test(raw)) return 'CLOUDINARY';
  if (LOCALHOST.test(raw)) return 'LOCALHOST';
  if (/^https?:\/\//i.test(raw)) return 'ABSOLUTE';
  return 'FILENAME'; // bare name → served off the ephemeral disk
}

// HEAD the resolved URL. Any network failure is itself the finding, so this
// reports the reason rather than throwing.
async function probe(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });
    return res.status;
  } catch (err) {
    return err.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE';
  }
}

// Every row funnels through here so the four collections report identically.
async function collect(label, rows) {
  const out = [];
  for (const { id, raw } of rows) {
    const kind = classify(raw);
    const resolved = toAbsolute(raw);
    const status = PROBE && resolved ? await probe(resolved) : null;
    out.push({ label, id, raw, kind, resolved, status });
  }
  return out;
}

function isBad(r) {
  return (
    r.kind === 'LOCALHOST' ||
    r.kind === 'EMPTY' ||
    (r.status !== null && r.status !== 200)
  );
}

async function main() {
  await mongoose.connect(MONGO_URI);

  if (!isConfigured()) {
    console.warn(
      `\n[audit] PUBLIC_BASE_URL is unset — bare filenames are being resolved\n` +
        `        against the fallback ${PUBLIC_BASE_URL}. Results for FILENAME\n` +
        `        rows reflect THIS machine, not production.\n`,
    );
  }

  const findings = [];

  findings.push(
    ...(await collect(
      'Service',
      (await Service.find().select('_id imageUrl').lean()).map((d) => ({
        id: String(d._id),
        raw: d.imageUrl,
      })),
    )),
  );

  findings.push(
    ...(await collect(
      'PromoBanner',
      (await PromoBanner.find().select('_id imageUrl').lean()).map((d) => ({
        id: String(d._id),
        raw: d.imageUrl,
      })),
    )),
  );

  findings.push(
    ...(await collect(
      'AppOpenAd',
      (await AppOpenAd.find().select('_id imageUrl').lean()).map((d) => ({
        id: String(d._id),
        raw: d.imageUrl,
      })),
    )),
  );

  // Home-section images live inside the contentData array, one per item.
  const sections = await DynamicSection.find()
    .select('_id sectionKey contentData')
    .lean();
  const sectionRows = [];
  for (const s of sections) {
    for (const item of s.contentData || []) {
      if (!item || !item.imageUrl) continue;
      sectionRows.push({
        id: `${s.sectionKey}/${item.itemId}`,
        raw: item.imageUrl,
      });
    }
  }
  findings.push(...(await collect('HomeSectionItem', sectionRows)));

  // ── Report ──────────────────────────────────────────────────────────────
  const byKind = findings.reduce((acc, r) => {
    acc[r.kind] = (acc[r.kind] || 0) + 1;
    return acc;
  }, {});

  console.log('\n─── Stored image URLs by kind ───────────────────────────────');
  for (const [kind, n] of Object.entries(byKind).sort()) {
    console.log(`  ${kind.padEnd(11)} ${n}`);
  }

  const bad = findings.filter(isBad);

  console.log(
    `\n─── Needs attention: ${bad.length} of ${findings.length} ────────────────────────`,
  );
  if (bad.length === 0) {
    console.log('  none — every image resolved with HTTP 200.\n');
  } else {
    for (const r of bad) {
      const why =
        r.kind === 'LOCALHOST'
          ? 'localhost origin — unreachable from any other device'
          : r.kind === 'EMPTY'
            ? 'no image stored'
            : r.kind === 'FILENAME'
              ? `HEAD ${r.status} — disk file likely wiped; re-upload`
              : `HEAD ${r.status}`;
      console.log(`  [${r.label}] ${r.id}`);
      console.log(`      stored: ${r.raw ?? '(null)'}`);
      console.log(`      ${why}`);
    }
    console.log(
      '\n  Fix: re-upload these through the admin console once Cloudinary\n' +
        '  and PUBLIC_BASE_URL are set. Bytes lost to the ephemeral disk\n' +
        '  cannot be recovered programmatically.\n',
    );
  }

  await mongoose.disconnect();
  // Non-zero exit lets CI gate on a clean image ledger if that's ever wanted.
  process.exit(bad.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
