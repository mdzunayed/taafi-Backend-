const express = require('express');

const { getBookingDepositAmount } = require('../services/pricingService');

const router = express.Router();

// Public platform configuration the clients need BEFORE they have a booking to
// read it off. Deliberately unauthenticated: the patient app must be able to
// show the deposit on the checkout screen, and there is nothing here that isn't
// already printed on that screen. Auth in this codebase is strictly per-route
// (there is no app-wide guard), so omitting the middleware is the whole opt-out;
// the global rate limiter from `applySecurity` still covers it.

// GET /api/config/pricing
// NOTE: camelCase, unlike the snake_case care-request payloads. Deliberate —
// this is a small, spec-defined client-config contract, not a model projection.
router.get('/pricing', async (_req, res) => {
  try {
    const bookingDepositAmount = await getBookingDepositAmount();
    // Short cache: the value changes a few times a year, and the app re-reads
    // it on every cold start.
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ bookingDepositAmount });
  } catch (err) {
    console.error('[config/pricing] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
