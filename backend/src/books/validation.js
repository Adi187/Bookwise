import { BookError } from './errors.js';
import { prepareValidation } from './prepare-async.js';
import { validateTokenBudget } from '../ingestion/prepare.js';
import { PIPELINE_VERSION } from '../ingestion/chunks.js';

// Per-service cache: summaries only, never full text or embeddings. In-flight
// deduplication and this queue bound downloads across simultaneous searches.
export function createBookValidator({ downloadText, maxTokens, now = Date.now, ttlMs = 600000, maxEntries = 200, concurrency = 3, maxQueued = 30 }) {
  validateTokenBudget(maxTokens);
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;
  function drain() {
    while (active < concurrency && queue.length) {
      active++;
      const { run, resolve, reject } = queue.shift();
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return async function validate(identifier) {
    const cached = cache.get(identifier);
    if (cached && cached.expiresAt > now()) return structuredClone(cached.result);
    cache.delete(identifier);
    if (pending.has(identifier)) return structuredClone(await pending.get(identifier));
    if (active >= concurrency && queue.length >= maxQueued) {
      throw new BookError(503, 'VALIDATION_BUSY', 'Book checks are busy. Please try again shortly.');
    }
    const promise = new Promise((resolve, reject) => {
      queue.push({ resolve, reject, run: async () => {
        try {
          const book = await downloadText(identifier);
          const { chunks, tokens } = await prepareValidation(book.text, maxTokens);
          const checkedAt = now();
          const result = { archiveIdentifier: identifier, eligible: true, reasonCode: null,
            title: book.title, author: book.author, year: book.year ?? null,
            verifiedAt: new Date(checkedAt).toISOString(),
            text: { accessible: true, reasonCode: null, filename: book.filename, sizeBytes: book.sizeBytes, sha1: book.sha1 },
            validation: { scope: 'full', pipelineVersion: PIPELINE_VERSION, chunks, embeddingTokens: tokens, maxEmbeddingTokens: maxTokens } };
          cache.set(identifier, { result, expiresAt: checkedAt + ttlMs });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
          return result;
        } catch (error) {
          // Technical rejection hides this candidate. Outages are not cached or
          // converted to an empty result; the caller can offer a retry.
          if (error instanceof BookError && (error.status === 404 || (error.status === 422 && error.code !== 'DOWNLOAD_UNAVAILABLE'))) {
            return { archiveIdentifier: identifier, eligible: false, reasonCode: error.code };
          }
          if (error instanceof BookError && error.code === 'DOWNLOAD_UNAVAILABLE') {
            throw new BookError(503, 'ARCHIVE_UNAVAILABLE', 'Internet Archive is temporarily unavailable. Please try again.');
          }
          throw error;
        }
      } });
    });
    pending.set(identifier, promise);
    drain();
    try { return structuredClone(await promise); }
    finally { pending.delete(identifier); }
  };
}

