// Redis read-through cache for public, read-heavy catalog endpoints.
//
// Wraps GET handlers (e.g. GET /api/services, GET /api/promo-banners) so the
// first request populates Redis and subsequent requests within the TTL are
// served from memory without touching Mongo. Admin writes call
// `invalidate(namespace)` to purge the affected keys instantly.
//
// GRACEFUL DEGRADATION: when Redis is disabled (no REDIS_URL) every function
// here becomes a no-op / pass-through — `cache()` just calls the handler, and
// `invalidate()` resolves immediately. The endpoints behave exactly as they
// did before caching existed; they simply always hit Mongo.
//
// The cache key encodes the full querystring so `?active=1` and the unfiltered
// list are cached separately and never cross-contaminate.

const { getClient, REDIS_PREFIX } = require('../config/redis');

const TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300); // 5 min

// Fully-qualified key namespace. We prepend REDIS_PREFIX ourselves (rather
// than relying on ioredis `keyPrefix`) so SET / SCAN / DEL all operate on the
// same literal keys and pattern-based invalidation actually matches.
function nsPrefix(namespace) {
  return `${REDIS_PREFIX}:cache:${namespace}:`;
}

// Build the Redis key for a request under a logical namespace. The querystring
// is normalised (sorted) so `?a=1&b=2` and `?b=2&a=1` share one entry.
function keyFor(namespace, req) {
  const q = req && req.query ? req.query : {};
  const sorted = Object.keys(q)
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join('&');
  return `${nsPrefix(namespace)}${sorted || 'all'}`;
}

/**
 * Express middleware factory. Caches the JSON body of a successful GET
 * (2xx) under `namespace` for TTL seconds.
 *
 * Usage:  router.get('/', cache('services'), handler)
 *
 * On a hit it responds directly and the handler never runs. On a miss it
 * transparently wraps res.json so the handler's payload is captured and
 * stored on the way out. Any Redis error is swallowed — the request always
 * falls through to the live handler, so a Redis outage can never 500 a read.
 */
function cache(namespace, ttlSeconds = TTL_SECONDS) {
  return async function cacheMiddleware(req, res, next) {
    const client = getClient();
    if (!client) return next(); // Redis disabled → straight to handler

    const key = keyFor(namespace, req);
    try {
      const hit = await client.get(key);
      if (hit) {
        res.set('X-Cache', 'HIT');
        res.type('application/json');
        return res.send(hit); // hit is already-serialised JSON
      }
    } catch (err) {
      console.warn(`[cache] read failed for ${key}:`, err.message);
      return next(); // fail open
    }

    // Miss — capture the handler's JSON output and persist it before sending.
    res.set('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only cache successful reads; never cache 4xx/5xx error payloads.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payload = JSON.stringify(body);
        // Fire-and-forget SET; don't delay the response on the write.
        client
          .set(key, payload, 'EX', ttlSeconds)
          .catch((err) =>
            console.warn(`[cache] write failed for ${key}:`, err.message),
          );
      }
      return originalJson(body);
    };
    return next();
  };
}

/**
 * Purge every cached entry for a namespace (all querystring variants).
 * Called by admin write handlers after a create/update/delete so readers
 * never see stale catalog data. No-op when Redis is disabled.
 *
 * Uses a non-blocking SCAN rather than KEYS so invalidation never stalls the
 * Redis event loop on a large keyspace.
 */
async function invalidate(namespace) {
  const client = getClient();
  if (!client) return;
  // Keys are stored fully-qualified (REDIS_PREFIX:cache:ns:...), so the SCAN
  // MATCH and the returned keys use the exact same literal namespace — DEL
  // then removes precisely what SCAN found.
  const match = `${nsPrefix(namespace)}*`;
  try {
    const stream = client.scanStream({ match, count: 100 });
    const batch = [];
    await new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        for (const k of keys) batch.push(k);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    if (batch.length) {
      await client.del(...batch);
      console.log(`[cache] invalidated ${batch.length} key(s) for "${namespace}"`);
    }
  } catch (err) {
    console.warn(`[cache] invalidate failed for ${namespace}:`, err.message);
  }
}

// Convenience: an Express middleware that invalidates AFTER a successful
// mutating response. Drop it on write routes when you'd rather not sprinkle
// invalidate() calls inside handlers.
//
// Usage:  router.post('/', requireRole('admin'), invalidateOnSuccess('services'), handler)
function invalidateOnSuccess(namespace) {
  return function invalidateMiddleware(_req, res, next) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidate(namespace).catch(() => {});
      }
    });
    next();
  };
}

module.exports = { cache, invalidate, invalidateOnSuccess, keyFor, TTL_SECONDS };
