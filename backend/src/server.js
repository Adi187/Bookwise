import { createResetMailer } from './auth/mailer.js';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { ConfigurationError, loadEnvironment, readConfig } from './config/env.js';
import { checkDatabase, createPool } from './db/connection.js';
import { createArchiveService, BookError } from './books/archive.js';
import { createEmbedder } from './ingestion/embeddings.js';
import { createGenerator } from './questions/generate.js';
import { askBook } from './questions/ask.js';
import { createIngestionWorker } from './jobs/worker.js';

let pool;
let worker;
try {
  loadEnvironment();
  const config = readConfig();
  pool = createPool(config.databaseUrl);
  await checkDatabase(pool);
  await pool.query('SELECT edition_id FROM ingestion_jobs LIMIT 0');
  const archive = createArchiveService({ maxTokens: config.maxEmbeddingTokens });
  const requireModels = () => {
    if (!config.openaiApiKey?.trim() || config.openaiApiKey.startsWith('replace_')) throw new BookError(503, 'MODEL_UNAVAILABLE', 'Book preparation and questions are temporarily unavailable.');
  };
  const embed = input => { requireModels(); return createEmbedder({ apiKey: config.openaiApiKey })(input); };
  const generate = evidence => { requireModels(); return createGenerator({ apiKey: config.openaiApiKey })(evidence); };
  const app = createApp({ frontendOrigin: config.frontendOrigin, checkDatabase: () => checkDatabase(pool), pool,
    jwtSecret: config.jwtSecret, sendPasswordReset: createResetMailer(config), archive, requireModels, ask: input => askBook({ pool, embed, generate, ...input }) });
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.info(`Noteway API listening on http://${config.host}:${config.port}`);
  if (config.openaiApiKey?.trim() && !config.openaiApiKey.startsWith('replace_')) {
    worker = createIngestionWorker({ pool, archive, embed, maxTokens: config.maxEmbeddingTokens });
    worker.start();
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await worker?.stop();
      await pool.end();
      clearTimeout(timeout);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : error.code === 'EADDRINUSE'
    ? 'Backend port is already in use.' : 'Backend startup failed. Check database connectivity, migrations, and the configured host/port.');
  await worker?.stop();
  if (pool) await pool.end();
  process.exitCode = 1;
}
