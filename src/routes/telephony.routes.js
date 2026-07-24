const express = require('express');
const { requireAccountId } = require('../middleware/auth');
const { initiateMaskedCall } = require('../controllers/telephonyController');

const router = express.Router();

// POST /api/telephony/initiate-masked-call  { appointmentId }
// Bridges the caller ↔ the other booking party on a masked proxy voice line.
router.post('/initiate-masked-call', requireAccountId, initiateMaskedCall);

module.exports = router;
