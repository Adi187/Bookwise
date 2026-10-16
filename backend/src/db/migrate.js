import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export function migrateUp(databaseUrl, { schema = 'public' } = {}) {
  return runner({
    databaseUrl,
    dir: fileURLToPath(new URL('./migrations/', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema,
    createSchema: true,
    checkOrder: true,
    singleTransaction: true,
    // Do not emit SQL/provider errors, which may include sensitive data.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
