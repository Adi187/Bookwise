export default function SourcePassage({ reference, number, identifier }) {
  return <details className="rounded-card border border-subtle bg-surface open:bg-surface-elevated">
    <summary className="min-h-12 rounded-card px-4 py-3 text-sm font-medium hover:bg-primary/5">[{number}] {reference.chapter || 'Supporting passage'}</summary>
    <div className="space-y-4 border-t border-subtle p-4"><blockquote className="whitespace-pre-wrap leading-7 text-secondary">{reference.excerpt}</blockquote>
      <a className="text-link text-sm" href={`https://archive.org/details/${encodeURIComponent(identifier)}`} target="_blank" rel="noreferrer">Internet Archive <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span></a>
    </div>
  </details>;
}
