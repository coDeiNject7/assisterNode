require('dotenv').config();
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: true
  },
  waitForConnections: true,
  connectionLimit: 10,   // number of concurrent connections
  queueLimit: 0          // unlimited queued queries
});

// Export promise-based pool (so you can use async/await)
module.exports = pool.promise();
