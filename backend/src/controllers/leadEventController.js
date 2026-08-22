const pool = require('../db/index');

// ── lead_events: the behavioural record ──
//
// The conversation transcript says what was SAID. This says what HAPPENED, in
// a shape you can aggregate: which properties get rejected most, how often a
// search comes back empty, how many leads reach a booking. Those are questions
// about patterns across leads, and prose cannot answer them.
//
// This file owns the table. Nothing else writes to lead_events.

// The one list of event types. Kept as a constant rather than a DB CHECK
// because event vocabulary grows as the bot learns to notice more things, and
// a migration per new event type would discourage recording them at all — the
// opposite of what this table is for.
const EVENT_TYPES = {
    SEARCH_PERFORMED: 'SEARCH_PERFORMED',
    SEARCH_RETURNED_NOTHING: 'SEARCH_RETURNED_NOTHING',
    PROPERTIES_SHOWN: 'PROPERTIES_SHOWN',
    PROPERTY_LIKED: 'PROPERTY_LIKED',
    PROPERTY_REJECTED: 'PROPERTY_REJECTED',
    PROPERTIES_COMPARED: 'PROPERTIES_COMPARED',
    MEDIA_REQUESTED: 'MEDIA_REQUESTED',
    SITE_VISIT_REQUESTED: 'SITE_VISIT_REQUESTED',
    SITE_VISIT_BOOKED: 'SITE_VISIT_BOOKED',
    BOOKING_DECLINED: 'BOOKING_DECLINED',
    HANDOFF_TRIGGERED: 'HANDOFF_TRIGGERED',
    BECAME_HOT: 'BECAME_HOT',
};

// ── recordEvent(leadId, eventType, { propertyId, metadata }) ──
// Best-effort by design: analytics must never be the reason a lead doesn't get
// a reply. A failure here is logged and swallowed rather than propagated into
// the message path.
const recordEvent = async (leadId, eventType, { propertyId = null, metadata = {} } = {}, client = pool) => {
    if (!leadId || !eventType) return;
    try {
        await client.query(
            'INSERT INTO lead_events (lead_id, event_type, property_id, metadata) VALUES ($1, $2, $3, $4)',
            [leadId, eventType, propertyId, metadata]
        );
    } catch (error) {
        console.error(`Failed to record lead event ${eventType}:`, error.message);
    }
};

// ── getEventsForLead(leadId, limit) ──
// The lead-detail timeline. Joins the property so the UI can say "rejected the
// villa in Bè" instead of "rejected #7" — LEFT JOIN because property_id is
// ON DELETE SET NULL and the event outlives the listing.
const getEventsForLead = async (leadId, limit = 50) => {
    const result = await pool.query(
        `SELECT e.id, e.event_type, e.property_id, e.metadata, e.created_at,
                p.type AS property_type, p.neighbourhood, p.city
           FROM lead_events e
           LEFT JOIN properties p ON p.id = e.property_id
          WHERE e.lead_id = $1
          ORDER BY e.created_at DESC
          LIMIT $2`,
        [leadId, limit]
    );
    return result.rows;
};

module.exports = { recordEvent, getEventsForLead, EVENT_TYPES };
