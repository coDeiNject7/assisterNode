const jwt = require('jsonwebtoken');
const pool = require('../db'); // Your mysql2 promise pool

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    console.log('--- Auth Middleware ---');
    console.log('Authorization header:', authHeader);

    if (!authHeader) {
      console.log('No authorization header provided');
      return res.status(401).json({ error: 'Token required' });
    }

    const parts = authHeader.trim().split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      console.log('Malformed Authorization header');
      return res.status(401).json({ error: 'Malformed Authorization header' });
    }

    const token = parts[1];
    console.log('Extracted token:', token);

    // Verify JWT token (sync version wrapped in promise)
    jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true }, async (err, user) => {
      if (err) {
        console.error('JWT verification failed:', err.message);
        return res.status(403).json({ error: 'Invalid token signature' });
      }
      console.log('JWT decoded payload:', user);

      try {
        const [rows] = await pool.query(
          'SELECT * FROM user_tokens WHERE user_id = ? AND token = ?',
          [user.id, token]
        );
        console.log('DB token check rows:', rows.length);

        if (rows.length === 0) {
          console.log('Token not found in database');
          return res.status(403).json({ error: 'Token not recognized, please login again' });
        }

        req.user = user;
        req.token = token;
        console.log('Auth Middleware passed, moving to next');
        next();
      } catch (dbError) {
        console.error('Database error during token check:', dbError.message);
        return res.status(500).json({ error: 'Database error' });
      }
    });
  } catch (e) {
    console.error('Unexpected error in auth middleware:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = authMiddleware;
