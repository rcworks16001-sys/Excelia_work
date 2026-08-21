const express = require('express');
const router = express.Router();
const { login } = require('../controllers/authController');

// POST /api/auth/login — body: { username, password }
// Not authenticateAdmin-protected — this IS the login endpoint.
router.post('/login', login);

module.exports = router;
