import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRequest } from '../api/client.js';
import { AuthContext } from './context.js';
export default function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const restore = useCallback(async signal => {
    try {
      const data = await accountRequest('/auth/session', { signal });
      if (!signal?.aborted) setSession(data.user ? { user: data.user } : null);
    } catch (error) {
      if (!signal?.aborted) {
        if (error.status === 401) setSession(null); else setError(error.message);
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void restore(controller.signal); });
    return () => controller.abort();
  }, [restore]);
  const logout = useCallback(async () => {
    try {
      await accountRequest('/auth/logout', { body: {} });
      generation.current++; setSession(null); setError('');
    } catch (error) { setError(error.message); }
  }, []);
  async function signIn(mode, credentials) {
    const data = await accountRequest(`/auth/${mode}`, { body: credentials });
    if (typeof data.user?.id !== 'string' || typeof data.user?.email !== 'string') throw new Error('Unexpected login response.');
    generation.current++; setSession({ user: data.user }); setError('');
  }
  const request = useCallback(async (path, options = {}) => {
    if (!session) throw new Error('Sign in to continue.');
    const current = generation.current;
    try { return await accountRequest(path, options); }
    catch (error) {
      if (error.status === 401 && generation.current === current) { generation.current++; setSession(null); }
      throw error;
    }
  }, [session]);
  if (loading) return <main className="p-8" role="status">Restoring your session…</main>;
  if (error && !session) return <main className="p-8 space-y-4"><p role="alert">{error}</p><button onClick={() => { setError(''); setLoading(true); void restore(); }}>Try again</button></main>;
  return <AuthContext.Provider value={{ user: session?.user, signIn, logout, request }}>{error && <p role="alert" className="p-4">{error}</p>}{children}</AuthContext.Provider>;
}
