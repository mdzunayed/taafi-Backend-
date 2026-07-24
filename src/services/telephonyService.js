// Masked-calling gateway. Bridges a patient and their assigned provider on a
// dual-legged voice call through a proxy number so NEITHER party ever sees
// the other's real mobile number.
//
// Driver model — the concrete telephony backend is pluggable and selected at
// call time from the environment, so this file never hard-depends on a paid
// SDK:
//   • `simulated` (default) — no external dependency, no credentials. Logs
//     the two legs and returns a `connecting` status + a masked proxy-line
//     display string, so the full app UX (button → "Connecting via secure
//     proxy line…") works end-to-end in dev and demos.
//   • `twilio` — auto-selected the moment TWILIO_ACCOUNT_SID + TWILIO_AUTH_
//     TOKEN + TWILIO_PROXY_NUMBER are all present. Lazily `require('twilio')`
//     so the dependency is only needed once you actually wire a live account.
//
// The controller (controllers/telephonyController.js) is driver-agnostic: it
// resolves the two phone numbers + validates access, then hands them here.

const crypto = require('crypto');

function twilioConfigured() {
  return (
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_PROXY_NUMBER
  );
}

// Which driver is live. Exposed so the controller/health checks can report it.
function activeDriver() {
  return twilioConfigured() ? 'twilio' : 'simulated';
}

// Mask a phone number for display: keep the last two digits, dot out the
// rest. `+8801712345678` → `+880·······78`. Never reveals the real number.
function maskNumber(num) {
  const s = String(num || '');
  if (s.length <= 3) return '•••';
  const prefix = s.startsWith('+') ? s.slice(0, 4) : s.slice(0, 2);
  const last2 = s.slice(-2);
  return `${prefix}${'·'.repeat(Math.max(3, s.length - prefix.length - 2))}${last2}`;
}

// ── simulated driver ────────────────────────────────────────────────────────
async function bridgeSimulated({ legA, legB, context }) {
  const callId = `sim_${crypto.randomBytes(8).toString('hex')}`;
  // Never log the raw numbers — mask them even in the server log.
  console.log(
    `[telephony:sim] bridging call ${callId} for booking ` +
      `${context?.bookingId || 'n/a'} — proxy dials ${maskNumber(legA)} ` +
      `AND ${maskNumber(legB)}`,
  );
  return {
    callId,
    status: 'connecting',
    // A stable-looking masked proxy line the client can show as the number
    // "in use" for this bridge. Purely cosmetic in the simulated driver.
    proxyDisplay: '+880 9600 TAAFI',
  };
}

// ── twilio driver (lazy) ─────────────────────────────────────────────────────
async function bridgeTwilio({ legA, legB, context }) {
  // Lazy require so `twilio` is only needed when a live account is wired.
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
  );
  const proxy = process.env.TWILIO_PROXY_NUMBER;
  const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL || undefined;
  // Dual-leg dial: the proxy calls legA, and once answered, a <Dial> TwiML
  // connects it to legB — both parties only ever see the proxy number.
  const twiml =
    `<Response><Say>Connecting your secure Taafi call.</Say>` +
    `<Dial callerId="${proxy}">${legB}</Dial></Response>`;
  const call = await client.calls.create({
    to: legA,
    from: proxy,
    twiml,
    statusCallback,
  });
  return {
    callId: call.sid,
    status: 'connecting',
    proxyDisplay: maskNumber(proxy),
  };
}

// Public entry point. `legA` is dialled first (the caller), then bridged to
// `legB`. `context` carries booking metadata for logging/telemetry.
async function bridgeCall({ legA, legB, context }) {
  if (!legA || !legB) {
    throw new Error('Both call legs (phone numbers) are required');
  }
  if (twilioConfigured()) {
    return bridgeTwilio({ legA, legB, context });
  }
  return bridgeSimulated({ legA, legB, context });
}

module.exports = {
  bridgeCall,
  activeDriver,
  maskNumber,
};
