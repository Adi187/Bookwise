import { useTheme } from '../../hooks/useTheme.js';
import Button from './Button.jsx';
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  return <Button variant="ghost" aria-label={label} title={label} onClick={toggleTheme}>
    <svg className="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {theme === 'light' ? <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" /></>}
    </svg>
  </Button>;
}
