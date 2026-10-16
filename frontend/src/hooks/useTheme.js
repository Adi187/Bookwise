import { useState } from 'react';
export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(next);
    try { localStorage.setItem('noteway-theme', next); } catch { /* Theme still works with storage disabled. */ }
    setTheme(next);
  }
  return { theme, toggleTheme };
}
