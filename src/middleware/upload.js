const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cloudinary = require('./cloudinary');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

// Only the disk fallback needs the directory. With Cloudinary configured
// nothing ever reads it, and creating it on a read-only or ephemeral
// filesystem is noise at best.
if (!cloudinary.isEnabled() && !fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.memoryStorage();

// `image/jpg` is not a registered MIME type, but enough clients send it that
// rejecting it would only produce confusing failures for real JPEGs.
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

// Checked alongside the MIME type rather than instead of it. The Content-Type
// on a multipart part is whatever the client chose to write there, so a
// `payload.svg` announced as `image/jpeg` passed the old MIME-only test and
// reached storeImage. Requiring the extension to agree closes that.
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Every client in this repo sends a name with an extension — dio_client
// defaults to avatar.jpg / attachment.jpg and prepareImageForUpload falls back
// to upload.jpg — so an extensionless upload is a malformed request, not a
// legitimate caller we would be breaking.
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (!ALLOWED_MIME.has(mime) || !ALLOWED_EXT.has(ext)) {
      const err = new Error('Only JPEG, PNG, and WEBP images are allowed.');
      // Tag it so uploadErrors.js can recognise this rejection by code
      // instead of regex-matching the message string across two files.
      err.code = 'ONLY_ALLOWED_IMAGES';
      return cb(err, false);
    }
    cb(null, true);
  },
});

// ── Patient medical documents ───────────────────────────────────────────────
// Separate pipeline from the image uploader above: a discharge summary or an
// old prescription is usually a PDF, and widening ALLOWED_MIME would have let
// PDFs into every avatar/service-image endpoint too.
const ALLOWED_DOC_MIME = new Set([...ALLOWED_MIME, 'application/pdf']);
const ALLOWED_DOC_EXT = new Set([...ALLOWED_EXT, '.pdf']);

const documentUpload = multer({
  storage,
  // Same 8 MB cap as the image uploader. Deliberately identical: multer's
  // LIMIT_FILE_SIZE error carries no limit value, so uploadErrors.js can only
  // name one number — and a message that quotes the wrong cap is worse than
  // the slightly tighter limit.
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_DOC_MIME.has(mime) || !ALLOWED_DOC_EXT.has(ext)) {
      const err = new Error('Only PDF, JPEG, PNG, and WEBP files are allowed.');
      err.code = 'ONLY_ALLOWED_DOCUMENTS';
      return cb(err, false);
    }
    cb(null, true);
  },
});

function writeDocumentToDisk(buffer, publicId, ext) {
  const filename = `${publicId}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, filename);
  // Document public ids are namespaced (`patient-docs/<account>-<ts>`), so the
  // target sits in a SUBDIRECTORY of UPLOAD_DIR that nothing has created yet —
  // writeFileSync does not make parents, and without this every disk-fallback
  // upload fails with ENOENT.
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);
  return filename;
}

/// Store a patient document and return the value to persist: a full
/// Cloudinary https URL, or a bare filename served off the /uploads mount in
/// local dev (same two shapes as [storeImage]).
async function storeDocument(buffer, publicId, { mime, ext }) {
  const isPdf = String(mime || '').toLowerCase() === 'application/pdf';
  if (cloudinary.isEnabled()) {
    // PDFs go through the `raw` pipeline; images keep the image pipeline so
    // Cloudinary's transformations/CDN still apply to them.
    return cloudinary.uploadBuffer(buffer, publicId, isPdf ? 'raw' : 'image');
  }
  return writeDocumentToDisk(buffer, publicId, ext || '');
}

function writeImageToDisk(buffer, serviceId) {
  const filename = `${serviceId}.jpg`;
  const fullPath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(fullPath, buffer);
  return filename;
}

function deleteImageFromDisk(serviceId) {
  const fullPath = path.join(UPLOAD_DIR, `${serviceId}.jpg`);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

// Unified image writer. Returns the value to store in the document's
// image field:
//   • Cloudinary on  → a full https URL (survives Render restarts).
//   • Cloudinary off → a bare filename, served via the /uploads static
//     mount + PUBLIC_BASE_URL (existing local-dev behaviour).
// Callers store whatever comes back as-is; the services `decorate()`
// helper only prepends PUBLIC_BASE_URL when the value isn't already a
// full URL, so both shapes round-trip correctly.
async function storeImage(buffer, publicId) {
  if (cloudinary.isEnabled()) {
    return cloudinary.uploadBuffer(buffer, publicId);
  }
  return writeImageToDisk(buffer, publicId);
}

// Mirror of storeImage for removal — clears whichever backend holds it.
async function removeImage(publicId) {
  await cloudinary.destroy(publicId);
  deleteImageFromDisk(publicId);
}

module.exports = {
  upload,
  documentUpload,
  writeImageToDisk,
  deleteImageFromDisk,
  storeImage,
  storeDocument,
  removeImage,
  UPLOAD_DIR,
};
