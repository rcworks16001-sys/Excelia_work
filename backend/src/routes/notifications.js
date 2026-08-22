const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

// GET /api/notifications?limit= — bell payload: recent items + unread count
router.get('/', authenticateAdmin, notificationController.list);

// PATCH /api/notifications/read-all — clear the badge in one go.
// Declared BEFORE /:id/read so "read-all" is never parsed as an id.
router.patch('/read-all', authenticateAdmin, notificationController.markAllRead);

// PATCH /api/notifications/:id/read — mark one as read
router.patch('/:id/read', authenticateAdmin, notificationController.markRead);

module.exports = router;
