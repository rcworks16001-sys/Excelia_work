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

module.exports = router;
