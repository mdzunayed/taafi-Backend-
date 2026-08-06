// Delivery route for ONE patient medical document, addressed by a presigned
// grant (see utils/documentAccess.js).
//
// Deliberately NOT behind a role guard: the surfaces that consume it — an
// `<img>` tag, a browser/native tab opened for a PDF, a save-as, a
// `flutter_pdfview` download — cannot attach an Authorization header. The
// grant in the path IS the credential. It names exactly one document on
// exactly one booking, it expires (~30 min), and it is unforgeable, so
// "a tampered or aged-out grant is refused" is the entire authorization story
// for this handler. Everything upstream of it decides WHO gets a grant:
//
//   • admin  — `requireRole('admin')` on the booking reads in routes/admin.js
//   • doctor / nurse — the assignment check on GET /doctor/bookings/:id,
//     which 403s anyone who is not the clinician dispatched to that visit
//
// Lives in its own module (rather than inline on the admin router, where it
// started) because it now serves two audiences. Mounted at `/api/documents`,
// with `GET /admin/documents/:token` kept as an alias so grants already in
// flight — and any admin surface holding one — keep resolving.

const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const CareRequest = require('../models/CareRequest');
const {
  resolveDocumentSource,
  safeMime,
  safeFileName,
} = require('../utils/bookingAttachments');
const { verifyDocumentToken } = require('../utils/documentAccess');

// GET /:token — resolve the grant, then stream the bytes it names.
//
// Exported as a bare handler so routes/admin.js can mount the same function
// on its legacy path without a second implementation to drift from this one.
async function deliverDocument(req, res) {
  try {
    const grant = verifyDocumentToken(req.params.token);
    if (!grant) {
      return res.status(403).json({
        message:
          'This document link is invalid or has expired. Reopen the booking to get a fresh link.',
      });
    }
    if (!mongoose.isValidObjectId(grant.requestId)) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const booking = await CareRequest.findById(grant.requestId, 'documents');
    const doc =
      booking && Array.isArray(booking.documents)
        ? booking.documents[grant.index]
        : null;
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    // Re-checked at READ time even though pickDocuments already screened it on
    // write: rows created before that check exist, and this is the request
    // that would actually perform the fetch.
    const source = resolveDocumentSource(doc.url);
    if (!source) {
      return res
        .status(502)
        .json({ message: 'This document is no longer readable from storage.' });
    }

    let body;
    if (source.kind === 'disk') {
      try {
        body = await fs.promises.readFile(source.filePath);
      } catch (_) {
        return res.status(404).json({ message: 'Document not found' });
      }
    } else {
      // 15s ceiling: a hung storage fetch must not pin a caller's request
      // (and its socket) open indefinitely.
      const upstream = await fetch(source.url, {
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) {
        return res
          .status(502)
          .json({ message: 'Storage did not return the document.' });
      }
      body = Buffer.from(await upstream.arrayBuffer());
    }

    const fileName = safeFileName(doc.name);
    // `?download=1` is a presentation switch, not a privilege one, which is
    // why it sits outside the signature — the same grant serves both.
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', safeMime(doc.mime));
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${fileName}"`,
    );
    // nosniff matters here specifically: `safeMime` collapses anything
    // unrecognised to octet-stream, and without this a browser could still
    // sniff those bytes back into something it will execute on our origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Medical records must not be written to a shared/proxy cache, and the
    // grant they were fetched with outlives neither.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

const router = express.Router();
router.get('/:token', deliverDocument);

module.exports = router;
module.exports.deliverDocument = deliverDocument;
