import { ConfigurationError, loadEnvironment, readDatabaseUrl } from '../src/config/env.js';
import { migrateUp } from '../src/db/migrate.js';

try {
  loadEnvironment();
  const name = process.env.MIGRATION_DATABASE_URL ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL';
  const applied = await migrateUp(readDatabaseUrl(process.env[name], name));
  console.info(`Applied ${applied.length} migration(s).`);
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : 'Migration failed. Check database connectivity, extension permissions, and migration SQL.');
  process.exitCode = 1;
}
