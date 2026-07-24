const fs = require('fs');

// Every uploaded image is written to disk as `<publicId>.jpg` regardless of
// its real format (middleware/upload.js#writeImageToDisk), while the multer
// filter accepts JPEG, PNG *and* WebP. express.static then derives
// `Content-Type: image/jpeg` from that extension — so PNG/WebP bytes get
// served under a JPEG type.
//
// Native Flutter shrugs this off (Skia sniffs magic bytes and ignores the
// declared type), but Flutter Web on CanvasKit hands the response type to the
// browser's ImageDecoder, which requires type and bytes to agree and throws
//   EncodingError: The source image cannot be decoded.
// when they don't. Hence: decide the type from the bytes, not the filename.

const SNIFF_BYTES = 12;

// Cache the verdict per (path, mtime, size) so a hot banner costs one statSync
// in express.static's own pipeline rather than a file read on every request.
// Bounded and cleared wholesale on overflow — this is a tiny hot-set (the
// upload dir), not a general-purpose LRU.
const MAX_CACHE_ENTRIES = 500;
const cache = new Map();

// Returns the MIME type implied by the leading magic bytes, or null when the
// signature is unrecognised — the caller then leaves whatever Content-Type
// express.static already derived from the extension in place.
function mimeFromMagic(buf, length) {
  if (length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
  if (length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return 'image/gif';
  }
  return null;
}

/**
 * Sniff the true image MIME type of a file on disk.
 *
 * @param {string} filePath  Absolute path to the file being served.
 * @param {fs.Stats} [stat]  The stat express.static already performed; used
 *                           only to key the cache. Omitting it just means a
 *                           colder cache, never a wrong answer.
 * @returns {string|null}    MIME type, or null if unrecognised/unreadable.
 */
function sniffImageMime(filePath, stat) {
  const key = stat
    ? `${filePath}:${stat.mtimeMs}:${stat.size}`
    : filePath;

  if (cache.has(key)) return cache.get(key);

  let mime = null;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(SNIFF_BYTES);
    const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    mime = mimeFromMagic(buf, read);
  } catch {
    // Unreadable/vanished file: fall through with null. This runs inside
    // express.static's setHeaders hook, where throwing would break the
    // response rather than produce a clean 404.
    mime = null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }

  // Cache negatives too — a non-image in the upload dir shouldn't be re-read
  // on every hit either.
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, mime);

  return mime;
}

module.exports = { sniffImageMime };
