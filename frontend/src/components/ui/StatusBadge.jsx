const states = { READY: ['Ready', 'bg-success/10 text-success'], FAILED: ['Failed', 'bg-danger/10 text-danger'], PROCESSING: ['Preparing book…', 'bg-warning/10 text-warning'] };
export default function StatusBadge({ status }) {
  const [label, style] = states[status] || states.PROCESSING;
  return <span className={`inline-flex items-center gap-2 rounded-control px-2 py-1 text-xs font-medium ${style}`}>
    <span aria-hidden="true">{status === 'READY' ? '✓' : status === 'FAILED' ? '!' : '◷'}</span>{label}
  </span>;
}
