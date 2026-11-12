// Migration runner: applies every .sql file in /migrations once, in name order.
// It remembers what it already applied in a table called schema_migrations,
// so running it again does nothing.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(200) PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (done.rowCount > 0) {
      console.log('skip (already applied):', file);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // all or nothing
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied:', file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('migrations finished');
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
