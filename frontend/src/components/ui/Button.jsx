import { Link } from 'react-router-dom';
export default function Button({ children, loading = false, disabled, variant = 'primary', className = '', to, ...props }) {
  const style = variant === 'primary' ? 'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-hover' : 'text-primary hover:bg-primary/8 active:bg-primary/15';
  const classes = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-semibold transition-colors disabled:bg-disabled-surface disabled:text-disabled ${style} ${className}`;
  if (to) return <Link className={classes} to={to} {...props}>{children}</Link>;
  return <button type="button" className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />}{children}
  </button>;
}
