const pool = require('../db/index');
const { maskPhone } = require('../utils/format');

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
    const existing = await pool.query(
        'SELECT id, pending_action, pending_property_id, pending_listing_ids FROM leads WHERE phone = $1',
        [phone]
    );

    if (existing.rows.length > 0) {
        const row = existing.rows[0];
        await pool.query(
            'UPDATE leads SET language = $1, name = COALESCE(name, $2), last_message_at = now() WHERE id = $3',
            [language, name, row.id]
        );
        return {
            id: row.id,
            isNew: false,
            pendingAction: row.pending_action,
            pendingPropertyId: row.pending_property_id,
            pendingListingIds: row.pending_listing_ids || [],
        };
    }

    const inserted = await pool.query(
        'INSERT INTO leads (phone, name, language, last_message_at) VALUES ($1, $2, $3, now()) RETURNING id',
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
        'SELECT id, language, pending_action, pending_property_id, pending_listing_ids FROM leads WHERE phone = $1',
        [phone]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
        id: row.id,
        language: row.language,
        pendingAction: row.pending_action,
        pendingPropertyId: row.pending_property_id,
        pendingListingIds: row.pending_listing_ids || [],
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

// ── Booking-flow pending state ──
// A lead has at most one active pending flow. These three functions are the
// only place that state is written — set when a numbered list of listings
// was just offered for booking, set again once they've picked one (now
// awaiting a date/time), and cleared once the flow ends (booked or declined).
const setPendingViewingSelection = async (leadId, listingIds) => {
    await pool.query(
        'UPDATE leads SET pending_action = $1, pending_listing_ids = $2, pending_property_id = NULL WHERE id = $3',
        ['awaiting_viewing_selection', listingIds, leadId]
    );
};

const setPendingViewingDatetime = async (leadId, propertyId) => {
    await pool.query(
        'UPDATE leads SET pending_action = $1, pending_property_id = $2, pending_listing_ids = NULL WHERE id = $3',
        ['awaiting_viewing_datetime', propertyId, leadId]
    );
};

const clearPendingAction = async (leadId) => {
    await pool.query(
        'UPDATE leads SET pending_action = NULL, pending_property_id = NULL, pending_listing_ids = NULL WHERE id = $1',
        [leadId]
    );
};

// ── Dashboard read endpoints ──
// Never SELECT * — only the columns the dashboard needs. Phone is always
// masked before it leaves the backend (CLAUDE.md: never send a user's
// WhatsApp number to the frontend).
const LEAD_COLUMNS = 'id, phone, name, language, status, created_at, last_message_at';

// The ONE list of valid pipeline stages — backend enforcement lives here;
// the frontend mirrors these same 6 literal values in its status dropdown
// (a UI label list, not shared business logic, so it isn't imported across
// the frontend/backend boundary).
const VALID_STATUSES = ['new', 'contacted', 'qualified', 'site_visit', 'converted', 'lost'];

const listLeads = async () => {
    const result = await pool.query(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY last_message_at DESC`);
    return result.rows.map((row) => ({ ...row, phone: maskPhone(row.phone) }));
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
    const leadResult = await pool.query(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`, [id]);
    if (leadResult.rows.length === 0) return null;

    const lead = { ...leadResult.rows[0], phone: maskPhone(leadResult.rows[0].phone) };

    const conversations = await pool.query(
        'SELECT id, sender, message, created_at FROM conversations WHERE lead_id = $1 ORDER BY created_at ASC',
        [id]
    );

    const appointments = await pool.query(
        `SELECT a.id, a.requested_datetime_text, a.requested_datetime, a.status, a.created_at,
                p.id AS property_id, p.type, p.neighbourhood, p.city, p.price
         FROM appointments a JOIN properties p ON p.id = a.property_id
         WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [id]
    );

    return { lead, conversations: conversations.rows, appointments: appointments.rows };
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

module.exports = {
    getOrCreateLead,
    getLeadState,
    saveConversationMessage,
    setPendingViewingSelection,
    setPendingViewingDatetime,
    clearPendingAction,
    list,
    getById,
    updateStatus,
    VALID_STATUSES,
};
