import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createArchiveService } from '../../src/books/archive.js';
import { createApp } from '../../src/app.js';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/archive-eligible.json', import.meta.url), 'utf8'));

const passage = 'At the lantern library, Mira opened the blue book. Its pages told the story of a sailor who returned each autumn to read beside the window. The library keeper left a lamp burning for every late visitor.';
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const text = (body = passage, headers = {}) => new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), ...headers } });
fixture.files[0].size = String(Buffer.byteLength(passage));
fixture.files[0].sha1 = createHash('sha1').update(passage).digest('hex');
function setup({ metadata = fixture, response = () => text(), search = { response: { docs: [{ identifier: 'noteway-test-edition', title: ['The Lantern Library'], creator: ['Mira', 'Sam'], year: 1901 }], numFound: 1 } } } = {}) {
  const fetchImpl = vi.fn(async url => {
    if (url.pathname === '/advancedsearch.php') return json(search);
    if (url.pathname.startsWith('/metadata/')) return json(metadata);
    return response();
  });
  const archive = createArchiveService({ fetchImpl });
  const app = createApp({ frontendOrigin: 'http://localhost:5173', checkDatabase: async () => {}, archive });
  return { app, fetchImpl };
}
const inspect = app => request(app).get('/api/books/noteway-test-edition/eligibility');

describe('book discovery API', () => {
  it('returns independently validated details without exposing file diagnostics', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/books/noteway-test-edition');
    expect(response.status).toBe(200);
    expect(response.body.book).toMatchObject({ archiveIdentifier: 'noteway-test-edition', title: expect.any(String), author: expect.any(String), eligible: true });
    expect(response.body.book).not.toHaveProperty('text');
    expect(response.body.book).not.toHaveProperty('validation');
  });
  it('maps a small consistent edition contract and quotes the search phrase', async () => {
    const { app, fetchImpl } = setup();
    const response = await request(app).get('/api/books/search').query({ q: '  title:"x" OR *:*  ' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [{ archiveIdentifier: 'noteway-test-edition', title: 'The Lantern Library', author: 'Mira, Sam', year: '1901' }], page: 1, hasMore: false });
    expect(fetchImpl.mock.calls[0][0].searchParams.get('q')).toContain('title:("title:\\"x\\" OR *:*")');
  });
  it('returns an empty search without treating it as an error', async () => {
    const { app } = setup({ search: { response: { docs: [], numFound: 0 } } });
    expect((await request(app).get('/api/books/search?q=zznothing')).body).toEqual({ items: [], page: 1, hasMore: false });
  });
  it.each(['/api/books/search?q=a', '/api/books/search?q=valid&page=0', '/api/books/search?q=x&q=y', '/api/books/search?q=valid&page=1.5', '/api/books/%2Fetc/eligibility'])( 'rejects invalid input %s before requesting Archive', async path => {
    const { app, fetchImpl } = setup();
    expect((await request(app).get(path)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reports pagination', async () => {
    const { app } = setup({ search: { response: { docs: [], numFound: 41 } } });
    expect((await request(app).get('/api/books/search?q=valid&page=2')).body.hasMore).toBe(true);
  });
});

describe('edition eligibility', () => {
  it('accepts accessible text without a review registry', async () => {
    const { app, fetchImpl } = setup();
    const response = await inspect(app);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ eligible: true, reasonCode: null, text: { accessible: true, filename: 'book.txt' } });
    expect(fetchImpl.mock.calls[1][1].headers.Range).toBe('bytes=0-8191');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([undefined, 'All rights reserved', 'https://creativecommons.org/publicdomain/zero/1.0/'])('does not gate technical eligibility on rights metadata: %s', async rights => {
    const metadata = structuredClone(fixture);
    metadata.metadata.rights = rights;
    const result = await inspect(setup({ metadata }).app);
    expect(result.body).toMatchObject({ eligible: true, reasonCode: null, text: { accessible: true } });
    expect(result.body).not.toHaveProperty('rights');
  });
  it('accepts a bounded partial response and never needs the full book', async () => {
    const body = passage.repeat(50).slice(0, 8192);
    const response = () => new Response(body, { status: 206, headers: { 'content-type': 'text/plain', 'content-range': 'bytes 0-8191/12000' } });
    expect((await inspect(setup({ response }).app)).body).toMatchObject({ eligible: true, text: { sampleBytes: 8192, sizeBytes: 12000 } });
  });
  it('rejects a truncated response', async () => {
    const response = () => text(passage, { 'content-length': '8192' });
    expect((await inspect(setup({ response }).app)).body.reasonCode).toBe('DOWNLOAD_UNAVAILABLE');
  });
  it('tries another text file when the first one is unusable', async () => {
    const metadata = structuredClone(fixture);
    metadata.files.unshift({ name: 'bad_djvu.txt', size: '100', sha1: 'a'.repeat(40) });
    const response = vi.fn().mockImplementationOnce(() => text('')).mockImplementationOnce(() => text());
    const { app } = setup({ metadata, response });
    expect((await inspect(app)).body.text.accessible).toBe(true);
    expect(response).toHaveBeenCalledTimes(2);
  });
  it.each(['access-restricted-item', 'nodownload'])('rejects %s without probing the listed text', async flag => {
    const metadata = structuredClone(fixture);
    metadata.metadata[flag] = 'true';
    const { app, fetchImpl } = setup({ metadata });
    expect((await inspect(app)).body.reasonCode).toBe('RESTRICTED_ACCESS');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(['inlibrary', 'printdisabled', 'borrow_only'].flatMap(collection => [{ collection }, { collection: [collection] }]))('rejects restricted collection $collection before fetching text', async ({ collection }) => {
    const metadata = structuredClone(fixture);
    metadata.metadata.collection = collection;
    const { app, fetchImpl } = setup({ metadata });
    expect((await inspect(app)).body).toMatchObject({ eligible: false, reasonCode: 'RESTRICTED_ACCESS' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not let a public-domain label bypass borrowing restrictions', async () => {
    const metadata = structuredClone(fixture);
    metadata.metadata['possible-copyright-status'] = 'NOT_IN_COPYRIGHT';
    metadata.metadata['access-restricted-item'] = 'true';
    const { app, fetchImpl } = setup({ metadata });
    expect((await inspect(app)).body).toMatchObject({ eligible: false, reasonCode: 'RESTRICTED_ACCESS' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported or private files', async () => {
    const metadata = structuredClone(fixture);
    metadata.files = [{ name: 'book.pdf' }, { name: 'book.txt', private: 'true' }];
    expect((await inspect(setup({ metadata }).app)).body.reasonCode).toBe('NO_SUPPORTED_TEXT');
  });
  it.each([
    ['HTML', () => text('<html><body>Sign in</body></html>'.repeat(10)), 'TEXT_UNUSABLE'],
    ['empty text', () => text('  '), 'TEXT_UNUSABLE'],
    ['binary', () => text('\x00'.repeat(100)), 'TEXT_UNUSABLE'],
    ['wrong type', () => text(passage, { 'content-type': 'application/pdf' }), 'TEXT_UNUSABLE'],
    ['oversized', () => text(passage, { 'content-length': String(11 * 1024 * 1024) }), 'FILE_TOO_LARGE'],
    ['forbidden', () => new Response('', { status: 403 }), 'RESTRICTED_ACCESS'],
    ['missing', () => new Response('', { status: 404 }), 'DOWNLOAD_UNAVAILABLE'],
  ])('rejects %s', async (_label, response, code) => {
    expect((await inspect(setup({ response }).app)).body.reasonCode).toBe(code);
  });
  it('does not follow redirects outside Archive', async () => {
    const { app, fetchImpl } = setup({ response: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
    expect((await inspect(app)).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('follows the Archive dn download hosts used by the live edition', async () => {
    const response = vi.fn().mockImplementationOnce(() => new Response(null, { status: 302, headers: { location: 'https://dn760003.eu.archive.org/0/items/noteway-test-edition/book.txt' } })).mockImplementationOnce(() => text());
    const { app, fetchImpl } = setup({ response });
    expect((await inspect(app)).body.eligible).toBe(true);
    expect(fetchImpl.mock.calls[2][0].hostname).toBe('dn760003.eu.archive.org');
  });
  it.each([429, 503])('keeps transient %s failures retryable', async status => {
    const { app } = setup({ response: () => new Response('', { status }) });
    const response = await inspect(app);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ARCHIVE_UNAVAILABLE');
    expect(response.body.eligible).toBeUndefined();
  });
  it('handles missing editions and malformed metadata separately', async () => {
    expect((await inspect(setup({ metadata: [] }).app)).status).toBe(404);
    expect((await inspect(setup({ metadata: { unexpected: true } }).app)).status).toBe(503);
  });
  it('rejects malformed search data', async () => {
    expect((await request(setup({ search: {} }).app).get('/api/books/search?q=book')).status).toBe(503);
  });
});
