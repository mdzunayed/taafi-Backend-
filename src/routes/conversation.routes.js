const express = require('express');
const { requireAccountId } = require('../middleware/auth');
const {
  listMyConversations,
  openConversation,
  listConversationMessages,
  readConversation,
} = require('../controllers/conversation.controller');

const router = express.Router();

// Every conversation surface is identity-scoped — the caller must resolve
// to a real account (`req.accountId`). Real-time delivery rides the
// Socket.io `conversation:*` events; these endpoints cover history +
// thread management.
router.use(requireAccountId);

// GET  /api/conversations              → my threads (inbox)
// POST /api/conversations              → find-or-create a thread
// GET  /api/conversations/:id/messages → paginated history (oldest-first)
// POST /api/conversations/:id/read     → mark-read fallback
router.get('/', listMyConversations);
router.post('/', openConversation);
router.get('/:id/messages', listConversationMessages);
router.post('/:id/read', readConversation);

module.exports = router;
