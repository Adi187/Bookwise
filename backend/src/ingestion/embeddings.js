import { BookError } from '../books/archive.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
const failure = (code, message) => new BookError(502, code, message);
async function readJson(response, maxBytes) {
  const reader = response.body.getReader();
  const buffers = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > maxBytes) throw new Error('Response too large.');
      buffers.push(part.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
export function validVector(value) {
  return Array.isArray(value) && value.length === EMBEDDING_DIMENSIONS && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 3.4028234663852886e38) && value.some(n => n !== 0);
}

export function createEmbedder({ apiKey, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!apiKey?.trim() || apiKey.startsWith('replace_')) throw failure('EMBEDDING_KEY_MISSING', 'Set OPENAI_API_KEY in backend/.env before ingestion.');
  return async function embed(input) {
    if (!Array.isArray(input) || !input.length || input.length > 16 || input.some(s => typeof s !== 'string' || !s.trim())) throw failure('EMBEDDING_INPUT_INVALID', 'Invalid embedding batch.');
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl('https://api.openai.com/v1/embeddings', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float', input }),
        });
      } catch {
        if (attempt === 2) throw failure('EMBEDDING_UNAVAILABLE', 'Embedding service could not be reached.');
      }
      if (response?.status === 429) {
        // Inspect only a bounded error payload; never expose provider messages or credentials.
        const detail = await readJson(response, 16384).catch(() => null);
        if (detail?.error?.code === 'insufficient_quota' || detail?.error?.type === 'insufficient_quota') {
          throw failure('EMBEDDING_QUOTA_EXCEEDED', 'OpenAI API quota is exhausted. Check API billing, credits, and project limits, then rerun ingestion.');
        }
        if (attempt < 2) await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 200));
        continue;
      }
      if (response && response.status !== 429 && response.status < 500) {
        if (!response.ok) {
          await response.body?.cancel();
          throw failure('EMBEDDING_REJECTED', 'Embedding request rejected. Check API credentials and account access.');
        }
        let data;
        try {
          data = await readJson(response, 2 * 1024 * 1024);
        } catch { throw failure('EMBEDDING_RESPONSE_INVALID', 'Invalid embedding response.'); }
        if (data.model !== EMBEDDING_MODEL || !Array.isArray(data.data) || data.data.length !== input.length) throw failure('EMBEDDING_RESPONSE_INVALID', 'Invalid embedding response.');
        const vectors = new Array(input.length);
        for (const row of data.data) {
          if (!Number.isInteger(row.index) || row.index < 0 || row.index >= input.length || vectors[row.index] || !validVector(row.embedding)) throw failure('EMBEDDING_RESPONSE_INVALID', 'Invalid embedding vector or index.');
          vectors[row.index] = row.embedding;
        }
        return vectors;
      }
      await response?.body?.cancel();
      if (attempt < 2) await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 200));
    }
    throw failure('EMBEDDING_UNAVAILABLE', 'Embedding service is temporarily unavailable or rate limited.');
  };
}
