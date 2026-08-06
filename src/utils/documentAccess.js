// Presigned, time-limited grants for patient medical documents.
//
// The admin console has to render a discharge summary inside an assignment
// drawer AND hand a PDF to a browser tab / a download. A browser tab carries
// no `Authorization` header, so the usual `requireRole('admin')` guard cannot
// reach those two surfaces — which is why the raw Cloudinary/uploads URL used
// to be the only thing that worked, and why anyone holding that URL could read
// a stranger's medical record forever.
//
// A grant replaces it: an admin-gated endpoint mints one, it names exactly one
// document on exactly one booking, it expires, and it is verifiable with no DB
// round-trip and no session. Everything about the grant is in the string, so
// the delivery route below can stay stateless.
//
// Token shape:  base64url("<requestId>.<index>.<expiresAtMs>") + "." + hmac
//
// The HMAC is keyed with JWT_SECRET but namespaced with a version label, so a
// grant can never be replayed as (or confused with) any other artefact this
// key signs.

const crypto = require('crypto');

// Mirrors utils/jwt.js — the same secret, deliberately: one thing to rotate.
// jwt.js already prints the "you forgot to set this" warning at boot, so this
// module stays quiet rather than double-shouting on every start.
const SECRET = process.env.JWT_SECRET || 'dev-not-for-prod';

// Long enough for an admin to open a drawer, read a lab report, and download
// it; short enough that a grant leaked through a browser history or a proxy
// log is worthless by the time anyone finds it.
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const NAMESPACE = 'taafi.doc.v1';

function hmac(payload) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${NAMESPACE}.${payload}`)
    .digest('base64url');
}

// Constant-time compare that tolerates length mismatch. `timingSafeEqual`
// THROWS on differing lengths, which would both crash the handler and leak
// length as a side channel — so the guard is required, not defensive noise.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Mint a grant for `documents[index]` of one care request.
function signDocumentToken({ requestId, index, ttlMs = DEFAULT_TTL_MS }) {
  const id = String(requestId || '').trim();
  const i = Number(index);
  if (!id) throw new Error('signDocumentToken: requestId is required');
  if (!Number.isInteger(i) || i < 0) {
    throw new Error('signDocumentToken: index must be a non-negative integer');
  }
  const payload = `${id}.${i}.${Date.now() + ttlMs}`;
  return `${Buffer.from(payload).toString('base64url')}.${hmac(payload)}`;
}

// Returns `{ requestId, index }` for a valid, unexpired grant, or null for
// anything else. Never throws — a malformed token is an ordinary 403, not a
// 500, and callers must not have to wrap this in try/catch.
function verifyDocumentToken(token) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (_) {
    return null;
  }

  // Verify BEFORE parsing: nothing inside an unauthenticated payload is
  // trustworthy enough to branch on.
  if (!safeEqual(signature, hmac(payload))) return null;

  const parts = payload.split('.');
  if (parts.length !== 3) return null;

  const [requestId, indexRaw, expRaw] = parts;
  const index = Number(indexRaw);
  const expiresAt = Number(expRaw);
  if (!requestId || !Number.isInteger(index) || index < 0) return null;
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return null;

  return { requestId, index, expiresAt };
}

module.exports = { signDocumentToken, verifyDocumentToken, DEFAULT_TTL_MS };
