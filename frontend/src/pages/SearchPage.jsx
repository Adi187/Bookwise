import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { searchBooks } from '../api/books.js';
import { listSources } from '../api/sources.js';
import { useAuth } from '../auth/context.js';
import Button from '../components/ui/Button.jsx';
import ErrorMessage from '../components/ui/ErrorMessage.jsx';
function Results({ items }) {
  const location = useLocation();
  const { request } = useAuth();
  const identifiers = items.map(b => b.archiveIdentifier).join(',');
  const [membership, setMembership] = useState({});
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (!identifiers) return;
    listSources(request, { identifiers: identifiers.split(','), signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setMembership(Object.fromEntries(data.items.map(s => [s.archiveIdentifier, s]))); setError(''); }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [identifiers, request, attempt]);
  return <>
    {error && <ErrorMessage onRetry={() => setAttempt(a => a + 1)}>{error}</ErrorMessage>}
    <ul className="divide-y divide-subtle rounded-card border border-subtle bg-surface">
      {items.map(book => <li className="flex flex-col justify-between gap-4 p-6 sm:flex-row sm:items-center" key={book.archiveIdentifier}>
        <div className="min-w-0 space-y-2"><h2 className="text-lg leading-6 tracking-normal">{book.title}</h2><p className="text-sm text-secondary">{book.author}{book.year ? ` · ${book.year}` : ''}</p>{membership[book.archiveIdentifier] && <p className="text-sm text-secondary">Already in your library</p>}</div>
        <Button variant="ghost" className="shrink-0" state={{ from: `${location.pathname}${location.search}` }} to={membership[book.archiveIdentifier] ? '/library' : `/books/${encodeURIComponent(book.archiveIdentifier)}`}>{membership[book.archiveIdentifier] ? 'View in Library' : 'View book →'}</Button>
      </li>)}
    </ul>
  </>;
}
function SearchResults({ query, page, onPending }) {
  const [, setParams] = useSearchParams();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    searchBooks(query, page, controller.signal, data => {
      if (!controller.signal.aborted) setState({ status: data.complete ? 'success' : 'checking', data });
    }).then(data => { if (!controller.signal.aborted) setState({ status: 'success', data }); })
      .catch(error => { if (!controller.signal.aborted) setState(previous => ({ status: 'error', data: previous.data, error: error.message })); });
    return () => controller.abort();
  }, [query, page, attempt]);
  const { items, hasMore } = state.data || { items: [], hasMore: false };
  const pending = state.status === 'loading' || state.status === 'checking';
  useEffect(() => { onPending(pending); return () => onPending(false); }, [pending, onPending]);
  const retry = () => { setState({ status: 'loading' }); setAttempt(a => a + 1); };
  return <section aria-label="Search results" className="space-y-8">
    {state.status === 'error' && <ErrorMessage onRetry={retry}>{state.error}</ErrorMessage>}
    <p role="status" className="text-sm text-secondary">{pending ? 'Searching…' : state.status === 'error' ? 'Search is incomplete.' : items.length ? `${items.length} available editions · Page ${page}` : 'No available editions found'}</p>
    {!!items.length && <Results items={items} />}
    {state.status === 'success' && !items.length && <p className="text-secondary">We couldn’t find a supported edition matching your search on this page. {hasMore ? 'Try the next page or another topic, title or author.' : 'Try another topic, title or author.'}</p>}
    {(page > 1 || hasMore) && <nav className="flex gap-4" aria-label="Search pages"><Button variant="ghost" disabled={page === 1} onClick={() => setParams({ q: query, page: String(page - 1) })}>Previous</Button><Button variant="ghost" disabled={pending || !hasMore || page >= 9999} onClick={() => setParams({ q: query, page: String(page + 1) })}>Next</Button></nav>}
  </section>;
}
function SearchForm({ query, onSearch, pending }) {
  const [draft, setDraft] = useState(query);
  const [error, setError] = useState('');
  function submit(event) {
    event.preventDefault();
    const value = draft.trim().replace(/\s+/g, ' ');
    if (value.length < 2 || value.length > 120) { setError('Enter between 2 and 120 characters.'); return; }
    setError(''); onSearch(value);
  }
  return <form onSubmit={submit} className="space-y-2"><label htmlFor="book-query" className="text-sm font-medium">Topic, genre, title or author</label>
    <div className="flex flex-col gap-4 sm:flex-row"><input id="book-query" type="search" maxLength={120} value={draft} onChange={event => { setDraft(event.target.value); setError(''); }} placeholder="e.g. maths, history, fantasy or The Time Machine" aria-invalid={!!error} aria-describedby={error ? 'query-error' : undefined} /><Button type="submit" loading={pending && draft.trim() === query}>{pending && draft.trim() === query ? 'Searching…' : 'Search'}</Button></div>
    {error && <p id="query-error" role="alert" className="text-danger">{error}</p>}
  </form>;
}
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [pending, setPending] = useState(false);
  const query = (params.get('q') || '').trim();
  const page = Number(params.get('page') || 1);
  const valid = query.length >= 2 && query.length <= 120 && Number.isInteger(page) && page >= 1 && page <= 9999;
  return <div className="page-stack"><div className="space-y-2"><h1>Find a book</h1><p className="text-secondary">Explore books by subject or genre, or search for a title or author.</p></div>
    <SearchForm key={query} query={query} pending={pending} onSearch={q => setParams({ q })} />
    {valid ? <SearchResults key={`${query}:${page}`} query={query} page={page} onPending={setPending} /> : <p role="status" className="text-secondary">{query ? 'Enter a valid search and page number.' : 'Search for a book to explore available editions.'}</p>}
  </div>;
}
