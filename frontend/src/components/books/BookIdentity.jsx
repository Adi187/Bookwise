export default function BookIdentity({ book }) {
  return <div className="space-y-2"><h1>{book.title}</h1><p className="text-secondary">{book.author}{book.year ? ` · ${book.year}` : ''}</p></div>;
}
