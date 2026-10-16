import { writeFile } from 'node:fs/promises';
import { loadEnvironment, readDatabaseUrl, ConfigurationError } from '../src/config/env.js';
import { createPool } from '../src/db/connection.js';
import { createEmbedder } from '../src/ingestion/embeddings.js';
import { retrievePassages } from '../src/retrieval/retrieve.js';
import { createGenerator, validateAnswer } from '../src/questions/generate.js';
import { BookError } from '../src/books/errors.js';

// Edition-specific regression, not a universal accuracy benchmark. This makes paid calls.
const identifier = 'animal-farm-by-george-orwell_202208';
const cases = [
  { id: 'chapter-one-ending', question: 'What happened at the end of chapter one?', chapter: 1, mode: 'ending', expected: ['Jones', 'gunfire interrupts the meeting', 'animals disperse and sleep'], terms: [/Jones/i, /shot|shoot|fir(?:ed|es|ing)|gun/i, /sleep|bed|dispers|scatter|fled|flee|broke up|breaks up/i] },
  { id: 'roman-ending', question: 'How does Chapter I end?', chapter: 1, mode: 'ending', expected: ['Jones interrupts the singing', 'meeting ends'], terms: [/Jones/i, /shot|shoot|fir(?:ed|es|ing)|gun/i] },
  { id: 'chapter-two-ending', question: 'What happened at the end of chapter two?', chapter: 2, mode: 'ending', expected: ['animals go to harvest', 'milk disappears'], terms: [/milk/i, /disappear|missing|gone/i] },
  { id: 'chapter-two-opening', question: 'What happens at the beginning of chapter II?', chapter: 2, mode: 'beginning', expected: ['Old Major dies', 'pigs organize'], terms: [/Major/i, /died|dies|dying|death/i] },
  { id: 'chapter-one-summary', question: 'Summarize chapter one.', chapter: 1, mode: 'overview', expected: ['Major addresses animals', 'Beasts of England', 'Jones ends the gathering'], terms: [/Major/i, /Beasts of England/i, /Jones/i] },
  { id: 'chapter-one-topic', question: 'In chapter 1, why does the meeting break up?', chapter: 1, mode: 'semantic', expected: ['Jones wakes and fires a gun'], terms: [/Jones/i, /shot|shoot|fir(?:ed|es|ing)|gun/i] },
  { id: 'unsupported-fact', question: 'In chapter 1, what is Napoleon’s email address?', chapter: 1, mode: 'semantic', insufficient: true, expected: ['insufficient evidence'], terms: [] },
];
let pool;
try {
  loadEnvironment();
  pool = createPool(readDatabaseUrl(process.env.DATABASE_URL));
  const embed = createEmbedder({ apiKey: process.env.OPENAI_API_KEY });
  const calls = [];
  const generate = createGenerator({ apiKey: process.env.OPENAI_API_KEY, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    body.model = 'gpt-6-sol';
    body.reasoning = { effort: 'medium' };
    body.max_output_tokens = 4096;
    const started = Date.now();
    const response = await fetch(url, { ...options, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const data = await response.clone().json();
    calls.push({ status: response.status, model: data.model, milliseconds: Date.now() - started, usage: data.usage, error: data.error, incompleteDetails: data.incomplete_details });
    return response;
  } });
  const selected = process.argv[2];
  if (selected && !cases.some(test => test.id === selected)) throw new ConfigurationError('Pass a known chapter evaluation case ID or omit it to run all cases.');
  const results = [];
  for (const test of cases.filter(test => !selected || test.id === selected)) {
    let evidence, raw;
    try {
      evidence = await retrievePassages({ pool, embed, identifier, question: test.question });
      raw = await generate(evidence);
      const result = validateAnswer(raw, evidence.passages);
      const checks = {
        correctScope: evidence.scope?.number === test.chapter && evidence.scope.mode === test.mode,
        onlyRequestedChapter: evidence.passages.every(p => p.chapter === `Chapter ${test.chapter}`),
        expectedAnswerState: result.insufficientEvidence === Boolean(test.insufficient),
        expectedTerms: test.terms.every(pattern => pattern.test(result.answer)),
        chronology: test.id !== 'chapter-two-opening' || !/three (?:nights|days) after (?:old )?Major[’']s death/i.test(result.answer),
      };
      results.push({ id: test.id, question: test.question, expected: test.expected, checks,
        passed: Object.values(checks).every(Boolean), publishedVersion: evidence.publishedVersion, scope: evidence.scope,
        answer: result.answer, insufficientEvidence: result.insufficientEvidence,
        // Keep the report compact; no full-book text or lengthy source excerpts.
        retrieved: evidence.passages.map(p => ({ chunkId: p.chunkId, chunkIndex: p.chunkIndex, chapter: p.chapter, startOffset: p.startOffset, endOffset: p.endOffset })),
        references: result.references.map(({ excerpt: _excerpt, ...reference }) => reference) });
    } catch (error) {
      if (!(error instanceof BookError)) throw error;
      results.push({ id: test.id, question: test.question, passed: false, errorCode: error.code, scope: evidence?.scope, rawAnswer: raw });
    }
    console.info(JSON.stringify(results.at(-1)));
    await writeFile(new URL(`../evaluations/chapter-sol-report${selected ? '-' + selected : ''}.json`, import.meta.url), JSON.stringify({
      runAt: new Date().toISOString(), archiveIdentifier: identifier, model: 'gpt-6-sol', reasoningEffort: 'medium', maxOutputTokens: 4096, calls,
      note: 'Live generation and retrieval. Checks validate scope, citation membership, answer state, and key terms; manual review is still required for factual accuracy.', results,
    }, null, 2) + '\n');
  }
  for (const [question, code] of [['What happens in chapter 99?', 'CHAPTER_NOT_FOUND'], ['Compare chapters 1 and 2.', 'CHAPTER_SCOPE_UNSUPPORTED']]) {
    let actual;
    try { await retrievePassages({ pool, embed, identifier, question }); } catch (error) { actual = error.code; }
    if (actual !== code) throw new Error('Expected chapter rejection was not returned.');
    console.info(JSON.stringify({ question, rejectedWith: actual }));
  }
  if (results.some(r => !r.passed)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof BookError || error instanceof ConfigurationError ? error.message : 'Chapter evaluation failed. Check database configuration and the reprocessed edition.');
  process.exitCode = 1;
} finally { await pool?.end(); }
