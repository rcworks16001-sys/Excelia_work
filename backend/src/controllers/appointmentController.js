const pool = require('../db/index');

// The ONE list of valid appointment statuses — matches the DB CHECK
// constraint on appointments.status in migrate.js.
const VALID_APPOINTMENT_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];

// ── createAppointment ──
// The ONE place an appointment gets created. Used by the bot now; the
// dashboard's booking calendar (Step 8) will read from this same table.
//
// `client` lets the caller run this inside an existing transaction (see
// pool.withTransaction) — booking an appointment and clearing the lead's
// pending state must both land or neither, or a crash between them leaves a
// booked viewing with the lead still stuck being asked for a date.
const createAppointment = async ({
    leadId,
    propertyId,
    requestedText,
    requestedDatetime,
    requestedDate = null,
    requestedTimeOfDay = null,
    client = pool,
}) => {
    const result = await client.query(
        `INSERT INTO appointments
            (lead_id, property_id, requested_datetime_text, requested_datetime, requested_date, requested_time_of_day)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [leadId, propertyId, requestedText, requestedDatetime, requestedDate, requestedTimeOfDay]
    );
    return result.rows[0].id;
};

// ── list(req, res) ──
// Dashboard's appointments list — joins in lead (masked phone) and property
// details so the page doesn't need separate round-trips.
const list = async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.id, a.requested_datetime_text, a.requested_datetime,
                   -- as text, NOT a DATE: node-postgres would parse a bare DATE
                   -- into a JS Date at the SERVER's local midnight, which then
                   -- shifts a day when the UI renders it in Togo time. A
                   -- calendar day has no timezone — keep it a plain string.
                   to_char(a.requested_date, 'YYYY-MM-DD') AS requested_date,
                   a.requested_time_of_day, a.status, a.created_at,
                   l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
                   p.id AS property_id, p.type, p.neighbourhood, p.city, p.price
            FROM appointments a
            JOIN leads l ON l.id = a.lead_id
            JOIN properties p ON p.id = a.property_id
            ORDER BY a.created_at DESC
        `);
        // lead_phone sent unmasked — client decision, admin needs the real
        // number to call leads back (see CLAUDE.md).
        res.json({ appointments: result.rows });
    } catch (error) {
        console.error('Error listing appointments:', error);
        res.status(500).json({ error: 'Failed to list appointments' });
    }
};

// ── updateAppointmentStatus(id, status) ──
// The ONE place an appointment's status is written.
const updateAppointmentStatus = async (id, status) => {
    const result = await pool.query(
        'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status',
        [status, id]
    );
    return result.rows[0] || null;
};

const updateStatus = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid appointment id' });
    }

    const { status } = req.body || {};
    if (!VALID_APPOINTMENT_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` });
    }

    try {
        const updated = await updateAppointmentStatus(id, status);
        if (!updated) {
            return res.status(404).json({ error: 'Appointment not found' });
        }
        res.json({ appointment: updated });
    } catch (error) {
        console.error('Error updating appointment status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
};

module.exports = { createAppointment, list, updateStatus, VALID_APPOINTMENT_STATUSES };
