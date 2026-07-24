const express = require('express');
const {
  listMessagesForAppointment,
  postMessage,
  uploadChatAttachment,
} = require('../controllers/chat.controller');
const { upload } = require('../middleware/upload');

const router = express.Router();

// GET  /api/chat/:appointmentId             → sorted message history
// POST /api/chat/:appointmentId             → HTTP fallback for sending
// POST /api/chat/:appointmentId/attachment  → upload an image, get mediaUrl
router.get('/:appointmentId', listMessagesForAppointment);
router.post('/:appointmentId', postMessage);
router.post(
  '/:appointmentId/attachment',
  upload.single('file'),
  uploadChatAttachment,
);

module.exports = router;
