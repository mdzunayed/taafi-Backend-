// Single source of truth for the API's own public origin.
//
// Four routers (services, promoBanners, appOpenAd, homeSections) each used to
// carry their own `process.env.PUBLIC_BASE_URL || 'http://localhost:4000'`
// fallback, while .env actually sets PORT=5000 — so an unset PUBLIC_BASE_URL
// produced absolute URLs pointing at a port nothing listens on. Worse, on
// Render PUBLIC_BASE_URL is `sync: false` (entered by hand in the dashboard):
// if it was never filled in, every /uploads URL a client receives points at
// *localhost*, which a phone on mobile data obviously cannot reach. That is
// the "mobile can't render newly uploaded images" symptom.
//
// Deriving the fallback from PORT keeps local dev honest; isConfigured() lets
// the boot sequence warn loudly when the real deployment forgot to set it.

const PORT = process.env.PORT || 5000;

// Trailing slashes are stripped so callers can always join with a leading '/'
// without producing a double slash.
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`
).replace(/\/+$/, '');

function isConfigured() {
  return !!process.env.PUBLIC_BASE_URL;
}

// Absolute URL for a bare filename stored by the disk fallback.
function uploadUrl(filename) {
  return filename ? `${PUBLIC_BASE_URL}/uploads/${filename}` : null;
}

// Absolutizes a stored image field. Values are one of two shapes: a full
// https URL (Cloudinary) or a bare filename (disk fallback). Cloud URLs must
// pass through untouched.
function toAbsolute(value) {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : uploadUrl(value);
}

module.exports = { PUBLIC_BASE_URL, isConfigured, uploadUrl, toAbsolute };
