const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const appointmentController = require('../controllers/appointmentController');

// GET /api/appointments — list, for the dashboard's appointments page
router.get('/', authenticateAdmin, appointmentController.list);

// PATCH /api/appointments/:id/status — update status, body: { status }
router.patch('/:id/status', authenticateAdmin, appointmentController.updateStatus);

module.exports = router;
