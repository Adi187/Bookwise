import { loadEnvironment, readDatabaseUrl, ConfigurationError } from '../src/config/env.js';
import { createPool } from '../src/db/connection.js';
import { createEmbedder } from '../src/ingestion/embeddings.js';
import { askBook } from '../src/questions/ask.js';
import { createGenerator } from '../src/questions/generate.js';
import { BookError } from '../src/books/errors.js';
let pool;
try {
  loadEnvironment();
  const [identifier, question, ...extra] = process.argv.slice(2);
  if (!identifier || !question || extra.length) throw new ConfigurationError('Usage: npm run ask:book -- <archiveIdentifier> "question"');
  pool = createPool(readDatabaseUrl(process.env.DATABASE_URL));
  const embed = createEmbedder({ apiKey: process.env.OPENAI_API_KEY });
  console.info(JSON.stringify(await askBook({ pool, embed, generate: createGenerator({ apiKey: process.env.OPENAI_API_KEY }), identifier, question }), null, 2));
} catch (error) {
  console.error(error instanceof BookError || error instanceof ConfigurationError ? error.message : 'Retrieval failed.');
  process.exitCode = 1;
} finally { await pool?.end(); }
