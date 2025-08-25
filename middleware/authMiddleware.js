const jwt = require('jsonwebtoken');
const connection = require('../db');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization']?.trim();

  console.log('--- Auth Middleware ---');
  console.log('Authorization header:', authHeader);

  if (!authHeader) return res.status(401).json({ error: 'Token required' });

  const parts = authHeader.trim().split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Malformed Authorization header' });
  }

  const token = parts[1];
  console.log('Extracted token:', token);

  // Verify JWT signature
  jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true }, (err, user) => {
    if (err) {
      console.error('JWT verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid token signature' });
    }

    console.log('JWT decoded payload:', user);

    // Check token exists in DB
    connection.query(
      'SELECT * FROM user_tokens WHERE user_id = ? AND token = ?',
      [user.id, token],
      (error, results) => {
        if (error) {
          console.error('DB query error:', error.message);
          return res.status(500).json({ error: 'Database error' });
        }

        console.log('DB token check results:', results);

        if (results.length === 0)
          return res.status(403).json({ error: 'Token not recognized, please login again' });

        req.user = user;
        req.token = token;
        next();
      }
    );
  });
};

module.exports = authMiddleware;
