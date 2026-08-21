const authenticateAdmin = (req, res, next) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

module.exports = { authenticateAdmin };
