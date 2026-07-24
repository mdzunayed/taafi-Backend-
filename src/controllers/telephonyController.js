const mongoose = require('mongoose');
const CareRequest = require('../models/CareRequest');
const { loadProviderPair } = require('../utils/doctorView');
const { isBookingChatOpen } = require('../utils/bookingFlow');
const { bridgeCall, activeDriver } = require('../services/telephonyService');

// Resolve the assigned provider's dialable phone for a booking. The caller
// is a patient dialling their provider — prefer the assigned doctor, fall
// back to the assigned nurse. Provider-id fields on CareRequest are Strings
// (not refs), so we reuse `loadProviderPair` which resolves either a Provider
// or an Account and returns both; the number can live on either record.
async function resolveProviderPhone(booking) {
  const providerId =
    booking.assigned_doctor_id || booking.assigned_nurse_id || null;
  if (!providerId || !mongoose.isValidObjectId(providerId)) return null;
  const role = booking.assigned_doctor_id ? 'doctor' : 'nurse';
  const { provider, account } = await loadProviderPair(providerId, role);
  const phone =
    (account && account.phone) || (provider && provider.phone) || null;
  return phone && String(phone).trim() ? String(phone).trim() : null;
}

// Is this caller allowed to dial on this booking — the booking patient or the
// assigned doctor/nurse? Returns 'patient' | 'provider' | null.
async function callerRoleFor(booking, accountId) {
  if (!accountId) return null;
  if (String(booking.patient_account_id) === String(accountId)) {
    return 'patient';
  }
  const providerIds = [
    booking.assigned_doctor_id,
    booking.assigned_nurse_id,
    booking.assigned_helper_id,
  ]
    .filter(Boolean)
    .map(String);
  if (providerIds.includes(String(accountId))) return 'provider';
  // The assigned provider may authenticate as their Account while the booking
  // stores a Provider id — resolve and compare emails/names as a fallback.
  const providerId = booking.assigned_doctor_id || booking.assigned_nurse_id;
  if (providerId && mongoose.isValidObjectId(providerId)) {
    const role = booking.assigned_doctor_id ? 'doctor' : 'nurse';
    const { account } = await loadProviderPair(providerId, role);
    if (account && String(account._id) === String(accountId)) return 'provider';
  }
  return null;
}

// POST /api/telephony/initiate-masked-call  { appointmentId }
//
// Bridges the caller and the other party on a proxy voice line. Neither side
// ever sees the other's real number. Validates the caller is a participant
// and the booking's communication channel is open before dialling.
async function initiateMaskedCall(req, res) {
  try {
    const appointmentId =
      (req.body && (req.body.appointmentId || req.body.bookingId)) || '';
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointmentId' });
    }
    const booking = await CareRequest.findById(appointmentId).lean();
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: 'Booking not found' });
    }

    // Access control — participant only.
    const role = await callerRoleFor(booking, req.accountId);
    if (!role) {
      return res.status(403).json({
        success: false,
        message: 'You are not a participant on this booking.',
      });
    }

    // Channel gate — same server-of-truth as the chat send guard.
    const channelLocked =
      booking.communicationChannel &&
      booking.communicationChannel.isLocked === true;
    if (channelLocked || !isBookingChatOpen(booking.status)) {
      return res.status(409).json({
        success: false,
        message:
          'This service has ended. Secure calling is no longer available.',
      });
    }

    // Resolve the two legs. legA = caller (dialled first), legB = the other
    // party. A patient dials the provider; a provider dials the patient.
    let callerPhone;
    let otherPhone;
    if (role === 'patient') {
      callerPhone = booking.patient_phone;
      otherPhone = await resolveProviderPhone(booking);
    } else {
      otherPhone = booking.patient_phone;
      callerPhone = await resolveProviderPhone(booking);
    }
    if (!callerPhone || !otherPhone) {
      return res.status(422).json({
        success: false,
        message:
          'A phone number for one of the parties is missing — secure call ' +
          'cannot be placed.',
      });
    }

    const result = await bridgeCall({
      legA: callerPhone,
      legB: otherPhone,
      context: { bookingId: String(booking._id), callerRole: role },
    });

    return res.json({
      success: true,
      status: result.status || 'connecting',
      callId: result.callId,
      proxyDisplay: result.proxyDisplay,
      driver: activeDriver(),
      message:
        role === 'patient'
          ? 'Connecting to your provider via secure proxy line…'
          : 'Connecting to patient via secure proxy line…',
    });
  } catch (err) {
    console.error('[telephony] initiate-masked-call failed:', err.message);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = { initiateMaskedCall };
