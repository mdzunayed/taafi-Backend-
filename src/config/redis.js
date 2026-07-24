// Shared Redis connection factory.
//
// One place decides whether Redis is available for the whole process. Both
// the read-cache layer (services/cacheService.js) and the background worker
// queue (queues/notificationQueue.js) call in here so they agree on a single
// source of truth and share credentials/prefix.
//
// Design goal — GRACEFUL DEGRADATION (mirrors services/fcmService.js):
//   • REDIS_URL set   → real ioredis clients; caching + queueing are live.
//   • REDIS_URL unset → every accessor returns null. Callers must treat a
//                       null client as "Redis disabled" and fall back:
//                         - cache  → pass-through straight to Mongo
//                         - queue  → run the job inline in-process
//   The API therefore boots and serves traffic identically with or without
//   Redis; you only lose the performance / high-availability benefits.
//
// `ioredis` is loaded lazily so a deploy that never sets REDIS_URL doesn't
// even need the package resolvable at boot.

let IORedis = null;
let _loadAttempted = false;
let _loadError = null;

// Cached singletons — one general-purpose client (cache reads/writes,
// pub/sub-free) and, separately, BullMQ makes its own connections from the
// options we hand it (it needs `maxRetriesPerRequest: null`).
let _client = null;
let _clientAttempted = false;

const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'taafi';

function isEnabled() {
  return Boolean(REDIS_URL);
}

function loadDriver() {
  if (_loadAttempted) return IORedis;
  _loadAttempted = true;
  try {
    // eslint-disable-next-line global-require
    IORedis = require('ioredis');
  } catch (e) {
    _loadError =
      '`ioredis` is not installed — Redis features disabled. ' +
      'Install with: npm i ioredis';
    console.warn('[redis] ' + _loadError);
    IORedis = null;
  }
  return IORedis;
}

// Base connection options shared by the general client and BullMQ.
// `maxRetriesPerRequest: null` + `enableReadyCheck: false` are REQUIRED by
// BullMQ; they're harmless for the cache client too, so we use one shape.
function connectionOptions() {
  return {
    // BullMQ mandates this — it manages its own blocking-command retries.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Don't fan out reconnect storms in a degraded environment; back off.
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: false,
  };
}

/**
 * General-purpose Redis client for the cache layer. Returns a connected
 * ioredis instance, or `null` when Redis is disabled / the driver is
 * missing. Never throws — a connection error is logged and the client is
 * left to auto-reconnect in the background; callers treat transient errors
 * as a cache miss.
 */
function getClient() {
  if (!isEnabled()) return null;
  if (_clientAttempted) return _client;
  _clientAttempted = true;
  const Driver = loadDriver();
  if (!Driver) return null;
  try {
    // NOTE: deliberately NO ioredis `keyPrefix` here. ioredis prepends the
    // prefix to command keys but NOT to a SCAN MATCH pattern, which silently
    // breaks pattern-based cache invalidation. The cache layer namespaces its
    // own keys with REDIS_PREFIX instead, keeping SET/SCAN/DEL symmetric.
    _client = new Driver(REDIS_URL, connectionOptions());
    _client.on('error', (err) => {
      // ioredis emits on every failed reconnect; keep it to one line so a
      // Redis outage doesn't flood the logs.
      console.warn('[redis] client error:', err.message);
    });
    _client.on('connect', () => console.log('[redis] cache client connected'));
    return _client;
  } catch (e) {
    console.warn('[redis] failed to create client:', e.message);
    _client = null;
    return null;
  }
}

/**
 * Fresh connection options for BullMQ. BullMQ wants to own its connections
 * (it opens several: one per Queue, Worker, and QueueEvents), so we hand it
 * the parsed URL + shared options rather than a shared client instance.
 * Returns `null` when Redis is disabled.
 *
 * NOTE: no `keyPrefix` here — BullMQ manages its own key namespacing via the
 * queue name + its `prefix` option (set in notificationQueue.js).
 */
function bullConnection() {
  if (!isEnabled()) return null;
  const Driver = loadDriver();
  if (!Driver) return null;
  // BullMQ accepts either a connection-options object or an IORedis
  // instance. We pass a fresh instance so its lifecycle is independent of
  // the cache client (closing one must not close the other).
  try {
    const conn = new Driver(REDIS_URL, connectionOptions());
    conn.on('error', (err) =>
      console.warn('[redis] bull connection error:', err.message),
    );
    return conn;
  } catch (e) {
    console.warn('[redis] failed to create bull connection:', e.message);
    return null;
  }
}

async function closeAll() {
  const jobs = [];
  if (_client) {
    jobs.push(_client.quit().catch(() => _client.disconnect()));
  }
  await Promise.allSettled(jobs);
}

module.exports = {
  isEnabled,
  getClient,
  bullConnection,
  connectionOptions,
  closeAll,
  REDIS_PREFIX,
};
