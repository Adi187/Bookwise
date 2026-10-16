import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/context.js';
import { useSource } from '../hooks/useSource.js';
import { askQuestion } from '../api/questions.js';
import BookIdentity from '../components/books/BookIdentity.jsx';
import SourcePassage from '../components/qa/SourcePassage.jsx';
import Button from '../components/ui/Button.jsx';
import ErrorMessage from '../components/ui/ErrorMessage.jsx';
import StatusBadge from '../components/ui/StatusBadge.jsx';
function Workspace({ id }) {
  const { request } = useAuth();
  const state = useSource(id);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(event) {
    event?.preventDefault();
    if (pending) return;
    if (!question.trim() || question.trim().length > 2000) { setFieldError('Enter a question of 1–2000 characters.'); return; }
    setPending(true); setError(''); setFieldError(''); setAnswer(null);
    controller.current = new AbortController();
    try { setAnswer(await askQuestion(request, id, question.trim(), controller.current.signal)); }
    catch (error) { if (error.name !== 'AbortError') setError(error.message); }
    finally { setPending(false); }
  }
  return <div className="page-stack max-w-[72ch]">
    <Link to={`/library/${id}`} className="text-link">← {state.source?.title || 'Book details'}</Link>
    {state.status === 'loading' && <p role="status">Loading book…</p>}
    {state.status === 'error' && <ErrorMessage onRetry={state.refresh}>{state.error}</ErrorMessage>}
    {state.source && <><BookIdentity book={state.source} />
      {state.source.status !== 'READY' && <div role="status" className="space-y-4"><StatusBadge status={state.source.status} /><p>Questions become available when the book is ready.</p><Link className="text-link" to="/library">View in Library</Link></div>}
      <form onSubmit={submit} className="space-y-4"><label htmlFor="question" className="block text-xl font-semibold tracking-tight">Ask this book</label>
        <textarea id="question" placeholder="Ask a question about this book…" value={question} maxLength={2000} onChange={event => { setQuestion(event.target.value); setFieldError(''); }} disabled={pending || state.source.status !== 'READY'} aria-invalid={!!fieldError} aria-describedby={fieldError ? 'question-error' : undefined} />
        {fieldError && <p id="question-error" role="alert" className="text-danger">{fieldError}</p>}
        <div className="flex justify-end"><Button type="submit" className="w-full sm:w-auto" disabled={state.source.status !== 'READY'} loading={pending}>{pending ? 'Asking…' : 'Ask'}</Button></div>
      </form>
    </>}
    {pending && <p role="status" className="text-secondary">Finding an answer in this book…</p>}
    {error && <ErrorMessage onRetry={() => submit()}>{error}</ErrorMessage>}
    {answer && <div className="page-stack" aria-live="polite">
      <section className="space-y-4"><h2>Question</h2><p className="whitespace-pre-wrap text-secondary">{answer.question}</p></section>
      <section className="space-y-4"><h2>Answer</h2><p className="whitespace-pre-wrap leading-7">{answer.answer}</p>
        {answer.insufficientEvidence && <p className="text-sm text-secondary">Try asking the question differently or ask about something else in the book.</p>}
      </section>
      {!!answer.references.length && <section className="space-y-4"><h2>Sources</h2><div className="space-y-3">{answer.references.map((reference, index) => <SourcePassage key={reference.chunkId} reference={reference} number={index + 1} identifier={state.source.archiveIdentifier} />)}</div></section>}
    </div>}
  </div>;
}
export default function BookQAPage() { const { sourceId } = useParams(); return <Workspace key={sourceId} id={sourceId} />; }
