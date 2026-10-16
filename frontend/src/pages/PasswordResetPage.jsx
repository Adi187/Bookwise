import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { accountRequest } from '../api/client.js';
import Button from '../components/ui/Button.jsx';
import ErrorMessage from '../components/ui/ErrorMessage.jsx';
import ThemeToggle from '../components/ui/ThemeToggle.jsx';

export default function PasswordResetPage({ reset = false }) {
  const location = useLocation();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const invalidLink = reset && !/^[a-f0-9]{64}$/.test(token);
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (reset && (password.length < 12 || password.length > 128)) return setError('Use a password of 12–128 characters.');
    if (reset && password !== confirm) return setError('Passwords do not match.');
    if (!reset && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter a valid email address.');
    setPending(true);
    try {
      const result = await accountRequest(`/auth/${reset ? 'reset-password' : 'forgot-password'}`, {
        body: reset ? { token, password } : { email },
      });
      setMessage(result.message);
      setPassword(''); setConfirm('');
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <main className="mx-auto max-w-md space-y-8 px-4 py-12">
    <div className="flex items-center justify-between"><Link to="/login" className="text-lg font-semibold tracking-tight">NOTEWAY</Link><ThemeToggle /></div>
    <div className="space-y-2"><h1>{reset ? 'Set a new password' : 'Forgot password?'}</h1><p className="text-secondary">{reset ? 'Use 12–128 characters for your new password.' : 'Enter your account email to receive a password reset link.'}</p></div>
    {invalidLink ? <ErrorMessage>This reset link is invalid. Request a new link.</ErrorMessage> : message ? <p role="status">{message}</p> : <form onSubmit={submit} noValidate className="space-y-6">
      {reset ? <>
        <div className="space-y-2"><label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div className="space-y-2"><label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" type="password" autoComplete="new-password" maxLength={128} required disabled={pending} value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
      </> : <div className="space-y-2"><label htmlFor="reset-email">Email</label><input id="reset-email" type="email" autoComplete="email" maxLength={254} required disabled={pending} value={email} onChange={e => setEmail(e.target.value)} /></div>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <Button type="submit" className="w-full" loading={pending}>{pending ? 'Please wait…' : reset ? 'Reset password' : 'Send reset link'}</Button>
    </form>}
    {reset && <Link className="text-link text-sm block" to="/forgot-password">Request a new reset link</Link>}
    <Link className="text-link text-sm block" to="/login">Back to sign in</Link>
  </main>;
}
