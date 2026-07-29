/**
 * CORS origin-policy test.
 *
 * `flutter run -d chrome` binds a NEW random port every launch, so a local web
 * build can never be named in an exact-match allow-list. When its preflight is
 * rejected the browser gives Dio nothing but a generic network failure, which
 * surfaces in Flutter as a bare `XMLHttpRequest error` with no status —
 * indistinguishable from the server being down. That ambiguity is why the
 * loopback rule exists, and why it is worth pinning down.
 *
 * The spoof cases are the point of the anchored regex: `localhost` appearing
 * anywhere in a hostname must NOT be enough to pass, or the rule would hand
 * any origin an allow simply by naming itself localhost.something.
 *
 * Drives real OPTIONS preflights through the real cors middleware, because
 * what matters is the Access-Control-Allow-Origin header actually emitted.
 *
 *   node backend/tests/cors.test.js
 */

const assert = require('node:assert');
const express = require('express');

const security = require('../src/middleware/security');

// One port per scenario. undici keeps connections alive per authority, so
// reusing a port across listens hands the next fetch a socket to the server we
// just closed — which fails as a transport error, not a policy result.
const BASE_PORT = 5312;

// buildCors() reads the environment on each call, so a scenario can be applied
// by setting the vars and constructing a fresh app.
function buildApp(env) {
  for (const key of [
    'NODE_ENV',
    'CORS_ALLOWED_ORIGINS',
    'CORS_ALLOW_LOCALHOST',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const app = express();
  app.use(security.cors());
  app.put('/api/app-open-ad', (_req, res) => res.json({ ok: true }));
  return app;
}

async function preflight(port, origin) {
  const res = await fetch(`http://127.0.0.1:${port}/api/app-open-ad`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  return {
    status: res.status,
    acao: res.headers.get('access-control-allow-origin'),
    vary: res.headers.get('vary'),
  };
}

const PROD_LIST = {
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://admin.taafi.app',
};

const scenarios = [
  {
    name: 'production, allow-list set, loopback flag OFF',
    env: PROD_LIST,
    expect: [
      ['https://admin.taafi.app', true],
      ['http://localhost:54321', false],
      ['https://evil.example.com', false],
    ],
  },
  {
    name: 'production, allow-list set, loopback flag ON',
    env: { ...PROD_LIST, CORS_ALLOW_LOCALHOST: '1' },
    expect: [
      ['https://admin.taafi.app', true],
      // Any port, both schemes, all three loopback spellings.
      ['http://localhost:54321', true],
      ['http://localhost:61099', true],
      ['https://localhost:8080', true],
      ['http://localhost', true],
      ['http://127.0.0.1:8080', true],
      ['http://[::1]:3000', true],
      ['https://evil.example.com', false],
    ],
  },
  {
    name: 'loopback flag ON must not admit lookalike hostnames',
    env: { ...PROD_LIST, CORS_ALLOW_LOCALHOST: '1' },
    expect: [
      ['https://localhost.attacker.com', false],
      ['http://notlocalhost:3000', false],
      ['http://localhost.evil.io:5000', false],
      ['http://127.0.0.1.evil.com', false],
      ['http://mylocalhost:80', false],
      ['http://localhost:3000.evil.com', false],
      ['http://localhost@evil.com', false],
    ],
  },
  {
    name: 'development needs no flag',
    env: { ...PROD_LIST, NODE_ENV: 'development' },
    expect: [
      ['http://localhost:54321', true],
      ['https://admin.taafi.app', true],
      ['https://evil.example.com', false],
    ],
  },
];

async function main() {
  let failed = 0;

  for (const [index, scenario] of scenarios.entries()) {
    console.log(`\n  ${scenario.name}`);
    const port = BASE_PORT + index;
    const server = buildApp(scenario.env).listen(port);
    await new Promise((resolve) => server.once('listening', resolve));

    for (const [origin, shouldAllow] of scenario.expect) {
      try {
        const { acao, vary } = await preflight(port, origin);
        const allowed = acao === origin;
        assert.equal(
          allowed,
          shouldAllow,
          `${origin}: expected ${shouldAllow ? 'allow' : 'block'}, ` +
            `got acao=${String(acao)}`,
        );
        if (allowed) {
          // Without Vary:Origin a shared cache can serve one origin's
          // allow header to another — and maxAge is a full day.
          assert.match(vary || '', /Origin/i, `${origin}: missing Vary: Origin`);
        }
        console.log(`    ok    ${shouldAllow ? 'allow' : 'block'}  ${origin}`);
      } catch (err) {
        failed += 1;
        console.error(`    FAIL  ${origin}\n          ${err.message}`);
      }
    }

    await new Promise((resolve) => server.close(resolve));
  }

  const total = scenarios.reduce((n, s) => n + s.expect.length, 0);
  console.log(
    failed === 0 ? `\n${total} passed\n` : `\n${failed} of ${total} FAILED\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
