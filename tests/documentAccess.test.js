/**
 * Patient medical document access-control test.
 *
 * Three things have to hold for the Assign Doctor/Nurse drawer to be able to
 * show a patient's discharge summary without also handing the internet a
 * medical record:
 *
 *   1. A grant is unforgeable and expires. It is the ONLY credential on the
 *      delivery route (a browser tab opening a PDF cannot send a header), so
 *      "tampered token is rejected" is the whole authorization story.
 *   2. The stored `documents[].url` is client-supplied and gets fetched
 *      SERVER-SIDE. Without an origin allow-list that is a stored SSRF — a
 *      patient stores `http://169.254.169.254/…`, an admin clicks Preview,
 *      and the API reads cloud instance metadata back to them.
 *   3. The `attachments` view never leaks the raw storage URL, because a
 *      Cloudinary asset stays readable forever by anyone holding it.
 *
 * Pure functions, no DB and no network.
 *
 *   node backend/tests/documentAccess.test.js
 */

const assert = require('node:assert');
const path = require('node:path');

// Pin the signing key + public origin BEFORE the modules under test read them
// at require-time, so the run doesn't depend on a local .env.
process.env.JWT_SECRET = 'test-secret-for-document-grants';
process.env.PUBLIC_BASE_URL = 'https://api.taafi.test';

const {
  signDocumentToken,
  verifyDocumentToken,
} = require('../src/utils/documentAccess');
const {
  describeAttachments,
  resolveDocumentSource,
  isStorableDocumentUrl,
  safeMime,
  safeFileName,
} = require('../src/utils/bookingAttachments');
const { UPLOAD_DIR } = require('../src/middleware/upload');

const REQUEST_ID = '652f1c9a4b21d8e3f0a91b77';
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('\ngrant tokens');

check('a freshly minted grant round-trips to its booking + index', () => {
  const token = signDocumentToken({ requestId: REQUEST_ID, index: 2 });
  const grant = verifyDocumentToken(token);
  assert.ok(grant, 'expected the grant to verify');
  assert.equal(grant.requestId, REQUEST_ID);
  assert.equal(grant.index, 2);
});

check('a tampered payload is rejected', () => {
  const token = signDocumentToken({ requestId: REQUEST_ID, index: 0 });
  const [, signature] = token.split('.');
  // Re-point the grant at document #9 of a DIFFERENT booking, keeping the
  // signature. This is the attack the HMAC exists to stop.
  const forged = `${Buffer.from('652f1c9a4b21d8e3f0a91b00.9.' + (Date.now() + 60000)).toString('base64url')}.${signature}`;
  assert.equal(verifyDocumentToken(forged), null);
});

check('a grant signed with a different secret is rejected', () => {
  const token = signDocumentToken({ requestId: REQUEST_ID, index: 0 });
  const [payload] = token.split('.');
  assert.equal(verifyDocumentToken(`${payload}.notarealsignature`), null);
});

check('an expired grant is rejected', () => {
  const token = signDocumentToken({ requestId: REQUEST_ID, index: 0, ttlMs: -1 });
  assert.equal(verifyDocumentToken(token), null);
});

check('garbage input returns null rather than throwing', () => {
  for (const bad of [null, undefined, '', 'x', 'a.b.c', '....', 42, {}]) {
    assert.equal(verifyDocumentToken(bad), null, `expected null for ${String(bad)}`);
  }
});

console.log('\nstorage origin allow-list');

check('a Cloudinary URL resolves as a remote fetch', () => {
  const src = resolveDocumentSource(
    'https://res.cloudinary.com/taafi/raw/upload/v1/taafi/patient-docs/abc.pdf',
  );
  assert.equal(src.kind, 'remote');
});

check('our own /uploads URL resolves to a contained disk path', () => {
  const src = resolveDocumentSource(
    'https://api.taafi.test/uploads/patient-docs/acct-123-deadbeef.pdf',
  );
  assert.equal(src.kind, 'disk');
  assert.ok(
    src.filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep),
    `expected containment under UPLOAD_DIR, got ${src.filePath}`,
  );
});

check('a bare filename (pre-toAbsolute rows) still resolves', () => {
  const src = resolveDocumentSource('patient-docs/legacy.pdf');
  assert.equal(src.kind, 'disk');
});

check('SSRF targets are refused', () => {
  const hostile = [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://localhost:5000/admin/requests',
    'http://127.0.0.1:6379/',
    'https://attacker.example.com/exfil.pdf',
    'file:///etc/passwd',
    'https://res.cloudinary.com.attacker.example.com/x.pdf',
    'javascript:alert(1)',
  ];
  for (const url of hostile) {
    assert.equal(
      resolveDocumentSource(url),
      null,
      `expected ${url} to be refused`,
    );
    assert.equal(isStorableDocumentUrl(url), false);
  }
});

check('path traversal out of the upload dir is refused', () => {
  const escapes = [
    'https://api.taafi.test/uploads/../../etc/passwd',
    // Pre-encoded, so a naive check that ran before decoding would miss it.
    'https://api.taafi.test/uploads/%2e%2e%2f%2e%2e%2fetc/passwd',
  ];
  for (const url of escapes) {
    assert.equal(resolveDocumentSource(url), null, `expected ${url} refused`);
  }
});

console.log('\nattachments view');

const documents = [
  {
    name: 'discharge_summary.pdf',
    url: 'https://res.cloudinary.com/taafi/raw/upload/v1/taafi/patient-docs/a.pdf',
    mime: 'application/pdf',
    size: 148223,
    uploaded_at: new Date('2026-08-07T01:30:00Z'),
  },
  {
    name: 'lab_report.png',
    url: 'https://res.cloudinary.com/taafi/image/upload/v1/taafi/patient-docs/b.png',
    mime: 'image/png',
    size: 20480,
    uploaded_at: new Date('2026-08-07T02:00:00Z'),
  },
];

check('descriptors carry the spec fields and no raw storage URL', () => {
  const [first] = describeAttachments(REQUEST_ID, documents);
  assert.equal(first.file_name, 'discharge_summary.pdf');
  assert.equal(first.file_type, 'application/pdf');
  assert.equal(first.uploaded_at, '2026-08-07T01:30:00.000Z');
  assert.equal(first.size_bytes, 148223);
  // Role-neutral path: the admin console and the assigned clinician's console
  // read the same bytes through the same handler, so the URL must not name
  // either audience.
  assert.ok(
    first.file_url.startsWith('https://api.taafi.test/api/documents/'),
    `expected a presigned API url, got ${first.file_url}`,
  );
  assert.match(first.download_url, /\?download=1$/);
  const serialized = JSON.stringify(describeAttachments(REQUEST_ID, documents));
  assert.ok(
    !serialized.includes('res.cloudinary.com'),
    'raw storage URL must not appear in a staff payload',
  );
});

check('each descriptor grant opens its own document only', () => {
  const list = describeAttachments(REQUEST_ID, documents);
  list.forEach((attachment, index) => {
    const token = attachment.file_url.split('/').pop();
    const grant = verifyDocumentToken(token);
    assert.ok(grant, `attachment ${index} should carry a valid grant`);
    assert.equal(grant.requestId, REQUEST_ID);
    assert.equal(grant.index, index);
  });
});

check('an untrusted entry is dropped without shifting its neighbours', () => {
  const mixed = [
    documents[0],
    { name: 'evil', url: 'http://169.254.169.254/', mime: 'application/pdf' },
    documents[1],
  ];
  const list = describeAttachments(REQUEST_ID, mixed);
  assert.equal(list.length, 2);
  // The surviving entries must still name their ORIGINAL positions, because
  // that index is what the delivery route indexes `documents` with.
  assert.equal(verifyDocumentToken(list[0].file_url.split('/').pop()).index, 0);
  assert.equal(verifyDocumentToken(list[1].file_url.split('/').pop()).index, 2);
});

check('no documents yields an empty array, never null', () => {
  assert.deepEqual(describeAttachments(REQUEST_ID, []), []);
  assert.deepEqual(describeAttachments(REQUEST_ID, undefined), []);
  assert.deepEqual(describeAttachments('', documents), []);
});

console.log('\nresponse header sanitising');

check('an unrecognised mime collapses to octet-stream', () => {
  assert.equal(safeMime('text/html'), 'application/octet-stream');
  assert.equal(safeMime('image/svg+xml'), 'application/octet-stream');
  assert.equal(safeMime(''), 'application/octet-stream');
  assert.equal(safeMime('APPLICATION/PDF'), 'application/pdf');
  // Parameters are stripped rather than reflected into the header.
  assert.equal(safeMime('image/png; charset=utf-8'), 'image/png');
});

check('a filename cannot break out of the Content-Disposition parameter', () => {
  assert.equal(safeFileName('a"; filename="b.exe'), 'a_; filename=_b.exe');
  assert.equal(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeFileName('report\r\nX-Evil: 1'), 'report__X-Evil_ 1');
  assert.equal(safeFileName(''), 'document');
});

if (failures) {
  console.error(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\nAll document access checks passed.\n');
