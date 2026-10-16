import { expect, it, vi } from 'vitest';
import { retrievePassages } from '../../src/retrieval/retrieve.js';
it.each(['', ' ', 'a'.repeat(2001), null])('rejects invalid questions without database/model calls', async question => {
  const pool = { query: vi.fn() };
  const embed = vi.fn();
  await expect(retrievePassages({ pool, embed, identifier: 'book', question })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(pool.query).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
});

import { askBook } from '../../src/questions/ask.js';
import { PIPELINE_VERSION } from '../../src/ingestion/chunks.js';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../src/ingestion/embeddings.js';
import { parseChapterScope } from '../../src/retrieval/chapter-scope.js';
const indexedEdition = { id: 'edition', status: 'READY', published_version: 'v1', pipeline_version: PIPELINE_VERSION,
  embedding_model: EMBEDDING_MODEL, embedding_dimensions: EMBEDDING_DIMENSIONS, chunk_count: 10, stored_count: 10,
  chapter_index: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}` })) };
it.each(['How many chapters are there in this book?', 'How many chapters does this book have?', 'What is the chapter count?', 'How many chapters are there?', 'how many chapters does the book have.,', 'How many chapters?', 'how many chapters', 'What is the chapter count?,'])('answers chapter counts without model calls: %s', async question => {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [indexedEdition] }) };
  const embed = vi.fn(), generate = vi.fn();
  const result = await askBook({ pool, embed, generate, identifier: 'book', question });
  expect(result).toMatchObject({ model: null, insufficientEvidence: false, references: [], publishedVersion: 'v1' });
  expect(result.answer).toContain('10 detected chapters');
  expect(embed).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});
it('does not invent a chapter count when the index is unavailable', async () => {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [{ ...indexedEdition, chapter_index: [] }] }) };
  const generate = vi.fn();
  const result = await askBook({ pool, generate, identifier: 'book', question: 'How many chapters are there?' });
  expect(result).toMatchObject({ insufficientEvidence: true, references: [], model: null });
  expect(result.answer).toContain('couldn’t reliably determine');
  expect(generate).not.toHaveBeenCalled();
});
it.each(['Compare chapters 1 and 2.', 'How many chapters are there in this book? Summarize chapters 1 and 2.'])('keeps unsupported multi-chapter requests blocked: %s', question => {
  expect(() => parseChapterScope(question)).toThrow();
});

it('recovers chapter counts for an already-ingested book with an empty index', async () => {
  const body = 'The reader walks along the path and learns a lesson. '.repeat(30);
  const text = `Contents\n\nArrival .... 1\nDeparture .... 8\n\nArrival\n\n${body}\n\nDeparture\n\n${body}`;
  const split = Math.floor(text.length / 2);
  const rows = [{ start_offset: 0, end_offset: split, content: text.slice(0, split) },
    { start_offset: split - 50, end_offset: text.length, content: text.slice(split - 50) }];
  const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...indexedEdition, chapter_index: [], chunk_count: 2, stored_count: 2 }] }).mockResolvedValueOnce({ rows }) };
  const embed = vi.fn(), generate = vi.fn();
  expect(await askBook({ pool, embed, generate, identifier: 'book', question: 'How many chapters does the book have?' })).toMatchObject({ chapterCount: 2, insufficientEvidence: false });
  expect(embed).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
});

it('recovers counts across paragraph separators omitted by the chunker', async () => {
  const body = 'A traveler opens the door and follows the winding path. '.repeat(25);
  const first = `Contents\n\nArrival .... 1\nDeparture .... 8\n\nArrival\n\n${body}`;
  const second = `Departure\n\n${body}`;
  const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...indexedEdition, chapter_index: [], chunk_count: 2, stored_count: 2 }] })
    .mockResolvedValueOnce({ rows: [{ start_offset: 0, end_offset: first.length, content: first },
      { start_offset: first.length + 3, end_offset: first.length + 3 + second.length, content: second }] }) };
  expect(await askBook({ pool, identifier: 'book', question: 'How many chapters does the book have?' })).toMatchObject({ chapterCount: 2, insufficientEvidence: false });
});
it('declines a count if stored chunks have inconsistent overlap', async () => {
  const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...indexedEdition, chapter_index: [], chunk_count: 2, stored_count: 2 }] })
    .mockResolvedValueOnce({ rows: [{ start_offset: 0, end_offset: 5, content: 'hello' }, { start_offset: 3, end_offset: 8, content: 'world' }] }) };
  expect(await askBook({ pool, identifier: 'book', question: 'How many chapters does the book have?' })).toMatchObject({ insufficientEvidence: true });
});
