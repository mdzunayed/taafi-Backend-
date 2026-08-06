// Per-service star ratings, derived from real patient feedback.
//
// There is deliberately NO `rating` column on Service. The only honest source
// is what patients actually left after a visit — `CareRequest.feedback.rating`,
// written by POST /api/appointments/:id/feedback — and an admin-typed number
// next to it would be indistinguishable on the wire from an earned one. So the
// figure is computed, and a service nobody has rated yet reports 0 / 0 reviews
// rather than a flattering default.
//
// The aggregation is memoized in-process for a minute: it backs the patient
// Home payload and the category listing, both of which are hit on every cold
// start, while feedback lands a handful of times an hour. Redis is not used
// here on purpose — the two callers are already Redis-cached at the response
// level, and this memo is what keeps the *uncached* paths (home-data) cheap.

const CareRequest = require('../models/CareRequest');

const TTL_MS = 60 * 1000;

let memo = { at: 0, byServiceId: new Map() };

// Empty stats, so callers never have to null-check a lookup miss.
const NONE = Object.freeze({ rating: 0, ratingCount: 0 });

// Map<serviceId, { rating, ratingCount }>. Never rejects: a failed aggregation
// degrades to "nothing is rated yet", which costs a sort order — not a screen.
async function serviceRatings() {
  const now = Date.now();
  if (now - memo.at < TTL_MS) return memo.byServiceId;

  try {
    const rows = await CareRequest.aggregate([
      {
        $match: {
          service_id: { $nin: [null, ''] },
          'feedback.rating': { $gte: 1 },
        },
      },
      {
        $group: {
          _id: '$service_id',
          rating: { $avg: '$feedback.rating' },
          ratingCount: { $sum: 1 },
        },
      },
    ]);

    const byServiceId = new Map();
    for (const row of rows) {
      const id = String(row._id || '');
      if (!id) continue;
      byServiceId.set(id, {
        // One decimal — the precision a 5-star widget can actually render.
        rating: Math.round((Number(row.rating) || 0) * 10) / 10,
        ratingCount: Number(row.ratingCount) || 0,
      });
    }
    memo = { at: now, byServiceId };
  } catch (err) {
    console.warn('[serviceRatings] aggregation failed:', err.message);
    // Don't poison the memo with an empty map on a transient failure — retry
    // on the next call instead of serving 0-stars for a full minute.
    return memo.byServiceId;
  }

  return memo.byServiceId;
}

function ratingFor(ratings, serviceId) {
  if (!ratings || !serviceId) return NONE;
  return ratings.get(String(serviceId)) || NONE;
}

// Test/admin hook: drops the memo so the next read re-aggregates.
function invalidateServiceRatings() {
  memo = { at: 0, byServiceId: new Map() };
}

module.exports = { serviceRatings, ratingFor, invalidateServiceRatings, NONE };
