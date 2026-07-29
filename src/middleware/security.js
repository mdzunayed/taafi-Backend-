// Centralised HTTP-security hardening layer.
//
// Everything the edge needs to survive the public internet lives here so
// server.js stays a wiring file: rate limiting, security headers (helmet),
// a strict CORS allow-list, and NoSQL-injection sanitization. Each piece is
// exported individually AND bundled into `applySecurity(app)` so the boot
// sequence is a single call in the right order.
//
// Order matters and is enforced by applySecurity():
//   1. trust proxy   — so the rate limiter keys on the real client IP.
//   2. helmet        — security headers on every response.
//   3. cors          — reject disallowed browser origins early.
//   4. mongoSanitize — strip operator injection from user input.
//   5. globalLimiter — blanket abuse protection.
//   (authLimiter is mounted per-route in routes/auth.js — see below.)

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const cors = require('cors');

const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === '1';

// Rate limiting is ON unless NODE_ENV explicitly names a dev/test box.
// Fail-closed on purpose: an UNSET NODE_ENV (the default on a Render service
// created by hand rather than from render.yaml) must never silently disable
// the limiter in production.
const RATE_LIMIT_BYPASS_ENV = ['development', 'test'].includes(
  process.env.NODE_ENV,
);

// The admin console fans out a dozen parallel requests on every page load and
// would burn a per-IP budget in a single view, so it is exempt. Matched on
// req.path — NOT originalUrl — so a `?x=/admin` query string on an unrelated
// endpoint can't be used to skip the limiter. Covers both mount points the
// admin router is bound to in server.js (`/admin` and `/api/admin`).
const ADMIN_PREFIXES = ['/admin', '/api/admin'];
const isAdminPath = (req) =>
  ADMIN_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`));

// ── 1. Rate limiters ────────────────────────────────────────────────────

// A limiter that no-ops when RATE_LIMIT_DISABLED=1 (local load testing),
// otherwise applies the given config. Returns a passthrough middleware in
// the disabled case so call sites don't branch.
function buildLimiter(opts) {
  if (RATE_LIMIT_DISABLED) return (_req, _res, next) => next();
  return rateLimit({
    standardHeaders: 'draft-7', // RateLimit-* response headers (RFC draft)
    legacyHeaders: false, // drop the deprecated X-RateLimit-* headers
    ...opts,
  });
}

// Global limiter — 1000 requests / 15 min / IP by default. Sized so an admin
// dashboard load or a chatty mobile session can't trip it, while still
// blunting scrapers and brute abuse across the whole API surface. Health
// checks and static uploads are skipped so probes/CDN don't burn a caller's
// budget; admin routes and dev/test environments are skipped entirely.
// RATE_LIMIT_MAX retunes the cap from the dashboard without a code deploy.
const globalLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 1000),
  message: {
    success: false,
    message: 'Too many requests — please slow down and try again shortly.',
  },
  skip: (req) =>
    req.path === '/health' ||
    req.path.startsWith('/uploads') ||
    isAdminPath(req) ||
    RATE_LIMIT_BYPASS_ENV,
});

// Auth/OTP limiter — 5 attempts / 15 min / IP. Mounted specifically on the
// credential + OTP endpoints (login, verify-otp, reset-password) to blunt
// brute-force and OTP-spray. Deliberately far stricter than the global cap.
const authLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  // Don't count successful logins against the limit — only failed attempts
  // burn the budget, so a legitimate user isn't locked out by their own
  // successful sign-ins.
  skipSuccessfulRequests: true,
  // Dev/test only — never relaxed in production. The 5-attempt cap is only
  // safe because `trust proxy` (below) makes this key on the real client IP;
  // untrusted, five failed logins from anyone would lock out everyone.
  skip: () => RATE_LIMIT_BYPASS_ENV,
  message: {
    success: false,
    message:
      'Too many attempts. For your security this action is locked for a few minutes.',
  },
});

// ── 2. Helmet (security headers + CSP) ──────────────────────────────────

function buildHelmet() {
  return helmet({
    // This is a JSON API that also serves uploaded images from /uploads.
    // A conservative CSP still adds defense-in-depth for the few HTML
    // surfaces (payment gateway callbacks, error pages).
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // Uploaded media + data URIs (avatars rendered in emails/callbacks).
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
        // No plugins, no framing — clickjacking protection.
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    // The Flutter app and the web admin load /uploads images cross-origin;
    // allow that while keeping the header present.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // HSTS is only meaningful over TLS; the reverse proxy terminates TLS in
    // prod. Keep the default 180-day max-age.
    hsts: { maxAge: 15552000, includeSubDomains: true },
    // Hide the framework fingerprint (also stripped by disabling x-powered-by).
    hidePoweredBy: true,
  });
}

// ── 3. CORS allow-list ──────────────────────────────────────────────────

// Native mobile clients (the Flutter apps) send NO Origin header, so they're
// always allowed. Browser origins must appear in CORS_ALLOWED_ORIGINS. In
// local dev (no allow-list configured) we fall back to reflecting the origin
// so the admin console on localhost / a LAN IP just works.
function parseAllowedOrigins() {
  return (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

// `flutter run -d chrome` binds a NEW random port on every launch, so a local
// web build can never be named in an exact-match allow-list. Matching loopback
// hosts on any port is the only way to express "my own machine" — without it,
// the standard dev loop (local Flutter Web against the deployed API) fails its
// preflight, and Dio on web reports that as a bare `XMLHttpRequest error` with
// no status, which looks nothing like a CORS problem.
//
// Anchored at both ends, and the host alternatives reject anything with a
// prefix or suffix, so `https://localhost.attacker.com` does NOT match.
const LOOPBACK_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isDevOrTestEnv() {
  return ['development', 'test'].includes(process.env.NODE_ENV);
}

// Opt-in in production: an operator debugging the web admin against the live
// API sets CORS_ALLOW_LOCALHOST=1 for as long as they need it, rather than the
// deployment trusting every page on every viewer's machine by default.
function allowsLocalhost() {
  return isDevOrTestEnv() || process.env.CORS_ALLOW_LOCALHOST === '1';
}

function buildCors() {
  const allowList = parseAllowedOrigins();
  const devMode = allowList.length === 0;
  const allowLocalhost = allowsLocalhost();
  return cors({
    origin(origin, cb) {
      // No Origin header → native app / server-to-server / curl → allow.
      if (!origin) return cb(null, true);
      if (devMode) return cb(null, true); // permissive fallback for local dev
      if (allowList.includes(origin)) return cb(null, true);
      if (allowLocalhost && LOOPBACK_ORIGIN.test(origin)) return cb(null, true);
      // Disallowed browser origin: resolve WITHOUT the Access-Control-Allow-
      // Origin header (cb(null, false)) rather than throwing. The browser
      // then blocks the response client-side, and we avoid a noisy 500 /
      // error-handler round-trip on every rejected preflight.
      //
      // Name the remedy in the log line: this rejection is invisible from the
      // browser side beyond a generic network error, so the server log is the
      // only place the cause can be read.
      console.warn(
        `[security] CORS blocked origin: ${origin} — add it to ` +
          'CORS_ALLOWED_ORIGINS' +
          (LOOPBACK_ORIGIN.test(origin)
            ? ', or set CORS_ALLOW_LOCALHOST=1 to allow loopback origins on any port'
            : ''),
      );
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-account-id',
      'X-Account-Id',
    ],
    maxAge: 86400, // cache preflight for a day
  });
}

// ── 4. NoSQL-injection sanitization ─────────────────────────────────────

// Strips any key beginning with `$` or containing `.` from req.body,
// req.query and req.params, neutralising Mongo operator-injection payloads
// like `{ "phone": { "$gt": "" } }` or `{ "role.$set": "admin" }`. The
// replaceWith:'_' keeps the request shape intact (rather than deleting keys)
// and logs the first offending key so probes are visible in the logs.
function buildMongoSanitize() {
  return mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
      console.warn(
        `[security] sanitized injection attempt: key="${key}" ` +
          `ip=${req.ip} path=${req.path}`,
      );
    },
  });
}

// ── Bundled application ─────────────────────────────────────────────────

/**
 * Apply the full security stack to an Express app in the correct order.
 * Call this immediately after `const app = express()` and BEFORE the body
 * parsers/routes so headers and rate limits cover everything.
 */
function applySecurity(app) {
  // Render (like every PaaS) terminates TLS at exactly ONE proxy hop in front
  // of the app. Without this, req.ip is the proxy's address, every caller
  // shares a single rate-limit bucket, and the whole user base gets 429'd at
  // once. Default to 1 hop so a service created by hand in the dashboard —
  // with no TRUST_PROXY_HOPS var set — is still correct out of the box.
  // Set TRUST_PROXY_HOPS=0 when running with NO proxy in front (bare VPS),
  // where trusting X-Forwarded-For would let a client spoof its own IP.
  // `??` not `||`: an explicit 0 must survive. A hop *count* (rather than
  // `true`) also keeps express-rate-limit's permissive-trust-proxy validator
  // satisfied.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  app.set('trust proxy', Number.isFinite(hops) ? hops : 1);

  app.disable('x-powered-by');

  // An empty allow-list silently flips CORS to reflect-any-origin WITH
  // credentials:true — the opposite of how NODE_ENV is treated a few lines
  // up, and easy to ship by accident because render.yaml lists
  // CORS_ALLOWED_ORIGINS as optional. Warn rather than exit: a running
  // deployment must not start crash-looping on a redeploy over this.
  if (!isDevOrTestEnv() && parseAllowedOrigins().length === 0) {
    console.warn(
      '[security] WARNING: CORS_ALLOWED_ORIGINS is unset outside dev/test —\n' +
        '  every browser origin is being reflected with credentials enabled.\n' +
        '  Set it to your admin console origin(s), comma-separated. Native\n' +
        '  Flutter clients send no Origin header and are unaffected.',
    );
  }
  if (!isDevOrTestEnv() && process.env.CORS_ALLOW_LOCALHOST === '1') {
    console.warn(
      '[security] NOTE: CORS_ALLOW_LOCALHOST=1 — loopback origins on any port\n' +
        '  are accepted. Intended for local frontend development against this\n' +
        '  deployment; unset it when you are done.',
    );
  }

  app.use(buildHelmet());
  app.use(buildCors());
  // Sanitize runs after the body parsers are mounted (server.js mounts them
  // right after this call) — express-mongo-sanitize is applied there in the
  // pipeline. We expose it separately so ordering stays explicit in server.js.
  app.use(globalLimiter);
}

module.exports = {
  applySecurity,
  globalLimiter,
  authLimiter,
  mongoSanitize: buildMongoSanitize(),
  cors: buildCors,
  helmet: buildHelmet,
};
