const pool = require('../db/index');
const { scoreLead } = require('../utils/leadScoring');
const { recordEvent, EVENT_TYPES } = require('./leadEventController');
const { createNotification } = require('./notificationController');
const { advanceLeadStatus } = require('./leadController');

// ── lead_profiles: what the bot KNOWS about a lead ──
//
// Before this existed the bot was stateless per message: extractSearchFilters
// produced a filter set, it was used for one search, and it was discarded. The
// only cross-turn memory was an instruction telling the model to re-read the
// last 10 transcript rows and repeat anything it found. That meant a
// requirement stated six exchanges ago was gone permanently, and nothing a
// lead ever said could be queried offline.
//
// This file owns that table. Nothing else writes to lead_profiles.

// The scalar fields that participate in the three-state merge below. Array and
// JSONB fields are append-style and have their own functions — merging them by
// replacement would throw away history on every turn.
const MERGEABLE_FIELDS = [
    'transaction',
    'property_type',
    'city',
    'neighbourhood',
    'bedrooms_min',
    'bedrooms_max',
    'budget_max',
    'budget_stretch_max',
    'purpose',
    'timeline',
    'last_objection',
];

const PROFILE_COLUMNS = `
    lead_id, transaction, property_type, city, neighbourhood,
    bedrooms_min, bedrooms_max, budget_max, budget_stretch_max,
    purpose, timeline, last_objection,
    liked_property_ids, rejected_property_ids, rejection_reasons,
    last_properties_shown, conversation_summary,
    lead_score, lead_temperature, needs_human, handoff_reason, handoff_at,
    updated_at
`;

// ── getProfile(leadId) ──
// Returns the stored profile, or null if this lead has never had one written.
// Callers must tolerate null — a brand-new lead has no profile until their
// first message produces something worth remembering.
const getProfile = async (leadId) => {
    const result = await pool.query(
        `SELECT ${PROFILE_COLUMNS} FROM lead_profiles WHERE lead_id = $1`,
        [leadId]
    );
    return result.rows[0] || null;
};

// ── mergeProfile(leadId, { deltas, clearedFields }) ──
// THE merge. Every field has three possible states each turn, and conflating
// any two of them produces a bot that is subtly, persistently wrong:
//
//   1. Not mentioned      -> keep whatever we already knew.
//   2. Mentioned          -> overwrite with the new value.
//   3. Explicitly retracted -> set back to NULL.
//
// A naive spread implements only (2) and wipes the profile every turn. Ignoring
// nulls implements only (1) and (2), turning the profile into a ratchet: a lead
// who says "forget the budget, show me anything" keeps their old budget_max
// forever, and every later search silently excludes exactly what they just
// asked to see. State (3) is why the NLU reports `cleared_fields` separately
// instead of just sending null — in JSON, "not mentioned" and "cleared" are
// the same value, so the distinction has to be carried out of band.
//
// `client` lets this join a caller's transaction (see pool.withTransaction).
const mergeProfile = async (leadId, { deltas = {}, clearedFields = [] } = {}, client = pool) => {
    const updates = {};
    for (const field of MERGEABLE_FIELDS) {
        if (clearedFields.includes(field)) {
            updates[field] = null;                    // (3) explicitly retracted
        } else if (deltas[field] !== undefined && deltas[field] !== null) {
            updates[field] = deltas[field];           // (2) newly stated
        }
        // (1) absent from `updates` entirely -> the UPSERT below never names
        // the column, so an existing row keeps its current value.
    }

    const fields = Object.keys(updates);
    if (fields.length === 0) {
        // Nothing to merge, but the row must exist so later appends and reads
        // have something to work with.
        await client.query(
            'INSERT INTO lead_profiles (lead_id) VALUES ($1) ON CONFLICT (lead_id) DO NOTHING',
            [leadId]
        );
        return;
    }

    // Only the changed columns are named, so ON CONFLICT DO UPDATE leaves every
    // other column exactly as it was — that is what makes state (1) work.
    const values = [leadId, ...fields.map((f) => updates[f])];
    const placeholders = fields.map((_, i) => `$${i + 2}`);
    const assignments = fields.map((f) => `${f} = EXCLUDED.${f}`);

    await client.query(
        `INSERT INTO lead_profiles (lead_id, ${fields.join(', ')})
         VALUES ($1, ${placeholders.join(', ')})
         ON CONFLICT (lead_id) DO UPDATE SET ${assignments.join(', ')}, updated_at = now()`,
        values
    );
};

// ── recordShownListings(leadId, propertyIds) ──
// Replaces (not appends) — this is "what is on their screen right now", which
// is what makes "the second one" resolvable next turn.
const recordShownListings = async (leadId, propertyIds, client = pool) => {
    await client.query(
        `INSERT INTO lead_profiles (lead_id, last_properties_shown)
         VALUES ($1, $2)
         ON CONFLICT (lead_id) DO UPDATE SET last_properties_shown = EXCLUDED.last_properties_shown, updated_at = now()`,
        [leadId, propertyIds]
    );
};

// ── recordInterest(leadId, propertyId, { liked }) ──
// Appends to liked_property_ids or rejected_property_ids, de-duplicated.
// A property can move between the two lists (someone can warm up to a place
// they first dismissed), so adding to one always removes it from the other —
// otherwise it would sit in both and the ranking layer could not tell what the
// lead currently thinks.
const recordInterest = async (leadId, propertyId, { liked }, client = pool) => {
    if (!Number.isInteger(propertyId)) return;
    const [addTo, removeFrom] = liked
        ? ['liked_property_ids', 'rejected_property_ids']
        : ['rejected_property_ids', 'liked_property_ids'];

    await client.query(
        `INSERT INTO lead_profiles (lead_id, ${addTo})
         VALUES ($1, ARRAY[$2]::integer[])
         ON CONFLICT (lead_id) DO UPDATE SET
            ${addTo} = (
                SELECT ARRAY(SELECT DISTINCT unnest(array_append(lead_profiles.${addTo}, $2)))
            ),
            ${removeFrom} = array_remove(lead_profiles.${removeFrom}, $2),
            updated_at = now()`,
        [leadId, propertyId]
    );
};

// ── recordRejectionReason(leadId, propertyId, reason) ──
// Why a listing was turned down ("too expensive", "wrong area"). Stored per
// property so the pattern is visible — three price rejections in a row says
// something a single one does not.
const recordRejectionReason = async (leadId, propertyId, reason, client = pool) => {
    if (!reason) return;
    await client.query(
        `INSERT INTO lead_profiles (lead_id, rejection_reasons)
         VALUES ($1, jsonb_build_object($2::text, $3::text))
         ON CONFLICT (lead_id) DO UPDATE SET
            rejection_reasons = lead_profiles.rejection_reasons || jsonb_build_object($2::text, $3::text),
            updated_at = now()`,
        [leadId, String(propertyId), reason]
    );
};

// ── updateSummary(leadId, summary) ──
// Long-term memory: the gist of everything older than the raw transcript
// window. Deliberately NOT authoritative — the recent transcript wins on
// conflict, because a summary written six turns ago can still describe a
// preference the lead has since retracted.
const updateSummary = async (leadId, summary, client = pool) => {
    if (!summary) return;
    await client.query(
        `INSERT INTO lead_profiles (lead_id, conversation_summary)
         VALUES ($1, $2)
         ON CONFLICT (lead_id) DO UPDATE SET conversation_summary = EXCLUDED.conversation_summary, updated_at = now()`,
        [leadId, summary]
    );
};

// ── profileToSearchFilters(profile) ──
// The profile IS the search. Turning it into the filter shape
// searchPropertiesWithFallback expects is the whole reason it is stored
// structurally rather than as prose.
const profileToSearchFilters = (profile) => {
    if (!profile) return {};

    // An exact bedroom count only when they named one. "2 or 3 bedrooms" spans
    // a range that `bedrooms = $n` cannot express, so rather than silently
    // picking one end (and hiding half of what they asked for) leave it open
    // and let the other filters narrow it. Phase 4's soft matching handles
    // ranges properly.
    const bedrooms = (profile.bedrooms_min !== null && profile.bedrooms_min === profile.bedrooms_max)
        ? profile.bedrooms_min
        : null;

    return {
        city: profile.city,
        neighbourhood: profile.neighbourhood,
        type: profile.property_type,
        transaction: profile.transaction,
        bedrooms,
        // A stated stretch is an ABSOLUTE ceiling — they have already told us
        // the most they would pay, so it goes in as price_ceiling and skips
        // the 10% tolerance buildQuery adds to price_max. Applying both would
        // push results past a number they explicitly named as their limit.
        price_ceiling: profile.budget_stretch_max || null,
        price_max: profile.budget_stretch_max ? null : profile.budget_max,
    };
};

// ── flagForHuman(leadId, reason) ──
// The bot deciding it should stop. Sets the flag, records the event, and raises
// a notification so a person actually finds out — before this, a lead could ask
// to speak to someone and nothing whatsoever would reach the agency.
//
// needs_human stays true until an admin clears it: the lead's situation has not
// resolved just because they sent another message.
const flagForHuman = async (leadId, reason, { leadName, leadPhone } = {}) => {
    await pool.query(
        `INSERT INTO lead_profiles (lead_id, needs_human, handoff_reason, handoff_at)
         VALUES ($1, true, $2, now())
         ON CONFLICT (lead_id) DO UPDATE SET
            needs_human = true, handoff_reason = EXCLUDED.handoff_reason,
            handoff_at = now(), updated_at = now()`,
        [leadId, reason]
    );
    await recordEvent(leadId, EVENT_TYPES.HANDOFF_TRIGGERED, { metadata: { reason } });
    await createNotification({
        leadId,
        type: 'needs_human',
        title: `${leadName || leadPhone || 'A lead'} needs a person`,
        // The reason travels as machine-readable metadata, not prose: the
        // dashboard has an FR/EN toggle, and a sentence baked in at write time
        // would be stuck in whichever language happened to be chosen then.
        metadata: { reason },
        // Short window: if they ask again hours later that IS worth re-raising.
        dedupeWindowHours: 6,
    });
};

// ── refreshLeadSignals(leadId, { leadName, leadPhone }) ──
// Recomputes everything derived from the profile after a turn: the score, the
// temperature band, and the pipeline status. Called once per message, after the
// profile has been merged.
//
// Best-effort throughout — none of this is worth failing a reply over.
const refreshLeadSignals = async (leadId, { leadName, leadPhone } = {}) => {
    try {
        const profile = await getProfile(leadId);
        if (!profile) return null;

        const counters = await pool.query(
            `SELECT
                (SELECT COUNT(*)::int FROM appointments WHERE lead_id = $1) AS appointment_count,
                (SELECT COUNT(*)::int FROM conversations WHERE lead_id = $1 AND sender = 'user') AS message_count`,
            [leadId]
        );
        const { appointment_count: appointmentCount, message_count: messageCount } = counters.rows[0];

        const { score, temperature } = scoreLead(profile, { appointmentCount, messageCount });
        const previousTemperature = profile.lead_temperature;

        await pool.query(
            `UPDATE lead_profiles SET lead_score = $1, lead_temperature = $2, updated_at = now() WHERE lead_id = $3`,
            [score, temperature, leadId]
        );

        // Notify on the TRANSITION into hot, not on being hot — otherwise every
        // subsequent message from an engaged lead re-raises the same alert and
        // the bell becomes noise.
        if (temperature === 'hot' && previousTemperature !== 'hot') {
            await recordEvent(leadId, EVENT_TYPES.BECAME_HOT, { metadata: { score } });
            await createNotification({
                leadId,
                type: 'hot_lead',
                title: `${leadName || leadPhone || 'A lead'} is now a hot lead`,
                detail: `Score ${score}/100 — strong buying signals. Worth calling while they're engaged.`,
            });
        }

        // Pipeline position, derived rather than typed. Forward-only, and
        // never overriding a human's 'converted'/'lost' — see advanceLeadStatus.
        if (appointmentCount > 0) {
            await advanceLeadStatus(leadId, 'site_visit');
        } else if (temperature === 'hot' || temperature === 'warm') {
            await advanceLeadStatus(leadId, 'qualified');
        } else {
            await advanceLeadStatus(leadId, 'contacted');
        }

        return { score, temperature };
    } catch (error) {
        console.error('Failed to refresh lead signals:', error.message);
        return null;
    }
};

module.exports = {
    getProfile,
    mergeProfile,
    flagForHuman,
    refreshLeadSignals,
    recordShownListings,
    recordInterest,
    recordRejectionReason,
    updateSummary,
    profileToSearchFilters,
    MERGEABLE_FIELDS,
};
