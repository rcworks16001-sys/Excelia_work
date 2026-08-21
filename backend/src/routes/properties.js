const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const propertyController = require('../controllers/propertyController');

// Memory storage — files are streamed straight to Cloudinary, never written
// to disk on this server.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/properties — full listing, for the dashboard's properties page
router.get('/', authenticateAdmin, propertyController.list);

// GET /api/properties/search?city=&neighbourhood=&type=&bedrooms=&price_max=
router.get('/search', authenticateAdmin, propertyController.search);

// POST /api/properties/:id/photos — upload one photo (multipart, field name "photo")
router.post('/:id/photos', authenticateAdmin, upload.single('photo'), propertyController.uploadPhoto);

// DELETE /api/properties/:id/photos — body: { url } — detach a photo
router.delete('/:id/photos', authenticateAdmin, propertyController.deletePhoto);

module.exports = router;
