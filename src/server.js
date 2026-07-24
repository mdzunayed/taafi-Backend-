require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');

const servicesRouter = require('./routes/services');
const promoBannersRouter = require('./routes/promoBanners');
const homeSectionsRouter = require('./routes/homeSections');
const appOpenAdRouter = require('./routes/appOpenAd');
const authRouter = require('./routes/auth');
const patientRouter = require('./routes/patient');
const adminRouter = require('./routes/admin');
const doctorRouter = require('./routes/doctor');
const appointmentsRouter = require('./routes/appointments');
const usersRouter = require('./routes/users');
const chatRouter = require('./routes/chat.routes');
const telephonyRouter = require('./routes/telephony.routes');
const conversationRouter = require('./routes/conversation.routes');
const notificationRouter = require('./routes/notification.routes');
const prescriptionRouter = require('./routes/prescriptions');
const providerRouter = require('./routes/provider');
const addressRouter = require('./routes/addresses');
const dependentRouter = require('./routes/dependents');
const fcmService = require('./services/fcmService');
const { userRoomFor, roleRoomFor } = require('./services/notificationService');
const { verifyToken } = require('./utils/jwt');
const { notifyChatRecipient } = require('./controllers/chat.controller');
const {
  conversationRoomFor,
  deliverConversationMessage,
  markConversationRead,
} = require('./controllers/conversation.controller');
const Conversation = require('./models/Conversation');
const Account = require('./models/Account');
const Provider = require('./models/Provider');
const Message = require('./models/Message');
const CareRequest = require('./models/CareRequest');
const { isBookingChatOpen } = require('./utils/bookingFlow');
const { normalizePhone } = require('./utils/phone');
const { UPLOAD_DIR } = require('./middleware/upload');
// Production security stack (helmet + CORS allow-list + rate limiting) and
// the NoSQL-injection sanitizer.
const security = require('./middleware/security');
// Redis-backed background worker + connection lifecycle.
const { startWorker, closeQueue } = require('./queues/notificationQueue');
const { closeAll: closeRedis } = require('./config/redis');

const app = express();

// ── Security edge (runs before body parsers + routes) ─────────────────────
// trust-proxy → helmet → CORS allow-list → global rate limiter. Replaces the
// former wide-open `app.use(cors())`.
security.applySecurity(app);

app.use(express.json({ limit: '2mb' }));
// SSLCommerz posts its success/fail/cancel/IPN callbacks as
// application/x-www-form-urlencoded — parse them so the two-phase booking
// payment webhooks (routes/patient.js) can read `val_id` / `tran_id`.
app.use(express.urlencoded({ extended: true }));
// NoSQL-injection sanitizer — strips `$`/`.` operator keys from body, query
// and params. Mounted AFTER the body parsers so there's a parsed body to
// scrub, and before any route handler.
app.use(security.mongoSanitize);
app.use(morgan('dev'));

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/services', servicesRouter);
// Promo marketing banners for the patient Home slider. Public GET (the
// client reads active banners); create/update/delete/reorder are
// admin-gated inside the router via requireRole('admin').
app.use('/api/promo-banners', promoBannersRouter);
// Server-driven dynamic home sections rendered below Banners + Care
// Services. Public GET (the client reads active sections); all writes are
// admin-gated inside the router via requireRole('admin').
app.use('/api/home-sections', homeSectionsRouter);
// Full-screen app-open interstitial ad. Public GET (the patient client
// checks for an active campaign at launch); upsert/delete are admin-gated
// inside the router via requireRole('admin').
app.use('/api/app-open-ad', appOpenAdRouter);
// Auth is exposed under both prefixes:
//   • `/auth/*`     — legacy. The existing DioClient + legacy LoginScreen.
//   • `/api/auth/*` — canonical (matches the new spec).
// Same handlers either way; aliasing keeps in-flight clients happy
// while we migrate.
app.use('/auth', authRouter);
app.use('/api/auth', authRouter);
app.use('/patient', patientRouter);
app.use('/admin', adminRouter);
// Spec-named alias — every admin route is reachable under both
// `/admin/*` and `/api/admin/*`. The new POST /api/admin/appointments/
// assign endpoint lives here.
app.use('/api/admin', adminRouter);
app.use('/doctor', doctorRouter);
// Spec-named alias. Every doctor route is reachable under both
// prefixes — `/doctor/profile-status` and `/api/doctor/profile-status`
// hit the same handlers — so the production-spec URL contract works
// without rewriting any existing call sites.
app.use('/api/doctor', doctorRouter);
// Canonical appointment surface — same domain as care_requests, just
// under the spec's `/api/appointments/*` URL contract.
app.use('/api/appointments', appointmentsRouter);
// User-shaped surface — currently just the avatar upload endpoint;
// future profile-photo-related routes (delete avatar, etc.) live here.
app.use('/api/users', usersRouter);
// Chat history (`GET /api/chat/:appointmentId`) + HTTP fallback send.
// Real-time delivery rides on the Socket.io layer initialised below.
app.use('/api/chat', chatRouter);
app.use('/api/telephony', telephonyRouter);
// Multi-role conversation engine — inbox list, find-or-create thread,
// paginated history, mark-read. Real-time delivery rides the Socket.io
// `conversation:*` events initialised below.
app.use('/api/conversations', conversationRouter);
// Multi-role notification hub. List + mark-read + bulk-read endpoints;
// live delivery rides on the Socket.io `new_notification` event below.
app.use('/api/notifications', notificationRouter);
// Digital prescription engine — doctor issues, patient reads /
// marks-as-taken. POST /api/prescriptions + GET /my-active +
// PATCH /:id/dose.
app.use('/api/prescriptions', prescriptionRouter);
// Shared provider (doctor / nurse / helper) self-service surface —
// session-resolved availability flip, default-fee update, and the
// settled/pending earnings ledger. Reachable under both prefixes.
app.use('/api/provider', providerRouter);
app.use('/provider', providerRouter);
// Patient lifecycle: saved-address ledger + family/dependents profiles.
app.use('/api/addresses', addressRouter);
app.use('/api/dependents', dependentRouter);

// Best-effort FCM warm-up. No-ops gracefully when the firebase-admin
// SDK or service-account credentials aren't configured.
fcmService.init();

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT || 4000);
// Matches the database the team actually populates via Compass / Docker
// (collections: accounts, care_requests, providers). Override with the
// MONGO_URI env var for staging / prod.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/taafi';

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log(`[mongo] connected to ${MONGO_URI}`);

    // Self-heal: drop the legacy `email_1` unique index from the
    // `accounts` collection if it's still hanging around. It was added
    // when email was the primary identifier; phone is now, and the
    // non-sparse old index treats every missing-email row as a
    // collision on `null`. The index drop is idempotent — if it
    // doesn't exist we silently move on.
    try {
      await mongoose.connection.db
        .collection('accounts')
        .dropIndex('email_1');
      console.log('[mongo] dropped legacy accounts.email_1 index');
    } catch (e) {
      // 27 = IndexNotFound, 26 = NamespaceNotFound (fresh DB) — both
      // safe to ignore. Anything else gets logged so it doesn't hide.
      if (e.code !== 27 && e.code !== 26) {
        console.warn('[mongo] email_1 drop skipped:', e.message);
      }
    }

    // Self-heal: canonicalise phone fields on every account so the
    // lookups in /auth/{login,verify-otp,reset-password} match
    // regardless of how the user typed their number originally. The
    // most common case: seeded accounts stored `+880 1700 000001`
    // (spaces + plus + leading-zero local prefix); the canonical
    // form is the digits-only international `8801700000001`. Idempotent
    // — rows already in canonical form are skipped without a write.
    try {
      const accounts = await Account.find({}, '_id phone').lean();
      let normalised = 0;
      for (const acc of accounts) {
        if (!acc.phone) continue;
        const canon = normalizePhone(acc.phone);
        if (canon && canon !== acc.phone) {
          await Account.updateOne({ _id: acc._id }, { $set: { phone: canon } });
          normalised++;
        }
      }
      if (normalised > 0) {
        console.log(`[mongo] canonicalised phone on ${normalised} account(s)`);
      }
    } catch (e) {
      console.warn('[mongo] phone canonicalisation skipped:', e.message);
    }

    // Self-heal: link Provider rows to their Account counterparts by
    // copying the Account's `email` onto any doctor-role Provider that
    // doesn't yet have one. This makes `GET /doctor/profile` find the
    // linked Provider via email when the Flutter session sends an
    // Account `_id` (which is the only id the patient/doctor app has
    // at hand). Idempotent — Providers already carrying an email are
    // skipped without a write. Match key: `full_name` + role='doctor'.
    try {
      const doctorAccounts = await Account.find(
        { role: 'doctor' },
        '_id full_name email'
      ).lean();
      let linked = 0;
      for (const acc of doctorAccounts) {
        if (!acc.email) continue;
        const res = await Provider.updateOne(
          {
            full_name: acc.full_name,
            role: 'doctor',
            $or: [{ email: { $exists: false } }, { email: '' }, { email: null }],
          },
          { $set: { email: acc.email } }
        );
        if (res.modifiedCount > 0) linked++;
      }
      if (linked > 0) {
        console.log(
          `[mongo] linked ${linked} provider(s) to their account by email`
        );
      }
    } catch (e) {
      console.warn('[mongo] provider email backfill skipped:', e.message);
    }

    // Self-heal: grandfather pre-release-gate prescriptions. Any script
    // missing `payment_status` predates the paid-unlock pipeline and
    // must stay fully visible, so it's marked PAID + APPROVED once.
    // Without this, the schema's `default: 'PENDING'` would materialise
    // on read and retroactively lock every legacy prescription.
    // Idempotent — the `$exists: false` match set shrinks to zero after
    // the first boot. Runs before the HTTP server listens, so no gated
    // read can ever race it.
    try {
      const r = await mongoose.connection.db
        .collection('prescriptions')
        .updateMany(
          { payment_status: { $exists: false } },
          {
            $set: {
              payment_status: 'PAID',
              admin_approval_status: 'APPROVED',
              unlock_fee_amount: 0,
              unlock_transaction_id: '',
              paid_at: null,
              approved_at: null,
              approved_by: 'grandfathered',
              rejection_reason: '',
            },
          }
        );
      if (r.modifiedCount > 0) {
        console.log(
          `[mongo] grandfathered ${r.modifiedCount} pre-gate prescription(s)`
        );
      }
    } catch (e) {
      console.warn('[mongo] prescription grandfathering skipped:', e.message);
    }

    // Start the in-process BullMQ worker so queued jobs (FCM push, SMS/OTP,
    // PDF invoices) drain here. Gated by QUEUE_INLINE_WORKER (default on) so a
    // dedicated worker dyno can take over by running `npm run worker` with the
    // flag off. No-ops (jobs run inline) when Redis isn't configured. Started
    // after Mongo connects because the job processors query the DB.
    if (process.env.QUEUE_INLINE_WORKER !== '0') {
      startWorker();
    }

    // Explicit http.Server so Socket.io can share the listening port
    // with Express. The `app.listen()` shorthand would create a server
    // we couldn't pass into `new SocketIOServer(server)`.
    const server = http.createServer(app);

    // --- Socket.io engine layer -----------------------------------------
    //
    // One namespace, one event protocol:
    //   • `join_room`     — payload: appointmentId (string). Adds the
    //                       socket to the segregated room so it only
    //                       receives messages for that appointment.
    //   • `send_message`  — payload: { appointmentId, senderId,
    //                       receiverId, messageText }. Persists the row
    //                       and broadcasts `receive_message` with the
    //                       saved document (so every client — sender
    //                       included — sees the same canonical id +
    //                       timestamp).
    //   • `receive_message` — server-emitted; pushed to everyone in the
    //                       appointment room when a new message lands.
    //
    // CORS is wide-open here because the Flutter clients connect from
    // multiple origins (localhost dev, Android emulator, deployed
    // frontend). Tighten in production via the SOCKET_ORIGIN env var.
    const io = new SocketIOServer(server, {
      cors: {
        origin: process.env.SOCKET_ORIGIN || '*',
        methods: ['GET', 'POST'],
      },
    });
    // Expose the IO instance to Express handlers so the HTTP fallback
    // sender in chat.controller.js can broadcast over the socket too.
    app.set('io', io);

    // ── JWT handshake authentication ──────────────────────────────────────
    // Validate the bearer token presented in the connection handshake
    // (`auth.token`, preferred, or `?token=` query). A token that is present
    // but INVALID rejects the stream immediately. A connection with NO token
    // is still allowed through for backward compatibility with the existing
    // anonymous chat client (it identifies itself later via `join_room`);
    // such sockets simply stay unauthenticated until they do.
    io.use((socket, next) => {
      const raw =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.query && socket.handshake.query.token) ||
        null;
      if (!raw) return next(); // anonymous (legacy) — allowed
      try {
        const payload = verifyToken(String(raw));
        if (!payload || !payload.sub) {
          return next(new Error('unauthorized'));
        }
        socket.data.accountId = String(payload.sub);
        socket.data.role = payload.role || null;
        return next();
      } catch (_err) {
        return next(new Error('unauthorized'));
      }
    });

    // Provider (doctor/nurse) roles whose live socket presence drives the
    // admin Dispatch console's ONLINE/OFFLINE duty status. Patient/admin
    // sockets don't participate — their rows never carry a duty_status.
    const DUTY_ROLES = new Set(['doctor', 'nurse']);

    // Flip a provider Account's duty_status + presence heartbeat. Best-effort:
    // a failed write must never break the socket lifecycle.
    async function setDutyStatus(accountId, status) {
      if (!accountId) return;
      try {
        await Account.updateOne(
          { _id: accountId },
          { $set: { duty_status: status, last_active_at: new Date() } },
        );
      } catch (err) {
        console.warn(`[socket] duty_status ${status} failed for ${accountId}: ${err.message}`);
      }
    }

    io.on('connection', (socket) => {
      console.log(`[socket] client connected: ${socket.id}`);

      // A provider's live connection marks them ONLINE for dispatch. The
      // roster endpoint still overrides this to ON_SERVICE when the provider
      // has an active/overlapping visit, so we only ever store ONLINE here.
      if (socket.data.accountId && DUTY_ROLES.has(socket.data.role)) {
        // eslint-disable-next-line no-floating-promises
        setDutyStatus(socket.data.accountId, 'ONLINE');
      }

      // Track the rooms this socket has joined so the disconnect log
      // is informative even after the socket has left them. Socket.io
      // 4.x auto-cleans room membership on disconnect.
      socket.data.rooms = new Set();

      // Authenticated handshake — auto-join the user's private room and
      // their role broadcast room so dispatch / notification fan-outs reach
      // the right streams without waiting for a `register_user` round-trip.
      if (socket.data.accountId) {
        const userRoom = userRoomFor(socket.data.accountId);
        socket.join(userRoom);
        socket.data.rooms.add(userRoom);
        if (socket.data.role) {
          const role = roleRoomFor(socket.data.role);
          socket.join(role);
          socket.data.rooms.add(role);
        }
        console.log(
          `[socket] ${socket.id} authenticated as ${socket.data.accountId} (${socket.data.role || 'unknown'})`,
        );
      }

      // Per-user channel for notifications. The Flutter app emits
      // `register_user` with the signed-in account id immediately after
      // connecting, which puts this socket into the user's private
      // room. `emitNotification(io, …)` then delivers via
      // `io.to('user:<id>').emit('new_notification', …)`.
      socket.on('register_user', (accountId) => {
        // Authenticated sockets are bound to their JWT identity — never to a
        // client-supplied id. The handshake already auto-joined this user's
        // private room (see above); we re-affirm it and ignore any mismatched
        // claim so a socket can't be steered into another user's room.
        if (socket.data.accountId) {
          if (accountId && String(accountId) !== socket.data.accountId) {
            console.warn(
              `[socket] ${socket.id} register_user id mismatch ` +
                `(claimed ${accountId}, authed ${socket.data.accountId}) — ignoring claim`,
            );
          }
          const room = userRoomFor(socket.data.accountId);
          socket.join(room);
          socket.data.rooms.add(room);
          return;
        }
        // Unauthenticated legacy socket (no JWT to bind against) — retain the
        // historical self-declared join so the anonymous chat keeps working.
        if (!accountId) return;
        const room = userRoomFor(accountId);
        socket.join(room);
        socket.data.rooms.add(room);
        socket.data.accountId = String(accountId);
        console.log(`[socket] ${socket.id} registered as ${accountId}`);
      });

      socket.on('unregister_user', (accountId) => {
        if (!accountId) return;
        const room = userRoomFor(accountId);
        socket.leave(room);
        socket.data.rooms.delete(room);
      });

      socket.on('join_room', async (appointmentId) => {
        if (!appointmentId) return;
        const room = String(appointmentId);
        try {
          // A patient may only join the status/vitals room of a care request
          // they actually own — otherwise any patient socket that knows (or
          // guesses) a request id could eavesdrop on another patient's live
          // updates. Providers/admins legitimately monitor many requests, so
          // they (and legacy unauthenticated sockets) keep the open join.
          // Mirrors the participant check on `conversation:join`.
          if (socket.data.accountId && socket.data.role === 'user') {
            if (!mongoose.isValidObjectId(appointmentId)) return;
            const cr = await CareRequest.findById(
              appointmentId,
              'patient_account_id',
            ).lean();
            if (!cr || String(cr.patient_account_id) !== socket.data.accountId) {
              console.warn(
                `[socket] ${socket.id} denied join_room ${room} (not the owner)`,
              );
              return;
            }
          }
          socket.join(room);
          socket.data.rooms.add(room);
          console.log(`[socket] ${socket.id} joined room ${room}`);
        } catch (err) {
          console.error('[socket] join_room failed:', err.message);
        }
      });

      socket.on('leave_room', (appointmentId) => {
        if (!appointmentId) return;
        const room = String(appointmentId);
        socket.leave(room);
        socket.data.rooms.delete(room);
      });

      socket.on('send_message', async (payload, ack) => {
        try {
          const {
            appointmentId,
            senderId,
            receiverId,
            messageText,
            messageType,
            attachmentUrl,
            locationCoordinates,
          } = payload || {};
          if (
            !mongoose.isValidObjectId(appointmentId) ||
            !mongoose.isValidObjectId(senderId) ||
            !mongoose.isValidObjectId(receiverId)
          ) {
            const err = { ok: false, message: 'Invalid id in send_message' };
            if (typeof ack === 'function') ack(err);
            return;
          }

          // Normalise the rich message kind. TEXT still requires a body;
          // IMAGE/LOCATION carry a caption/label in `messageText` (the
          // schema keeps it required) plus their payload field.
          const kind = ['TEXT', 'IMAGE', 'DOCUMENT', 'LOCATION'].includes(
            String(messageType || '').toUpperCase(),
          )
            ? String(messageType).toUpperCase()
            : 'TEXT';
          const text = (messageText || '').toString().trim();
          if (kind === 'TEXT' && !text) {
            const err = { ok: false, message: 'messageText is required' };
            if (typeof ack === 'function') ack(err);
            return;
          }
          if (kind === 'IMAGE' && !attachmentUrl) {
            const err = { ok: false, message: 'attachmentUrl is required' };
            if (typeof ack === 'function') ack(err);
            return;
          }

          // Server-of-truth access-control gate: reject any write to a
          // booking whose channel is locked (completed/cancelled) or that
          // isn't in an active-visit status. The client input bar also
          // disables, but a stale-cache client still can't push a row into
          // a closed thread. Load only the two fields we gate on.
          const booking = await CareRequest.findById(
            appointmentId,
            'status communicationChannel',
          ).lean();
          const channelLocked =
            booking &&
            booking.communicationChannel &&
            booking.communicationChannel.isLocked === true;
          const statusClosed = booking && !isBookingChatOpen(booking.status);
          if (!booking || channelLocked || statusClosed) {
            const err = {
              ok: false,
              message:
                'This service has ended. The conversation is now read-only.',
            };
            if (typeof ack === 'function') ack(err);
            return;
          }

          const doc = {
            appointmentId,
            senderId,
            receiverId,
            messageType: kind,
            // Fallback label so `messageText` (required) is always present
            // even when the client omits a caption for a media message.
            messageText:
              text ||
              (kind === 'IMAGE'
                ? '📷 Photo'
                : kind === 'LOCATION'
                  ? '📍 Shared location'
                  : ''),
          };
          if (kind === 'IMAGE' && attachmentUrl) {
            doc.attachmentUrl = String(attachmentUrl);
          }
          if (kind === 'LOCATION' && locationCoordinates) {
            doc.locationCoordinates = {
              latitude: Number(locationCoordinates.latitude),
              longitude: Number(locationCoordinates.longitude),
              addressSnippet: (locationCoordinates.addressSnippet || '')
                .toString()
                .slice(0, 200),
            };
          }

          const saved = await Message.create(doc);
          const json = saved.toJSON();
          io.to(String(appointmentId)).emit('receive_message', json);
          // Fan out a `new_notification` (+ FCM push when the recipient is
          // offline) so their bell badge updates even if they aren't on
          // the chat screen.
          await notifyChatRecipient(io, saved);
          if (typeof ack === 'function') ack({ ok: true, message: json });
        } catch (err) {
          console.error('[socket] send_message failed:', err.message);
          if (typeof ack === 'function') {
            ack({ ok: false, message: err.message || 'Server error' });
          }
        }
      });

      // Typing indicator relay for the appointment chat — no persistence,
      // just a fan-out to the room so the other party sees "typing…". The
      // sender is echoed the event too but filters its own id client-side.
      socket.on('typing_indicator', (payload) => {
        try {
          const { appointmentId, userId, isTyping } = payload || {};
          if (!mongoose.isValidObjectId(appointmentId)) return;
          io.to(String(appointmentId)).emit('user_typing', {
            appointmentId: String(appointmentId),
            userId: userId ? String(userId) : null,
            isTyping: isTyping === true,
          });
        } catch (err) {
          console.error('[socket] typing_indicator failed:', err.message);
        }
      });

      // Mark every inbound message in an appointment thread as read for the
      // caller, then tell the room so the sender's delivery ticks turn blue.
      // Parallels `conversation:read` for the legacy 1:1 path.
      socket.on('mark_chat_read', async (payload) => {
        try {
          const { appointmentId, userId } = payload || {};
          if (
            !mongoose.isValidObjectId(appointmentId) ||
            !mongoose.isValidObjectId(userId)
          ) {
            return;
          }
          await Message.updateMany(
            { appointmentId, receiverId: userId, isRead: false },
            { $set: { isRead: true } },
          );
          io.to(String(appointmentId)).emit('chat_read', {
            appointmentId: String(appointmentId),
            userId: String(userId),
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          console.error('[socket] mark_chat_read failed:', err.message);
        }
      });

      // ── Multi-role conversation engine ──────────────────────────────────
      // Parallel to the appointment-scoped events above; keyed by
      // `conversationId` instead of `appointmentId`. Group-capable: fan-out
      // is derived from the Conversation's participants, and unread counters
      // are maintained per participant.

      // Join a conversation room — membership is verified against the
      // thread's participant list so a socket can't eavesdrop on a thread
      // it isn't part of.
      socket.on('conversation:join', async (conversationId) => {
        try {
          if (!mongoose.isValidObjectId(conversationId)) return;
          const uid = socket.data.accountId;
          if (uid) {
            const convo = await Conversation.findById(
              conversationId,
              'participantIds'
            ).lean();
            const member = convo && (convo.participantIds || []).some(
              (p) => String(p) === String(uid)
            );
            if (!member) {
              console.warn(
                `[socket] ${socket.id} denied conversation:join ${conversationId} (not a participant)`
              );
              return;
            }
          }
          const room = conversationRoomFor(conversationId);
          socket.join(room);
          socket.data.rooms.add(room);
        } catch (err) {
          console.error('[socket] conversation:join failed:', err.message);
        }
      });

      socket.on('conversation:leave', (conversationId) => {
        if (!mongoose.isValidObjectId(conversationId)) return;
        const room = conversationRoomFor(conversationId);
        socket.leave(room);
        socket.data.rooms.delete(room);
      });

      socket.on('conversation:send', async (payload, ack) => {
        try {
          const { conversationId, senderId, messageText, messageType, attachmentUrl } =
            payload || {};
          const json = await deliverConversationMessage(io, {
            conversationId,
            senderId,
            messageText,
            messageType,
            attachmentUrl,
          });
          if (typeof ack === 'function') ack({ ok: true, message: json });
        } catch (err) {
          console.error('[socket] conversation:send failed:', err.message);
          if (typeof ack === 'function') {
            ack({ ok: false, message: err.message || 'Server error' });
          }
        }
      });

      socket.on('conversation:read', async (payload) => {
        try {
          const { conversationId, userId } = payload || {};
          await markConversationRead(io, { conversationId, userId });
        } catch (err) {
          console.error('[socket] conversation:read failed:', err.message);
        }
      });

      socket.on('disconnect', async (reason) => {
        console.log(
          `[socket] client disconnected: ${socket.id} (${reason})`
        );
        // Flip the provider OFFLINE for dispatch — but only once their LAST
        // socket drops. A doctor on phone + tablet stays ONLINE until both
        // disconnect. Socket.io has already removed this socket from the
        // room by the time the disconnect handler runs, so a remaining
        // count of 0 means no live sessions left.
        if (socket.data.accountId && DUTY_ROLES.has(socket.data.role)) {
          try {
            const room = userRoomFor(socket.data.accountId);
            const remaining = await io.in(room).fetchSockets();
            if (remaining.length === 0) {
              await setDutyStatus(socket.data.accountId, 'OFFLINE');
            }
          } catch (err) {
            console.warn(`[socket] disconnect duty flip failed: ${err.message}`);
          }
        }
      });
    });

    // server.listen(PORT, () =>
    //   console.log(`[api] listening on http://localhost:${PORT}`)
    // );

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    // Friendly diagnostic when something else is already holding the
    // port. The default Node trace dump leads people to think Express
    // crashed; the real cause is almost always a stale process (often
    // a Docker container — `docker ps` will show it).
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[api] port ${PORT} is already in use.\n` +
          `      Likely causes (in order):\n` +
          `        • A Docker container is mapping it — run \`docker ps\` and \`docker stop <name>\`.\n` +
          `        • A previous \`npm run dev\` didn't shut down cleanly — \`sudo fuser -k ${PORT}/tcp\`.\n`
        );
        process.exit(1);
      }
      console.error('[api] server error:', err);
      process.exit(1);
    });

    // Graceful shutdown. SIGINT (Ctrl+C in your terminal) and SIGTERM
    // (nodemon restart, `kill`, system shutdown) both trigger this so
    // the listening socket + Mongo connection always close cleanly.
    // Without this, an abrupt termination can leak the socket and the
    // next `npm run dev` greets you with EADDRINUSE.
    const shutdown = async (signal) => {
      console.log(`[api] ${signal} received, shutting down…`);
      // Stop accepting new connections; finish in-flight ones.
      await new Promise((resolve) => server.close(resolve));
      // Drain the worker + queue and close the Redis connections before Mongo
      // so in-flight jobs can finish their DB work first.
      await closeQueue();
      await closeRedis();
      await mongoose.connection.close();
      console.log('[api] clean shutdown complete');
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Last-resort safety nets. Every route handler carries its own
    // try/catch, so these should never fire in practice — but a rejection
    // that escapes anyway must not silently kill (or zombify) the process.
    process.on('unhandledRejection', (reason) => {
      console.error('[api] unhandled promise rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[api] uncaught exception, exiting:', err);
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error('[mongo] connection error:', err.message);
    process.exit(1);
  });
