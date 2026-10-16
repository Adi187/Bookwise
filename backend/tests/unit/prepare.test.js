import { describe, expect, it } from 'vitest';
import { prepareText, validateTokenBudget } from '../../src/ingestion/prepare.js';

describe('ingestion preparation shared by preview and publication', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s', budget => {
    expect(() => validateTokenBudget(budget)).toThrow('positive safe integer');
  });
  it('accepts an exact budget and rejects one token below it', () => {
    const text = '\uFEFFChapter One\r\n\r\n' + 'The lantern lit the library. '.repeat(200);
    const result = prepareText(text);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[0].content.startsWith('Chapter One\n\n')).toBe(true);
    expect(prepareText(text, result.tokens)).toEqual(result);
    expect(() => prepareText(text, result.tokens - 1)).toThrow('token budget');
  });
});
