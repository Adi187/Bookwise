import { expect, it } from 'vitest';
import { prepareValidation } from '../../src/books/prepare-async.js';
import { prepareText } from '../../src/ingestion/prepare.js';
const text = ('A reader walks along the path and learns a lesson. '.repeat(25) + '\n\n').repeat(30);
it('prepares a large book without blocking the event loop and preserves validation totals', async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  const result = await prepareValidation(text, 1000000);
  clearTimeout(timer);
  const expected = prepareText(text);
  expect(ticked).toBe(true);
  expect(result).toEqual({ chunks: expected.chunks.length, tokens: expected.tokens });
});
it('preserves token budget rejection from the worker', async () => {
  await expect(prepareValidation(text, 1)).rejects.toMatchObject({ status: 422, code: 'TOKEN_BUDGET_EXCEEDED' });
});
it('terminates timed-out checks so the validation queue can continue', async () => {
  await expect(prepareValidation(text, 1000000, { timeoutMs: 1 })).rejects.toMatchObject({ status: 503, code: 'VALIDATION_BUSY' });
  expect(await prepareValidation('A readable paragraph about a reader and a library.', 1000)).toMatchObject({ chunks: 1 });
});
