const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Account = require('../models/Account');
const { normalizeRole } = require('../models/Conversation');
const { userRoomFor, safeEmitNotification } = require('../services/notificationService');

// Room name for a conversation thread. Sockets join this to receive the
// thread's `receive_message` / `conversation:read` broadcasts.
function conversationRoomFor(conversationId) {
  return `conversation:${String(conversationId)}`;
}

// Best display avatar for an account (uploaded picture wins over Google).
function avatarFor(acc) {
  return acc.profile_picture || acc.photo_url || '';
}

// Build a participant sub-doc snapshot from an Account row.
function participantFrom(acc) {
  return {
    userId: acc._id,
    role: normalizeRole(acc.role),
    name: acc.full_name || 'Member',
    avatarUrl: avatarFor(acc),
  };
}

// ── Shared delivery core ────────────────────────────────────────────────────
// Persist a message into a conversation, update the thread header + unread
// counters, broadcast over the socket, and fan `new_notification` to every
// other participant. Reused by BOTH the socket `conversation:send` handler
// and the (optional) HTTP fallback. Returns the saved message JSON.
//
// `io` may be null (tests / no live socket) — persistence still happens.
async function deliverConversationMessage(io, { conversationId, senderId, messageText, messageType, attachmentUrl }) {
  const text = (messageText || '').toString().trim();
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new Error('Invalid conversationId');
  }
  if (!mongoose.isValidObjectId(senderId)) {
    throw new Error('Invalid senderId');
  }
  if (!text) throw new Error('messageText is required');

  const convo = await Conversation.findById(conversationId);
  if (!convo) throw new Error('Conversation not found');

  const sender = convo.participants.find(
    (p) => String(p.userId) === String(senderId)
  );
  if (!sender) throw new Error('Sender is not a participant');

  const saved = await Message.create({
    conversationId,
    senderId,
    senderRole: sender.role,
    senderName: sender.name,
    messageType: messageType || 'TEXT',
    attachmentUrl: attachmentUrl || null,
    messageText: text,
  });

  // Update the thread header + bump unread for everyone except the sender.
  const inc = {};
  for (const p of convo.participants) {
    if (String(p.userId) === String(senderId)) continue;
    inc[`unreadCounters.${String(p.userId)}`] = 1;
  }
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        lastMessageText: text.slice(0, 500),
        lastMessageSenderId: senderId,
        lastMessageAt: saved.timestamp,
      },
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    }
  );

  const json = saved.toJSON();
  if (io) {
    io.to(conversationRoomFor(conversationId)).emit('receive_message', json);
    // Bell badge for every other participant, even off the chat screen.
    const preview = text.slice(0, 120);
    for (const p of convo.participants) {
      if (String(p.userId) === String(senderId)) continue;
      // ignore individual failures — best-effort per recipient.
      // eslint-disable-next-line no-await-in-loop
      await safeEmitNotification(io, {
        recipientId: p.userId,
        senderId,
        title: `New message from ${sender.name}`,
        body: preview,
        type: 'chat',
        payload: { conversationId: String(conversationId), deepLink: 'conversation' },
      });
    }
  }
  return json;
}

// Reset one user's unread tally for a conversation and broadcast the read
// receipt to the thread room. Reused by the socket + HTTP paths.
async function markConversationRead(io, { conversationId, userId }) {
  if (!mongoose.isValidObjectId(conversationId) || !mongoose.isValidObjectId(userId)) {
    return;
  }
  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { [`unreadCounters.${String(userId)}`]: 0 } }
  );
  if (io) {
    io.to(conversationRoomFor(conversationId)).emit('conversation:read', {
      conversationId: String(conversationId),
      userId: String(userId),
    });
  }
}

// ── REST handlers ───────────────────────────────────────────────────────────

// GET /api/conversations — every thread the caller participates in,
// newest-activity first, each carrying the caller's unread count.
async function listMyConversations(req, res) {
  try {
    const me = req.accountId;
    const rows = await Conversation.find({ participantIds: me, isActive: true })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .lean({ virtuals: true });
    const out = rows.map((c) => {
      const counters = c.unreadCounters || {};
      // lean() Maps come back as plain objects already.
      const unread = Number(counters[String(me)] || 0);
      return {
        id: c._id?.toString(),
        participants: (c.participants || []).map((p) => ({
          userId: p.userId?.toString(),
          role: p.role,
          name: p.name,
          avatarUrl: p.avatarUrl || '',
        })),
        contextRequestId: c.contextRequestId?.toString() || null,
        lastMessageText: c.lastMessageText || '',
        lastMessageSenderId: c.lastMessageSenderId?.toString() || null,
        lastMessageAt: c.lastMessageAt || null,
        isActive: c.isActive !== false,
        unreadCount: unread,
      };
    });
    res.json({ success: true, conversations: out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}

// POST /api/conversations  { participantIds: [<accountId>...], contextRequestId? }
//
// Find-or-create. The caller is always included. Dedupes on the exact
// participant set (+ contextRequestId) so re-opening a thread reuses it.
// Refreshes each participant's name/avatar snapshot on open.
async function openConversation(req, res) {
  try {
    const me = req.accountId;
    const body = req.body || {};
    const rawIds = Array.isArray(body.participantIds) ? body.participantIds : [];
    const contextRequestId =
      body.contextRequestId && mongoose.isValidObjectId(body.contextRequestId)
        ? body.contextRequestId
        : null;

    // Union the caller in, validate, and dedupe.
    const idSet = new Set([String(me), ...rawIds.map((x) => String(x))]);
    const ids = [...idSet].filter((x) => mongoose.isValidObjectId(x));
    if (ids.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'A conversation needs at least two distinct participants',
      });
    }

    const accounts = await Account.find(
      { _id: { $in: ids } },
      '_id full_name role profile_picture photo_url'
    ).lean();
    if (accounts.length !== ids.length) {
      return res
        .status(404)
        .json({ success: false, message: 'One or more participants not found' });
    }
    const participants = accounts.map(participantFrom);
    const participantIds = participants
      .map((p) => p.userId)
      .sort((a, b) => String(a).localeCompare(String(b)));

    // Match on exact set (same size + contains-all) and same context anchor.
    let convo = await Conversation.findOne({
      participantIds: { $all: participantIds, $size: participantIds.length },
      contextRequestId: contextRequestId,
    });

    let created = false;
    if (convo) {
      // Refresh snapshots so renamed / re-avatared accounts stay current.
      convo.participants = participants;
      convo.participantIds = participantIds;
      convo.isActive = true;
      await convo.save();
    } else {
      convo = await Conversation.create({
        participants,
        participantIds,
        contextRequestId,
        unreadCounters: {},
      });
      created = true;
    }
    res.status(created ? 201 : 200).json({
      success: true,
      conversation: convo.toJSON(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}

// GET /api/conversations/:id/messages?before=<ISO>&limit=<n>
//
// Paginated history, returned OLDEST-first for the ListView. `before`
// pages backwards through time (older than the cursor); omit for the
// latest page.
async function listConversationMessages(req, res) {
  try {
    const me = req.accountId;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid conversationId' });
    }
    // Authorisation — caller must be a participant.
    const convo = await Conversation.findById(id, 'participantIds').lean();
    if (!convo) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }
    const isMember = (convo.participantIds || []).some(
      (p) => String(p) === String(me)
    );
    if (!isMember) {
      return res.status(403).json({ success: false, message: 'Not a participant' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const query = { conversationId: id };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!Number.isNaN(before.getTime())) query.timestamp = { $lt: before };
    }
    // Pull newest-first for the cursor window, then reverse to oldest-first.
    const page = await Message.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean({ getters: true });
    const out = page
      .map((m) => ({
        id: m._id?.toString(),
        conversationId: m.conversationId?.toString() || null,
        appointmentId: m.appointmentId?.toString() || null,
        senderId: m.senderId?.toString(),
        senderRole: m.senderRole || null,
        senderName: m.senderName || '',
        receiverId: m.receiverId?.toString() || null,
        messageType: m.messageType || 'TEXT',
        attachmentUrl: m.attachmentUrl || null,
        messageText: m.messageText,
        timestamp: m.timestamp,
        isRead: m.isRead === true,
      }))
      .reverse();
    res.json({ success: true, messages: out });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}

// POST /api/conversations/:id/read — HTTP fallback for mark-read.
async function readConversation(req, res) {
  try {
    const me = req.accountId;
    const { id } = req.params;
    const io = req.app.get('io');
    await markConversationRead(io, { conversationId: id, userId: me });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  conversationRoomFor,
  deliverConversationMessage,
  markConversationRead,
  listMyConversations,
  openConversation,
  listConversationMessages,
  readConversation,
};
