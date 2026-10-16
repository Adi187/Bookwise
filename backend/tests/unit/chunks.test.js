import { describe, expect, it } from 'vitest';
import { chunkText, cleanText, tokenCount } from '../../src/ingestion/chunks.js';

describe('text cleaning and chunking', () => {
  it('normalizes BOM/newlines while preserving content and notices', () => {
    expect(cleanText('\uFEFFCopyright notice\r\n\r\nChapter 1\rText.')).toBe('Copyright notice\n\nChapter 1\nText.');
  });
  it('preserves meaningful content, offsets and ordering across long paragraphs', () => {
    const text = cleanText('Chapter One\n\n' + 'Mira visits the library to learn about distant islands. '.repeat(140) + '\n\nChapter Two\n\n' + 'The keeper shows her a chart of the stars. '.repeat(100));
    const chunks = chunkText(text);
    const covered = new Uint8Array(text.length);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.chunkIndex).toBe(index);
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.tokenCount).toBeLessThanOrEqual(500);
      expect(chunk.tokenCount).toBe(tokenCount(chunk.content));
      expect(['Chapter 1', 'Chapter 2']).toContain(chunk.chapter);
      covered.fill(1, chunk.startOffset, chunk.endOffset);
      if (index) expect(chunk.endOffset).toBeGreaterThan(chunks[index - 1].endOffset);
    }
    for (let i = 0; i < text.length; i++) if (/\S/.test(text[i])) expect(covered[i]).toBe(1);
    expect(chunks.length).toBeGreaterThan(2);
  });
  it('repeats bounded complete-sentence context when practical', () => {
    const chunks = chunkText('A lantern stood by the window. '.repeat(100), { targetTokens: 50, overlapTokens: 15 });
    expect(chunks.some((chunk, i) => i && chunk.startOffset < chunks[i - 1].endOffset)).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      const overlap = chunks[i - 1].endOffset - chunks[i].startOffset;
      if (overlap > 0) expect(tokenCount(chunks[i].content.slice(0, overlap))).toBeLessThanOrEqual(15);
    }
  });
  it('terminates on long text without sentence boundaries and preserves Unicode', () => {
    const text = '中文😀'.repeat(400);
    const chunks = chunkText(text, { targetTokens: 50, overlapTokens: 10 });
    expect(chunks.map(chunk => chunk.content).join('')).toBe(text);
    expect(chunks.every(chunk => chunk.tokenCount <= 50 && !chunk.content.includes('\uFFFD'))).toBe(true);
  });
  it('rejects empty input and non-progressing configuration', () => {
    expect(() => chunkText(' \n\n ')).toThrow('No usable');
    expect(() => chunkText('hello', { targetTokens: 10, overlapTokens: 10 })).toThrow('Invalid chunk');
  });
});
