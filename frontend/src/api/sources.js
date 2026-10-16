const invalid = () => new Error('We could not load your library. Please try again.');
export function validateSource(source) {
  if (!source || typeof source.id !== 'string' || typeof source.archiveIdentifier !== 'string' || typeof source.title !== 'string' ||
      !['PROCESSING', 'READY', 'FAILED'].includes(source.status) || typeof source.canRetry !== 'boolean') throw invalid();
  return source;
}
export async function listSources(request, { page = 1, identifiers, signal } = {}) {
  const params = new URLSearchParams({ page });
  if (identifiers) { if (!identifiers.length) return { items: [], page, hasMore: false }; params.set('identifiers', identifiers.join(',')); }
  const data = await request(`/sources?${params}`, { signal });
  if (!Array.isArray(data?.items) || typeof data.hasMore !== 'boolean') throw invalid();
  return { ...data, items: data.items.map(validateSource) };
}
export async function getSource(request, id, signal) { return validateSource((await request(`/sources/${encodeURIComponent(id)}`, { signal }))?.source); }
export async function addSource(request, archiveIdentifier) { return validateSource((await request('/sources', { body: { archiveIdentifier } }))?.source); }
export async function retrySource(request, id) { return validateSource((await request(`/sources/${encodeURIComponent(id)}/retry`, { body: {} }))?.source); }
