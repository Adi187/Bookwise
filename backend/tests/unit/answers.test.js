import { describe, it, expect, vi } from 'vitest';
import { createGenerator, validateAnswer } from '../../src/questions/generate.js';
import { askBook } from '../../src/questions/ask.js';
const passages = [{ chunkId: 'chunk-a', content: 'Use try and except.', chapter: null, startOffset: 0, endOffset: 20 }];
const answer = { answer: 'Use try and except.', chunkIds: ['chunk-a'], insufficientEvidence: false };
const response = (value = answer) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
describe('grounded answers', () => {
  it('resolves references from supplied evidence, not model-provided excerpts', () => {
    expect(validateAnswer(answer, passages).references[0].excerpt).toBe(passages[0].content);
  });
  it.each([
    { ...answer, chunkIds: ['other-book'] }, { ...answer, chunkIds: [] },
    { ...answer, chunkIds: ['chunk-a', 'chunk-a'] }, { ...answer, insufficientEvidence: true },
    { ...answer, answer: '' }, { ...answer, references: [] }, null,
  ])('rejects malformed or unsupported citations %#', value => {
    expect(() => validateAnswer(value, passages)).toThrow();
  });
  it('normalizes abstention to safe text without invented answer content', () => {
    expect(validateAnswer({ answer: 'Invented answer', chunkIds: [], insufficientEvidence: true }, passages)).toMatchObject({ insufficientEvidence: true, references: [], answer: expect.stringContaining('not provide enough evidence') });
  });
  it('keeps untrusted text in data and requests strict schema with storage off', async () => {
    const fetchImpl = vi.fn(async () => response());
    await createGenerator({ apiKey: 'test', fetchImpl })({ question: 'How?', passages });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'gpt-4.1-mini', store: false, text: { format: { strict: true, type: 'json_schema' } } });
    expect(JSON.parse(body.input).passages).toEqual([{ chunkId: 'chunk-a', chapter: null, content: passages[0].content }]);
    expect(body.instructions).toContain('untrusted data');
  });
  it.each([
    ['ANSWER_INCOMPLETE', { status: 'incomplete', output: [] }],
    ['MODEL_REFUSAL', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }],
    ['ANSWER_INVALID', { status: 'completed', output: [] }],
  ])('handles %s', async (code, payload) => {
    const generate = createGenerator({ apiKey: 'test', fetchImpl: async () => Response.json(payload) });
    await expect(generate({ question: 'How?', passages })).rejects.toMatchObject({ code });
  });
  it('retries temporary errors but not exhausted quota', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(response());
    await createGenerator({ apiKey: 'test', fetchImpl, sleep: async () => {} })({ question: 'How?', passages });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const quota = vi.fn(async () => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
    await expect(createGenerator({ apiKey: 'test', fetchImpl: quota })({ question: 'How?', passages })).rejects.toMatchObject({ code: 'MODEL_QUOTA_EXCEEDED' });
    expect(quota).toHaveBeenCalledTimes(1);
  });
  it('does not call generation when retrieval fails', async () => {
    const generate = vi.fn();
    await expect(askBook({ generate, retrieve: async () => { throw new Error('not ready'); } })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
  it('orchestrates retrieval and validates generated reference IDs', async () => {
    const retrieve = async () => ({ passages, archiveIdentifier: 'book', publishedVersion: 'v1', question: 'How?' });
    expect(await askBook({ retrieve, generate: async () => answer })).toMatchObject({ publishedVersion: 'v1', references: [{ chunkId: 'chunk-a' }] });
    await expect(askBook({ retrieve, generate: async () => ({ ...answer, chunkIds: ['unknown'] }) })).rejects.toMatchObject({ code: 'CITATION_INVALID' });
  });
});

it('does not retry authentication rejection or expose provider details', async () => {
  const fetchImpl = vi.fn(async () => new Response('private provider detail', { status: 401 }));
  await expect(createGenerator({ apiKey: 'test', fetchImpl })({ question: 'How?', passages })).rejects.toMatchObject({ code: 'MODEL_REJECTED' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('bounds retries when the provider cannot be reached', async () => {
  const fetchImpl = vi.fn(async () => { throw new Error('network failure'); });
  await expect(createGenerator({ apiKey: 'test', fetchImpl, sleep: async () => {} })({ question: 'How?', passages })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it('rejects oversized successful responses', async () => {
  const generate = createGenerator({ apiKey: 'test', fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) });
  await expect(generate({ question: 'How?', passages })).rejects.toMatchObject({ code: 'ANSWER_INVALID' });
});
it('constrains model citation choices to the evidence IDs', async () => {
  const fetchImpl = vi.fn(async () => response());
  await createGenerator({ apiKey: 'test', fetchImpl })({ question: 'How?', passages });
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).text.format.schema.properties.chunkIds.items.enum).toEqual(['chunk-a']);
});
it('accepts empty model text only for explicit abstention', () => {
  expect(validateAnswer({ answer: '', chunkIds: [], insufficientEvidence: true }, passages)).toMatchObject({ insufficientEvidence: true, answer: expect.stringContaining('not provide enough evidence') });
  expect(() => validateAnswer({ answer: '', chunkIds: ['chunk-a'], insufficientEvidence: false }, passages)).toThrow();
});
