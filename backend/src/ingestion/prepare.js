import { BookError } from '../books/errors.js';
import { chunkText, cleanText } from './chunks.js';
import { detectChapters } from './chapters.js';

export function validateTokenBudget(maxTokens) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new BookError(400, 'VALIDATION_ERROR', 'MAX_EMBEDDING_TOKENS must be a positive safe integer.');
  }
}

export function prepareText(text, maxTokens = 1000000) {
  validateTokenBudget(maxTokens);
  let chunks;
  let chapters;
  try {
    const cleaned = cleanText(text);
    chapters = detectChapters(cleaned);
    chunks = chunkText(cleaned, { chapters });
  }
  catch { throw new BookError(422, 'TEXT_CHUNKING_FAILED', 'The text could not be prepared within chunking limits.'); }
  const tokens = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
  if (tokens > maxTokens) {
    throw new BookError(422, 'TOKEN_BUDGET_EXCEEDED', 'This edition exceeds the configured embedding token budget.');
  }
  return { chunks, tokens, chapters };
}
