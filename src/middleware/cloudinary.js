// Cloudinary image storage. Render's free filesystem is ephemeral — any
// file written to ./uploads is wiped on the next sleep/redeploy, which is
// why uploaded images "go black". Cloudinary keeps the bytes off-box so a
// stored https URL stays valid forever.
//
// Configuration (set on Render → Environment). Either form works:
//   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
// or the three separate vars:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// `isEnabled()` is true only when a COMPLETE credential set actually resolved,
// so a missing, partial, or unparseable configuration all read as disabled and
// callers fall back to the disk writer (local dev) while server.js refuses to
// boot on it (production).

// Recorded before the delete below, so the boot guard in server.js can still
// tell "nothing was configured" apart from "something was configured and did
// not survive parsing" — two very different things to go fix.
const suppliedVars = [
  process.env.CLOUDINARY_URL && 'CLOUDINARY_URL',
  process.env.CLOUDINARY_CLOUD_NAME && 'CLOUDINARY_CLOUD_NAME',
  process.env.CLOUDINARY_API_KEY && 'CLOUDINARY_API_KEY',
  process.env.CLOUDINARY_API_SECRET && 'CLOUDINARY_API_SECRET',
].filter(Boolean);

// Validate the URL shape BEFORE requiring the SDK. `cloudinary/lib/utils`
// calls config() at module-load time, so a malformed CLOUDINARY_URL throws
// from inside `require()` itself — a stack trace that names neither the env
// var nor this file, and which no try/catch of ours is positioned to see.
// Dropping the bad value instead lets `enabled` come out false, so the boot
// preflight in server.js prints the actionable fatal in production while local
// dev falls back to disk rather than dying on startup.
const CLOUDINARY_URL_SHAPE = /^cloudinary:\/\/[^:@/]+:[^:@/]+@[^:@/]+/;

if (
  process.env.CLOUDINARY_URL &&
  !CLOUDINARY_URL_SHAPE.test(process.env.CLOUDINARY_URL)
) {
  console.error(
    '[cloudinary] CLOUDINARY_URL is malformed and has been ignored.\n' +
      '  Expected: cloudinary://<api_key>:<api_secret>@<cloud_name>\n' +
      '  Copy it verbatim from the Cloudinary console (Dashboard → API keys);\n' +
      '  a secret containing @ or : must be percent-encoded.',
  );
  delete process.env.CLOUDINARY_URL;
}

const { v2: cloudinary } = require('cloudinary');

// Only forward vars that are actually set. Passing `cloud_name: undefined` is
// NOT a no-op: the SDK's config() merges via lodash/extend, which copies
// undefined over existing keys — so the explicit form wiped the credentials
// the SDK had just parsed out of CLOUDINARY_URL. isEnabled() still reported
// true, uploads took the Cloudinary branch instead of the disk fallback, and
// every upload endpoint died with "Must supply api_key" as a 500.
const explicit = {};
if (process.env.CLOUDINARY_CLOUD_NAME) {
  explicit.cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
}
if (process.env.CLOUDINARY_API_KEY) {
  explicit.api_key = process.env.CLOUDINARY_API_KEY;
}
if (process.env.CLOUDINARY_API_SECRET) {
  explicit.api_secret = process.env.CLOUDINARY_API_SECRET;
}

let resolved = {};
try {
  // Calling config() at all is what triggers the SDK's lazy parse of
  // CLOUDINARY_URL, so this covers both configuration forms — and the return
  // value is the merged result, which is what we judge `enabled` on.
  resolved = cloudinary.config({ ...explicit, secure: true }) || {};
} catch (err) {
  // A malformed CLOUDINARY_URL throws out of the URL parser. Swallow it here
  // so the boot guard in server.js gets to print the actionable message.
  console.error(
    '[cloudinary] config failed — check CLOUDINARY_URL formatting ' +
      '(expected cloudinary://<api_key>:<api_secret>@<cloud_name>):',
    err.message,
  );
}

// Ask the SDK what it ended up holding rather than inferring from which env
// vars happen to be present. A partial or clobbered config now reads as
// disabled, which is what lets server.js's preflight refuse to boot on it.
const enabled = !!(
  resolved.cloud_name &&
  resolved.api_key &&
  resolved.api_secret
);

function isEnabled() {
  return enabled;
}

// Names of the Cloudinary env vars that were present at boot, whether or not
// they parsed. Never their values.
function configuredVarNames() {
  return [...suppliedVars];
}

// The SDK throws away Cloudinary's JSON error body on any status it doesn't
// expect, leaving only "Server returned unexpected status code - <n>". That
// message is what an upload failure looks like in the logs, and it names
// neither the cause nor the fix — the real body for a scoped-key rejection,
// for instance, reads `missing permissions (actions=["create"])`. Re-attach
// the meaning we can infer from the status code so the 5xx is diagnosable.
const UPLOAD_HINTS = {
  401: 'Cloudinary rejected the credentials. Check CLOUDINARY_URL / the API key+secret pair.',
  403:
    'Cloudinary forbade the upload. The API key is valid but lacks upload ' +
    'permission — in the Cloudinary console open Settings → API Keys and ' +
    'either use the primary key or grant this key the "create" action.',
  404: 'Cloudinary cloud name not found. Check the cloud_name in CLOUDINARY_URL.',
  420: 'Cloudinary rate limit reached. Retry shortly.',
  429: 'Cloudinary rate limit reached. Retry shortly.',
};

function describeUploadError(err) {
  const hint = UPLOAD_HINTS[err && err.http_code];
  if (!hint) return err;

  const wrapped = new Error(hint);
  wrapped.http_code = err.http_code;
  // Upstream storage refused us — the client's request was fine, so this is a
  // gateway failure rather than a bug in the handler.
  wrapped.status = 502;
  wrapped.cause = err;
  return wrapped;
}

// Uploads a raw image buffer and returns the permanent https URL.
// `publicId` is deterministic (derived from the owning doc id) so a
// re-upload overwrites the previous image instead of leaking copies.
// [resourceType] is 'image' for pictures and 'raw' for everything else
// (patient medical documents arrive as PDFs too). Cloudinary refuses a PDF
// on the image pipeline, so the caller picks the lane from the MIME type.
function uploadBuffer(buffer, publicId, resourceType = 'image') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 'taafi',
        overwrite: true,
        invalidate: true,
        resource_type: resourceType,
      },
      (err, result) => {
        if (err) return reject(describeUploadError(err));
        // A 200 with no usable payload would otherwise throw a bare
        // "cannot read properties of undefined" from the property access.
        if (!result || !result.secure_url) {
          return reject(new Error('Cloudinary upload returned no secure_url'));
        }
        resolve(result.secure_url);
      },
    );
    // A transport-level failure (DNS, TLS, socket reset) surfaces on the
    // stream, not the callback. Without this listener Node treats it as an
    // unhandled 'error' event and the process-level uncaughtException handler
    // in server.js takes the whole server down mid-request.
    stream.on('error', (err) => reject(describeUploadError(err)));
    stream.end(buffer);
  });
}

// Best-effort delete — never throws, so request handlers can fire-and-
// forget during a service/avatar removal without wrapping in try/catch.
async function destroy(publicId) {
  if (!enabled) return;
  try {
    await cloudinary.uploader.destroy(`taafi/${publicId}`, {
      invalidate: true,
    });
  } catch (_) {
    /* swallow — orphan cleanup is best-effort */
  }
}

module.exports = { isEnabled, configuredVarNames, uploadBuffer, destroy };
