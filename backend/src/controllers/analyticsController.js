const pool = require('../db/index');

// ── Analytics ──
//
// Deliberately FIVE metrics, not a wall of charts. Each one is here because it
// changes a decision someone can actually take:
//
//   leads by temperature  -> who to call today
//   searches with no match -> what inventory to acquire next (the single most
//                             valuable signal in here, and one the agency has
//                             never had: it is a list of demand they cannot serve)
//   most-rejected listings -> what is mispriced or badly presented
//   handoffs this week    -> where the bot is reaching its limits
//   booking conversion    -> whether any of this is working
//
// CLAUDE.md says there is deliberately no dashboardController.js, because every
// dashboard read belongs to the controller owning that resource. Analytics is
// the documented exception: it is cross-resource by nature — it spans leads,
// events, properties and appointments — so it belongs to none of them.

// ── getOverview() ──
// One round-trip per metric rather than a single monstrous query: at this data
// volume the difference is unmeasurable, and five readable queries beat one
// nobody dares change.
const getOverview = async () => {
    const [temperature, deadSearches, rejected, handoffs, conversion] = await Promise.all([
        // Who to call. LEFT JOIN so leads with no profile yet still count as cold.
        pool.query(`
            SELECT COALESCE(p.lead_temperature, 'cold') AS temperature, COUNT(*)::int AS count
              FROM leads l
              LEFT JOIN lead_profiles p ON p.lead_id = l.id
             GROUP BY 1
        `),

        // Demand the catalogue could not serve, newest first.
        pool.query(`
            SELECT e.created_at, e.metadata, l.phone, l.name
              FROM lead_events e
              JOIN leads l ON l.id = e.lead_id
             WHERE e.event_type = 'SEARCH_RETURNED_NOTHING'
             ORDER BY e.created_at DESC
             LIMIT 20
        `),

        // What people keep turning down. INNER JOIN drops events whose property
        // was since deleted (property_id is ON DELETE SET NULL) — a rejection
        // we can no longer attribute isn't actionable.
        pool.query(`
            SELECT p.id, p.type, p.neighbourhood, p.city, p.price,
                   COUNT(*)::int AS rejections
              FROM lead_events e
              JOIN properties p ON p.id = e.property_id
             WHERE e.event_type = 'PROPERTY_REJECTED'
             GROUP BY p.id, p.type, p.neighbourhood, p.city, p.price
             ORDER BY rejections DESC
             LIMIT 10
        `),

        pool.query(`
            SELECT COUNT(*)::int AS count
              FROM lead_events
             WHERE event_type = 'HANDOFF_TRIGGERED'
               AND created_at > now() - interval '7 days'
        `),

        // Of everyone who was shown a property, how many went on to book.
        //
        // Counting DISTINCT LEADS, not events: someone shown listings five
        // times is one opportunity, not five.
        //
        // `booked` is restricted to leads who ALSO have a PROPERTIES_SHOWN
        // event, so both figures describe the same cohort. Without that
        // restriction, appointments made before event tracking existed counted
        // as conversions with no corresponding "shown" — which produced the
        // nonsense of 3 bookings from 0 opportunities.
        pool.query(`
            WITH shown_leads AS (
                SELECT DISTINCT lead_id FROM lead_events WHERE event_type = 'PROPERTIES_SHOWN'
            )
            SELECT
                (SELECT COUNT(*)::int FROM shown_leads) AS shown,
                (SELECT COUNT(DISTINCT a.lead_id)::int
                   FROM appointments a
                   JOIN shown_leads s ON s.lead_id = a.lead_id) AS booked
        `),
    ]);

    const { shown, booked } = conversion.rows[0];

    return {
        temperature: temperature.rows,
        deadSearches: deadSearches.rows,
        mostRejected: rejected.rows,
        handoffsThisWeek: handoffs.rows[0].count,
        conversion: {
            shown,
            booked,
            // Guarded: no leads shown anything yet must read as 0%, not NaN.
            rate: shown > 0 ? Math.round((booked / shown) * 100) : 0,
        },
    };
};

const overview = async (req, res) => {
    try {
        res.json(await getOverview());
    } catch (error) {
        console.error('Error building analytics overview:', error);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
};

module.exports = { overview, getOverview };
