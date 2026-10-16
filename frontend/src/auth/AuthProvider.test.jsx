import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthProvider from './AuthProvider.jsx';
import { useAuth } from './context.js';
function Account() {
  const { user, logout } = useAuth();
  return <><p>{user ? user.email : 'Signed out'}</p><button onClick={logout}>Log out</button></>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('restores login after remount without storing credentials in browser storage', async () => {
  const fetchMock = vi.fn(async () => Response.json({ user: { id: 'reader', email: 'reader@example.test' } }));
  vi.stubGlobal('fetch', fetchMock);
  const first = render(<AuthProvider><Account /></AuthProvider>);
  expect(await screen.findByText('reader@example.test')).toBeTruthy();
  first.unmount();
  render(<AuthProvider><Account /></AuthProvider>);
  expect(await screen.findByText('reader@example.test')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  expect(localStorage.length).toBe(0);
});
it('revokes the server session before displaying signed out', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ user: { id: 'reader', email: 'reader@example.test' } }))
    .mockResolvedValueOnce(Response.json({ message: 'Signed out.' }));
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthProvider><Account /></AuthProvider>);
  await screen.findByText('reader@example.test');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Log out' }));
  expect(await screen.findByText('Signed out')).toBeTruthy();
  expect(fetchMock.mock.calls[1][0]).toContain('/auth/logout');
});
