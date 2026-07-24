/**
 * Taafi backend load-test suite (autocannon).
 *
 * Runs three high-concurrency scenarios sequentially and prints a latency /
 * throughput summary for each:
 *
 *   1. AUTH      — 100 concurrent login attempts        (POST /api/auth/login)
 *   2. CATALOG   — 500 concurrent service-catalog reads (GET  /api/services?active=1)
 *   3. BOOKING   — high-concurrency care-request creates (POST /patient/requests)
 *
 * Usage:
 *   # start the API first (ideally with limits off so the limiter doesn't
 *   # reject the flood and skew the numbers):
 *   RATE_LIMIT_DISABLED=1 npm run dev
 *
 *   # then, in another shell:
 *   npm run loadtest
 *   # or target a deployed host / tune the run:
 *   BASE_URL=https://api.taafi.app DURATION=30 npm run loadtest
 *
 * Env knobs:
 *   BASE_URL      default http://localhost:4000
 *   DURATION      per-scenario seconds (default 15)
 *   AUTH_TOKEN    bearer token for the authenticated BOOKING scenario
 *   TEST_PHONE / TEST_PASSWORD   creds used by the AUTH scenario
 *   TEST_SERVICE_ID / TEST_ADDRESS_ID   ids used by the BOOKING body
 *
 * NOTE: with rate limiting ON, scenarios 1 and 3 will mostly receive 429s —
 * that's the limiter doing its job, not a failure. Set RATE_LIMIT_DISABLED=1
 * on the server to measure raw capacity.
 */

const autocannon = require('autocannon');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const DURATION = Number(process.env.DURATION || 15);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const scenarios = [
  {
    name: '1. AUTH — 100 concurrent logins',
    opts: {
      url: `${BASE_URL}/api/auth/login`,
      connections: 100,
      duration: DURATION,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: process.env.TEST_PHONE || '8801700000001',
        password: process.env.TEST_PASSWORD || 'password',
        role: 'patient',
      }),
    },
  },
  {
    name: '2. CATALOG — 500 concurrent service fetches',
    opts: {
      url: `${BASE_URL}/api/services?active=1`,
      connections: 500,
      duration: DURATION,
      method: 'GET',
    },
  },
  {
    name: '3. BOOKING — high-concurrency care-request creates',
    opts: {
      url: `${BASE_URL}/patient/requests`,
      connections: 200,
      duration: DURATION,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The create-request handler resolves the patient from the bearer
        // token / x-account-id. Supply AUTH_TOKEN to exercise the real path;
        // without it these requests will 401 (still a valid throughput test
        // of the auth-guard + router).
        ...(AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        service_id: process.env.TEST_SERVICE_ID || '000000000000000000000000',
        address_id: process.env.TEST_ADDRESS_ID || '000000000000000000000000',
        notes: 'load-test booking',
      }),
    },
  },
];

function runScenario({ name, opts }) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶  ${name}`);
    console.log(`   ${opts.method} ${opts.url}  (connections=${opts.connections}, ${opts.duration}s)`);
    const instance = autocannon(opts, (err, result) => {
      if (err) return reject(err);
      const p = result.latency;
      const nonSuccess =
        result.non2xx === undefined ? 'n/a' : result.non2xx;
      console.log(
        `   ✔ req/sec avg=${result.requests.average}  ` +
          `latency p50=${p.p50}ms p97_5=${p.p97_5}ms max=${p.max}ms  ` +
          `2xx=${result['2xx']}  non-2xx=${nonSuccess}  errors=${result.errors}`,
      );
      resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: true, renderResultsTable: false });
  });
}

async function main() {
  console.log('════════════════════════════════════════════════════════════');
  console.log(` Taafi load test → ${BASE_URL}  (${DURATION}s per scenario)`);
  console.log('════════════════════════════════════════════════════════════');
  for (const scenario of scenarios) {
    try {
      await runScenario(scenario);
    } catch (err) {
      console.error(`   ✖ ${scenario.name} failed:`, err.message);
    }
  }
  console.log('\n✅ Load test complete.\n');
}

main();
