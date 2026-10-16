import { ConfigurationError, loadEnvironment, readDatabaseUrl } from '../src/config/env.js';
import { createPool } from '../src/db/connection.js';

const hints = {
  ECONNREFUSED: 'PostgreSQL is not accepting connections. Check that it is running and that the host/port are correct.',
  ENOTFOUND: 'The database host could not be resolved. Check the hostname.',
  '28P01': 'Authentication failed. Check the PostgreSQL username and password.',
  '28000': 'PostgreSQL rejected authentication. Check the role and server access rules.',
  '3D000': 'The configured database does not exist. Create it or correct DATABASE_URL.',
};

let pool;
try {
  loadEnvironment();
  pool = createPool(readDatabaseUrl(process.env.DATABASE_URL));
  await pool.query('SELECT 1');
  console.info('Database connection successful.');
  const { rows } = await pool.query("SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'");
  if (!rows.length) {
    console.info('pgvector is not available on this PostgreSQL server. Install it before running migrations.');
    process.exitCode = 1;
  } else if (!rows[0].installed_version) {
    console.info('pgvector is available; the initial migration will enable it (extension privileges required).');
  } else {
    console.info('pgvector is enabled in this database.');
  }
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message :
    hints[error.code] || 'Database check failed. Check connectivity, credentials, and any required TLS configuration.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
