const pool = require('../db/index');
const cloudinary = require('../utils/cloudinary');

// Columns the bot and dashboard actually need — never SELECT *.
const PROPERTY_COLUMNS = `
    id, city, neighbourhood, type, price, bedrooms,
    description, description_en, photos, video_url, latitude, longitude, agency_contact
`;

const PRICE_TOLERANCE = 1.1; // 10% tolerance on price_max, per CLAUDE.md search rules

// The ONE list of valid property types — matches the DB CHECK constraint on
// properties.type in migrate.js.
const VALID_PROPERTY_TYPES = ['chambre_salon', 'appartement', 'villa', 'terrain', 'mini_villa', 'appartement_meuble'];

// Client decision: no per-agency contact numbers — every listing always
// shows the single EXCELIA office number (same value migrate.js backfills
// onto existing rows). A newly-created listing gets it automatically.
const EXCELIA_OFFICE_CONTACT = '+228 91062626 — EXCELIA office';

// ── searchProperties(filters) ──
// The ONE property search function. Both the WhatsApp bot and the (future)
// dashboard call this — never duplicate this query elsewhere.
//
// filters: { city, neighbourhood, type, price_max, bedrooms }
// - city / neighbourhood: fuzzy match (ILIKE)
// - type / bedrooms: exact match
// - price: price <= price_max * 1.1
//
// If no results: relax the neighbourhood constraint (keep type + price) and
// return the 3 closest listings. If still no results, returns an empty array —
// the caller (bot conversation logic) is responsible for asking a clarifying
// question in the user's language.
const searchProperties = async (filters = {}) => {
    const { city, neighbourhood, type, price_max, bedrooms } = filters;

    const buildQuery = ({ includeNeighbourhood, limit }) => {
        const conditions = [];
        const values = [];

        if (city) {
            values.push(`%${city}%`);
            // unaccent() on both sides: WhatsApp/French input very commonly
            // drops accents ("lome" for "Lomé") — plain ILIKE is
            // case-insensitive but not accent-insensitive.
            conditions.push(`unaccent(city) ILIKE unaccent($${values.length})`);
        }
        if (includeNeighbourhood && neighbourhood) {
            values.push(`%${neighbourhood}%`);
            conditions.push(`unaccent(neighbourhood) ILIKE unaccent($${values.length})`);
        }
        if (type) {
            values.push(type);
            conditions.push(`type = $${values.length}`);
        }
        if (bedrooms !== undefined && bedrooms !== null) {
            values.push(bedrooms);
            conditions.push(`bedrooms = $${values.length}`);
        }
        if (price_max) {
            values.push(Math.round(price_max * PRICE_TOLERANCE));
            conditions.push(`price <= $${values.length}`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const text = `SELECT ${PROPERTY_COLUMNS} FROM properties ${whereClause} ORDER BY price ASC LIMIT ${limit}`;
        return { text, values };
    };

    const primary = buildQuery({ includeNeighbourhood: true, limit: 10 });
    let result = await pool.query(primary.text, primary.values);

    if (result.rows.length > 0) {
        return result.rows;
    }

    // No results — relax neighbourhood, keep type + price, return 3 closest.
    if (neighbourhood) {
        const relaxed = buildQuery({ includeNeighbourhood: false, limit: 3 });
        result = await pool.query(relaxed.text, relaxed.values);
    }

    return result.rows; // may still be empty
};

// ── getKnownLocations() ──
// Distinct city/neighbourhood pairs currently in the properties table. Used
// by the bot's NLU prompt (webhookController.js) so Claude can tell a bare
// neighbourhood name ("Avédji") apart from a city name, instead of guessing.
const getKnownLocations = async () => {
    const result = await pool.query(
        'SELECT DISTINCT city, neighbourhood FROM properties ORDER BY city, neighbourhood'
    );
    return result.rows; // [{ city, neighbourhood }, ...]
};

// ── list(req, res) ──
// Full listing for the dashboard's properties page — all 13 seed listings,
// not just the top matches searchProperties() would return.
const list = async (req, res) => {
    try {
        const result = await pool.query(`SELECT ${PROPERTY_COLUMNS}, created_at FROM properties ORDER BY created_at DESC`);
        res.json({ properties: result.rows });
    } catch (error) {
        console.error('Error listing properties:', error);
        res.status(500).json({ error: 'Failed to list properties' });
    }
};

// ── getPropertyById(id) ──
// Used by the booking flow to look up the specific listing a lead selected.
const getPropertyById = async (id) => {
    const result = await pool.query(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = $1`, [id]);
    return result.rows[0] || null;
};

// ── HTTP handler ──
// Thin wrapper for a manual/dashboard-facing search endpoint. Parses query
// params into the same filters object and calls searchProperties().
const search = async (req, res) => {
    const { city, neighbourhood, type, bedrooms, price_max } = req.query;

    try {
        const properties = await searchProperties({
            city,
            neighbourhood,
            type,
            bedrooms: bedrooms !== undefined ? parseInt(bedrooms, 10) : undefined,
            price_max: price_max !== undefined ? parseInt(price_max, 10) : undefined,
        });
        res.json({ properties });
    } catch (error) {
        console.error('Error searching properties:', error);
        res.status(500).json({ error: 'Search failed' });
    }
};

// ── uploadPhoto(req, res) ──
// Single-listing photo add, for the dashboard's "Upload photo" button.
// Expects one file on req.file (multer memory storage, see routes/properties.js).
// Streams straight to Cloudinary (no temp file on disk) and appends the
// resulting URL to that listing's photos array.
const uploadPhoto = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid property id' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No photo file uploaded' });
    }

    try {
        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'excelia/properties' },
                (error, result) => (error ? reject(error) : resolve(result))
            );
            stream.end(req.file.buffer);
        });

        const result = await pool.query(
            'UPDATE properties SET photos = array_append(photos, $1) WHERE id = $2 RETURNING photos',
            [uploadResult.secure_url, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json({ photos: result.rows[0].photos });
    } catch (error) {
        console.error('Error uploading property photo:', error);
        res.status(500).json({ error: 'Failed to upload photo' });
    }
};

// ── deletePhoto(req, res) ──
// Detaches a photo URL from a listing (body: { url }). Doesn't also delete
// the Cloudinary asset in this first cut — a deliberate simplification, see
// the Task 1 plan; easy to add cloudinary.uploader.destroy() later.
const deletePhoto = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid property id' });
    }
    const { url } = req.body || {};
    if (!url) {
        return res.status(400).json({ error: 'url is required' });
    }

    try {
        const result = await pool.query(
            'UPDATE properties SET photos = array_remove(photos, $1) WHERE id = $2 RETURNING photos',
            [url, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json({ photos: result.rows[0].photos });
    } catch (error) {
        console.error('Error deleting property photo:', error);
        res.status(500).json({ error: 'Failed to delete photo' });
    }
};

// ── uploadVideo(req, res) ──
// Single-listing video, for the dashboard's "Upload video" button. Unlike
// photos this is a single value, not an array — a new upload REPLACES
// video_url rather than appending (mirrors how the bulk script treats it).
const uploadVideo = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid property id' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }

    try {
        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'excelia/properties', resource_type: 'video' },
                (error, result) => (error ? reject(error) : resolve(result))
            );
            stream.end(req.file.buffer);
        });

        const result = await pool.query(
            'UPDATE properties SET video_url = $1 WHERE id = $2 RETURNING video_url',
            [uploadResult.secure_url, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json({ video_url: result.rows[0].video_url });
    } catch (error) {
        console.error('Error uploading property video:', error);
        res.status(500).json({ error: 'Failed to upload video' });
    }
};

// ── deleteVideo(req, res) ──
// Clears video_url. Doesn't also delete the Cloudinary asset in this first
// cut — same deliberate simplification as deletePhoto.
const deleteVideo = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid property id' });
    }

    try {
        const result = await pool.query(
            'UPDATE properties SET video_url = NULL WHERE id = $1 RETURNING video_url',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json({ video_url: result.rows[0].video_url });
    } catch (error) {
        console.error('Error deleting property video:', error);
        res.status(500).json({ error: 'Failed to delete video' });
    }
};

// ── create(req, res) ──
// New listing from the dashboard's "Add property" form. agency_contact is
// never taken from the request — always the single static office number,
// matching the existing client decision (see EXCELIA_OFFICE_CONTACT above).
const create = async (req, res) => {
    const { city, neighbourhood, type, price, bedrooms, description } = req.body || {};

    if (typeof city !== 'string' || !city.trim()) {
        return res.status(400).json({ error: 'city is required' });
    }
    if (typeof neighbourhood !== 'string' || !neighbourhood.trim()) {
        return res.status(400).json({ error: 'neighbourhood is required' });
    }
    if (!VALID_PROPERTY_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${VALID_PROPERTY_TYPES.join(', ')}` });
    }
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0 || !Number.isInteger(priceNum)) {
        return res.status(400).json({ error: 'price must be a positive integer' });
    }
    let bedroomsNum = null;
    if (bedrooms !== undefined && bedrooms !== null && bedrooms !== '') {
        bedroomsNum = Number(bedrooms);
        if (!Number.isInteger(bedroomsNum) || bedroomsNum < 0) {
            return res.status(400).json({ error: 'bedrooms must be a non-negative integer' });
        }
    }

    try {
        const result = await pool.query(
            `INSERT INTO properties (city, neighbourhood, type, price, bedrooms, description, photos, agency_contact)
             VALUES ($1, $2, $3, $4, $5, $6, '{}', $7)
             RETURNING ${PROPERTY_COLUMNS}`,
            [city.trim(), neighbourhood.trim(), type, priceNum, bedroomsNum, description || null, EXCELIA_OFFICE_CONTACT]
        );
        res.status(201).json({ property: result.rows[0] });
    } catch (error) {
        console.error('Error creating property:', error);
        res.status(500).json({ error: 'Failed to create property' });
    }
};

// ── remove(req, res) ──
// Blocks deletion if the listing has any appointments booked against it —
// appointments.property_id is ON DELETE CASCADE, so an unguarded delete
// would silently wipe that booking history. The admin has to clear/reassign
// those appointments first (or we'd need an explicit force flag, which we
// deliberately don't offer here).
const remove = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid property id' });
    }

    try {
        const appointmentCheck = await pool.query('SELECT COUNT(*) FROM appointments WHERE property_id = $1', [id]);
        const appointmentCount = parseInt(appointmentCheck.rows[0].count, 10);
        if (appointmentCount > 0) {
            return res.status(409).json({
                error: `Cannot delete: ${appointmentCount} appointment(s) are booked against this property.`,
            });
        }

        const result = await pool.query('DELETE FROM properties WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting property:', error);
        res.status(500).json({ error: 'Failed to delete property' });
    }
};

module.exports = {
    searchProperties, search, getPropertyById, list, uploadPhoto, deletePhoto,
    uploadVideo, deleteVideo, getKnownLocations, create, remove, VALID_PROPERTY_TYPES,
};
