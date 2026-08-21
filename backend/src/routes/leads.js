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

module.exports = router;
