// Standalone BullMQ worker entrypoint.
//
// Run this as a SEPARATE process (its own container / dyno) to drain the
// notifications queue independently of the API, so heavy jobs never compete
// with request handling for CPU:
//
//     QUEUE_INLINE_WORKER=0   # in the API's env, so it doesn't also spawn one
//     node src/queues/worker.js
//
// The worker's processors query Mongo (invoice render, token lookup), so we
// connect Mongoose here just like the API does. Requires REDIS_URL — with no
// Redis there's no queue to drain (the API runs those jobs inline instead).

require('dotenv').config();

const mongoose = require('mongoose');
const { isEnabled } = require('../config/redis');
const { startWorker, closeQueue } = require('./notificationQueue');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';

async function main() {
  if (!isEnabled()) {
    console.error(
      '[worker] REDIS_URL is not set — nothing to drain. ' +
        'The API runs jobs inline without Redis. Exiting.',
    );
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI);
  console.log(`[worker] mongo connected to ${MONGO_URI}`);

  const worker = startWorker();
  if (!worker) {
    console.error('[worker] failed to start — check bullmq install + REDIS_URL');
    process.exit(1);
  }
  console.log('[worker] draining "notifications" queue…');

  const shutdown = async (signal) => {
    console.log(`[worker] ${signal} received, closing…`);
    await closeQueue();
    await mongoose.connection.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
