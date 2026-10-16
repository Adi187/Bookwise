import { useEffect, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { getSource } from '../api/sources.js';
export function useSource(id) {
  const { request } = useAuth();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const source = await getSource(request, id, controller.signal);
        if (!controller.signal.aborted) {
          setState({ status: 'success', source });
          if (source.status === 'PROCESSING') timer = setTimeout(load, 3000);
        }
      } catch (error) { if (!controller.signal.aborted) setState({ status: 'error', error: error.message }); }
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, request, attempt]);
  return { ...state, refresh: () => { setState({ status: 'loading' }); setAttempt(a => a + 1); } };
}
