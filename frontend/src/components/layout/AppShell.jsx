import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/context.js';
import ThemeToggle from '../ui/ThemeToggle.jsx';
import Button from '../ui/Button.jsx';
export default function AppShell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const account = useRef(null);
  const trigger = useRef(null);
  const main = useRef(null);
  const location = useLocation();
  useEffect(() => { main.current?.focus(); }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    function close(event) {
      if (event.type === 'keydown' && event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      if (event.type === 'pointerdown' && !account.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return <>
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-surface focus:p-4">Skip to content</a>
    <header className="border-b border-subtle bg-surface">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-2 px-4 py-4 md:px-8">
        <Link to="/library" className="text-lg font-semibold tracking-tight">NOTEWAY</Link>
        <nav aria-label="Main navigation" className="order-3 flex w-full gap-8 sm:order-none sm:w-auto">
          {[['/library', 'Library'], ['/search', 'Search']].map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => `inline-flex min-h-11 items-center border-b-2 text-sm ${isActive ? 'border-primary font-semibold text-primary' : 'border-transparent text-secondary hover:text-primary'}`}>{label}</NavLink>)}
        </nav>
        <div className="ml-auto flex items-center gap-2"><ThemeToggle />
          <div ref={account} className="relative">
            <button ref={trigger} onClick={() => setOpen(value => !value)} aria-label="Account" aria-expanded={open} aria-controls="account-panel" className="flex size-12 items-center justify-center rounded-control border border-subtle bg-surface text-sm font-semibold hover:bg-primary/8 active:bg-primary/15">{user.email[0].toUpperCase()}</button>
            {open && <div id="account-panel" className="absolute right-0 z-20 mt-2 w-60 space-y-2 rounded-popover border border-subtle bg-surface-elevated p-4 shadow-lg">
              <p className="text-sm text-secondary">{user.email}</p><Button variant="ghost" onClick={logout}>Log out</Button>
            </div>}
          </div>
        </div>
      </div>
    </header>
    <main id="main" ref={main} tabIndex={-1} className="mx-auto grid max-w-[1200px] grid-cols-4 gap-4 px-4 py-8 outline-none md:grid-cols-8 md:gap-6 md:px-8 lg:grid-cols-12">
      <div className="col-span-full min-w-0"><Outlet /></div>
    </main>
  </>;
}
