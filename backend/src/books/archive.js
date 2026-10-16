import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readableText } from './text.js';
import { buildSearchQuery, rankSearchResults } from './search-query.js';
import { createBookValidator } from './validation.js';
import { BookError } from './errors.js';
export { BookError } from './errors.js';

const ORIGIN = 'https://archive.org';
export const MAX_BOOK_BYTES = 10 * 1024 * 1024;
const SAMPLE_BYTES = 8192;
const PAGE_SIZE = 20;
export const validIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const strings = value => (Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string');
const label = value => strings(value).join(', ').slice(0, 500);
const flagged = value => [true, 1, 'true', '1'].includes(value);
const unavailable = () => new BookError(503, 'ARCHIVE_UNAVAILABLE', 'Internet Archive is temporarily unavailable. Please try again.');

export function createArchiveService({ fetchImpl = fetch, maxTokens = Number(process.env.MAX_EMBEDDING_TOKENS || 1000000), validationOptions = {} } = {}) {
  // Only Archive HTTPS hosts; never forward credentials or follow an arbitrary URL.
  async function request(url, options = {}, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try { return await requestOnce(url, options, Math.max(1, deadline - Date.now())); }
      catch (error) {
        if (attempt >= 2 || error.retryable === false || Date.now() + 250 * 2 ** attempt >= deadline) throw error;
        await delay(250 * 2 ** attempt);
      }
    }
  }
  async function requestOnce(url, options = {}, timeoutMs = 12000) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password || target.port ||
            !(target.hostname === 'archive.org' || /^(?:ia|dn)\d+\.[a-z0-9-]+\.archive\.org$/.test(target.hostname))) {
          const error = unavailable();
          error.retryable = false;
          throw error;
        }
        const response = await fetchImpl(target, { ...options, signal, redirect: 'manual' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location) throw unavailable();
          url = new URL(location, target).href;
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          throw unavailable();
        }
        return response;
      }
      throw unavailable();
    } catch (error) { throw error instanceof BookError ? error : unavailable(); }
  }

  async function json(url, timeoutMs = 12000) {
    const response = await request(url, {}, timeoutMs);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new BookError(404, 'BOOK_NOT_FOUND', 'This edition could not be found.');
    }
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    // Bound metadata/search responses as well as text samples.
    try {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) throw unavailable();
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw unavailable(); }
  }

  async function probe(identifier, file) {
    const response = await request(`${ORIGIN}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}`, {
      headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}`, 'Accept-Encoding': 'identity' },
    });
    const reject = async reasonCode => { await response.body?.cancel(); return { accessible: false, reasonCode }; };
    if ([401, 403].includes(response.status)) return reject('RESTRICTED_ACCESS');
    if (![200, 206].includes(response.status)) return reject('DOWNLOAD_UNAVAILABLE');
    if (!/^text\/plain(?:;|$)/i.test(response.headers.get('content-type') || '')) return reject('TEXT_UNUSABLE');
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const total = response.status === 206 ? Number(range?.[2]) : Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(total) || total <= 0 || (response.status === 206 && (!range || Number(range[1]) >= SAMPLE_BYTES))) return reject('DOWNLOAD_UNAVAILABLE');
    if (total > MAX_BOOK_BYTES) return reject('FILE_TOO_LARGE');
    const chunks = [];
    let size = 0;
    try {
      const reader = response.body.getReader();
      try {
        while (size < SAMPLE_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, SAMPLE_BYTES - size);
          chunks.push(chunk);
          size += chunk.length;
        }
      } finally { await reader.cancel(); }
    } catch { throw unavailable(); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (size !== Math.min(total, SAMPLE_BYTES)) return { accessible: false, reasonCode: 'DOWNLOAD_UNAVAILABLE' };
    if (!readableText(text)) return { accessible: false, reasonCode: 'TEXT_UNUSABLE' };
    return { accessible: true, reasonCode: null, filename: file.name, sizeBytes: total, sampleBytes: size };
  }

  async function inspectMetadata(identifier, timeoutMs) {
    if (!validIdentifier(identifier)) throw new BookError(400, 'VALIDATION_ERROR', 'Invalid Archive identifier.');
    const data = await json(`${ORIGIN}/metadata/${encodeURIComponent(identifier)}`, timeoutMs);
    if ((Array.isArray(data) && data.length === 0) || (data && Object.keys(data).length === 0)) throw new BookError(404, 'BOOK_NOT_FOUND', 'This edition could not be found.');
    if (data?.error || !data?.metadata || data.metadata.identifier !== identifier || !Array.isArray(data.files)) throw unavailable();
    const metadata = data.metadata;
    return { data, metadata };
  }

  function restricted(data, metadata) {
    return [data.is_dark, data.nodownload, metadata.is_dark, metadata.nodownload, metadata['access-restricted-item'], metadata.restricted].some(flagged) ||
      strings(metadata.collection).some(value => ['inlibrary', 'printdisabled', 'borrow_only'].includes(value));
  }

  function candidates(data) {
    return data.files.filter(file => typeof file?.name === 'string' && /^[^/\\]+\.txt$/i.test(file.name) && ![...file.name].some(char => char.charCodeAt(0) < 32) && !flagged(file.private))
      .sort((a, b) => Number(b.name.endsWith('_djvu.txt')) - Number(a.name.endsWith('_djvu.txt')));
  }

  const service = {
    async search(q, page, { onProgress = () => {}, signal } = {}) {
      const url = new URL('/advancedsearch.php', ORIGIN);
      url.search = new URLSearchParams({ q: buildSearchQuery(q), rows: String(PAGE_SIZE), page: String(page), output: 'json', 'sort[]': 'downloads desc' });
      for (const field of ['identifier', 'title', 'creator', 'year', 'subject', 'description']) url.searchParams.append('fl[]', field);
      const data = await json(url);
      if (!Array.isArray(data?.response?.docs) || !Number.isSafeInteger(data.response.numFound) || data.response.numFound < 0) throw unavailable();
      const seen = new Set();
      const items = rankSearchResults(data.response.docs.slice(0, PAGE_SIZE), q).filter(item => {
        if (!validIdentifier(item?.identifier) || seen.has(item.identifier)) return false;
        seen.add(item.identifier);
        return true;
      }).map(item => ({ archiveIdentifier: item.identifier, title: label(item.title) || 'Untitled edition', author: label(item.creator) || 'Unknown author', year: /\b\d{4}\b/.exec(String(item.year || ''))?.[0] || null }));
      // Keep Archive ordering, but expose only candidates that pass access checks.
      // Three workers bound outbound pressure. Isolate temporary candidate failures
      // and report incomplete checks without discarding verified results.
      const checked = new Array(items.length);
      let next = 0;
      let failedChecks = 0;
      let failure;
      const snapshot = () => ({ items: checked.filter(Boolean), page, hasMore: page * PAGE_SIZE < data.response.numFound, ...(failedChecks ? { failedChecks } : {}) });
      onProgress({ ...snapshot(), complete: false });
      await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
        while (!failure && !signal?.aborted && next < items.length) {
          const index = next++;
          try {
            const eligibility = await service.discover(items[index].archiveIdentifier);
            if (eligibility.eligible) checked[index] = { ...items[index], eligibility };
            if (!signal?.aborted) onProgress({ ...snapshot(), complete: false });
          } catch (error) {
            if (error instanceof BookError && ['ARCHIVE_UNAVAILABLE', 'VALIDATION_BUSY'].includes(error.code)) failedChecks++;
            else if (!(error instanceof BookError) || error.code !== 'BOOK_NOT_FOUND') failure = error;
          }
        }
      }));
      if (failure) throw failure;
      if (failedChecks && !checked.some(Boolean)) throw new BookError(503, 'BOOK_CHECKS_UNAVAILABLE', 'Some books could not be checked. Please try again.');
      return snapshot();
    },

    async discover(identifier) {
      const { data, metadata } = await inspectMetadata(identifier, 3000);
      if (restricted(data, metadata) || metadata.mediatype !== 'texts') return { eligible: false };
      const file = candidates(data).slice(0, 3).find(file => Number(file.size) > 0 &&
        Number(file.size) <= MAX_BOOK_BYTES && /^[a-f0-9]{40}$/i.test(file.sha1 || ''));
      return { archiveIdentifier: identifier, eligible: !!file, validation: { scope: 'metadata' },
        text: { available: !!file, ...(file ? { filename: file.name, sizeBytes: Number(file.size) } : {}) } };
    },
    async eligibility(identifier) {
      const { data, metadata } = await inspectMetadata(identifier);
      let text = { accessible: false, reasonCode: 'NO_SUPPORTED_TEXT' };
      if (restricted(data, metadata)) {
        text.reasonCode = 'RESTRICTED_ACCESS';
      } else if (metadata.mediatype === 'texts') {
        const files = candidates(data);
        // Limit remote probes per inspection; try alternatives if one listed file is unusable.
        for (const file of files.slice(0, 3)) {
          if (Number(file.size) > MAX_BOOK_BYTES) { text = { accessible: false, reasonCode: 'FILE_TOO_LARGE' }; continue; }
          if (!/^[a-f0-9]{40}$/i.test(file.sha1 || '')) { text = { accessible: false, reasonCode: 'CHECKSUM_UNAVAILABLE' }; continue; }
          text = await probe(identifier, file);
          if (text.accessible) break;
        }
      }
      return { archiveIdentifier: identifier, eligible: text.accessible, reasonCode: text.reasonCode, verifiedAt: new Date().toISOString(), text };
    },
    async downloadText(identifier) {
      // Fresh metadata and access checks; never trust the earlier browser preflight.
      const { data, metadata } = await inspectMetadata(identifier);
      const reject = code => new BookError(422, code, 'The complete text did not pass technical validation.');
      if (restricted(data, metadata)) throw reject('RESTRICTED_ACCESS');
      if (metadata.mediatype !== 'texts') throw reject('NO_SUPPORTED_TEXT');
      let failure = 'NO_SUPPORTED_TEXT';
      for (const file of candidates(data).slice(0, 3)) {
        if (Number(file.size) > MAX_BOOK_BYTES) { failure = 'FILE_TOO_LARGE'; continue; }
        const sample = await probe(identifier, file);
        if (!sample.accessible) { failure = sample.reasonCode; continue; }
        if (!/^[a-f0-9]{40}$/i.test(file.sha1 || '')) { failure = 'CHECKSUM_UNAVAILABLE'; continue; }
        const url = `${ORIGIN}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}`;
        const response = await request(url, { headers: { 'Accept-Encoding': 'identity' } }, 60000);
        const reader = response.body?.getReader();
        try {
          if ([401, 403].includes(response.status)) throw reject('RESTRICTED_ACCESS');
          if (response.status !== 200 || !reader) throw reject('DOWNLOAD_UNAVAILABLE');
          if (!/^text\/plain(?:;|$)/i.test(response.headers.get('content-type') || '') ||
              ![null, 'identity'].includes(response.headers.get('content-encoding'))) throw reject('TEXT_UNUSABLE');
          const lengthHeader = response.headers.get('content-length');
          const declared = lengthHeader === null ? null : Number(lengthHeader);
          if (declared !== null && (!Number.isSafeInteger(declared) || declared < 1)) throw reject('DOWNLOAD_UNAVAILABLE');
          if (declared > MAX_BOOK_BYTES) throw reject('FILE_TOO_LARGE');
          const buffers = [];
          const hash = createHash('sha1');
          let bytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > MAX_BOOK_BYTES) throw reject('FILE_TOO_LARGE');
            hash.update(value);
            buffers.push(value);
          }
          if (bytes !== sample.sizeBytes || (declared !== null && bytes !== declared) ||
              (file.size !== undefined && bytes !== Number(file.size))) throw reject('DOWNLOAD_UNAVAILABLE');
          const sha1 = hash.digest('hex');
          if (sha1 !== file.sha1.toLowerCase()) throw reject('CHECKSUM_MISMATCH');
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)); }
          catch { throw reject('TEXT_UNUSABLE'); }
          if (!readableText(text)) throw reject('TEXT_UNUSABLE');
          return { archiveIdentifier: identifier, title: label(metadata.title) || 'Untitled edition',
            author: label(metadata.creator) || 'Unknown author', year: String(metadata.year || metadata.date || '').match(/\d{4}/)?.[0] || null,
            sourceUrl: `${ORIGIN}/details/${encodeURIComponent(identifier)}`,
            filename: file.name, sizeBytes: bytes, sha1, text };
        } catch (error) {
          if (!(error instanceof BookError)) throw unavailable();
          failure = error.code;
        } finally { await reader?.cancel().catch(() => {}); }
      }
      throw reject(failure);
    },
  };
  service.validate = createBookValidator({ ...validationOptions, maxTokens, downloadText: identifier => service.downloadText(identifier) });
  return service;
}
