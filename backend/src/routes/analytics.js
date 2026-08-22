const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const analyticsController = require('../controllers/analyticsController');

// GET /api/analytics — the five dashboard metrics
router.get('/', authenticateAdmin, analyticsController.overview);

module.exports = router;
