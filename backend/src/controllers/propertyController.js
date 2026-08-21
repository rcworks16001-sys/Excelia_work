const pool = require('../db/index');
const cloudinary = require('../utils/cloudinary');

// Columns the bot and dashboard actually need — never SELECT *.
const PROPERTY_COLUMNS = `
    id, city, neighbourhood, type, price, bedrooms,
    description, photos, latitude, longitude, agency_contact
`;

const PRICE_TOLERANCE = 1.1; // 10% tolerance on price_max, per CLAUDE.md search rules

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

module.exports = { searchProperties, search, getPropertyById, list, uploadPhoto, deletePhoto, getKnownLocations };
