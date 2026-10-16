import { expect, it, vi } from 'vitest';
import { askQuestion } from './questions.js';
it('accepts an explicitly identified chapter-index answer without invented citations', async () => {
  const data = { question: 'how many chapters are there in this book.', answer: 'This edition has 10 detected chapters, according to its chapter index.', model: null, answerSource: 'chapter_index', chapterCount: 10, insufficientEvidence: false, references: [] };
  expect(await askQuestion(vi.fn().mockResolvedValue(data), 'source', data.question)).toEqual(data);
});
it('still rejects uncited model answers', async () => {
  await expect(askQuestion(vi.fn().mockResolvedValue({ question: 'Why?', answer: 'Because.', insufficientEvidence: false, references: [] }), 'source', 'Why?')).rejects.toThrow('We could not read');
});
