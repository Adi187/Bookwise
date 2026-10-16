import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvironment, readDatabaseUrl, ConfigurationError } from '../src/config/env.js';
import { createPool } from '../src/db/connection.js';
import { createEmbedder } from '../src/ingestion/embeddings.js';
import { retrievePassages } from '../src/retrieval/retrieve.js';
import { BookError } from '../src/books/errors.js';
const normalize = text => text.toLowerCase().replace(/\s+/g, ' ');
let pool;
try {
  loadEnvironment();
  pool = createPool(readDatabaseUrl(process.env.DATABASE_URL));
  const embed = createEmbedder({ apiKey: process.env.OPENAI_API_KEY });
  const cases = JSON.parse(await readFile(new URL('../evaluations/retrieval-cases.json', import.meta.url), 'utf8'));
  const results = [];
  for (const test of cases) {
    // Verify reference evidence exists in this edition before scoring retrieval.
    const corpus = await pool.query(`SELECT c.content FROM book_chunks c JOIN book_editions e ON e.id=c.edition_id
      WHERE e.archive_identifier=$1 AND c.processing_version=e.published_version AND e.status='READY'`, [test.identifier]);
    if (test.expectedGroups && !test.expectedGroups.every(group => corpus.rows.some(row => group.some(anchor => normalize(row.content).includes(normalize(anchor)))))) {
      throw new Error(`Fixture evidence missing for ${test.id}`);
    }
    const result = await retrievePassages({ pool, embed, identifier: test.identifier, question: test.question });
    const ranks = test.expectedGroups?.map(group => {
      const index = result.passages.findIndex(p => group.some(anchor => normalize(p.content).includes(normalize(anchor))));
      return index < 0 ? null : index + 1;
    }) ?? null;
    const passed = ranks ? ranks.every(rank => rank !== null) : null;
    results.push({ id: test.id, expectedGroups: test.expectedGroups, evidenceRanks: ranks, passed,
      evaluation: ranks ? 'Expected evidence must appear in top five.' : 'Unrelated question: manual negative-control review; retrieval does not classify answerability.', ...result });
    console.info(JSON.stringify({ id: test.id, evidenceRanks: ranks, passed, topSimilarity: result.passages[0]?.similarity }));
  }
  const scored = results.filter(r => r.passed !== null);
  const report = { runAt: new Date().toISOString(), knownAnswerHits: scored.filter(r => r.passed).length,
    knownAnswerCases: scored.length, negativeControls: results.length - scored.length, results };
  await writeFile(new URL('../evaluations/retrieval-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  if (scored.some(r => !r.passed)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof BookError || error instanceof ConfigurationError ? error.message : 'Evaluation failed. Check fixture evidence and database configuration.');
  process.exitCode = 1;
} finally { await pool?.end(); }
