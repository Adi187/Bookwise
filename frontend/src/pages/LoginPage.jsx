import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/context.js';
import Button from '../components/ui/Button.jsx';
import ErrorMessage from '../components/ui/ErrorMessage.jsx';
import ThemeToggle from '../components/ui/ThemeToggle.jsx';
export default function LoginPage({ register = false }) {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const [pending, setPending] = useState(false);
  if (user) return <Navigate to="/library" replace />;
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
    if (password.length < 12 || password.length > 128) errors.password = 'Use a password of 12–128 characters.';
    setFields(errors);
    if (Object.keys(errors).length) return;
    setPending(true); setError('');
    try { await signIn(register ? 'register' : 'login', { email, password }); navigate('/library'); }
    catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <main className="mx-auto max-w-md space-y-8 px-4 py-12">
    <div className="flex items-center justify-between"><Link to="/login" className="text-lg font-semibold tracking-tight">NOTEWAY</Link><ThemeToggle /></div>
    <div className="space-y-2"><h1>{register ? 'Create your account' : 'Welcome back'}</h1><p className="text-secondary">{register ? 'Start building a library you can question.' : 'Sign in to continue to your library.'}</p></div>
    <form onSubmit={submit} noValidate className="space-y-6">
      <div className="space-y-2"><label htmlFor="email" className="block text-sm font-medium">Email</label><input id="email" type="email" autoComplete="email" required disabled={pending} maxLength={254} value={email} onChange={e => { setEmail(e.target.value); setFields(f => ({ ...f, email: '' })); }} aria-invalid={!!fields.email} aria-describedby={fields.email ? 'email-error' : undefined} />{fields.email && <p id="email-error" role="alert" className="text-sm text-danger">{fields.email}</p>}</div>
      <div className="space-y-2"><label htmlFor="password" className="block text-sm font-medium">Password</label><input id="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required disabled={pending} minLength={12} maxLength={128} value={password} onChange={e => { setPassword(e.target.value); setFields(f => ({ ...f, password: '' })); }} aria-invalid={!!fields.password} aria-describedby={fields.password ? 'password-error' : register ? 'password-help' : undefined} />
        {register && <p id="password-help" className="text-sm text-secondary">Use 12–128 characters.</p>}{fields.password && <p id="password-error" role="alert" className="text-sm text-danger">{fields.password}</p>}
      </div>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <Button type="submit" className="w-full" loading={pending}>{pending ? register ? 'Creating account…' : 'Signing in…' : register ? 'Create account' : 'Sign in'}</Button>
    </form>
    {!register && <Link className="text-link text-sm block" to="/forgot-password">Forgot password?</Link>}
    <Link className="text-link text-sm" to={register ? '/login' : '/register'}>{register ? 'Already have an account? Sign in' : 'New to Noteway? Create account'}</Link>
  </main>;
}
