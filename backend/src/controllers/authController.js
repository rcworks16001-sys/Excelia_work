const bcrypt = require('bcryptjs');

// Precomputed hash of an arbitrary value that will never be a real password.
// bcrypt.compare() always runs against SOME hash — this one when the
// username doesn't match — so a wrong username and a wrong password take
// the same amount of time. Cheap, standard hardening against username
// enumeration via response timing.
const DUMMY_HASH = '$2a$10$itSa5BlrGy8kedRxvXzXl.rUNQrAgmLFmzsh3zEo3Ymn7KDY1iG3a';

// ── login(req, res) ──
// Verifies username+password against ADMIN_USERNAME/ADMIN_PASSWORD_HASH
// (env vars, single admin account — see backend/scripts/hash-password.js
// for generating the hash). On success, returns the SAME ADMIN_TOKEN the
// rest of the app has always used — this only changes how that token is
// obtained, not the session/cookie mechanism itself. Not authenticateAdmin
// -protected — this IS the login endpoint.
const login = async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
    }

    const usernameMatches = username === process.env.ADMIN_USERNAME;
    const hashToCheck = usernameMatches ? process.env.ADMIN_PASSWORD_HASH : DUMMY_HASH;

    try {
        const passwordMatches = await bcrypt.compare(password, hashToCheck);
        if (!usernameMatches || !passwordMatches) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        res.json({ token: process.env.ADMIN_TOKEN });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
};

module.exports = { login };
