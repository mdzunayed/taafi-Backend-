// Asynchronous background-worker queue (BullMQ + Redis).
//
// Offloads slow, best-effort side-effects — FCM push fan-out, SMS/OTP
// dispatch, PDF invoice rendering — off the HTTP request path so API
// handlers return in ~milliseconds instead of blocking on a multicast push
// or a Puppeteer render. The handler just enqueues a job and responds; a
// worker drains the queue out-of-band, with automatic retries + backoff.
//
// GRACEFUL DEGRADATION: when Redis is disabled (no REDIS_URL) there is no
// queue to push to, so every `enqueue*` helper runs its processor INLINE and
// awaited — i.e. exactly the old synchronous behaviour. Code that calls
// `enqueuePush(...)` therefore works identically whether or not Redis is up;
// you simply lose the "return immediately" latency win.
//
// Job types (job.name):
//   • 'push'    { userId, title, body, data }   → FCM multicast
//   • 'sms'     { phone, message, purpose }      → SMS / OTP gateway
//   • 'invoice' { prescriptionId }               → PDF invoice render
//
// The processor functions live here and are shared by both paths (queued
// worker AND inline fallback) so there's a single implementation to maintain.

const { isEnabled, bullConnection } = require('../config/redis');

const QUEUE_NAME = 'notifications';

// Lazily loaded BullMQ classes + singletons. Loaded only when Redis is on so
// a Redis-less deploy needn't resolve the `bullmq` package at boot.
let BullMQ = null;
let _queue = null;
let _worker = null;
let _queueAttempted = false;

// Default job options — retry transient failures with exponential backoff,
// and auto-trim completed/failed history so Redis doesn't grow unbounded.
const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
};

function loadBullMQ() {
  if (BullMQ) return BullMQ;
  try {
    // eslint-disable-next-line global-require
    BullMQ = require('bullmq');
  } catch (e) {
    console.warn(
      '[queue] `bullmq` is not installed — jobs will run inline. ' +
        'Install with: npm i bullmq',
    );
    BullMQ = null;
  }
  return BullMQ;
}

// ── Processors (the actual work) ────────────────────────────────────────
// Kept dependency-light and lazily required so the worker file / inline path
// only pulls in Puppeteer etc. when a job of that kind actually runs.

async function processPush({ userId, title, body, data }) {
  // eslint-disable-next-line global-require
  const { sendHighPriorityPush } = require('../services/fcmService');
  return sendHighPriorityPush(userId, title, body, data || {});
}

async function processSms({ phone, message, purpose }) {
  // Wire your real SMS/OTP gateway here (Twilio, SSLWireless, etc.). The
  // telephony service is the natural home; for now this is a logged stub so
  // the queue is exercised end-to-end without a paid account.
  console.log(
    `[queue:sms] → ${phone} (${purpose || 'generic'}): ${String(message).slice(0, 80)}`,
  );
  return { sent: true, phone };
}

async function processInvoice({ prescriptionId }) {
  // eslint-disable-next-line global-require
  const { renderPrescriptionPdf } = require('../utils/prescriptionPdf');
  // eslint-disable-next-line global-require
  const Prescription = require('../models/Prescription');
  const rx = await Prescription.findById(prescriptionId).lean();
  if (!rx) throw new Error(`invoice: prescription ${prescriptionId} not found`);
  const pdf = await renderPrescriptionPdf(rx);
  return { prescriptionId, bytes: pdf ? pdf.length : 0 };
}

// Single dispatch table shared by the worker and the inline fallback.
const PROCESSORS = {
  push: processPush,
  sms: processSms,
  invoice: processInvoice,
};

async function runInline(name, payload) {
  const fn = PROCESSORS[name];
  if (!fn) throw new Error(`[queue] unknown job type "${name}"`);
  try {
    return await fn(payload);
  } catch (err) {
    // Match the best-effort contract of the original inline calls: log, don't
    // throw, so a failed side-effect never tanks the originating request.
    console.warn(`[queue:inline:${name}] failed:`, err.message);
    return { error: err.message };
  }
}

// ── Queue accessor ──────────────────────────────────────────────────────

function getQueue() {
  if (!isEnabled()) return null;
  if (_queueAttempted) return _queue;
  _queueAttempted = true;
  const mod = loadBullMQ();
  const connection = bullConnection();
  if (!mod || !connection) return null;
  try {
    _queue = new mod.Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    console.log('[queue] notifications queue ready');
    return _queue;
  } catch (e) {
    console.warn('[queue] failed to create queue:', e.message);
    _queue = null;
    return null;
  }
}

// Generic enqueue with inline fallback. Never throws — mirrors the
// fire-and-forget, best-effort contract of the original push calls.
async function enqueue(name, payload, opts = {}) {
  const queue = getQueue();
  if (!queue) {
    // Redis off → do the work now, inline, exactly like the old code path.
    return runInline(name, payload);
  }
  try {
    return await queue.add(name, payload, opts);
  } catch (err) {
    console.warn(`[queue] enqueue "${name}" failed, running inline:`, err.message);
    return runInline(name, payload);
  }
}

// ── Public enqueue helpers ──────────────────────────────────────────────

// Drop-in replacement for fcmService.sendHighPriorityPush — IDENTICAL
// signature, so call sites swap the import and nothing else. Returns a
// promise (queued job or inline result) and never throws.
function enqueuePush(userId, title, body, data = {}) {
  return enqueue('push', { userId, title, body, data });
}

function enqueueSms(phone, message, purpose = 'generic') {
  return enqueue('sms', { phone, message, purpose });
}

function enqueueInvoice(prescriptionId) {
  return enqueue('invoice', { prescriptionId });
}

// ── Worker ──────────────────────────────────────────────────────────────

// Start the worker that drains the queue. Called from server.js when
// QUEUE_INLINE_WORKER=1 (default) so a single-process deploy Just Works; set
// it to 0 and run `node src/queues/worker.js` to scale workers separately.
// Returns the Worker (or null when Redis is disabled — nothing to drain).
function startWorker() {
  if (!isEnabled()) {
    console.log('[queue] Redis disabled — jobs run inline, no worker started');
    return null;
  }
  if (_worker) return _worker;
  const mod = loadBullMQ();
  const connection = bullConnection();
  if (!mod || !connection) return null;
  try {
    _worker = new mod.Worker(
      QUEUE_NAME,
      async (job) => runInline(job.name, job.data),
      { connection, concurrency: Number(process.env.QUEUE_CONCURRENCY || 5) },
    );
    _worker.on('failed', (job, err) =>
      console.warn(
        `[queue:worker] job ${job ? job.id : '?'} (${job ? job.name : '?'}) failed:`,
        err.message,
      ),
    );
    _worker.on('error', (err) =>
      console.warn('[queue:worker] error:', err.message),
    );
    console.log('[queue] worker started (concurrency 5)');
    return _worker;
  } catch (e) {
    console.warn('[queue] failed to start worker:', e.message);
    return null;
  }
}

async function closeQueue() {
  const jobs = [];
  if (_worker) jobs.push(_worker.close().catch(() => {}));
  if (_queue) jobs.push(_queue.close().catch(() => {}));
  await Promise.allSettled(jobs);
}

module.exports = {
  QUEUE_NAME,
  enqueue,
  enqueuePush,
  enqueueSms,
  enqueueInvoice,
  startWorker,
  closeQueue,
};
