const multer = require('multer');

// Multer rejects a request BEFORE the route handler runs, so the try/catch
// inside every upload route is bypassed entirely — those catches only ever
// see DB/Cloudinary failures. Without this handler the rejection falls to the
// generic one in server.js, which has no `.status` to read and so reports
// every one of them as a 500 ("Server error") while logging a full stack
// trace for what is really routine client input.
//
// The practical cost: an admin whose photo is over the limit is told the
// server is broken, and a frontend doing `if (status >= 500)` cannot tell
// "your file is too big" from "the database is down".

// fileFilter (middleware/upload.js) rejects with a plain Error, not a
// MulterError, so it has to be matched separately. It tags the error with
// code 'ONLY_ALLOWED_IMAGES'. The older 'INVALID_FILE_TYPE' tag and the
// message regex are both kept as fallbacks: a request already in flight
// across a deploy, or an error raised somewhere that predates either tag,
// must not regress to a 500.
const MIMETYPE_REJECTION = /only jpeg[ ,/]+png[ ,/]*(and )?webp images are allowed/i;

const REJECTION_CODES = new Set(['ONLY_ALLOWED_IMAGES', 'INVALID_FILE_TYPE']);

function isMimetypeRejection(err) {
  if (!err) return false;
  return (
    REJECTION_CODES.has(err.code) || MIMETYPE_REJECTION.test(err.message || '')
  );
}

const CODE_MAP = {
  LIMIT_FILE_SIZE: [413, 'Image is larger than the 8 MB limit.'],
  LIMIT_UNEXPECTED_FILE: [400, 'Unexpected upload field.'],
  LIMIT_FILE_COUNT: [400, 'Too many files in one request.'],
  LIMIT_PART_COUNT: [400, 'Too many parts in the upload.'],
  LIMIT_FIELD_KEY: [400, 'Upload field name is too long.'],
  LIMIT_FIELD_VALUE: [400, 'Upload field value is too long.'],
  LIMIT_FIELD_COUNT: [400, 'Too many fields in the upload.'],
};

function uploadErrorHandler(err, _req, res, next) {
  if (!(err instanceof multer.MulterError)) {
    if (isMimetypeRejection(err)) {
      return res.status(415).json({ success: false, message: err.message });
    }
    return next(err);
  }

  const [status, message] = CODE_MAP[err.code] || [400, err.message];

  // Name the offending field — LIMIT_UNEXPECTED_FILE is the failure mode most
  // likely to be mistaken for "the upload silently did nothing", and knowing
  // the field turns it into a one-line fix.
  const detail = err.field ? `${message} (field "${err.field}")` : message;

  return res.status(status).json({ success: false, message: detail });
}

module.exports = { uploadErrorHandler };
