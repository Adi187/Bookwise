import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createArchiveService, BookError } from '../../src/books/archive.js';
import { createBookValidator } from '../../src/books/validation.js';
import { createApp } from '../../src/app.js';

const body = 'The sailor opened the book and read beside the window. '.repeat(200);
const sha1 = text => createHash('sha1').update(text).digest('hex');
const book = { text: body, filename: 'book.txt', sizeBytes: Buffer.byteLength(body), sha1: sha1(body) };
function setup({ bad = false, budget = 1000000, outage = false } = {}) {
  const full = bad ? body + '\0bad ending' : body;
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.pathname === '/advancedsearch.php') return Response.json({ response: { docs: [{ identifier: 'fixture-book', title: 'Fixture', creator: 'Author' }], numFound: 1 } });
    if (url.pathname.startsWith('/metadata/')) return Response.json({ metadata: { identifier: 'fixture-book', mediatype: 'texts' }, files: [{ name: 'book.txt', size: Buffer.byteLength(full), sha1: sha1(full) }] });
    if (options.headers.Range) return new Response(Buffer.from(full).subarray(0, 8192), { status: 206, headers: { 'content-type': 'text/plain', 'content-range': `bytes 0-8191/${Buffer.byteLength(full)}` } });
    if (outage) return new Response('', { status: 503 });
    return new Response(full, { headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(full)) } });
  });
  const archive = createArchiveService({ fetchImpl, maxTokens: budget });
  const app = createApp({ archive, checkDatabase: async () => {}, frontendOrigin: 'http://localhost:5173' });
  return { archive, app, fetchImpl };
}

describe('search defers complete preparation until a book is opened', () => {
  it('discovers a book quickly but still rejects unusable full text when opened', async () => {
    const { archive } = setup({ bad: true });
    expect((await archive.eligibility('fixture-book')).eligible).toBe(true);
    expect((await archive.search('fixture', 1)).items).toHaveLength(1);
    expect((await archive.validate('fixture-book')).eligible).toBe(false);
  });
  it('defers embedding budget checks until a book is opened', async () => {
    const { archive } = setup({ budget: 1 });
    expect((await archive.search('fixture', 1)).items).toHaveLength(1);
    expect((await archive.validate('fixture-book')).eligible).toBe(false);
  });
  it('streams discoverable candidates without downloading or tokenizing books', async () => {
    const { app, fetchImpl } = setup();
    const res = await request(app).get('/api/books/search?q=fixture').set('Accept', 'application/x-ndjson');
    const events = res.text.trim().split('\n').map(JSON.parse);
    expect(events[0]).toMatchObject({ items: [], complete: false });
    expect(events.at(-1)).toMatchObject({ complete: true, items: [{ eligibility: { validation: { scope: 'metadata' }, text: { available: true } } }] });
    expect(fetchImpl.mock.calls.every(([url]) => !url.pathname.startsWith('/download/'))).toBe(true);
  });
  it('reports transient failure rather than a completed empty search', async () => {
    const { app, archive } = setup();
    archive.discover = vi.fn().mockRejectedValue(new BookError(503, 'ARCHIVE_UNAVAILABLE', 'temporary'));
    const res = await request(app).get('/api/books/search?q=fixture').set('Accept', 'application/x-ndjson');
    const events = res.text.trim().split('\n').map(JSON.parse);
    expect(events.at(-1).error.code).toBe('BOOK_CHECKS_UNAVAILABLE');
    expect(events.some(event => event.complete)).toBe(false);
  });
  it('does not schedule candidates after the search is cancelled', async () => {
    const { archive, fetchImpl } = setup();
    const controller = new AbortController();
    controller.abort();
    const progress = vi.fn();
    await archive.search('fixture', 1, { signal: controller.signal, onProgress: progress });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Catalog only; no book download.
  });
});

describe('bounded validation cache', () => {
  it('deduplicates checks, caches summaries, expires, and revalidates changed files', async () => {
    let time = 0;
    const downloadText = vi.fn(async () => book);
    const validate = createBookValidator({ downloadText, maxTokens: 1000000, now: () => time, ttlMs: 10 });
    const [a, b] = await Promise.all([validate('book'), validate('book')]);
    expect(a).toEqual(b);
    expect(downloadText).toHaveBeenCalledTimes(1);
    a.text.filename = 'mutated';
    expect((await validate('book')).text.filename).toBe('book.txt');
    time = 11;
    downloadText.mockResolvedValueOnce({ ...book, filename: 'changed.txt' });
    expect((await validate('book')).text.filename).toBe('changed.txt');
    expect(downloadText).toHaveBeenCalledTimes(2);
  });
  it('does not cache provider failures', async () => {
    const downloadText = vi.fn().mockRejectedValueOnce(new BookError(503, 'ARCHIVE_UNAVAILABLE', 'temporary')).mockResolvedValue(book);
    const validate = createBookValidator({ downloadText, maxTokens: 1000000 });
    await expect(validate('book')).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
    expect((await validate('book')).eligible).toBe(true);
  });
  it('does not permanently hide an edition after a technical rejection', async () => {
    const downloadText = vi.fn().mockRejectedValueOnce(new BookError(422, 'TEXT_UNUSABLE', 'bad text')).mockResolvedValue(book);
    const validate = createBookValidator({ downloadText, maxTokens: 1000000 });
    expect((await validate('book')).eligible).toBe(false);
    expect((await validate('book')).eligible).toBe(true);
  });
  it('evicts old summaries at the entry limit', async () => {
    const downloadText = vi.fn(async () => book);
    const validate = createBookValidator({ downloadText, maxTokens: 1000000, maxEntries: 1 });
    await validate('one'); await validate('two'); await validate('one');
    expect(downloadText).toHaveBeenCalledTimes(3);
  });
  it('bounds active downloads and queued work across callers', async () => {
    let finish;
    const downloadText = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(book);
    const validate = createBookValidator({ downloadText, maxTokens: 1000000, concurrency: 1, maxQueued: 1 });
    const first = validate('one');
    const second = validate('two');
    await expect(validate('three')).rejects.toMatchObject({ code: 'VALIDATION_BUSY' });
    expect(downloadText).toHaveBeenCalledTimes(1);
    finish(book);
    await Promise.all([first, second]);
    expect(downloadText).toHaveBeenCalledTimes(2);
  });
});

describe('search resilience', () => {
  it('returns ordered verified books and keeps checking after one candidate fails', async () => {
    const archive = createArchiveService({ fetchImpl: async () => Response.json({ response: {
      docs: ['one', 'broken', 'two', 'three'].map(identifier => ({ identifier, title: identifier })), numFound: 40,
    } }) });
    archive.discover = vi.fn(async identifier => {
      if (identifier === 'broken') throw new BookError(503, 'ARCHIVE_UNAVAILABLE', 'temporary');
      return { eligible: true, archiveIdentifier: identifier, validation: { scope: 'full' }, text: { accessible: true } };
    });
    const progress = vi.fn();
    const result = await archive.search('math', 1, { onProgress: progress });
    expect(result.items.map(item => item.archiveIdentifier)).toEqual(['one', 'two', 'three']);
    expect(result).toMatchObject({ failedChecks: 1, hasMore: true });
    expect(archive.discover).toHaveBeenCalledTimes(4);
    expect(progress.mock.calls.at(-1)[0].failedChecks).toBe(1);
  });
  it('retries a temporary catalog failure and succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ response: { docs: [], numFound: 0 } }));
    const archive = createArchiveService({ fetchImpl });
    expect((await archive.search('math', 1)).items).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('bounds retries when the initial catalog search fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    await expect(createArchiveService({ fetchImpl }).search('math', 1)).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
