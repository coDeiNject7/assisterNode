const admin = require('firebase-admin');

// Parse FIREBASE_CONFIG from environment variable
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

module.exports = admin;
