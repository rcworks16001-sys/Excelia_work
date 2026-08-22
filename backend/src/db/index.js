const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Idle clients in the pool can still emit 'error' (e.g. Supabase's pooler
// resetting a connection that's just sitting there). Without a listener,
// Node treats an unhandled EventEmitter 'error' as fatal and crashes the
// whole process — this keeps the pool (and the server) alive instead.
pool.on('error', (err) => {
    console.error('Unexpected error on idle database client:', err);
});

// Simple connectivity check on startup. Uses pool.query() (which checks a
// client out AND back in automatically) rather than pool.connect(callback),
// which would otherwise leak a client for the lifetime of the process since
// nothing here would ever call its release().
pool.query('SELECT 1')
    .then(() => console.log('Database connected successfully'))
    .catch((err) => console.error('Database connection failed:', err));

// ── pool.withTransaction(fn) ──
// CLAUDE.md requires BEGIN/COMMIT whenever two or more rows must be written
// together. Attached to the pool itself rather than exported separately so
// every existing `const pool = require('../db/index')` gets it for free.
//
// The callback receives a dedicated client — every query inside MUST use it
// (not `pool`), or that query runs on a different connection and silently
// escapes the transaction. Controllers that participate take an optional
// `client` parameter defaulting to `pool` for this reason.
pool.withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        // Best-effort rollback: if the connection itself died, ROLLBACK will
        // throw too, and that must not mask the original error.
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Rollback failed:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
};

module.exports = pool;
