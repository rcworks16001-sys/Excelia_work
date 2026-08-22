const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const leadController = require('../controllers/leadController');

// GET /api/leads — overview list
router.get('/', authenticateAdmin, leadController.list);

// GET /api/leads/:id — detail + conversation history + appointments
router.get('/:id', authenticateAdmin, leadController.getById);

// PATCH /api/leads/:id/status — update pipeline stage, body: { status }
router.patch('/:id/status', authenticateAdmin, leadController.updateStatus);

// POST /api/leads/:id/reply — send a plain WhatsApp text reply, body: { message }
router.post('/:id/reply', authenticateAdmin, leadController.sendReply);

// PATCH /api/leads/:id/notes — update admin notes, body: { notes }
router.patch('/:id/notes', authenticateAdmin, leadController.updateNotes);

// POST /api/leads/:id/summary — generate a one-off conversation summary for
// the admin, body: { lang }. Not persisted — see utils/summarizer.js.
router.post('/:id/summary', authenticateAdmin, leadController.summarizeLeadConversation);

module.exports = router;
