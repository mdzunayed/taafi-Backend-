// SSLCommerz payment-gateway service for the two-phase booking flow.
//
// Strategy (mirrors fcmService.js graceful-degradation):
//   - When SSLCZ_STORE_ID / SSLCZ_STORE_PASSWD are configured we drive the
//     real SSLCommerz hosted checkout: `initSession()` opens a payment
//     session and returns the GatewayPageURL the client redirects to;
//     `validate()` confirms an IPN/return via the server-to-server
//     validation API before we trust a payment.
//   - When creds are ABSENT the service degrades to SIMULATED mode:
//     `initSession()` returns `{ simulated: true }` so the route can mark
//     the payment settled instantly with a synthetic transaction id, and
//     `validate()` trusts the caller. This lets the whole two-phase
//     workflow run end-to-end today; drop sandbox keys into `.env` to go
//     live with zero code changes.
//
// Configuration (set in `.env`):
//   SSLCZ_STORE_ID       — SSLCommerz store id (sandbox or live)
//   SSLCZ_STORE_PASSWD   — SSLCommerz store password
//   SSLCZ_IS_LIVE        — "true" for production endpoints, else sandbox
//   PUBLIC_BASE_URL      — base for success/fail/cancel/ipn callback URLs

const SANDBOX_BASE = 'https://sandbox.sslcommerz.com';
const LIVE_BASE = 'https://securepay.sslcommerz.com';

function isLive() {
  return String(process.env.SSLCZ_IS_LIVE || '').toLowerCase() === 'true';
}

function baseUrl() {
  return isLive() ? LIVE_BASE : SANDBOX_BASE;
}

function isConfigured() {
  return Boolean(process.env.SSLCZ_STORE_ID && process.env.SSLCZ_STORE_PASSWD);
}

// Synthetic transaction id used both as the SSLCommerz `tran_id` and, in
// simulated mode, as the settled gateway reference stored on the request.
function makeTranId(prefix = 'MT') {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${Date.now()}-${rand}`;
}

// Opens a payment session.
//   opts: { amount, tranId, successUrl, failUrl, cancelUrl, ipnUrl,
//           productName, customer: { name, email, phone } }
// Returns (real):      { simulated: false, gatewayUrl, sessionkey, tranId }
// Returns (fallback):  { simulated: true, tranId }
async function initSession(opts) {
  const tranId = opts.tranId || makeTranId();
  if (!isConfigured()) {
    return { simulated: true, tranId };
  }

  const c = opts.customer || {};
  const form = new URLSearchParams({
    store_id: process.env.SSLCZ_STORE_ID,
    store_passwd: process.env.SSLCZ_STORE_PASSWD,
    total_amount: String(opts.amount),
    currency: 'BDT',
    tran_id: tranId,
    success_url: opts.successUrl || '',
    fail_url: opts.failUrl || '',
    cancel_url: opts.cancelUrl || '',
    ipn_url: opts.ipnUrl || '',
    shipping_method: 'NO',
    product_name: opts.productName || 'Taafi Booking',
    product_category: 'Service',
    product_profile: 'general',
    cus_name: c.name || 'Taafi Patient',
    cus_email: c.email || 'noreply@taafi.app',
    cus_phone: c.phone || '00000000000',
    cus_add1: c.address || 'N/A',
    cus_city: 'Dhaka',
    cus_country: 'Bangladesh',
  });

  const res = await fetch(`${baseUrl()}/gwprocess/v4/api.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await res.json();
  if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
    const reason = data.failedreason || data.status || 'unknown error';
    throw new Error(`SSLCommerz session init failed: ${reason}`);
  }
  return {
    simulated: false,
    gatewayUrl: data.GatewayPageURL,
    sessionkey: data.sessionkey,
    tranId,
  };
}

// Server-to-server validation of a completed payment. Confirms the gateway
// reports the transaction VALID for at least `expectedAmount` BDT.
//   params: { valId, expectedAmount }
// In simulated mode (no creds) we trust the caller and return true.
async function validate({ valId, expectedAmount }) {
  if (!isConfigured()) return true;
  if (!valId) return false;

  const qs = new URLSearchParams({
    val_id: valId,
    store_id: process.env.SSLCZ_STORE_ID,
    store_passwd: process.env.SSLCZ_STORE_PASSWD,
    format: 'json',
  });
  const res = await fetch(
    `${baseUrl()}/validator/api/validationserverAPI.php?${qs.toString()}`,
  );
  const data = await res.json();
  const ok = data.status === 'VALID' || data.status === 'VALIDATED';
  if (!ok) return false;
  if (expectedAmount != null) {
    const paid = Number(data.amount);
    // Allow a tiny rounding tolerance; reject underpayment.
    if (!Number.isFinite(paid) || paid + 0.5 < Number(expectedAmount)) {
      return false;
    }
  }
  return true;
}

module.exports = { isConfigured, initSession, validate, makeTranId };
