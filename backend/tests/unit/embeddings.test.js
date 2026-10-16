import { describe, expect, it, vi } from 'vitest';
import { createEmbedder, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../src/ingestion/embeddings.js';
const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
const response = data => new Response(JSON.stringify({ model: EMBEDDING_MODEL, data }), { headers: { 'content-type': 'application/json' } });
describe('embedding boundary', () => {
  it('orders response vectors by index and sends the configured model/dimensions', async () => {
    const a = vector(); const b = vector(); b[1] = 0.5;
    const fetchImpl = vi.fn(async () => response([{ index: 1, embedding: b }, { index: 0, embedding: a }]));
    expect(await createEmbedder({ apiKey: 'test-key', fetchImpl })(['first', 'second'])).toEqual([a, b]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ model: EMBEDDING_MODEL, dimensions: 1536, encoding_format: 'float' });
  });
  it.each([
    { data: [{ index: 0, embedding: [1] }] },
    { data: [{ index: 0, embedding: Array(1536).fill(0) }] },
    { data: [{ index: 1, embedding: vector() }] },
    { data: [] },
  ])('rejects malformed vector data %#', async ({ data }) => {
    await expect(createEmbedder({ apiKey: 'test-key', fetchImpl: async () => response(data) })(['text'])).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
  });
  it('retries rate limits with bounded attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(response([{ index: 0, embedding: vector() }]));
    const sleep = vi.fn(async () => {});
    await createEmbedder({ apiKey: 'test-key', fetchImpl, sleep })(['text']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('does not retry authentication failure or expose its body', async () => {
    const fetchImpl = vi.fn(async () => new Response('secret provider detail', { status: 401 }));
    await expect(createEmbedder({ apiKey: 'test-key', fetchImpl })(['text'])).rejects.toMatchObject({ code: 'EMBEDDING_REJECTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('reports exhausted quota without retrying or exposing provider details', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'private detail' } }), { status: 429 }));
    const sleep = vi.fn();
    await expect(createEmbedder({ apiKey: 'test-key', fetchImpl, sleep })(['text'])).rejects.toMatchObject({ code: 'EMBEDDING_QUOTA_EXCEEDED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('rejects a missing key before any request', () => {
    expect(() => createEmbedder()).toThrow('Set OPENAI_API_KEY');
  });
});
