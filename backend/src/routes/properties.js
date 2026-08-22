const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const propertyController = require('../controllers/propertyController');

// Memory storage — files are streamed straight to Cloudinary, never written
// to disk on this server.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Separate instance for video — a property walkthrough is routinely well
// over the 10MB photo limit above, so it needs its own higher ceiling.
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/properties — full listing, for the dashboard's properties page
router.get('/', authenticateAdmin, propertyController.list);

// POST /api/properties — create a new listing, body: { city, neighbourhood, type, price, bedrooms?, description? }
router.post('/', authenticateAdmin, propertyController.create);

// DELETE /api/properties/:id — remove a listing (blocked if it has appointments)
router.delete('/:id', authenticateAdmin, propertyController.remove);

// PATCH /api/properties/:id/status — update availability, body: { listing_status, reserved_for? }
router.patch('/:id/status', authenticateAdmin, propertyController.updateListingStatus);

// GET /api/properties/search?city=&neighbourhood=&type=&bedrooms=&price_max=
router.get('/search', authenticateAdmin, propertyController.search);

// POST /api/properties/:id/photos — upload one photo (multipart, field name "photo")
router.post('/:id/photos', authenticateAdmin, upload.single('photo'), propertyController.uploadPhoto);

// DELETE /api/properties/:id/photos — body: { url } — detach a photo
router.delete('/:id/photos', authenticateAdmin, propertyController.deletePhoto);

// POST /api/properties/:id/video — upload/replace the listing's walkthrough video (multipart, field name "video")
router.post('/:id/video', authenticateAdmin, uploadVideo.single('video'), propertyController.uploadVideo);

// DELETE /api/properties/:id/video — clear the listing's video
router.delete('/:id/video', authenticateAdmin, propertyController.deleteVideo);

module.exports = router;
