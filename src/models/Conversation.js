const mongoose = require('mongoose');

// `conversations` collection — the multi-role messaging engine's thread
// header. One document per conversation; the individual messages live in
// the shared `messages` collection (models/Message.js) keyed by
// `conversationId`. A conversation can be a 1:1 (Patient ↔ Provider) or a
// group escalation (Patient ↔ Support ↔ Admin), optionally anchored to a
// booking (`CareRequest`) for context.
//
// Every participant references the single `accounts` collection — there is
// no separate User/ProviderProfile/AdminProfile table in this codebase.
// `role` is the NORMALISED participant role, decoupled from the raw
// Account role enum (user/doctor/nurse/admin/support_member) so the client
// only ever reasons about four buckets. Map with `normalizeRole()` below.

// Normalised participant roles the client reasons about.
const PARTICIPANT_ROLES = ['patient', 'provider', 'admin', 'support'];

// Collapse a raw Account.role into one of the four participant buckets.
// Unknown roles fall back to 'patient' (the least-privileged bucket).
function normalizeRole(accountRole) {
  switch (String(accountRole || '').toLowerCase()) {
    case 'doctor':
    case 'nurse':
    case 'helper':
      return 'provider';
    case 'admin':
      return 'admin';
    case 'support_member':
      return 'support';
    case 'user':
    default:
      return 'patient';
  }
}

const ParticipantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    role: { type: String, enum: PARTICIPANT_ROLES, required: true },
    // Snapshot of the account's display name + avatar at join time so the
    // inbox can render a thread row without an extra populate. Refreshed
    // whenever the conversation is re-opened via the find-or-create route.
    name: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
  },
  { _id: false }
);

const ConversationSchema = new mongoose.Schema(
  {
    participants: {
      type: [ParticipantSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 2,
        message: 'A conversation needs at least two participants',
      },
    },
    // Denormalised mirror of participants[].userId — a flat, indexed
    // ObjectId array so the "my conversations" query is a single
    // `{ participantIds: <me> }` hit without cracking the sub-doc array.
    participantIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Account',
      index: true,
      default: [],
    },
    // Optional booking anchor. The team's booking entity is `CareRequest`
    // (a.k.a. appointment) — NOT a `Booking` collection.
    contextRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CareRequest',
      default: null,
      index: true,
    },
    lastMessageText: { type: String, default: '' },
    lastMessageSenderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    lastMessageAt: { type: Date, default: null, index: true },
    isActive: { type: Boolean, default: true },
    // Per-user unread tally. Key = account-id string, value = count. The
    // socket / REST layer `$inc`s every participant except the sender on a
    // new message and resets a user's entry to 0 on `conversation:read`.
    unreadCounters: { type: Map, of: Number, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.contextRequestId = ret.contextRequestId?.toString() || null;
        ret.lastMessageSenderId = ret.lastMessageSenderId?.toString() || null;
        ret.participantIds = Array.isArray(ret.participantIds)
          ? ret.participantIds.map((p) => p?.toString())
          : [];
        if (Array.isArray(ret.participants)) {
          ret.participants = ret.participants.map((p) => ({
            userId: p.userId?.toString(),
            role: p.role,
            name: p.name,
            avatarUrl: p.avatarUrl || '',
          }));
        }
        // Map → plain object so the client gets `{ "<id>": 3 }`.
        if (ret.unreadCounters instanceof Map) {
          ret.unreadCounters = Object.fromEntries(ret.unreadCounters);
        }
        delete ret._id;
        return ret;
      },
    },
  }
);

// Inbox list query: my threads, newest-activity first.
ConversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', ConversationSchema);
module.exports.PARTICIPANT_ROLES = PARTICIPANT_ROLES;
module.exports.normalizeRole = normalizeRole;
