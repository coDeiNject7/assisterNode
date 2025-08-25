const jwt = require('jsonwebtoken');

// Get secret at runtime
function getSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set');
  return process.env.JWT_SECRET;
}

// Generate token with very long expiration (365 days)
function generateToken(user) {
  const secret = getSecret();
  const token = jwt.sign({ id: user.id, email: user.email }, secret, { expiresIn: '365d' });
  console.log('Generated JWT token:', token);
  return token;
}

// Verify token ignoring expiration (DB controls validity)
function verifyToken(token) {
  try {
    const secret = getSecret();
    return jwt.verify(token, secret, { ignoreExpiration: true });
  } catch (err) {
    console.error('JWT verification failed in verifyToken():', err.message);
    return null;
  }
}

module.exports = { generateToken, verifyToken };
