const admin = require("firebase-admin");

let firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);

// Fix escaped newlines
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

module.exports = admin;