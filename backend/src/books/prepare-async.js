import { Worker } from 'node:worker_threads';
import { BookError } from './errors.js';
import { prepareText } from '../ingestion/prepare.js';

export function prepareValidation(text, maxTokens, { timeoutMs = 30000 } = {}) {
  // Small checks finish quickly without worker startup overhead.
  if (text.length <= 32768) {
    const { chunks, tokens } = prepareText(text, maxTokens);
    return Promise.resolve({ chunks: chunks.length, tokens });
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./prepare-worker.js', import.meta.url), {
      workerData: { text, maxTokens }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new BookError(503, 'VALIDATION_BUSY', 'Book checks are taking too long. Please try again.')), timeoutMs);
    worker.once('message', result => {
      if (result.error) finish(new BookError(result.error.status || 422, result.error.code || 'TEXT_CHUNKING_FAILED', result.error.message || 'The text could not be prepared.'));
      else finish(null, result);
    });
    worker.once('error', () => finish(new BookError(503, 'VALIDATION_BUSY', 'Book checks are temporarily unavailable.')));
    worker.once('exit', () => { if (!settled) finish(new BookError(503, 'VALIDATION_BUSY', 'Book checks were interrupted.')); });
  });
}
