import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/context.js';
import { listSources, retrySource } from '../api/sources.js';
import Button from '../components/ui/Button.jsx';
import StatusBadge from '../components/ui/StatusBadge.jsx';
import ErrorMessage from '../components/ui/ErrorMessage.jsx';
function LibraryBook({ source, onRetry }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    if (pending) return;
    setPending(true); setError('');
    try { await onRetry(source.id); } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <li className="flex min-w-0 flex-col gap-4 rounded-card border border-subtle bg-surface p-6 transition-colors hover:border-primary/40">
    <div className="space-y-2"><h2 className="text-lg leading-6 tracking-normal"><Link className="hover:text-primary hover:underline" to={`/library/${source.id}`}>{source.title}</Link></h2><p className="text-sm text-secondary">{source.author}</p></div>
    <div><StatusBadge status={source.status} /></div>
    {source.status === 'FAILED' && <p className="text-sm text-secondary">{source.errorMessage}</p>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <div className="mt-auto flex flex-wrap gap-2">
      {source.status === 'READY' ? <Button variant="ghost" to={`/library/${source.id}/ask`}>Ask this book →</Button>
        : source.canRetry ? <Button variant="ghost" onClick={retry} loading={pending}>{pending ? 'Adding…' : 'Retry preparation'}</Button> : <Button disabled>Ask this book</Button>}
    </div>
  </li>;
}
function Library({ page }) {
  const { request } = useAuth();
  const [, setParams] = useSearchParams();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const data = await listSources(request, { page, signal: controller.signal });
        if (!controller.signal.aborted) {
          setState({ status: 'success', data });
          if (data.items.some(source => source.status === 'PROCESSING')) timer = setTimeout(load, 3000);
        }
      } catch (error) { if (!controller.signal.aborted) setState(previous => ({ ...previous, status: 'error', error: error.message })); }
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [request, page, attempt]);
  async function retry(id) { await retrySource(request, id); setAttempt(a => a + 1); }
  return <div className="page-stack">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h1>Your Library</h1><p className="text-secondary">Your books, ready for a closer reading.</p></div><Button to="/search">Find a book</Button></div>
    {state.status === 'loading' && <p role="status">Loading your books…</p>}
    {state.status === 'error' && <ErrorMessage onRetry={() => setAttempt(a => a + 1)}>{state.error}</ErrorMessage>}
    {state.data && <>
      {!state.data.items.length && <section className="rounded-card border border-subtle bg-surface px-6 py-12 text-center"><h2>{page === 1 ? 'Your library starts with a book' : 'No books on this page'}</h2><p className="mt-4 text-secondary">Find an available edition, add it to your library, and ask about what’s inside.</p><Link className="text-link mt-4" to="/search">Find a book →</Link></section>}
      <p className="sr-only" role="status">{state.data.items.filter(s => s.status === 'READY').length} books ready. {state.data.items.filter(s => s.status === 'PROCESSING').length} preparing. {state.data.items.filter(s => s.status === 'FAILED').length} failed.</p>
      <ul className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">{state.data.items.map(source => <LibraryBook key={source.id} source={source} onRetry={retry} />)}</ul>
      {(page > 1 || state.data.hasMore) && <nav className="flex items-center gap-4" aria-label="Library pages"><Button variant="ghost" disabled={page === 1} onClick={() => setParams({ page: String(page - 1) })}>Previous</Button><span className="text-sm text-secondary">Page {page}</span><Button variant="ghost" disabled={!state.data.hasMore || page >= 9999} onClick={() => setParams({ page: String(page + 1) })}>Next</Button></nav>}
    </>}
  </div>;
}
export default function LibraryPage() {
  const [params] = useSearchParams();
  const page = Number(params.get('page') || 1);
  if (!Number.isInteger(page) || page < 1 || page > 9999) return <ErrorMessage>Invalid page. <Link to="/library" className="text-link">Return to Library</Link></ErrorMessage>;
  return <Library key={page} page={page} />;
}
