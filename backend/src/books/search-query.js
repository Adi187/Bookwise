// Metadata search covers arbitrary subjects and genres, not just known aliases.
// Aliases only bridge common abbreviations and spelling variants.
const aliases = [
  ['math', 'maths', 'mathematics'],
  ['sci fi', 'sci-fi', 'scifi', 'science fiction'],
  ['self help', 'self-help', 'personal development'],
  ['cs', 'computer science'],
  ['ai', 'artificial intelligence'],
  ['ml', 'machine learning'],
  ['bio', 'biology'],
  ['philosophy', 'philosophical'],
  ['psychology', 'psychological'],
  ['cookbook', 'cookbooks', 'cooking', 'cookery'],
];
const quote = value => `"${value.replace(/[\\"]/g, '\\$&')}"`;
export function searchTerms(query) {
  const cleaned = query.trim().replace(/\s+/g, ' ');
  const group = aliases.find(terms => terms.includes(cleaned.toLowerCase()));
  return [...new Set([cleaned, ...(group || [])])];
}
export function buildSearchQuery(query) {
  const terms = searchTerms(query);
  const fields = [['subject', 4], ['title', 3], ['creator', 2], ['description', 1]];
  const matches = fields.map(([field, boost]) => `${field}:(${terms.map(quote).join(' OR ')})${boost > 1 ? `^${boost}` : ''}`);
  // Exclude known borrowing-only collections before downloading candidates.
  // Fresh metadata and full-text validation still decide eligibility.
  return `mediatype:texts AND format:("Text") AND NOT collection:("inlibrary" OR "printdisabled" OR "borrow_only") AND (${matches.join(' OR ')})`;
}

export function rankSearchResults(docs, query) {
  const normalize = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const terms = searchTerms(query).map(normalize);
  const values = value => (Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string');
  const match = value => terms.some(term => ` ${normalize(value)} `.includes(` ${term} `));
  const score = doc => {
    const subjects = values(doc.subject);
    return (values(doc.title).some(match) ? 6 : 0) +
      (subjects.some(value => terms.includes(normalize(value))) ? 5 : subjects.some(match) ? 3 : 0) +
      (values(doc.creator).some(match) ? 4 : 0) + (values(doc.description).some(match) ? 1 : 0);
  };
  // Preserve Archive's popularity order when relevance scores tie.
  return [...docs].sort((a, b) => score(b) - score(a));
}
