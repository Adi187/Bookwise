const baseUrl = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export async function get(path, signal, onProgress) {
  let response;
  try { response = await fetch(`${baseUrl}${path}`, { signal, ...(onProgress ? { headers: { Accept: 'application/x-ndjson' } } : {}) }); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Cannot reach Noteway. Check that the backend is running and try again.');
  }
  if (response.ok && onProgress && response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (buffer.length > 1024 * 1024) throw new Error('The server returned an unexpected response.');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { throw new Error('The server returned an unexpected response. Please try again.'); }
          if (event.error) throw new Error(event.error.code === 'BOOK_CHECKS_UNAVAILABLE' ? 'Some books couldn’t be checked. Please try again.' : 'Book checks could not be completed. Please try again.');
          if (final || typeof event.complete !== 'boolean') throw new Error('The server returned an unexpected response.');
          onProgress(event);
          if (event.complete) final = event;
        }
        if (done) break;
      }
      if (!final || buffer.trim()) throw new Error('Book checks were interrupted. Please try again.');
      return final;
    } finally { await reader.cancel().catch(() => {}); }
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server returned an unexpected response. Please try again.'); }
  if (!response.ok) {
    const messages = {
      BOOK_CHECKS_UNAVAILABLE: 'Some books couldn’t be checked. Please try again.',
      ARCHIVE_UNAVAILABLE: 'Internet Archive is temporarily unavailable. Please try again.',
      BOOK_NOT_FOUND: 'This edition is no longer available. Try another edition.',
      BOOK_UNAVAILABLE: 'This edition is no longer available for Noteway. Try another edition.',
      VALIDATION_ERROR: 'Check your search text and try again.',
    };
    throw new Error(messages[data?.error?.code] || 'The request failed. Please try again.');
  }
  return data;
}

export async function accountRequest(path, { token, body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', signal, credentials: 'include',
      headers: { 'X-Noteway-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Cannot reach Noteway. Please try again.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unexpected response.'); }
  if (!response.ok) {
    const messages = { RESET_INVALID: 'This reset link has expired or already been used. Request a new link.', RESET_UNAVAILABLE: 'Password reset is temporarily unavailable. Please try again later.', INVALID_CREDENTIALS: 'Email or password is incorrect.', EMAIL_EXISTS: 'An account with this email already exists.',
      UNAUTHORIZED: 'Your session has expired. Sign in again.', AUTH_RATE_LIMITED: 'Too many attempts. Please try again later.',
      SOURCE_NOT_READY: 'This book is not ready for questions yet.',
      SOURCE_NOT_FOUND: 'Saved book not found.', VALIDATION_ERROR: 'Check your input and try again.',
      BOOK_UNAVAILABLE: 'This edition cannot be prepared. Try another edition.',
      ARCHIVE_UNAVAILABLE: 'Internet Archive is temporarily unavailable. Please try again.',
      INGESTION_BUSY: 'Book preparation is busy. Please try again shortly.',
      RETRY_UNAVAILABLE: 'This edition cannot be retried. Try another edition or contact support.',
      RATE_LIMITED: 'Too many requests. Please wait a little and try again.',
      CHAPTERS_UNAVAILABLE: 'Chapter boundaries have not been reliably identified for this edition. Try a question about a specific event or topic instead.',
      CHAPTER_NOT_FOUND: 'That chapter was not found in this edition. Please check the chapter number.',
      CHAPTER_SCOPE_UNSUPPORTED: 'Please ask about one numbered chapter at a time, for example “What happens at the end of Chapter 1?”',
      CHAPTER_TOO_LONG: 'This chapter is too long to summarize reliably in one answer. Ask about a specific event, topic, beginning, or ending.',
      MODEL_UNAVAILABLE: 'Answering questions and preparing books are temporarily unavailable. Please try again later.' };
    const error = new Error(messages[data?.error?.code] || 'The request failed. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}
