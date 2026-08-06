// The one thing under UPLOAD_DIR that is NOT public.
//
// `/uploads` is an open static mount — service images, avatars, and banners
// are meant to be fetched by anyone. Patient medical documents (discharge
// summaries, lab reports, old prescriptions) land in the SAME directory under
// `patient-docs/` whenever Cloudinary is off, which is every local and
// self-hosted deployment. Without this guard the static mount would hand a
// stranger's medical record to anyone who guessed a filename.
//
// They are readable only through `GET /api/admin/documents/:token`, which
// requires a presigned, expiring grant that an admin-gated endpoint minted
// (see utils/documentAccess.js).
//
// Must be mounted BEFORE `express.static` — ordering is the whole mechanism.

const PRIVATE_SUBTREE = /(^|\/)patient-docs(\/|$)/i;

function blockPrivateUploads(req, res, next) {
  let pathname;
  try {
    // Decode first: `%2E%2E%2Fpatient-docs%2Fx.pdf` must be judged as the path
    // express.static will ultimately resolve, not as the raw escape sequence.
    pathname = decodeURIComponent(req.path);
  } catch (_) {
    // Undecodable percent-escapes are never a legitimate asset request, and
    // letting them through would mean this check ran on a different string
    // than express.static resolves — the exact gap a bypass lives in.
    return res.status(400).json({ message: 'Malformed upload path.' });
  }
  if (PRIVATE_SUBTREE.test(pathname)) {
    return res.status(403).json({
      message: 'Medical documents are not publicly accessible.',
    });
  }
  return next();
}

module.exports = { blockPrivateUploads };
