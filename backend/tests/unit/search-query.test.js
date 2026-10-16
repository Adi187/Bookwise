import { expect, it } from 'vitest';
import { buildSearchQuery, searchTerms, rankSearchResults } from '../../src/books/search-query.js';
it('expands maths into common equivalent terms across metadata fields', () => {
  expect(searchTerms(' Maths ')).toEqual(['Maths', 'math', 'maths', 'mathematics']);
  const query = buildSearchQuery('maths');
  for (const field of ['subject', 'title', 'creator', 'description']) expect(query).toContain(`${field}:("maths" OR "math" OR "mathematics")`);
  expect(query).toContain('subject:');
  expect(query).toContain('format:("Text")');
});
it.each(['history', 'fantasy', 'astronomy', 'gardening', 'marine biology', 'romance', 'Hindi poetry'])('searches arbitrary topics and genres: %s', topic => {
  const query = buildSearchQuery(topic);
  expect(query).toContain(`subject:("${topic}")`);
  expect(query).toContain(`description:("${topic}")`);
});
it('preserves exact titles and author names', () => {
  expect(searchTerms(' H. G.   Wells ')).toEqual(['H. G. Wells']);
  expect(buildSearchQuery('The Time Machine')).toContain('title:("The Time Machine")');
});
it('quotes user syntax instead of accepting query operators', () => {
  expect(buildSearchQuery('title:"x" OR *:*')).toContain('subject:("title:\\"x\\" OR *:*")');
});
it('expands genre abbreviations and leaves unrelated phrases intact', () => {
  expect(searchTerms('sci-fi')).toContain('science fiction');
  expect(searchTerms('maths for kids')).toEqual(['maths for kids']);
});

it('puts focused books ahead of incidental description matches and broad subject tags', () => {
  const docs = [
    { identifier: 'incidental', title: 'A travelers diary', description: 'Some thoughts on mathematics' },
    { identifier: 'broad', title: 'Collected studies', subject: ['Science and mathematics'] },
    { identifier: 'focused', title: 'A first course', subject: ['Mathematics'] },
    { identifier: 'textbook', title: 'Mathematics for beginners', subject: ['Mathematics'] },
  ];
  expect(rankSearchResults(docs, 'maths').map(doc => doc.identifier)).toEqual(['textbook', 'focused', 'broad', 'incidental']);
});
