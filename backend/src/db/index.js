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

module.exports = pool;
