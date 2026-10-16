import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../app/App.jsx';
import { AuthContext } from '../../auth/context.js';
const libraryRequest = async () => ({ items: [], page: 1, hasMore: false });

const edition = { archiveIdentifier: 'fixture-edition', title: 'The Lantern Library', author: 'Mira', year: '1901', eligibility: { eligible: true, validation: { scope: 'full' }, text: { accessible: true } } };
const results = { items: [edition], page: 1, hasMore: false };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function start(path = '/search') { render(<MemoryRouter initialEntries={[path]}><AuthContext.Provider value={{ user: { id: 'reader', email: 'reader@example.test' }, request: libraryRequest }}><App /></AuthContext.Provider></MemoryRouter>); return userEvent.setup(); }
async function search(user, value) {
  await user.clear(screen.getByLabelText('Topic, genre, title or author'));
  await user.type(screen.getByLabelText('Topic, genre, title or author'), value);
  await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('automatically checked search results', () => {
  it('shows accessible results without an inspection button or second request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(results));
    vi.stubGlobal('fetch', fetchMock);
    const user = start();
    await search(user, 'Lantern');
    expect(await screen.findByText('The Lantern Library')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect edition' })).toBeNull();
    expect(screen.getByRole('link', { name: 'View book →' })).toBeTruthy();
    expect(screen.queryByText('fixture-edition')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects a successful payload containing an unchecked result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...results, items: [{ ...edition, eligibility: { eligible: false, text: { accessible: false } } }] })));
    start('/search?q=Lantern');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('The Lantern Library')).toBeNull();
  });
  it('rejects sample-only evidence even when eligible is true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...results, items: [{ ...edition, eligibility: { eligible: true, text: { accessible: true } } }] })));
    start('/search?q=Lantern');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('The Lantern Library')).toBeNull();
  });
  it('shows verified results progressively and keeps them when a later check fails', async () => {
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })));
    start('/search?q=Lantern');
    const send = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
    await act(async () => { send({ ...results, items: [], complete: false }); });
    expect(screen.queryByText('The Lantern Library')).toBeNull();
    await act(async () => { send({ ...results, complete: false }); });
    expect(await screen.findByText('The Lantern Library')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Searching…' }).disabled).toBe(true);
    await act(async () => { send({ error: { code: 'ARCHIVE_UNAVAILABLE' } }); controller.close(); });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('The Lantern Library')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
  it('handles split stream records and finishes the checking state', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ ...results, complete: true }) + '\n');
    const stream = new ReadableStream({ start(controller) { controller.enqueue(encoded.slice(0, 31)); controller.enqueue(encoded.slice(31)); controller.close(); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })));
    start('/search?q=Lantern');
    expect(await screen.findByText(/1 available editions/)).toBeTruthy();
    expect(screen.queryByText(/verified so far/)).toBeNull();
  });
  it('does not treat a truncated stream as a completed empty result', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ items: [], page: 1, hasMore: false, complete: false }) + '\n')); controller.close(); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })));
    start('/search?q=Lantern');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/No available editions found/)).toBeNull();
  });
  it('shows empty results without claiming the whole catalog was exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], page: 1, hasMore: true })));
    start('/search?q=zznothing');
    expect(await screen.findByText(/No available editions found/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).disabled).toBe(false);
  });
  it('shows loading and recovers from an automatic-check outage', async () => {
    let finish;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json(results)));
    const user = start('/search?q=Lantern');
    expect(screen.getByRole('button', { name: 'Searching…' }).disabled).toBe(true);
    finish(json({ error: { code: 'ARCHIVE_UNAVAILABLE' } }, 503));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The Lantern Library')).toBeTruthy();
  });
  it('ignores a stale search response after the query changes', async () => {
    let finish;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json({ items: [], page: 1, hasMore: false }));
    vi.stubGlobal('fetch', fetchMock);
    const user = start('/search?q=Lantern');
    await search(user, 'zznothing');
    expect(await screen.findByText(/No available editions found/)).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    finish(json(results));
    await waitFor(() => expect(screen.queryByText('The Lantern Library')).toBeNull());
  });
  it('rejects too-short searches without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = start();
    await search(user, 'a');
    expect(await screen.findByText('Enter between 2 and 120 characters.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it('displays available books without an incomplete-search notice when some checks fail', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...results, failedChecks: 1 })));
  start('/search?q=mathematics');
  expect(await screen.findByText('The Lantern Library')).toBeTruthy();
  expect(await screen.findByText(/1 available editions/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('shows metadata-checked books without requiring full preparation during search', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...results, items: [{ ...edition,
    eligibility: { eligible: true, validation: { scope: 'metadata' }, text: { available: true } } }] })));
  start('/search?q=computer+science');
  expect(await screen.findByText('The Lantern Library')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'View book →' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
