import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../app/App.jsx';
import AuthProvider from '../../auth/AuthProvider.jsx';
import { AuthContext } from '../../auth/context.js';

const book = { archiveIdentifier: 'lantern', title: 'The Lantern Library', author: 'Mira', year: null, eligible: true };
const source = { ...book, id: 'source-id', status: 'READY', canRetry: false, errorMessage: null };
const answer = { question: 'What color is the lantern?', answer: 'The lantern is blue.', insufficientEvidence: false,
  references: [{ chunkId: 'chunk-1', chapter: null, excerpt: 'The blue lantern marked the way home.' }] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const list = items => ({ items, page: 1, hasMore: false });
function start(path, request) {
  render(<MemoryRouter initialEntries={[path]}><AuthContext.Provider value={{ user: { id: 'reader', email: 'reader@example.test' }, request, logout: vi.fn() }}><App /></AuthContext.Provider></MemoryRouter>);
  return userEvent.setup();
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); document.documentElement.classList.remove('dark', 'light'); });

it('registers and enters the library, keeping the access token out of storage', async () => {
  const fetchMock = vi.fn(async path => path.endsWith('/auth/register') ? json({ token: 'test-token', user: { id: 'reader', email: 'reader@example.test' } }) : json(list([])));
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/register']}><AuthProvider><App /></AuthProvider></MemoryRouter>);
  const user = userEvent.setup();
  await screen.findByLabelText('Email');
  await user.type(screen.getByLabelText('Email'), 'reader@example.test');
  await user.type(screen.getByLabelText('Password'), 'my-long-password');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByRole('heading', { name: 'Your Library' })).toBeTruthy();
  expect(await screen.findByText('Your library starts with a book')).toBeTruthy();
  expect(fetchMock.mock.calls.find(([path]) => path.includes('/sources'))[1].credentials).toBe('include');
  expect(localStorage.length).toBe(0);
});
it('adds at Book Details and shows the persisted processing state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ book })));
  const request = vi.fn(async (path, options) => options?.body ? { source: { ...source, status: 'PROCESSING' } } : list(path.includes('identifiers') ? [] : [{ ...source, status: 'PROCESSING' }]));
  const user = start('/books/lantern', request);
  expect(await screen.findByText('Available for Noteway', { exact: false })).toBeTruthy();
  expect(screen.queryByText('Unknown year')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add to Library' }));
  expect(await screen.findByRole('heading', { name: 'Your Library' })).toBeTruthy();
  expect(await screen.findByText('Preparing book…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ask this book' }).disabled).toBe(true);
  expect(request).toHaveBeenCalledWith('/sources', { body: { archiveIdentifier: 'lantern' } });
});
it('keeps book context and offers retry after an add fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ book })));
  const request = vi.fn(async (_path, options) => { if (options?.body) throw new Error('Please try again.'); return list([]); });
  const user = start('/books/lantern', request);
  await user.click(await screen.findByRole('button', { name: 'Add to Library' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'The Lantern Library' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try adding again' })).toBeTruthy();
});
it('does not offer Add for a saved edition or perform another Archive check', async () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  start('/books/lantern', async () => list([source]));
  expect(await screen.findByText('In your library')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Ask this book' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add to Library' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('renders plain answers with separately numbered expandable sources and exact provenance', async () => {
  const request = vi.fn(async path => path.endsWith('/questions') ? answer : { source });
  const user = start('/library/source-id/ask', request);
  await screen.findByRole('heading', { name: 'The Lantern Library' });
  await user.type(screen.getByLabelText('Ask this book'), answer.question);
  await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
  expect(await screen.findByText(answer.answer)).toBeTruthy();
  expect(screen.getByText(answer.answer).textContent).not.toContain('[1]');
  const summary = screen.getByText('[1] Supporting passage');
  await user.click(summary);
  expect(summary.closest('details').open).toBe(true);
  expect(screen.getByText(answer.references[0].excerpt)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Internet Archive/ }).href).toBe('https://archive.org/details/lantern');
  expect(screen.queryByText('chunk-1')).toBeNull();
});
it('replaces the previous answer with a valid insufficient-evidence result without error styling', async () => {
  let calls = 0;
  const request = async path => path.endsWith('/questions') ? (++calls === 1 ? answer : { ...answer, answer: 'Not enough evidence.', insufficientEvidence: true, references: [] }) : { source };
  const user = start('/library/source-id/ask', request);
  await screen.findByRole('heading', { name: 'The Lantern Library' });
  await user.type(screen.getByLabelText('Ask this book'), answer.question);
  await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
  await screen.findByText(answer.answer);
  await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
  expect(await screen.findByText('Not enough evidence.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Sources' })).toBeNull();
  expect(screen.queryByText(answer.answer)).toBeNull();
});
it('preserves the question after a failure and disables duplicate submissions while pending', async () => {
  let reject;
  const request = async path => path.endsWith('/questions') ? new Promise((_resolve, r) => { reject = r; }) : { source };
  const user = start('/library/source-id/ask', request);
  await screen.findByRole('heading', { name: 'The Lantern Library' });
  await user.type(screen.getByLabelText('Ask this book'), answer.question);
  await user.click(screen.getByRole('button', { name: 'Ask', exact: true }));
  expect(screen.getByRole('button', { name: 'Asking…' }).disabled).toBe(true);
  reject(new Error('Please try again.'));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByLabelText('Ask this book').value).toBe(answer.question);
});
it('redirects protected pages to sign in and clears an expired session', async () => {
  vi.stubGlobal('fetch', vi.fn(async path => path.endsWith('/auth/login') ? json({ token: 'expired', user: { id: 'reader', email: 'reader@example.test' } }) : json({ error: { code: 'UNAUTHORIZED' } }, 401)));
  render(<MemoryRouter initialEntries={['/library']}><AuthProvider><App /></AuthProvider></MemoryRouter>);
  const user = userEvent.setup();
  expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
  await user.type(screen.getByLabelText('Email'), 'reader@example.test');
  await user.type(screen.getByLabelText('Password'), 'my-long-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeTruthy());
  expect(screen.queryByRole('heading', { name: 'Your Library' })).toBeNull();
});
it('persists a user-selected theme and exposes keyboard-operable account actions', async () => {
  const user = start('/library', async () => list([]));
  await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem('noteway-theme')).toBe('dark');
  await user.click(screen.getByRole('button', { name: 'Account' }));
  expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Account' }));
});

it('polls only preparing books and cancels polling after the edition becomes ready', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValueOnce(list([{ ...source, status: 'PROCESSING' }])).mockResolvedValue(list([source]));
  await act(async () => { start('/library', request); });
  expect(screen.getByText('Preparing book…')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole('link', { name: 'Ask this book →' })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(request).toHaveBeenCalledTimes(2);
});
it('cancels the pending library request on unmount', async () => {
  const request = vi.fn(() => new Promise(() => {}));
  start('/library', request);
  const signal = request.mock.calls[0][1].signal;
  cleanup();
  expect(signal.aborted).toBe(true);
});
it('offers preparation retry only when the backend permits it', async () => {
  start('/library', async () => list([{ ...source, status: 'FAILED', canRetry: false, errorMessage: 'Try another edition.' }]));
  expect(await screen.findByText('Failed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry preparation' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Ask this book' }).disabled).toBe(true);
});
