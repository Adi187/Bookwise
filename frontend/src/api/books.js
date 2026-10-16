import { get } from './client.js';

const invalid = () => new Error('The server returned unexpected book information. Please try again.');
function validate(data) {
  if (!Array.isArray(data?.items) || !Number.isInteger(data.page) || typeof data.hasMore !== 'boolean' ||
      !data.items.every(item => typeof item?.archiveIdentifier === 'string' && typeof item.title === 'string' && typeof item.author === 'string' && item.eligibility?.eligible === true && ((item.eligibility?.validation?.scope === 'metadata' && item.eligibility?.text?.available === true) || (item.eligibility?.validation?.scope === 'full' && item.eligibility?.text?.accessible === true)) && (item.year === null || typeof item.year === 'string'))) throw invalid();
  return data;
}

export async function searchBooks(q, page, signal, onProgress) {
  const data = await get(`/books/search?${new URLSearchParams({ q, page })}`, signal,
    onProgress ? event => onProgress(validate(event)) : undefined);
  return validate(data);
}

export async function getBook(identifier, signal) {
  const { book } = await get(`/books/${encodeURIComponent(identifier)}`, signal);
  if (!book || typeof book.title !== 'string' || typeof book.author !== 'string' || book.archiveIdentifier !== identifier || book.eligible !== true) throw invalid();
  return book;
}
