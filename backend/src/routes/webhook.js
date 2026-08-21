const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// Webhook verification (GET) - Meta calls this once to verify
router.get('/', webhookController.verify);

// Webhook messages (POST) - Meta calls this for every message
router.post('/', webhookController.handleMessage);

module.exports = router;
