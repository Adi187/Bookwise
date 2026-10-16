import { loadEnvironment, readDatabaseUrl, ConfigurationError } from '../src/config/env.js';
import { createPool, checkDatabase } from '../src/db/connection.js';
import { BookError, createArchiveService, validIdentifier } from '../src/books/archive.js';
import { prepareText, validateTokenBudget } from '../src/ingestion/prepare.js';
import { createEmbedder } from '../src/ingestion/embeddings.js';
import { ingestEdition } from '../src/ingestion/ingest.js';

let pool;
try {
  loadEnvironment();
  const [identifier, mode, ...extra] = process.argv.slice(2);
  if (!validIdentifier(identifier) || (mode && !['--validate-only', '--reprocess'].includes(mode)) || extra.length) throw new ConfigurationError('Usage: npm run ingest:book -- <archiveIdentifier> [--validate-only | --reprocess]');
  const maxTokens = Number(process.env.MAX_EMBEDDING_TOKENS || 1000000);
  validateTokenBudget(maxTokens);
  const archive = createArchiveService();
  if (mode === '--validate-only') {
    const book = await archive.downloadText(identifier);
    const { chunks, tokens, chapters } = prepareText(book.text, maxTokens);
    console.info(JSON.stringify({ archiveIdentifier: identifier, filename: book.filename, bytes: book.sizeBytes, sha1: book.sha1,
      chunks: chunks.length, chapters, embeddingTokens: tokens, maxEmbeddingTokens: maxTokens, stored: false, embeddingsCreated: false }, null, 2));
  } else {
    const embed = createEmbedder({ apiKey: process.env.OPENAI_API_KEY });
    pool = createPool(readDatabaseUrl(process.env.DATABASE_URL));
    await checkDatabase(pool);
    const result = await ingestEdition({ pool, archive, embed, identifier, maxTokens, reprocess: mode === '--reprocess',
      onProgress: progress => console.info(JSON.stringify(progress)) });
    console.info(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error instanceof ConfigurationError || error instanceof BookError ? error.message : 'Ingestion failed. Check configuration, database connectivity, and migrations.');
  process.exitCode = 1;
} finally { await pool?.end(); }
