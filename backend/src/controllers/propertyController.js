const pool = require('../db/index');
const cloudinary = require('../utils/cloudinary');
const { translateToEnglish, translateToFrench } = require('../utils/translate');

// Columns the bot and dashboard actually need — never SELECT *.
const PROPERTY_COLUMNS = `
    id, city, neighbourhood, type, price, bedrooms,
    description, description_en, photos, video_url, latitude, longitude, agency_contact,
    listing_status, reserved_for, transaction
`;

const PRICE_TOLERANCE = 1.1; // 10% tolerance on price_max, per CLAUDE.md search rules

// The ONE list of valid property types — matches the DB CHECK constraint on
// properties.type in migrate.js.
const VALID_PROPERTY_TYPES = ['chambre_salon', 'appartement', 'villa', 'terrain', 'mini_villa', 'appartement_meuble'];

// The ONE list of valid listing statuses — matches the DB CHECK constraint on
// properties.listing_status in migrate.js.
const VALID_LISTING_STATUSES = ['available', 'reserved', 'rented'];

// The ONE list of valid transaction types — matches the DB CHECK constraint on
// properties.transaction in migrate.js.
const VALID_TRANSACTIONS = ['rent', 'sale'];

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
// The ONE place a property search query is built. Every search path
// (strict, relaxed, dashboard) goes through this — never hand-roll another.
const buildQuery = (filters, limit) => {
    const { city, neighbourhood, type, price_max, bedrooms, transaction } = filters;
    const conditions = [];
    const values = [];

    if (transaction) {
        values.push(transaction);
        conditions.push(`transaction = $${values.length}`);
    }

    if (city) {
        values.push(`%${city}%`);
        // unaccent() on both sides: WhatsApp/French input very commonly
        // drops accents ("lome" for "Lomé") — plain ILIKE is
        // case-insensitive but not accent-insensitive.
        conditions.push(`unaccent(city) ILIKE unaccent($${values.length})`);
    }
    if (neighbourhood) {
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
    // An ABSOLUTE ceiling, with no tolerance added. Used when the lead has
    // already told us the most they would stretch to ("I could go to 90") —
    // that figure is their own limit, so nudging it another 10% would show
    // them places they have explicitly ruled out. price_max keeps the
    // tolerance because a bare "my budget is 80" is an estimate, not a wall.
    if (filters.price_ceiling) {
        values.push(Math.round(filters.price_ceiling));
        conditions.push(`price <= $${values.length}`);
    }
    // Bot-only contract (see searchPropertiesWithFallback) — never dropped by
    // its relaxation cascade, unlike every other filter above. searchProperties()
    // (the dashboard/exact-match contract) never sets this, so it still sees
    // every status.
    if (filters.available_only) {
        conditions.push(`listing_status = 'available'`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const text = `SELECT ${PROPERTY_COLUMNS} FROM properties ${whereClause} ORDER BY price ASC LIMIT ${limit}`;
    return { text, values };
};

const runSearch = async (filters, limit) => {
    const { text, values } = buildQuery(filters, limit);
    const result = await pool.query(text, values);
    return result.rows;
};

const searchProperties = async (filters = {}) => {
    const rows = await runSearch(filters, 10);
    if (rows.length > 0) return rows;

    // No results — relax neighbourhood, keep type + price, return 3 closest.
    if (filters.neighbourhood) {
        return runSearch({ ...filters, neighbourhood: null }, 3);
    }
    return rows; // may still be empty
};

// ── searchPropertiesWithFallback(filters) ──
// What the BOT uses. Same query builder as searchProperties (no duplicated
// search logic) but never dead-ends: it widens the search step by step until
// something matches, and reports which constraints it had to drop so the
// reply can say so honestly instead of pretending it was an exact match.
//
// Drop order is "least painful first". price_max is held onto the longest —
// showing someone a 6 000 000 F CFA plot when they asked for 35 000 is worse
// than showing them a different neighbourhood — and is only dropped as an
// explicit last resort.
//
// Returns { listings, relaxed: ['neighbourhood', 'bedrooms', ...] }.
// `relaxed` is empty when the strict search matched.
const searchPropertiesWithFallback = async (filters = {}) => {
    // `transaction` is dropped AFTER type on purpose. Only the two land plots
    // are for sale, so someone asking to buy a villa has no strict match —
    // dropping type first offers them what IS for sale (land) before falling
    // back to offering rentals, which is the more useful order. Either way the
    // widening is reported back and admitted in the reply rather than passed
    // off as an exact match.
    const steps = [
        { drop: [] },
        { drop: ['neighbourhood'] },
        { drop: ['neighbourhood', 'bedrooms'] },
        { drop: ['neighbourhood', 'bedrooms', 'type'] },
        { drop: ['neighbourhood', 'bedrooms', 'type', 'transaction'] },
        { drop: ['neighbourhood', 'bedrooms', 'type', 'transaction', 'city'] },
        // price_ceiling drops WITH price_max — they express the same constraint
        // (see buildQuery), so relaxing one while keeping the other would leave
        // the budget silently enforced by the survivor.
        { drop: ['neighbourhood', 'bedrooms', 'type', 'transaction', 'city', 'price_max', 'price_ceiling'] },
    ];

    // A wide-open query ("anything cheap?") would otherwise return 10 full
    // listing cards — a wall of text in WhatsApp. Show a browsable handful
    // instead; the lead can narrow down from there.
    const hasAnyFilter = ['city', 'neighbourhood', 'type', 'price_max', 'price_ceiling', 'bedrooms', 'transaction']
        .some((f) => filters[f] !== undefined && filters[f] !== null);
    const strictLimit = hasAnyFilter ? 10 : 5;

    for (const step of steps) {
        // Only count a constraint as "relaxed" if it was actually set — a
        // dropped filter the user never gave isn't something to apologise for.
        const relaxed = step.drop.filter((f) => filters[f] !== undefined && filters[f] !== null);
        // available_only is NOT part of the relaxation cascade — a rented or
        // reserved listing must never appear in bot search results, no matter
        // how far the search has to widen otherwise.
        const attemptFilters = { ...filters, available_only: true };
        for (const field of step.drop) attemptFilters[field] = null;

        const listings = await runSearch(attemptFilters, step.drop.length === 0 ? strictLimit : 3);
        if (listings.length > 0) return { listings, relaxed };
    }

    return { listings: [], relaxed: [] }; // only if the table is empty
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
//
// descriptionLang tells us which language the admin actually typed in
// ('fr' default, or 'en'). `description` is treated as the French column
// everywhere else in the app (bot replies, dashboard FR mode, search), so
// whichever language WASN'T typed gets machine-translated once, right here
// at creation time — same write-time-only pattern as the bulk backfill
// script, just triggered per-listing instead of in a batch. A translation
// failure never blocks creation: it just leaves the missing side to be
// picked up by a later `npm run backfill-translations` run (or, for the
// French column specifically — since it's shown by default and must never
// be empty — falls back to the raw typed text rather than leaving it blank).
const create = async (req, res) => {
    const { city, neighbourhood, type, price, bedrooms, description, descriptionLang, transaction } = req.body || {};

    if (typeof city !== 'string' || !city.trim()) {
        return res.status(400).json({ error: 'city is required' });
    }
    if (typeof neighbourhood !== 'string' || !neighbourhood.trim()) {
        return res.status(400).json({ error: 'neighbourhood is required' });
    }
    if (!VALID_PROPERTY_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${VALID_PROPERTY_TYPES.join(', ')}` });
    }
    // Optional — omitting it takes the DB default ('rent'), which is what the
    // overwhelming majority of the catalogue is.
    if (transaction !== undefined && transaction !== null && !VALID_TRANSACTIONS.includes(transaction)) {
        return res.status(400).json({ error: `transaction must be one of: ${VALID_TRANSACTIONS.join(', ')}` });
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

    const typedDescription = description && description.trim() ? description.trim() : null;
    let descriptionFr = typedDescription;
    let descriptionEn = null;

    if (typedDescription) {
        if (descriptionLang === 'en') {
            descriptionEn = typedDescription;
            const translated = await translateToFrench(typedDescription);
            // French column is the one shown by default and read by the bot —
            // never leave it blank just because the API call failed.
            descriptionFr = translated || typedDescription;
        } else {
            descriptionEn = await translateToEnglish(typedDescription); // null on failure — EN mode falls back to French, same as any pre-existing listing
        }
    }

    try {
        const result = await pool.query(
            `INSERT INTO properties (city, neighbourhood, type, price, bedrooms, description, description_en, photos, agency_contact, transaction)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9)
             RETURNING ${PROPERTY_COLUMNS}`,
            [city.trim(), neighbourhood.trim(), type, priceNum, bedroomsNum, descriptionFr, descriptionEn, EXCELIA_OFFICE_CONTACT,
                transaction || 'rent']
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

// ── updateListingStatus(req, res) ──
// Dashboard availability control: Available / Reserved / Rented, plus an
// optional reserved_for note. reserved_for is only meaningful while status is
// 'reserved' — moving a listing to any other status clears it server-side, so
// a stale note can never linger and resurface next time the listing is
// reserved again.
const updateListingStatus = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid property id' });
    }

    const { listing_status, reserved_for } = req.body || {};
    if (!VALID_LISTING_STATUSES.includes(listing_status)) {
        return res.status(400).json({ error: `listing_status must be one of: ${VALID_LISTING_STATUSES.join(', ')}` });
    }
    const note = listing_status === 'reserved' && typeof reserved_for === 'string' && reserved_for.trim()
        ? reserved_for.trim()
        : null;

    try {
        const result = await pool.query(
            'UPDATE properties SET listing_status = $1, reserved_for = $2 WHERE id = $3 RETURNING id, listing_status, reserved_for',
            [listing_status, note, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Property not found' });
        }
        res.json({ property: result.rows[0] });
    } catch (error) {
        console.error('Error updating property listing status:', error);
        res.status(500).json({ error: 'Failed to update listing status' });
    }
};

module.exports = {
    searchProperties, searchPropertiesWithFallback, search, getPropertyById, list,
    uploadPhoto, deletePhoto, uploadVideo, deleteVideo, getKnownLocations,
    create, remove, updateListingStatus,
    VALID_PROPERTY_TYPES, VALID_LISTING_STATUSES, VALID_TRANSACTIONS,
};
