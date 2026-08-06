// Staff-facing view of `care_requests.documents` — the previous medical
// records (discharge summaries, old prescriptions, lab reports) a patient
// attached at booking time.
//
// Read by two audiences, both of which have to pass their own check before
// anything here runs: admins (`requireRole('admin')` on the booking reads in
// routes/admin.js) and the doctor or nurse actually dispatched to the visit
// (the assignment check on `GET /doctor/bookings/:id`). Never the patient-
// facing payloads — those already carry the patient's own uploads.
//
// Two jobs:
//
//   1. `describeAttachments` turns the stored subdocuments into the descriptor
//      the consoles render, with a PRESIGNED url in place of the raw storage
//      location. The raw Cloudinary/uploads URL never leaves the API again —
//      clients only ever hold a grant that names one document and expires
//      (see utils/documentAccess.js).
//
//   2. `resolveDocumentSource` decides where the bytes actually live, behind
//      an origin allow-list. This one is load-bearing: `documents[].url` is
//      client-supplied (routes/patient.js `pickDocuments` persists whatever
//      the create-booking payload carried), so a handler that fetches it
//      server-side is an SSRF primitive unless the origin is constrained. A
//      patient could otherwise store `http://169.254.169.254/…` and have the
//      admin API read cloud instance metadata back to them.

const path = require('path');
const { PUBLIC_BASE_URL, toAbsolute } = require('./publicUrl');
const { UPLOAD_DIR } = require('../middleware/upload');
const { signDocumentToken } = require('./documentAccess');

// Where a legitimately-stored document can live. `storeDocument` only ever
// produces one of these two shapes:
//   • Cloudinary  → https://res.cloudinary.com/<cloud>/…
//   • disk        → <PUBLIC_BASE_URL>/uploads/<file>
const CLOUDINARY_HOSTS = new Set(['res.cloudinary.com']);
const LOCAL_UPLOAD_PREFIX = '/uploads/';

function parseUrl(raw) {
  try {
    return new URL(String(raw || ''));
  } catch (_) {
    return null;
  }
}

// Resolve a stored `documents[].url` to something readable, or null when the
// value does not name a location this API is willing to read from.
//
// Returns one of:
//   { kind: 'disk',   filePath }  — read straight off the local upload mount
//   { kind: 'remote', url }       — fetch server-side (Cloudinary only)
function resolveDocumentSource(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return null;

  // Reject a foreign scheme BEFORE `toAbsolute` gets it. `toAbsolute` treats
  // anything that isn't http(s) as a bare filename, so `file:///etc/passwd`
  // and `javascript:…` would otherwise be glued onto the uploads path and
  // resolved as if they were ordinary filenames.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return null;
  }

  // Bare filenames predate the `toAbsolute` call in POST /patient/documents;
  // they always meant "on the local upload mount".
  const absolute = toAbsolute(raw);
  const url = parseUrl(absolute);
  if (!url) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const base = parseUrl(PUBLIC_BASE_URL);
  const isOwnOrigin = !!base && url.origin === base.origin;

  if (isOwnOrigin && url.pathname.startsWith(LOCAL_UPLOAD_PREFIX)) {
    // decodeURIComponent so a percent-encoded `..` cannot slip past the
    // containment check below by arriving pre-escaped.
    let relative;
    try {
      relative = decodeURIComponent(url.pathname.slice(LOCAL_UPLOAD_PREFIX.length));
    } catch (_) {
      return null;
    }
    if (!relative) return null;
    const filePath = path.resolve(UPLOAD_DIR, relative);
    // Containment guard: `path.resolve` happily walks out of UPLOAD_DIR when
    // the relative part contains `../`. Compare against the directory plus a
    // separator so `/uploads-secret/x` cannot pass as `/uploads` + `-secret/x`.
    const root = path.resolve(UPLOAD_DIR) + path.sep;
    if (!filePath.startsWith(root)) return null;
    return { kind: 'disk', filePath };
  }

  if (url.protocol === 'https:' && CLOUDINARY_HOSTS.has(url.hostname)) {
    return { kind: 'remote', url: url.toString() };
  }

  return null;
}

// True when a URL is one this API would be willing to serve back later.
// Called at WRITE time (routes/patient.js) so an unreadable — or hostile —
// location is rejected when the booking is created rather than discovered
// when an admin clicks Preview.
function isStorableDocumentUrl(rawUrl) {
  return resolveDocumentSource(rawUrl) !== null;
}

// Content types we will echo back on the delivery route. Anything else is
// served as a download of unnamed bytes: the upload filter already restricts
// patient documents to PDF/JPEG/PNG/WEBP, so a stored `mime` outside this set
// means the row was written before that filter or by something else, and
// reflecting it verbatim would let a stored `text/html` render as a page on
// the API's own origin.
const SERVABLE_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function safeMime(raw) {
  const mime = String(raw || '').toLowerCase().split(';')[0].trim();
  return SERVABLE_MIME.has(mime) ? mime : 'application/octet-stream';
}

// Strip anything that could break out of the `filename="…"` header parameter
// or write outside a folder when the browser saves it.
function safeFileName(raw) {
  const name = String(raw || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
  return name.slice(0, 120) || 'document';
}

// One stored subdocument → the console's attachment descriptor.
//
// `file_url` and `download_url` are presigned: they carry their own authority
// and work in an <img>, a browser tab, and a save-as, none of which can attach
// an Authorization header.
function describeAttachment(requestId, doc, index, ttlMs) {
  const token = signDocumentToken({ requestId, index, ttlMs });
  // Role-neutral path: admins and assigned clinicians read the same bytes
  // through the same handler (routes/documents.js), and a provider app should
  // not be calling an `/admin/` URL. `/api/admin/documents/:token` still
  // resolves as an alias for grants minted before the move.
  const base = `${PUBLIC_BASE_URL}/api/documents/${token}`;
  const uploadedAt = doc && doc.uploaded_at ? new Date(doc.uploaded_at) : null;
  return {
    // Stable within a booking: the subdocuments are stored with `_id: false`,
    // so position IS the identity — and it is what the grant names.
    id: `${requestId}-${index}`,
    file_name: safeFileName(doc && doc.name),
    file_type: safeMime(doc && doc.mime),
    file_url: base,
    download_url: `${base}?download=1`,
    size_bytes: Number(doc && doc.size) > 0 ? Math.trunc(doc.size) : 0,
    uploaded_at:
      uploadedAt && !Number.isNaN(uploadedAt.getTime())
        ? uploadedAt.toISOString()
        : null,
  };
}

// Full `attachments` array for one care request. Skips entries whose stored
// location is unreadable/untrusted rather than advertising a tile that can
// only ever 404 — but keeps the position of every entry it does emit, because
// that position is what the grant resolves against.
function describeAttachments(requestId, documents, { ttlMs } = {}) {
  if (!Array.isArray(documents) || !requestId) return [];
  const out = [];
  documents.forEach((doc, index) => {
    if (!doc || !resolveDocumentSource(doc.url)) return;
    out.push(describeAttachment(String(requestId), doc, index, ttlMs));
  });
  return out;
}

// Decorates a serialized care request (a `toJSON()` result) in place with its
// `attachments` array, and strips the raw `documents` it was derived from.
//
// For handlers that return the WHOLE serialized row (the admin booking reads).
// The doctor console's `GET /doctor/bookings/:id` builds a hand-picked
// response object instead, so it calls `describeAttachments` directly — there
// is no raw `documents` key on its output to delete.
//
// Only ever call this on a payload whose handler has already established the
// caller may read this booking's medical records. A grant carries its own
// authority for 30 minutes; minting one is the access decision.
function withAttachments(json, { ttlMs } = {}) {
  if (!json || typeof json !== 'object') return json;
  json.attachments = describeAttachments(json.id || json._id, json.documents, {
    ttlMs,
  });
  // Drop the raw storage locations now that a presigned equivalent exists.
  // A Cloudinary asset is readable forever by anyone holding its URL, so
  // shipping it to a browser — where it lands in devtools, history, and any
  // installed extension — would leave a permanent way around the expiring
  // grants above. No admin surface reads `documents`; they all read
  // `attachments`.
  delete json.documents;
  return json;
}

module.exports = {
  describeAttachments,
  withAttachments,
  resolveDocumentSource,
  isStorableDocumentUrl,
  safeMime,
  safeFileName,
};
