require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/index');
const cloudinary = require('../src/utils/cloudinary');

// ── EXCELIA bulk photo upload ──
// One-time/repeatable admin tool — NOT an Express route, run manually:
//   node scripts/bulk-upload-photos.js
//
// Convention: drop photos into backend/photos-to-upload/<property_id>/,
// one folder per listing. Filenames inside a folder can be anything — they
// upload in alphabetical order. Run with no photos in place first to just
// see the id -> listing cheat-sheet below.
//
// A listing with no matching folder (or an empty one) is left untouched —
// safe to re-run after adding more folders. Re-running for a listing that
// already has a folder REPLACES its photos array wholesale with the newly
// uploaded set (this is a bulk *load* tool, not an incremental editor —
// the dashboard's per-listing upload/delete buttons handle that afterward).

const UPLOAD_DIR = path.join(__dirname, '..', 'photos-to-upload');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const printManifest = (properties) => {
    console.log('\n--- Property id -> listing (organize your photo folders using these ids) ---');
    for (const p of properties) {
        console.log(`  ${p.id}  —  ${p.type}, ${p.neighbourhood}, ${p.city} — ${p.price} XOF`);
    }
    console.log('---\n');
};

const run = async () => {
    try {
        const { rows: properties } = await pool.query(
            'SELECT id, type, neighbourhood, city, price FROM properties ORDER BY id'
        );
        printManifest(properties);

        if (!fs.existsSync(UPLOAD_DIR)) {
            console.log(`No ${path.relative(process.cwd(), UPLOAD_DIR)} folder found — nothing to upload.`);
            console.log('Create it and drop photos into subfolders named by property id (see manifest above).');
            process.exit(0);
        }

        let updatedCount = 0;

        for (const property of properties) {
            const propertyDir = path.join(UPLOAD_DIR, String(property.id));
            if (!fs.existsSync(propertyDir)) continue;

            const files = fs.readdirSync(propertyDir)
                .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
                .sort();

            if (files.length === 0) {
                console.log(`#${property.id}: folder exists but has no image files — skipping.`);
                continue;
            }

            console.log(`#${property.id} (${property.type}, ${property.neighbourhood}): uploading ${files.length} photo(s)...`);

            const uploadedUrls = [];
            for (let i = 0; i < files.length; i += 1) {
                const filePath = path.join(propertyDir, files[i]);
                // Deterministic public_id + overwrite:true — re-running this
                // script replaces the same Cloudinary assets instead of
                // accumulating duplicates every time.
                const result = await cloudinary.uploader.upload(filePath, {
                    public_id: `excelia/properties/${property.id}/${i}`,
                    overwrite: true,
                });
                uploadedUrls.push(result.secure_url);
                console.log(`  uploaded ${files[i]} -> ${result.secure_url}`);
            }

            await pool.query('UPDATE properties SET photos = $1 WHERE id = $2', [uploadedUrls, property.id]);
            updatedCount += 1;
        }

        console.log(`\nDone. ${updatedCount} listing(s) updated.`);
        process.exit(0);
    } catch (error) {
        console.error('Bulk photo upload failed:', error);
        process.exit(1);
    }
};

run();
