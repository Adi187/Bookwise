import pg from 'pg';

export function createPool(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
  });
  pool.on('error', () => console.error('An idle database connection failed.'));
  return pool;
}

export async function checkDatabase(pool) {
  await pool.query('SELECT 1');
}
