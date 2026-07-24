const mongoose = require('mongoose');

// Chat messages. One document per message. Two thread models share this
// single collection:
//   • Appointment chat (legacy 1:1) — keyed by `appointmentId` +
//     `receiverId`. Patient ↔ assigned doctor/nurse.
//   • Conversation engine (multi-role / group) — keyed by
//     `conversationId`. `receiverId` is null (fan-out is derived from the
//     Conversation's participants), and the richer sender/type fields
//     below are populated.
// Both `appointmentId` and `conversationId` are indexed so either history
// query stays fast as the global collection grows. Exactly one of the two
// is set on any given row.
const MessageSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CareRequest',
      // Optional now: conversation-engine rows have no appointment. The
      // legacy appointment-chat path still always supplies it.
      required: false,
      index: true,
    },
    // Conversation-engine thread id. Mutually exclusive with
    // `appointmentId`. Indexed for the paginated history query below.
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: false,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    // Only set on appointment-chat rows (1:1 has a definite recipient).
    // Null for conversation rows — recipients are the thread participants.
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    // Normalised sender role (patient/provider/admin/support) — snapshot so
    // group threads can render a role tag without a join. Optional (legacy
    // appointment rows omit it).
    senderRole: {
      type: String,
      enum: ['patient', 'provider', 'admin', 'support'],
      default: null,
    },
    // Snapshot of the sender's display name at send time.
    senderName: { type: String, default: '' },
    // Rich message kind. Attachments are scaffolded (fields persist +
    // render) but only TEXT is sent in this pass.
    messageType: {
      type: String,
      enum: ['TEXT', 'IMAGE', 'DOCUMENT', 'LOCATION'],
      default: 'TEXT',
    },
    attachmentUrl: { type: String, default: null },
    // Structured payload for `messageType: 'LOCATION'` rows — the raw GPS
    // fix the sender shared, plus a short human-readable address snippet so
    // the client can render a map card + "Open Directions" without a
    // reverse-geocode round-trip. Null on every non-LOCATION row.
    locationCoordinates: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      addressSnippet: { type: String, default: '' },
    },
    messageText: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    // Match the rest of the codebase: `toJSON` flattens `_id` and strips
    // the Mongo `__v` so clients see a clean shape.
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.appointmentId = ret.appointmentId?.toString() || null;
        ret.conversationId = ret.conversationId?.toString() || null;
        ret.senderId = ret.senderId?.toString();
        ret.receiverId = ret.receiverId?.toString() || null;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Compound index for the history query (timestamp-ordered by appointment).
MessageSchema.index({ appointmentId: 1, timestamp: 1 });
// Compound index for conversation-engine paginated history (newest-first).
MessageSchema.index({ conversationId: 1, timestamp: -1 });

module.exports = mongoose.model('Message', MessageSchema);
