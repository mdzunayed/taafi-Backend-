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
const ALLOWED_MIME = /^image\/(jpeg|jpg|png|webp)$/i;

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      const err = new Error('Only JPEG / PNG / WEBP images are allowed');
      // Tag it so uploadErrors.js can recognise this rejection by code
      // instead of regex-matching the message string across two files.
      err.code = 'INVALID_FILE_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
});

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
  writeImageToDisk,
  deleteImageFromDisk,
  storeImage,
  removeImage,
  UPLOAD_DIR,
};
