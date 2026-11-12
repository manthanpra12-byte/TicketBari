// PostgreSQL connection pool (a pool reuses connections instead of opening a new one per request)
const { Pool } = require('pg');

module.exports = new Pool({ connectionString: process.env.DATABASE_URL });
