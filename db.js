const mysql = require('mysql2');

const pool = mysql.createPool({
  host: "assister-mysql-1.mysql.database.azure.com",
  user: "azureadmin",
  password: "FillClock07",
  database: "assister",
  port: 3306,
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,   // number of concurrent connections
  queueLimit: 0          // unlimited queued queries
});

// Export promise-based pool (so you can use async/await)
module.exports = pool.promise();
