const cloudinary = require('cloudinary').v2;

// The ONE place Cloudinary gets configured. Imported by the bot
// (webhookController.js doesn't actually upload, just reads URLs), the
// bulk-upload script, and the dashboard's single-listing upload/delete
// endpoints (propertyController.js) — never configure it inline elsewhere.
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
