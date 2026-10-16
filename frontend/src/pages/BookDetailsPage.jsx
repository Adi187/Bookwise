import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/context.js';
import { getBook } from '../api/books.js';
import { addSource, listSources } from '../api/sources.js';
import { useSource } from '../hooks/useSource.js';
import BookIdentity from '../components/books/BookIdentity.jsx';
import Button from '../components/ui/Button.jsx';
import ErrorMessage from '../components/ui/ErrorMessage.jsx';
import StatusBadge from '../components/ui/StatusBadge.jsx';
function Provenance({ identifier }) {
  return <section><h2>Source</h2><a className="text-link mt-2" href={`https://archive.org/details/${encodeURIComponent(identifier)}`} target="_blank" rel="noreferrer">Internet Archive <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span></a></section>;
}
function SavedDetails({ id }) {
  const state = useSource(id);
  return <div className="page-stack"><Link className="text-link" to="/library">← Library</Link>
    {state.status === 'loading' && <p role="status">Loading book…</p>}
    {state.status === 'error' && <ErrorMessage onRetry={state.refresh}>{state.error}</ErrorMessage>}
    {state.source && <><BookIdentity book={state.source} /><div role="status"><StatusBadge status={state.source.status} /></div>
      {state.source.status === 'FAILED' && <p className="text-danger">{state.source.errorMessage} Recovery options are in your Library.</p>}
      <Provenance identifier={state.source.archiveIdentifier} />
      {state.source.status === 'READY' ? <Button to={`/library/${id}/ask`}>Ask this book</Button> : <Button disabled>Ask this book</Button>}
    </>}
  </div>;
}
function NewDetails({ identifier }) {
  const { request } = useAuth();
  const location = useLocation();
  const back = /^\/search(?:\?|$)/.test(location.state?.from || '') ? location.state.from : '/search';
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const saved = await listSources(request, { identifiers: [identifier], signal: controller.signal });
      if (saved.items.length) return { book: saved.items[0], source: saved.items[0] };
      return { book: await getBook(identifier, controller.signal) };
    }
    load().then(data => { if (!controller.signal.aborted) setState({ status: 'success', ...data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ status: 'error', error: error.message }); });
    return () => controller.abort();
  }, [identifier, request, attempt]);
  async function add() {
    if (pending) return;
    setPending(true); setError('');
    try { await addSource(request, identifier); navigate('/library'); }
    catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <div className="page-stack"><Link to={back} className="text-link">← Search results</Link>
    {state.status === 'loading' && <p role="status">Loading book…</p>}
    {state.status === 'error' && <ErrorMessage onRetry={() => { setState({ status: 'loading' }); setAttempt(a => a + 1); }}>{state.error}</ErrorMessage>}
    {state.book && <><BookIdentity book={state.book} />
      {state.source ? <div className="space-y-4"><p>In your library</p><StatusBadge status={state.source.status} /></div> : <div className="max-w-xl space-y-2"><p className="font-medium text-success">✓ Available for Noteway</p><p className="text-secondary">This edition has been verified and can be prepared for asking questions about its contents.</p></div>}
      <Provenance identifier={identifier} />
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {state.source ? <div className="flex flex-wrap gap-4">{state.source.status === 'READY' && <Button to={`/library/${state.source.id}/ask`}>Ask this book</Button>}<Button variant="ghost" to="/library">View in Library</Button></div> : <Button className="w-full sm:w-auto" loading={pending} onClick={add}>{pending ? 'Adding…' : error ? 'Try adding again' : 'Add to Library'}</Button>}
    </>}
  </div>;
}
export default function BookDetailsPage() {
  const { identifier, sourceId } = useParams();
  return sourceId ? <SavedDetails key={sourceId} id={sourceId} /> : <NewDetails key={identifier} identifier={identifier} />;
}
