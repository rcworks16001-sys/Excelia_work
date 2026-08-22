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

        // English rendering of `description` (which is authored in French).
        // Filled ONCE per listing by scripts/backfill-translations.js and then
        // read for free forever — never translated per page-view or per bot
        // reply. Nullable on purpose: readers fall back to the French
        // description, so a brand-new listing degrades gracefully until the
        // next backfill run fills it in.
        await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS description_en TEXT;`);

        // One optional walkthrough video per listing (not a gallery like
        // `photos` — a single Cloudinary video URL, or NULL).
        await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS video_url TEXT;`);

        // Availability status shown on the dashboard and enforced in bot search —
        // a rented/reserved listing must never surface in searchPropertiesWithFallback().
        // Defaults every existing row (and every new one) to 'available'.
        await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_status TEXT NOT NULL DEFAULT 'available' CHECK (listing_status IN (
            'available', 'reserved', 'rented'
        ));`);

        // Free-text note on who a 'reserved' listing is held for. Nullable — only
        // meaningful when listing_status = 'reserved'; the PATCH endpoint clears it
        // whenever status moves away from 'reserved' (app-level, not a DB constraint,
        // matching how this codebase already handles similar cases).
        await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS reserved_for TEXT;`);

        // Rent vs sale. The agency does both across all property types, so
        // this is a real field rather than something derivable from `type` —
        // but 'rent' is the safe default because it's the overwhelming
        // majority of the catalogue, and a mislabelled sale listing merely
        // shows up in the wrong search rather than breaking anything.
        await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS transaction TEXT NOT NULL DEFAULT 'rent' CHECK (transaction IN (
            'rent', 'sale'
        ));`);

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

        // requested_datetime only gets set when BOTH date and time were
        // confidently resolvable, which threw away perfectly good dates from
        // replies like "demain matin" (date resolvable, time only coarse).
        // These two capture that middle ground WITHOUT inventing a clock time:
        // requested_date is the resolved calendar day, requested_time_of_day
        // the coarse part-of-day. requested_datetime keeps its strict
        // exact-datetime-only meaning so nothing downstream is misled.
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS requested_date DATE;`);
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS requested_time_of_day TEXT CHECK (requested_time_of_day IN ('morning', 'afternoon', 'evening'));`);

        // Prospect pipeline stage. Defaults every lead (including existing
        // rows) to 'new'.
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
            'new', 'contacted', 'qualified', 'site_visit', 'converted', 'lost'
        ));`);

        // Free-text admin notes about a lead — separate from `conversations`
        // (the actual WhatsApp transcript). Auto-saved from the dashboard's
        // lead detail page, never touched by the bot.
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;`);

        // lead_profiles — what the bot actually KNOWS about a lead, as
        // structured data rather than something re-derived from the transcript
        // on every turn. Before this, extractSearchFilters produced a filter
        // set, used it for one search and threw it away; "memory" was the model
        // re-reading the last 10 rows of conversation, so anything said more
        // than ~5 exchanges ago was gone for good and nothing was queryable.
        //
        // Discrete typed columns rather than one JSONB blob: the dashboard has
        // to filter and sort on these ("show me every hot lead wanting a villa
        // under 300k"), which is the whole point of storing them.
        //
        // ON DELETE CASCADE is load-bearing, not decoration — smoke-bot.js
        // cleans up with `DELETE FROM leads WHERE phone = $1`, and without the
        // cascade every scenario's teardown would throw an FK violation and
        // crash the suite. Declared inline because a later ADD CONSTRAINT
        // cannot be made IF NOT EXISTS.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS lead_profiles (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,

                -- What they're looking for. Mirrors the search filter fields,
                -- plus the rent/sale distinction added in the previous phase.
                transaction TEXT CHECK (transaction IN ('rent', 'sale')),
                property_type TEXT CHECK (property_type IN (
                    'chambre_salon', 'appartement', 'villa',
                    'terrain', 'mini_villa', 'appartement_meuble'
                )),
                city TEXT,
                neighbourhood TEXT,
                bedrooms_min INTEGER,
                bedrooms_max INTEGER,

                -- budget_max is the stated ceiling; budget_stretch_max is what
                -- they'd go to if pushed ("I could stretch to 90"). A real
                -- number, NOT a boolean flag: a flag would force the search
                -- layer to invent a stretch percentage, which is exactly the
                -- kind of made-up figure this codebase forbids everywhere else.
                budget_max INTEGER,
                budget_stretch_max INTEGER,

                purpose TEXT CHECK (purpose IN ('self_use', 'investment', 'rental_income')),
                timeline TEXT CHECK (timeline IN ('immediate', 'within_1_month', 'within_3_months', 'later', 'exploring')),

                -- How the conversation is going, as opposed to what they want.
                last_objection TEXT,
                liked_property_ids INTEGER[] DEFAULT '{}',
                rejected_property_ids INTEGER[] DEFAULT '{}',
                rejection_reasons JSONB DEFAULT '{}'::jsonb,
                last_properties_shown INTEGER[] DEFAULT '{}',

                -- Long-term memory. The raw transcript is short-term and wins
                -- on conflict; this carries the gist of everything older.
                conversation_summary TEXT,

                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now()
            );
        `);
        // Per CLAUDE.md: every table queried by lead needs an index on that FK.
        // (UNIQUE already provides one here, but stated explicitly so the rule
        // isn't quietly relied on via a constraint that could later change.)
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_profiles_lead_id ON lead_profiles (lead_id);`);

        // Records WHEN the current pending booking state was set, so it can be
        // expired. Without it a lead who goes quiet mid-booking stays parked in
        // 'awaiting_viewing_datetime' forever, and their "hello" three days
        // later is read as a date for a property they've long forgotten.
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pending_set_at TIMESTAMPTZ;`);

        // Client decision: no per-agency contact numbers — every listing
        // always shows the single EXCELIA office number. Updating seed.js
        // alone wouldn't touch already-seeded live rows (seed.js skips
        // re-seeding once properties has data), so this idempotent backfill
        // is what actually changes what's live.
        await pool.query(
            `UPDATE properties SET agency_contact = $1 WHERE agency_contact IS DISTINCT FROM $1;`,
            ['+228 91062626 — EXCELIA office']
        );

        // Land is sold, not rented. The `transaction` column defaults to
        // 'rent', so without this the two terrain listings would advertise
        // plots for monthly rent.
        //
        // Content-idempotent (`AND transaction <> 'sale'`) rather than
        // run-once, deliberately: the documented order is migrate-then-seed,
        // so on a fresh database this runs BEFORE any rows exist and does
        // nothing. seed.js therefore sets `transaction` itself, and this
        // backfill is what fixes already-live rows. Re-running is free, and
        // an admin who deliberately re-labels a plot is not overridden on the
        // next deploy — only rows still holding the wrong default are touched.
        await pool.query(`UPDATE properties SET transaction = 'sale' WHERE type = 'terrain' AND transaction <> 'sale';`);

        console.log('Migrations complete.');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

runMigrations();
