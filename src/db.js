const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'mycelium_db',
  user: process.env.DB_USER || 'mycelium_user',
  password: process.env.DB_PASSWORD || 'mycelium2026',
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err.message);
  process.exit(-1);
});

module.exports = pool;
