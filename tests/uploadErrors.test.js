/**
 * Upload error-handling test.
 *
 * Multer rejects a request BEFORE the route handler runs, so a route's own
 * try/catch never sees a size/mimetype/field-name failure. Before
 * middleware/uploadErrors.js these all fell through to the generic handler as
 * 500s, which meant an admin whose photo was too big was told the server was
 * broken — and a client doing `if (status >= 500)` could not tell that apart
 * from a database outage.
 *
 * Exercises the real middleware stack (real multer, real Express, real
 * multipart over HTTP) rather than calling the handler with a fake error,
 * because the thing worth proving is precisely that the rejection reaches
 * this handler and not the generic one.
 *
 *   node backend/tests/uploadErrors.test.js
 */

const assert = require('node:assert');
const express = require('express');

const { upload } = require('../src/middleware/upload');
const { uploadErrorHandler } = require('../src/middleware/uploadErrors');

const PORT = 5311;

function buildApp() {
  const app = express();

  app.post('/upload', upload.single('image'), (req, res) => {
    res.json({ ok: true, size: req.file ? req.file.size : 0 });
  });

  app.use(uploadErrorHandler);
  // Mirrors server.js: anything the upload handler passes on lands here as a
  // 500. If a case below returns 500, it means uploadErrorHandler let it slip.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ message: err.message || 'Server error' });
  });

  return app;
}

async function post(fields) {
  const form = new FormData();
  for (const [name, { bytes, filename, type }] of Object.entries(fields)) {
    form.append(name, new Blob([bytes], { type }), filename);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/upload`, {
    method: 'POST',
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

// A minimal but genuinely valid JPEG header, so the mimetype filter passes and
// only the property under test decides the outcome.
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function jpegOfSize(totalBytes) {
  return Buffer.concat([
    JPEG_MAGIC,
    Buffer.alloc(Math.max(0, totalBytes - JPEG_MAGIC.length), 0x20),
  ]);
}

const cases = [
  {
    name: 'a normal JPEG under the cap succeeds',
    fields: {
      image: { bytes: jpegOfSize(2048), filename: 'ok.jpg', type: 'image/jpeg' },
    },
    expectStatus: 200,
    check: (body) => assert.equal(body.ok, true),
  },
  {
    name: 'over 8 MB -> 413 (was 500)',
    fields: {
      image: {
        bytes: jpegOfSize(9 * 1024 * 1024),
        filename: 'huge.jpg',
        type: 'image/jpeg',
      },
    },
    expectStatus: 413,
    check: (body) =>
      assert.match(body.message, /larger than the 8 MB limit/i),
  },
  {
    name: 'disallowed mimetype -> 415 (was 500)',
    fields: {
      image: {
        bytes: Buffer.from('%PDF-1.4'),
        filename: 'doc.pdf',
        type: 'application/pdf',
      },
    },
    expectStatus: 415,
    check: (body) => assert.match(body.message, /JPEG \/ PNG \/ WEBP/i),
  },
  {
    name: 'wrong field name -> 400 naming the field (was 500)',
    fields: {
      file: { bytes: jpegOfSize(1024), filename: 'ok.jpg', type: 'image/jpeg' },
    },
    expectStatus: 400,
    check: (body) => {
      assert.match(body.message, /Unexpected upload field/i);
      // Naming the field is what turns this from "the upload silently did
      // nothing" into a one-line fix.
      assert.match(body.message, /"file"/);
    },
  },
];

async function main() {
  const server = buildApp().listen(PORT);
  await new Promise((resolve) => server.once('listening', resolve));

  let failed = 0;
  for (const testCase of cases) {
    try {
      const { status, body } = await post(testCase.fields);
      assert.equal(
        status,
        testCase.expectStatus,
        `expected ${testCase.expectStatus}, got ${status} (${JSON.stringify(body)})`,
      );
      testCase.check(body);
      console.log(`  ok    ${testCase.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${testCase.name}\n        ${err.message}`);
    }
  }

  server.close();
  console.log(
    failed === 0
      ? `\n${cases.length} passed\n`
      : `\n${failed} of ${cases.length} FAILED\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
