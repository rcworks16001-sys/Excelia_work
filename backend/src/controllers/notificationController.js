const pool = require('../db/index');

// ── notifications: the dashboard's bell ──
//
// Before this, nothing told the agency anything. A lead could ask for a human,
// book a viewing and go cold again without a single signal reaching a person —
// you only found out by happening to open the right page.
//
// Stored rather than derived on read, for two reasons: a notification is a
// point-in-time fact ("this lead turned hot on Tuesday") that has to survive
// the underlying state changing afterwards, and read/unread is per-notification
// state with nowhere else to live.

const VALID_TYPES = ['needs_human', 'hot_lead', 'appointment_booked'];

const NOTIFICATION_COLUMNS = `
    n.id, n.lead_id, n.type, n.title, n.detail, n.metadata, n.read_at, n.created_at
`;

// ── createNotification({ leadId, type, title, detail, metadata, dedupeWindowHours }) ──
// Best-effort: a failure here must never stop a lead getting their reply.
//
// dedupeWindowHours guards against the bell filling up with the same fact. A
// lead who stays hot across ten messages is hot ONCE — without this, every
// subsequent turn would re-notify and the badge would become noise nobody
// reads, which is the usual way notification systems die.
const createNotification = async ({
    leadId, type, title, detail = null, metadata = {}, dedupeWindowHours = 24,
}, client = pool) => {
    if (!leadId || !VALID_TYPES.includes(type)) return null;
    try {
        if (dedupeWindowHours) {
            const existing = await client.query(
                `SELECT id FROM notifications
                  WHERE lead_id = $1 AND type = $2
                    AND created_at > now() - ($3 || ' hours')::interval
                  LIMIT 1`,
                [leadId, type, String(dedupeWindowHours)]
            );
            if (existing.rows.length > 0) return null;
        }

        const result = await client.query(
            `INSERT INTO notifications (lead_id, type, title, detail, metadata)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [leadId, type, title, detail, metadata]
        );
        return result.rows[0].id;
    } catch (error) {
        console.error(`Failed to create ${type} notification:`, error.message);
        return null;
    }
};

// ── list(req, res) ──
// The bell's payload: recent notifications plus the unread count that drives
// the badge. Unread first so the things needing action are never buried under
// older read items, then newest first within each group.
const list = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
        const result = await pool.query(
            `SELECT ${NOTIFICATION_COLUMNS},
                    l.name AS lead_name, l.phone AS lead_phone
               FROM notifications n
               JOIN leads l ON l.id = n.lead_id
              ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC
              LIMIT $1`,
            [limit]
        );
        const unread = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE read_at IS NULL');
        res.json({ notifications: result.rows, unreadCount: unread.rows[0].n });
    } catch (error) {
        console.error('Error listing notifications:', error);
        res.status(500).json({ error: 'Failed to load notifications' });
    }
};

// ── markRead(req, res) ──
const markRead = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid notification id' });
    }
    try {
        const result = await pool.query(
            'UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL RETURNING id',
            [id]
        );
        // Already-read is success, not a 404: two tabs open, or a double click,
        // shouldn't surface an error to the admin.
        if (result.rows.length === 0) {
            const exists = await pool.query('SELECT id FROM notifications WHERE id = $1', [id]);
            if (exists.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification read:', error);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
};

// ── markAllRead(req, res) ──
const markAllRead = async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE notifications SET read_at = now() WHERE read_at IS NULL RETURNING id'
        );
        res.json({ success: true, count: result.rows.length });
    } catch (error) {
        console.error('Error marking all notifications read:', error);
        res.status(500).json({ error: 'Failed to mark all as read' });
    }
};

module.exports = { createNotification, list, markRead, markAllRead, VALID_TYPES };
