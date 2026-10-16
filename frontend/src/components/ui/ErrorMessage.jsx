import Button from './Button.jsx';
export default function ErrorMessage({ children, onRetry }) {
  return <div role="alert" className="space-y-2 rounded-card border border-danger/30 bg-danger/5 p-4">
    <p className="text-danger">{children}</p>{onRetry && <Button variant="ghost" onClick={onRetry}>Try again</Button>}
  </div>;
}
