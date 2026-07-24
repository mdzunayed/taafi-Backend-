const mongoose = require('mongoose');
const Message = require('../models/Message');
const Account = require('../models/Account');
const {
  safeEmitNotification,
  userRoomFor,
} = require('../services/notificationService');
// Push dispatch is offloaded to the BullMQ background queue (identical
// signature to the old fcmService call, so nothing else changes). Falls
// back to inline send when Redis is disabled.
const { enqueuePush: sendHighPriorityPush } = require('../queues/notificationQueue');
const { storeImage } = require('../middleware/upload');

// Best-effort presence check — is the recipient currently connected on any
// socket in their private room? Drives whether we escalate to an OS-level
// FCM push (offline) on top of the always-on in-app notification. Returns
// false on any error so a probe failure just means "push anyway".
async function isRecipientOnline(io, recipientId) {
  if (!io || !recipientId) return false;
  try {
    const sockets = await io.in(userRoomFor(recipientId)).fetchSockets();
    return Array.isArray(sockets) && sockets.length > 0;
  } catch (_) {
    return false;
  }
}

// Short human-readable preview for the notification body — a media message
// has no text worth showing, so surface its kind instead.
function previewFor(msg) {
  switch (String(msg.messageType || 'TEXT').toUpperCase()) {
    case 'IMAGE':
      return '📷 Photo';
    case 'LOCATION':
      return '📍 Shared location';
    case 'DOCUMENT':
      return '📄 Document';
    default:
      return (msg.messageText || '').slice(0, 120);
  }
}

async function notifyChatRecipient(io, savedMessage) {
  if (!savedMessage) return;
  let senderName = 'Someone';
  try {
    const acc = await Account.findById(savedMessage.senderId, 'full_name').lean();
    if (acc && acc.full_name) senderName = acc.full_name;
  } catch (_) {
    /* best-effort */
  }
  const title = `New message from ${senderName}`;
  const preview = previewFor(savedMessage);
  const payload = {
    appointmentId: savedMessage.appointmentId?.toString(),
    messageId: savedMessage._id?.toString() || savedMessage.id,
    deepLink: 'chat',
  };
  // Always fan out the in-app notification (bell badge + socket event).
  await safeEmitNotification(io, {
    recipientId: savedMessage.receiverId,
    senderId: savedMessage.senderId,
    title,
    body: preview,
    type: 'chat',
    payload,
  });
  // Escalate to an OS-level push only when the recipient isn't connected —
  // an open app already got the realtime `receive_message`. Best-effort.
  try {
    const online = await isRecipientOnline(io, savedMessage.receiverId);
    if (!online && savedMessage.receiverId) {
      sendHighPriorityPush(savedMessage.receiverId.toString(), title, preview, {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        ...payload,
      });
    }
  } catch (_) {
    /* push escalation failure is non-fatal */
  }
}

// GET /api/chat/:appointmentId — full sorted message log for one
// appointment (a.k.a. care_request). Returns oldest-first so the
// Flutter ListView can render the conversation top-to-bottom without
// reversing.
async function listMessagesForAppointment(req, res) {
  try {
    const { appointmentId } = req.params;
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointmentId' });
    }
    const messages = await Message.find({ appointmentId })
      .sort({ timestamp: 1 })
      .lean({ getters: true });
    // `.lean()` skips the schema `toJSON` transform, so we normalise
    // ObjectId-shaped fields by hand to match the websocket payload.
    const out = messages.map((m) => ({
      id: m._id?.toString(),
      appointmentId: m.appointmentId?.toString(),
      senderId: m.senderId?.toString(),
      receiverId: m.receiverId?.toString(),
      messageText: m.messageText,
      timestamp: m.timestamp,
      isRead: m.isRead === true,
    }));
    res.json({ success: true, messages: out });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

// POST /api/chat/:appointmentId  { senderId, receiverId, messageText }
//
// Optional HTTP fallback for clients that can't open a websocket (e.g.
// background notifications retrying a queued send). Same persistence
// path as the socket handler; whichever endpoint writes first, the
// other one is safe to skip.
async function postMessage(req, res) {
  try {
    const { appointmentId } = req.params;
    const { senderId, receiverId, messageText } = req.body || {};
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointmentId' });
    }
    if (!senderId || !mongoose.isValidObjectId(senderId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid senderId' });
    }
    if (!receiverId || !mongoose.isValidObjectId(receiverId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid receiverId' });
    }
    const text = (messageText || '').toString().trim();
    if (!text) {
      return res
        .status(400)
        .json({ success: false, message: 'messageText is required' });
    }
    const saved = await Message.create({
      appointmentId,
      senderId,
      receiverId,
      messageText: text,
    });
    // Echo over the websocket too, if Socket.io is mounted, so any
    // open chat screens for this appointment receive the message in
    // real time without a refresh. The IO instance lives on the app
    // (`app.set('io', io)` in server.js) — gracefully skipped when
    // tests boot the router without a live socket layer.
    const io = req.app.get('io');
    if (io) {
      io.to(appointmentId.toString()).emit('receive_message', saved.toJSON());
    }
    await notifyChatRecipient(io, saved);
    res.status(201).json({ success: true, message: saved.toJSON() });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

// POST /api/chat/:appointmentId/attachment  (multipart/form-data, field
// `file`) — uploads an image attachment for a chat message and returns the
// permanent `mediaUrl`. The client then sends a normal `send_message` with
// `messageType: 'IMAGE'` + this url over the socket (or the POST fallback),
// so the persistence path stays single-sourced. Mirrors the avatar upload
// flow (routes/users.js): Cloudinary in prod, /uploads disk mount in local
// dev. Deterministic public id per (appointment, timestamp) so re-uploads
// don't leak copies while distinct messages keep distinct urls.
async function uploadChatAttachment(req, res) {
  try {
    const { appointmentId } = req.params;
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointmentId' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: 'No image uploaded. Use form field "file".',
      });
    }
    const publicId = `chat_${appointmentId}_${Date.now()}`;
    const stored = await storeImage(req.file.buffer, publicId);
    const isFullUrl = /^https?:\/\//i.test(stored);
    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      `http://localhost:${process.env.PORT || 4000}`;
    const mediaUrl = isFullUrl ? stored : `${baseUrl}/uploads/${stored}`;
    res.status(201).json({ success: true, mediaUrl });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  notifyChatRecipient,
  listMessagesForAppointment,
  postMessage,
  uploadChatAttachment,
};
