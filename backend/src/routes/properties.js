const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const propertyController = require('../controllers/propertyController');

// GET /api/properties — full listing, for the dashboard's properties page
router.get('/', authenticateAdmin, propertyController.list);

// GET /api/properties/search?city=&neighbourhood=&type=&bedrooms=&price_max=
router.get('/search', authenticateAdmin, propertyController.search);

module.exports = router;
