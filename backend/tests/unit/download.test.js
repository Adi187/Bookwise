import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createArchiveService, MAX_BOOK_BYTES } from '../../src/books/archive.js';

const body = 'Chapter One\n\nMira entered the library to find the map. The keeper left the blue lantern beside the door.\n'.repeat(100);
function setup({ fullBody = body, sha1 = createHash('sha1').update(fullBody).digest('hex'), restricted = false, download, fileOverrides = {} } = {}) {
  const metadata = { metadata: { identifier: 'fixture-book', title: 'Fixture book', creator: 'Noteway', mediatype: 'texts', 'access-restricted-item': restricted }, files: [{ name: 'book.txt', size: String(Buffer.byteLength(fullBody)), sha1, ...fileOverrides }] };
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.pathname.startsWith('/metadata')) return new Response(JSON.stringify(metadata));
    if (options.headers?.Range) return new Response(Buffer.from(body).subarray(0, 8192), { status: 206, headers: { 'content-type': 'text/plain', 'content-range': `bytes 0-8191/${Buffer.byteLength(fullBody)}` } });
    return download ? download() : new Response(fullBody, { headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(fullBody)) } });
  });
  return { archive: createArchiveService({ fetchImpl }), fetchImpl };
}

describe('full Archive text validation', () => {
  it('downloads complete text and calculates the declared SHA-1', async () => {
    const { archive, fetchImpl } = setup();
    const result = await archive.downloadText('fixture-book');
    expect(result.text).toBe(body);
    expect(result.sha1).toBe(createHash('sha1').update(body).digest('hex'));
    expect(result.sizeBytes).toBe(Buffer.byteLength(body));
    expect(fetchImpl.mock.calls[2][1].headers.Range).toBeUndefined();
  });
  it('rejects restricted metadata before probing or downloading', async () => {
    const { archive, fetchImpl } = setup({ restricted: true });
    await expect(archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'RESTRICTED_ACCESS' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('validates command identifiers before any request', async () => {
    const { archive, fetchImpl } = setup();
    await expect(archive.downloadText('../bad')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects a checksum mismatch', async () => {
    await expect(setup({ sha1: 'a'.repeat(40) }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });
  it('requires checksum evidence before the full request', async () => {
    const { archive, fetchImpl } = setup({ fileOverrides: { sha1: undefined } });
    await expect(archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'CHECKSUM_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects bad text later than the preflight sample', async () => {
    await expect(setup({ fullBody: body + '\0hidden binary' }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'TEXT_UNUSABLE' });
  });
  it('rejects invalid UTF-8 even when the checksum matches', async () => {
    const fullBody = Buffer.concat([Buffer.from(body), Buffer.from([0xff])]);
    await expect(setup({ fullBody }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'TEXT_UNUSABLE' });
  });
  it('rejects a truncated complete response', async () => {
    const download = () => new Response(body.slice(0, -10), { headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(body)) } });
    await expect(setup({ download }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'DOWNLOAD_UNAVAILABLE' });
  });
  it('caps actual streamed bytes even without Content-Length', async () => {
    let cancelled = false;
    const download = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BOOK_BYTES + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/plain' } });
    await expect(setup({ download }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });
  it.each([401, 403, 206, 404])('rejects full-download status %s', async status => {
    const download = () => new Response('', { status });
    await expect(setup({ download }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: [401, 403].includes(status) ? 'RESTRICTED_ACCESS' : 'DOWNLOAD_UNAVAILABLE' });
  });
  it('rejects provider outage as a retryable error', async () => {
    await expect(setup({ download: () => new Response('', { status: 503 }) }).archive.downloadText('fixture-book')).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
  });
});
