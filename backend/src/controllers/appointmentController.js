const pool = require('../db/index');
const { maskPhone } = require('../utils/format');

// ── createAppointment ──
// The ONE place an appointment gets created. Used by the bot now; the
// dashboard's booking calendar (Step 8) will read from this same table.
const createAppointment = async ({ leadId, propertyId, requestedText, requestedDatetime }) => {
    const result = await pool.query(
        `INSERT INTO appointments (lead_id, property_id, requested_datetime_text, requested_datetime)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [leadId, propertyId, requestedText, requestedDatetime]
    );
    return result.rows[0].id;
};

// ── list(req, res) ──
// Dashboard's appointments list — joins in lead (masked phone) and property
// details so the page doesn't need separate round-trips.
const list = async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.id, a.requested_datetime_text, a.requested_datetime, a.status, a.created_at,
                   l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
                   p.id AS property_id, p.type, p.neighbourhood, p.city, p.price
            FROM appointments a
            JOIN leads l ON l.id = a.lead_id
            JOIN properties p ON p.id = a.property_id
            ORDER BY a.created_at DESC
        `);
        const appointments = result.rows.map((row) => ({ ...row, lead_phone: maskPhone(row.lead_phone) }));
        res.json({ appointments });
    } catch (error) {
        console.error('Error listing appointments:', error);
        res.status(500).json({ error: 'Failed to list appointments' });
    }
};

module.exports = { createAppointment, list };
