const pool = require('../db/index');
const { getEventsForLead } = require('./leadEventController');

// A booking conversation that has gone cold is worse than no booking
// conversation: without an expiry, a lead who stops replying while being asked
// for a date stays parked in 'awaiting_viewing_datetime' indefinitely, and
// their "bonjour" three days later gets read as a viewing time for a property
// they have long since forgotten. 24 hours mirrors WhatsApp's own session
// window — past that, treat them as starting fresh.
//
// Applied identically in getOrCreateLead and getLeadState; they must agree.
const PENDING_STATE_TTL_HOURS = 24;

// ── getOrCreateLead(phone, name, language) ──
// The ONE place a lead is looked up or created. Returns
// { id, isNew, pendingAction, pendingPropertyId, pendingListingIds } so the
// caller (the bot) can decide whether to send the first-contact welcome and
// whether this reply is answering an in-progress booking flow.
// Updates language on every call, per CLAUDE.md ("language field is stored
// on the leads table and updated every message"). Never overwrites a known
// name with a missing one (COALESCE keeps the existing name if the new
// value is null — WhatsApp doesn't always include a profile name).
const getOrCreateLead = async (phone, name, language) => {
    // The expiry check MUST match getLeadState's. Routing reads pendingAction
    // from here while the decision to skip the general NLU reads it from
    // getLeadState — if only one of them expired stale state, the bot would
    // run a fresh search AND still route the reply into the booking handler.
    const existing = await pool.query(
        `SELECT id, pending_action, pending_property_id, pending_listing_ids,
                (pending_set_at IS NOT NULL AND pending_set_at < now() - ($2 || ' hours')::interval) AS pending_expired
           FROM leads WHERE phone = $1`,
        [phone, String(PENDING_STATE_TTL_HOURS)]
    );

    if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const expired = row.pending_expired === true;
        // COALESCE on language too: callers pass null when the inbound message
        // carries NO reliable language signal (an image, a sticker, a bare
        // "ok"). Without this, one image would overwrite a known-English lead
        // back to the default and flip the whole conversation to French.
        await pool.query(
            'UPDATE leads SET language = COALESCE($1, language), name = COALESCE(name, $2), last_message_at = now() WHERE id = $3',
            [language, name, row.id]
        );
        return {
            id: row.id,
            isNew: false,
            pendingAction: expired ? null : row.pending_action,
            pendingPropertyId: expired ? null : row.pending_property_id,
            pendingListingIds: expired ? [] : (row.pending_listing_ids || []),
        };
    }

    // language is NOT NULL — a brand-new lead whose very first message carries
    // no language signal (an image) falls back to the column default.
    const inserted = await pool.query(
        "INSERT INTO leads (phone, name, language, last_message_at) VALUES ($1, $2, COALESCE($3, 'fr'), now()) RETURNING id",
        [phone, name, language]
    );
    return {
        id: inserted.rows[0].id,
        isNew: true,
        pendingAction: null,
        pendingPropertyId: null,
        pendingListingIds: [],
    };
};

// ── getLeadState(phone) ──
// Read-only lookup — used to decide whether to trust the lead's already-known
// language rather than re-detecting it from a short pending-flow reply
// ("1", "oui") that isn't a reliable language signal on its own. Returns
// null if this phone number has never contacted us.
const getLeadState = async (phone) => {
    const result = await pool.query(
        `SELECT id, language, pending_action, pending_property_id, pending_listing_ids,
                pending_set_at,
                (pending_set_at IS NOT NULL AND pending_set_at < now() - ($2 || ' hours')::interval) AS pending_expired
           FROM leads WHERE phone = $1`,
        [phone, String(PENDING_STATE_TTL_HOURS)]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    // Expired state is reported as absent rather than deleted here: this is a
    // read path, and a stale flag does no harm sitting in the row. The next
    // search or booking step overwrites it anyway.
    const expired = row.pending_expired === true;

    return {
        id: row.id,
        language: row.language,
        pendingAction: expired ? null : row.pending_action,
        pendingPropertyId: expired ? null : row.pending_property_id,
        pendingListingIds: expired ? [] : (row.pending_listing_ids || []),
        pendingExpired: expired,
    };
};

// ── saveConversationMessage(leadId, sender, message) ──
// The ONE place a conversation turn is written. sender is 'user' or 'bot'.
const saveConversationMessage = async (leadId, sender, message) => {
    await pool.query(
        'INSERT INTO conversations (lead_id, sender, message) VALUES ($1, $2, $3)',
        [leadId, sender, message]
    );
};

// ── getRecentConversation(leadId, limit) ──
// The bot's short-term memory. The transcript has always been written here;
// nothing read it back, which is why the bot re-greeted people mid-chat and
// forgot what they'd already told it.
//
// Media placeholders ("[photo sent: https://...]") are filtered out — they're
// bookkeeping for the dashboard, not conversation, and the URLs would burn a
// lot of tokens for no benefit. Returned oldest-first, ready to feed a prompt.
const getRecentConversation = async (leadId, limit = 10) => {
    const result = await pool.query(
        `SELECT sender, message FROM conversations
         WHERE lead_id = $1 AND message NOT LIKE '[%sent:%'
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [leadId, limit]
    );
    return result.rows.reverse();
};

// ── Booking-flow pending state ──
// A lead has at most one active pending flow. These three functions are the
// only place that state is written — set when a numbered list of listings
// was just offered for booking, set again once they've picked one (now
// awaiting a date/time), and cleared once the flow ends (booked or declined).
// pending_set_at is stamped on every transition, not just the first — each step
// of the booking flow restarts the clock, so an active back-and-forth never
// expires mid-conversation (see PENDING_STATE_TTL_HOURS above).
const setPendingViewingSelection = async (leadId, listingIds) => {
    await pool.query(
        'UPDATE leads SET pending_action = $1, pending_listing_ids = $2, pending_property_id = NULL, pending_set_at = now() WHERE id = $3',
        ['awaiting_viewing_selection', listingIds, leadId]
    );
};

const setPendingViewingDatetime = async (leadId, propertyId) => {
    await pool.query(
        'UPDATE leads SET pending_action = $1, pending_property_id = $2, pending_listing_ids = NULL, pending_set_at = now() WHERE id = $3',
        ['awaiting_viewing_datetime', propertyId, leadId]
    );
};

// ── advanceLeadStatus(leadId, target) ──
// The bot moving a lead along the pipeline. Two hard rules, both about not
// fighting the human using the dashboard:
//
//   1. FORWARD ONLY. An admin who has already marked someone 'qualified' must
//      not watch the bot drag them back to 'contacted' on their next message.
//   2. 'converted' and 'lost' are ABSORBING — they are human judgements about
//      an outcome the bot cannot observe. Once set, the bot never overrides
//      them. Without this, an admin marking a lead 'lost' would see it silently
//      reappear in their active pipeline the next time that person said hello.
//
// Returns the status actually in effect, so callers can tell whether they moved.
const STATUS_LADDER = ['new', 'contacted', 'qualified', 'site_visit', 'converted'];
const ABSORBING_STATUSES = ['converted', 'lost'];

const advanceLeadStatus = async (leadId, target, client = pool) => {
    const targetRank = STATUS_LADDER.indexOf(target);
    if (targetRank === -1) return null;

    const current = await client.query('SELECT status FROM leads WHERE id = $1', [leadId]);
    if (current.rows.length === 0) return null;
    const currentStatus = current.rows[0].status;

    if (ABSORBING_STATUSES.includes(currentStatus)) return currentStatus;
    const currentRank = STATUS_LADDER.indexOf(currentStatus);
    if (currentRank >= targetRank) return currentStatus;

    await client.query('UPDATE leads SET status = $1 WHERE id = $2', [target, leadId]);
    return target;
};

// `client` lets this join a caller's transaction (see pool.withTransaction) —
// clearing the flow after createAppointment must be atomic with it.
const clearPendingAction = async (leadId, client = pool) => {
    await client.query(
        'UPDATE leads SET pending_action = NULL, pending_property_id = NULL, pending_listing_ids = NULL, pending_set_at = NULL WHERE id = $1',
        [leadId]
    );
};

// ── Dashboard read endpoints ──
// Never SELECT * — only the columns the dashboard needs. Phone is sent
// UNMASKED (client decision, overriding the earlier masking rule — the admin
// needs the real number to actually call leads back; see CLAUDE.md).
const LEAD_COLUMNS = 'id, phone, name, language, status, notes, created_at, last_message_at';

// Scoring lives on lead_profiles, so the dashboard's lead views LEFT JOIN it —
// LEFT because a lead who has only ever said "hi" has no profile row yet, and
// they must still appear in the list. COALESCE gives those rows the same
// defaults the column would have, so the frontend never has to special-case a
// missing profile.
const LEAD_PROFILE_JOIN = `
    LEFT JOIN lead_profiles pr ON pr.lead_id = l.id
`;
const LEAD_PROFILE_COLUMNS = `
    COALESCE(pr.lead_score, 0) AS lead_score,
    COALESCE(pr.lead_temperature, 'cold') AS lead_temperature,
    COALESCE(pr.needs_human, false) AS needs_human,
    pr.handoff_reason
`;

// The ONE list of valid pipeline stages — backend enforcement lives here;
// the frontend mirrors these same 6 literal values in its status dropdown
// (a UI label list, not shared business logic, so it isn't imported across
// the frontend/backend boundary).
const VALID_STATUSES = ['new', 'contacted', 'qualified', 'site_visit', 'converted', 'lost'];

const listLeads = async () => {
    const result = await pool.query(
        `SELECT ${LEAD_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ')}, ${LEAD_PROFILE_COLUMNS}
           FROM leads l ${LEAD_PROFILE_JOIN}
          ORDER BY l.last_message_at DESC`
    );
    return result.rows;
};

const list = async (req, res) => {
    try {
        const leads = await listLeads();
        res.json({ leads });
    } catch (error) {
        console.error('Error listing leads:', error);
        res.status(500).json({ error: 'Failed to list leads' });
    }
};

const getLeadWithConversation = async (id) => {
    const leadResult = await pool.query(
        `SELECT ${LEAD_COLUMNS.split(', ').map((c) => `l.${c}`).join(', ')}, ${LEAD_PROFILE_COLUMNS}
           FROM leads l ${LEAD_PROFILE_JOIN}
          WHERE l.id = $1`,
        [id]
    );
    if (leadResult.rows.length === 0) return null;

    const lead = leadResult.rows[0];

    const conversations = await pool.query(
        'SELECT id, sender, message, created_at FROM conversations WHERE lead_id = $1 ORDER BY created_at ASC',
        [id]
    );

    const appointments = await pool.query(
        `SELECT a.id, a.requested_datetime_text, a.requested_datetime,
                -- as text, not DATE — see the note in appointmentController.js
                to_char(a.requested_date, 'YYYY-MM-DD') AS requested_date,
                a.requested_time_of_day, a.status, a.created_at,
                p.id AS property_id, p.type, p.neighbourhood, p.city, p.price
         FROM appointments a JOIN properties p ON p.id = a.property_id
         WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [id]
    );

    // What the bot has learned about them, and what it saw them do. Added as
    // NEW top-level keys rather than folded into `lead` — the detail page polls
    // this every 5s with careful merge logic around the admin's local-only
    // sent replies, so changing the existing shape risks breaking that.
    const profile = await pool.query(
        `SELECT transaction, property_type, city, neighbourhood,
                bedrooms_min, bedrooms_max, budget_max, budget_stretch_max,
                purpose, timeline, liked_property_ids, rejected_property_ids,
                rejection_reasons, lead_score, lead_temperature,
                needs_human, handoff_reason, handoff_at, updated_at
           FROM lead_profiles WHERE lead_id = $1`,
        [id]
    );

    const events = await getEventsForLead(id, 30);

    return {
        lead,
        conversations: conversations.rows,
        appointments: appointments.rows,
        // null for a lead who has only ever said "hi" — the UI must handle it.
        profile: profile.rows[0] || null,
        events,
    };
};

const getById = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid lead id' });
    }

    try {
        const result = await getLeadWithConversation(id);
        if (!result) {
            return res.status(404).json({ error: 'Lead not found' });
        }
        res.json(result);
    } catch (error) {
        console.error('Error fetching lead:', error);
        res.status(500).json({ error: 'Failed to fetch lead' });
    }
};

// ── updateLeadStatus(id, status) ──
// The ONE place a lead's pipeline stage is written.
const updateLeadStatus = async (id, status) => {
    const result = await pool.query(
        'UPDATE leads SET status = $1 WHERE id = $2 RETURNING id, status',
        [status, id]
    );
    return result.rows[0] || null;
};

const updateStatus = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid lead id' });
    }

    const { status } = req.body || {};
    if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    try {
        const updated = await updateLeadStatus(id, status);
        if (!updated) {
            return res.status(404).json({ error: 'Lead not found' });
        }
        res.json({ lead: updated });
    } catch (error) {
        console.error('Error updating lead status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
};

// ── updateLeadNotes(id, notes) ──
// The ONE place a lead's admin notes get written. Separate endpoint from
// status, mirroring that same thin pattern — notes are free text, not a
// constrained enum, so there's no VALID_* list to check against.
const updateLeadNotes = async (id, notes) => {
    const result = await pool.query(
        'UPDATE leads SET notes = $1 WHERE id = $2 RETURNING id, notes',
        [notes, id]
    );
    return result.rows[0] || null;
};

const updateNotes = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid lead id' });
    }

    const { notes } = req.body || {};
    if (notes !== null && typeof notes !== 'string') {
        return res.status(400).json({ error: 'notes must be a string or null' });
    }

    try {
        const updated = await updateLeadNotes(id, notes);
        if (!updated) {
            return res.status(404).json({ error: 'Lead not found' });
        }
        res.json({ lead: updated });
    } catch (error) {
        console.error('Error updating lead notes:', error);
        res.status(500).json({ error: 'Failed to update notes' });
    }
};

// ── sendReply(id, message) ──
// Admin-typed WhatsApp reply, sent from the dashboard's lead detail page.
// Looks up the RAW (unmasked) phone directly — this is the one place that's
// allowed, since it's used server-side only and never returned in the
// response (CLAUDE.md: never send a user's WhatsApp number to the frontend).
// sendWhatsAppMessage is required lazily here, not at module top, to avoid a
// require cycle: webhookController.js already requires this file.
const sendReply = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid lead id' });
    }

    const { message } = req.body || {};
    if (typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: 'message is required' });
    }

    try {
        const result = await pool.query('SELECT phone FROM leads WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lead not found' });
        }

        const { sendWhatsAppMessage } = require('./webhookController');
        const sent = await sendWhatsAppMessage(result.rows[0].phone, message.trim());
        if (!sent) {
            return res.status(502).json({ error: 'Failed to send WhatsApp message' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error sending lead reply:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
};

module.exports = {
    getOrCreateLead,
    getLeadState,
    saveConversationMessage,
    getRecentConversation,
    setPendingViewingSelection,
    setPendingViewingDatetime,
    clearPendingAction,
    list,
    getById,
    updateStatus,
    updateNotes,
    sendReply,
    advanceLeadStatus,
    VALID_STATUSES,
    STATUS_LADDER,
    ABSORBING_STATUSES,
    PENDING_STATE_TTL_HOURS,
};
