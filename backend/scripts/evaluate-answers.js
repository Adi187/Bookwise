import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvironment } from '../src/config/env.js';
import { createGenerator, validateAnswer } from '../src/questions/generate.js';
import { BookError } from '../src/books/errors.js';
try {
  loadEnvironment();
  const generate = createGenerator({ apiKey: process.env.OPENAI_API_KEY });
  const retrieval = JSON.parse(await readFile(new URL('../evaluations/retrieval-report.json', import.meta.url), 'utf8'));
  const results = [];
  for (const evidence of retrieval.results) {
    let raw;
    let result;
    try {
      raw = await generate(evidence);
      result = validateAnswer(raw, evidence.passages);
    } catch (error) {
      if (!(error instanceof BookError)) throw error;
      results.push({ id: evidence.id, passed: false, errorCode: error.code, rawAnswer: raw });
      console.info(JSON.stringify({ id: evidence.id, passed: false, errorCode: error.code }));
      continue;
    }
    const expectedInsufficient = evidence.expectedGroups === null;
    const passed = result.insufficientEvidence === expectedInsufficient;
    results.push({ id: evidence.id, question: evidence.question, archiveIdentifier: evidence.archiveIdentifier,
      publishedVersion: evidence.publishedVersion, expectedInsufficient, passed, ...result });
    console.info(JSON.stringify({ id: evidence.id, passed, answer: result.answer, citations: result.references.length }));
  }
  const report = { runAt: new Date().toISOString(), retrievalRunAt: retrieval.runAt,
    note: 'Generation over saved retrieval evidence. Pass checks answer/abstention state and citation membership, not semantic correctness. Manual review is required.', results };
  await writeFile(new URL('../evaluations/answer-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  if (results.some(r => !r.passed)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof BookError ? error.message : 'Answer evaluation failed. Check the saved retrieval report and configuration.');
  process.exitCode = 1;
}
