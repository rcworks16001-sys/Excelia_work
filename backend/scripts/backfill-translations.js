require('dotenv').config();
const pool = require('../src/db/index');
const { translateToEnglish } = require('../src/utils/translate');
const { extractAppointmentDateTime } = require('../src/controllers/webhookController');

// ── EXCELIA translation / date backfill ──
// One-time-per-row, repeatable admin tool — NOT an Express route, run manually:
//   npm run backfill-translations
//
// Two independent passes, both strictly additive and both skipping rows that
// are already filled, so this is safe (and cheap) to re-run any time:
//
//   1. properties.description_en — descriptions are authored in French; this
//      caches an English translation ONCE per listing so neither the dashboard
//      nor the bot ever pays translation latency/cost at read time. Re-run
//      after adding new listings to translate just the new ones.
//
//   2. appointments.requested_date / requested_time_of_day — older bookings
//      were parsed before these columns existed, so a reply like "demain
//      matin" resolved to nothing and the UI had only raw French to show.
//      Re-resolves those using each row's own created_at as the reference
//      "now" (critical: "demain" is meaningless without the date it was said).
//
// Rows that fail to resolve are left NULL and simply keep falling back to the
// original raw text — a failure here degrades display, never breaks anything.

const backfillDescriptions = async () => {
    const { rows } = await pool.query(
        `SELECT id, description FROM properties
         WHERE description IS NOT NULL AND description <> '' AND description_en IS NULL
         ORDER BY id`
    );

    if (rows.length === 0) {
        console.log('descriptions: nothing to do — every listing already has an English version.');
        return;
    }

    console.log(`descriptions: translating ${rows.length} listing(s)...`);
    let filled = 0;

    for (const row of rows) {
        const translated = await translateToEnglish(row.description);
        if (!translated) {
            console.warn(`  ! id ${row.id}: translation failed, leaving NULL (will fall back to French)`);
            continue;
        }
        await pool.query('UPDATE properties SET description_en = $1 WHERE id = $2', [translated, row.id]);
        filled += 1;
        console.log(`  ✓ id ${row.id}: ${translated}`);
    }

    console.log(`descriptions: filled ${filled}/${rows.length}.`);
};

const backfillAppointmentDates = async () => {
    const { rows } = await pool.query(
        `SELECT id, requested_datetime_text, requested_datetime, created_at
         FROM appointments
         WHERE requested_date IS NULL
         ORDER BY id`
    );

    if (rows.length === 0) {
        console.log('appointments: nothing to do — every booking already has a resolved date.');
        return;
    }

    console.log(`appointments: re-resolving ${rows.length} booking(s)...`);
    let filled = 0;

    for (const row of rows) {
        // Fast path: an exact datetime was already resolved at booking time,
        // so the date/part-of-day are derivable without another API call.
        if (row.requested_datetime) {
            const dt = new Date(row.requested_datetime);
            const hour = dt.getUTCHours(); // stored as Togo time (UTC+0)
            const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
            await pool.query(
                'UPDATE appointments SET requested_date = $1, requested_time_of_day = $2 WHERE id = $3',
                [dt.toISOString().slice(0, 10), timeOfDay, row.id]
            );
            filled += 1;
            console.log(`  ✓ id ${row.id}: derived from existing timestamp`);
            continue;
        }

        // Slow path: only free text ("demain matin"). Re-run the extractor
        // with the booking's own creation time as the reference point.
        const result = await extractAppointmentDateTime(row.requested_datetime_text, row.created_at);
        if (!result.resolved_date) {
            console.warn(`  ! id ${row.id}: "${row.requested_datetime_text}" — no date resolvable, leaving NULL`);
            continue;
        }

        await pool.query(
            'UPDATE appointments SET requested_date = $1, requested_time_of_day = $2 WHERE id = $3',
            [result.resolved_date, result.time_of_day, row.id]
        );
        filled += 1;
        console.log(`  ✓ id ${row.id}: "${row.requested_datetime_text}" -> ${result.resolved_date} ${result.time_of_day || ''}`.trimEnd());
    }

    console.log(`appointments: filled ${filled}/${rows.length}.`);
};

const run = async () => {
    try {
        await backfillDescriptions();
        console.log('');
        await backfillAppointmentDates();
        console.log('\nBackfill complete.');
        process.exit(0);
    } catch (error) {
        console.error('Backfill failed:', error);
        process.exit(1);
    }
};

run();
