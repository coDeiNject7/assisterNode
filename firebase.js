const admin = require('firebase-admin');
const serviceAccount = require('./assister-738e8-firebase-adminsdk-fbsvc-6a6487b222.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;
