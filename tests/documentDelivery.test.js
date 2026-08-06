/**
 * Patient medical document delivery — HTTP-level access control.
 *
 * Companion to documentAccess.test.js, which covers the pure functions. This
 * one drives real requests through the real middleware, because the two things
 * being checked are both properties of the wiring rather than of any function:
 *
 *   1. `GET /api/documents/:token` is deliberately NOT behind any role guard —
 *      a browser tab opening a PDF cannot send an Authorization header, so the
 *      grant in the path is the only credential. That makes "a forged/expired
 *      grant is refused" the entire authorization story for the route, and
 *      worth proving over HTTP rather than in a unit. `/admin/documents/:token`
 *      is a legacy alias of the same handler and must behave identically.
 *
 *   2. The `/uploads` static mount is public by design (service images,
 *      avatars). Medical documents share that directory whenever Cloudinary is
 *      off. The guard's ORDER relative to express.static is the whole
 *      mechanism, and order is not something a unit test can observe.
 *
 *   3. Grants are minted by the booking reads, so those reads ARE the access
 *      decision. Both audiences must refuse an unauthenticated caller before
 *      any grant exists: admin via `requireRole('admin')`, and the clinician
 *      console via `requireAccountId` + the assignment check.
 *
 * No database: every case here resolves before the handler reaches Mongo,
 * which is exactly where the security decisions live.
 *
 *   node backend/tests/documentDelivery.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-document-delivery';
process.env.PUBLIC_BASE_URL = 'https://api.taafi.test';

// Point the upload mount at a scratch dir BEFORE middleware/upload.js reads it
// at require-time, so the fixtures below don't touch the real ./uploads.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'taafi-uploads-'));
process.env.UPLOAD_DIR = SCRATCH;

const { blockPrivateUploads } = require('../src/middleware/privateUploads');
const { signDocumentToken } = require('../src/utils/documentAccess');
const adminRouter = require('../src/routes/admin');
const documentsRouter = require('../src/routes/documents');
const doctorRouter = require('../src/routes/doctor');

const PORT = 5314;
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

// Mirrors server.js: the guard sits in front of express.static on the same
// mount. If the order here diverges from server.js the test is worthless, so
// it is deliberately the only thing this app does.
fs.mkdirSync(path.join(SCRATCH, 'patient-docs'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'public-service.jpg'), 'not-really-a-jpeg');
fs.writeFileSync(
  path.join(SCRATCH, 'patient-docs', 'discharge.pdf'),
  '%PDF-1.4 private',
);

const app = express();
app.use('/uploads', blockPrivateUploads, express.static(SCRATCH));
app.use('/admin', adminRouter);
// Canonical mount for the same handler. `/admin/documents/:token` is now an
// alias of this, and both are asserted below — the alias exists so grants
// minted before the move (they live ~30 min) keep resolving.
app.use('/api/documents', documentsRouter);
// The clinician surface that now mints those grants. Mounted here to prove
// the assignment gate holds over HTTP: an unauthenticated caller must not be
// able to make the API hand out a grant for someone else's medical records.
app.use('/doctor', doctorRouter);

const server = app.listen(PORT);

function get(url) {
  return fetch(`http://127.0.0.1:${PORT}${url}`, { redirect: 'manual' });
}

(async () => {
  console.log('\n/uploads mount');

  await check('an ordinary uploaded image is still public', async () => {
    const res = await get('/uploads/public-service.jpg');
    assert.equal(res.status, 200);
  });

  await check('a medical document is refused', async () => {
    const res = await get('/uploads/patient-docs/discharge.pdf');
    assert.equal(res.status, 403);
    const body = await res.text();
    assert.ok(
      !body.includes('private'),
      'the 403 body must not contain the file contents',
    );
  });

  await check('a percent-encoded path cannot bypass the guard', async () => {
    // Encoded separator: a check that ran before decoding would see one
    // opaque segment and wave this through to express.static, which decodes.
    for (const url of [
      '/uploads/patient-docs%2Fdischarge.pdf',
      '/uploads/%70atient-docs/discharge.pdf',
      '/uploads/PATIENT-DOCS/discharge.pdf',
    ]) {
      const res = await get(url);
      assert.ok(
        res.status === 403 || res.status === 404,
        `${url} returned ${res.status}; expected the file to be unreachable`,
      );
    }
  });

  console.log('\nGET /api/documents/:token');

  await check('a garbage grant is refused without touching the DB', async () => {
    const res = await get('/api/documents/not-a-real-token');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.message, /invalid or has expired/i);
  });

  await check('the legacy /admin alias runs the same handler', async () => {
    // Same refusal, same wording, from the same function — the alias must not
    // become a second implementation that can drift on its own.
    const res = await get('/admin/documents/not-a-real-token');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.message, /invalid or has expired/i);
  });

  await check('an expired grant is refused', async () => {
    const token = signDocumentToken({
      requestId: '652f1c9a4b21d8e3f0a91b77',
      index: 0,
      ttlMs: -1,
    });
    const res = await get(`/api/documents/${token}`);
    assert.equal(res.status, 403);
  });

  await check('a re-signed grant for another booking is refused', async () => {
    const token = signDocumentToken({
      requestId: '652f1c9a4b21d8e3f0a91b77',
      index: 0,
    });
    const [payload, signature] = token.split('.');
    const swapped = Buffer.from(
      `652f1c9a4b21d8e3f0a91b00.0.${Date.now() + 60000}`,
    ).toString('base64url');
    assert.notEqual(swapped, payload);
    const res = await get(`/api/documents/${swapped}.${signature}`);
    assert.equal(res.status, 403);
  });

  await check('a valid grant naming no real booking 404s', async () => {
    // `not-an-object-id` fails the isValidObjectId check, so this exercises
    // the authenticated path right up to (but not into) the database.
    const token = signDocumentToken({ requestId: 'not-an-object-id', index: 0 });
    const res = await get(`/api/documents/${token}`);
    assert.equal(res.status, 404);
  });

  console.log('\nbooking reads stay guarded (this is where grants are minted)');

  await check('GET /admin/requests without a token is 401', async () => {
    const res = await get('/admin/requests');
    assert.equal(res.status, 401);
  });

  await check('GET /admin/bookings/:id without a token is 401', async () => {
    const res = await get('/admin/bookings/652f1c9a4b21d8e3f0a91b77');
    assert.equal(res.status, 401);
  });

  await check('GET /doctor/bookings/:id without a token is 401', async () => {
    // The clinician read now carries `attachments`. `requireAccountId` has to
    // reject before the handler runs, or an anonymous caller could ask the API
    // to mint grants for any booking id they can guess.
    const res = await get('/doctor/bookings/652f1c9a4b21d8e3f0a91b77');
    assert.equal(res.status, 401);
  });

  await check('GET /doctor/bookings/:id rejects a malformed id', async () => {
    // Ordering check: the 401 above must come from the auth middleware, not
    // from the id validation — otherwise the guard is sitting in the wrong
    // place and a well-formed id might slip through.
    const res = await get('/doctor/bookings/not-an-object-id');
    assert.equal(res.status, 401);
  });

  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  if (failures) {
    console.error(`\n${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log('\nAll document delivery checks passed.\n');
})();
