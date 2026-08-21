require('dotenv').config();
const pool = require('./index');

// EXCELIA schema — built one table at a time as each step needs it.
// Add new tables/columns here using CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
// Never edit production schema manually — every change goes through this file.
const runMigrations = async () => {
    try {
        // Accent-insensitive matching for city/neighbourhood search — French
        // WhatsApp input very commonly drops accents ("lome" for "Lomé"), and
        // plain ILIKE is case-insensitive but NOT accent-insensitive.
        await pool.query(`CREATE EXTENSION IF NOT EXISTS unaccent;`);

        // properties — single source of truth for listings (bot + dashboard both
        // read this table via searchProperties() in propertyController.js).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS properties (
                id SERIAL PRIMARY KEY,
                city TEXT NOT NULL,
                neighbourhood TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN (
                    'chambre_salon', 'appartement', 'villa',
                    'terrain', 'mini_villa', 'appartement_meuble'
                )),
                price INTEGER NOT NULL,
                bedrooms INTEGER,
                description TEXT,
                photos TEXT[] DEFAULT '{}',
                latitude DOUBLE PRECISION,
                longitude DOUBLE PRECISION,
                agency_contact TEXT,
                created_at TIMESTAMPTZ DEFAULT now()
            );
        `);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_properties_city ON properties (city);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_properties_neighbourhood ON properties (neighbourhood);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_properties_type ON properties (type);`);

        // processed_messages — idempotency guard for the WhatsApp webhook.
        // Meta retries delivery; message_id UNIQUE + the SELECT-before-insert
        // pattern in handleMessage() ensures we never process (or re-reply
        // to) the same inbound message twice.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS processed_messages (
                id SERIAL PRIMARY KEY,
                message_id TEXT NOT NULL UNIQUE,
                processed_at TIMESTAMPTZ DEFAULT now()
            );
        `);

        // leads — one row per WhatsApp number that has ever contacted us.
        // language is updated on every inbound message (per CLAUDE.md).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leads (
                id SERIAL PRIMARY KEY,
                phone TEXT NOT NULL UNIQUE,
                name TEXT,
                language TEXT NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
                created_at TIMESTAMPTZ DEFAULT now(),
                last_message_at TIMESTAMPTZ DEFAULT now()
            );
        `);

        // conversations — every inbound message and every bot reply, linked
        // to the lead that sent/received it.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS conversations (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                sender TEXT NOT NULL CHECK (sender IN ('user', 'bot')),
                message TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now()
            );
        `);
        // Queried by lead (dashboard's lead-detail conversation view, per CLAUDE.md's
        // "every table queried by ... lead must have an index on that FK column").
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_lead_id ON conversations (lead_id);`);

        // Pending-flow state for the appointment-booking conversation (a lead
        // can be mid-way through "which listing?" or "what date/time?").
        // Columns, not a separate table, since a lead has at most one active
        // pending flow at a time.
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pending_action TEXT CHECK (pending_action IN ('awaiting_viewing_selection', 'awaiting_viewing_datetime'));`);
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pending_property_id INTEGER REFERENCES properties(id);`);
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pending_listing_ids INTEGER[];`);

        // appointments — viewing requests. requested_datetime_text keeps the
        // user's own wording; requested_datetime is a best-effort parsed
        // timestamp (nullable — a booking is never blocked just because the
        // exact time couldn't be resolved from free text).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
                requested_datetime_text TEXT NOT NULL,
                requested_datetime TIMESTAMPTZ,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
                created_at TIMESTAMPTZ DEFAULT now()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments (lead_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_appointments_property_id ON appointments (property_id);`);

        // Prospect pipeline stage. Defaults every lead (including existing
        // rows) to 'new'.
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
            'new', 'contacted', 'qualified', 'site_visit', 'converted', 'lost'
        ));`);

        // Client decision: no per-agency contact numbers — every listing
        // always shows the single EXCELIA office number. Updating seed.js
        // alone wouldn't touch already-seeded live rows (seed.js skips
        // re-seeding once properties has data), so this idempotent backfill
        // is what actually changes what's live.
        await pool.query(
            `UPDATE properties SET agency_contact = $1 WHERE agency_contact IS DISTINCT FROM $1;`,
            ['+228 91062626 — EXCELIA office']
        );

        console.log('Migrations complete.');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

runMigrations();
