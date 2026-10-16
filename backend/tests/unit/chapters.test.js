import { describe, expect, it } from 'vitest';
import { chapterNumber, detectChapters } from '../../src/ingestion/chapters.js';
import { chunkText } from '../../src/ingestion/chunks.js';
import { parseChapterScope } from '../../src/retrieval/chapter-scope.js';
const body = 'Mira studied the old map by the window. '.repeat(40);
describe('conservative chapter boundaries', () => {
  it.each([['I', 1], ['II', 2], ['VIII', 8], ['one', 1], ['twenty-one', 21], ['third', 3], ['42', 42], ['IT', null], ['IIII', null]])('reads %s without repairing ambiguous OCR', (text, number) => {
    expect(chapterNumber(text)).toBe(number);
  });
  it('ignores a contents list and running OCR headers while preserving original offsets', () => {
    const text = `Contents\nChapter I .... 25\nChapter II .... 35\n\n${body}\nChapter I\n${body}\nBook - 39 - Chapter IT\n${body}\nChapter II\n${body}`;
    const chapters = detectChapters(text);
    expect(chapters.map(c => c.number)).toEqual([1, 2]);
    expect(chapters[0].startOffset).toBe(text.indexOf('Chapter I\n'));
    expect(chapters[0].endOffset).toBe(text.indexOf('Chapter II\n'));
    const chunks = chunkText(text);
    expect(chunks[0].chapter).toBeNull();
    for (const chunk of chunks) {
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.tokenCount).toBeLessThanOrEqual(500);
      if (chunk.chapter) {
        const chapter = chapters.find(c => c.title === chunk.chapter);
        expect(chunk.startOffset).toBeGreaterThanOrEqual(chapter.startOffset);
        expect(chunk.endOffset).toBeLessThanOrEqual(chapter.endOffset);
      }
    }
  });
  it('ignores dense bare contents headings and labels only body chapters', () => {
    const text = `Chapter I\nChapter II\n\n${body}\nChapter I\n${body}\nChapter II\n${body}`;
    expect(detectChapters(text)[0].startOffset).toBe(text.lastIndexOf('Chapter I\n'));
  });
  it.each([
    `Chapter I\n${body}\nChapter III\n${body}`,
    `Chapter I\n${body}\nChapter II\n${body}\nChapter I\n${body}`,
    `Chapter I\n${body}\nChapter IT\n${body}`,
    `Chapter I .... 1\nChapter II .... 2\n${body}`,
    `Chapter I\n${body}`,
  ])('declines missing, repeated-part, ambiguous or contents-only chapter structure', text => {
    expect(detectChapters(text)).toEqual([]);
    expect(chunkText(text).every(chunk => chunk.chapter === null)).toBe(true);
  });
});
describe('chapter question scope', () => {
  it.each([
    ['What happened at the end of chapter one?', 1, 'ending'],
    ['How does Chapter I end?', 1, 'ending'],
    ['How does chapter1 end?', 1, 'ending'],
    ['What is the ending of the first chapter?', 1, 'ending'],
    ['What happens at the beginning of chapter 2?', 2, 'beginning'],
    ['Summarize chapter II.', 2, 'overview'],
    ['What happens in chapter two?', 2, 'overview'],
    ['Why does Mira hide in chapter twenty-one?', 21, 'semantic'],
    ['How does the last chapter end?', 'last', 'ending'],
  ])('resolves %s', (question, number, mode) => expect(parseChapterScope(question)).toEqual({ number, mode }));
  it('leaves general questions unscoped', () => expect(parseChapterScope('Why does Mira hide?')).toBeNull());
  it.each(['Compare chapters 1 and 2.', 'Compare chapter one and chapter two.', 'Summarize chapter 1–3.', 'What happens in chapter 1 and 2?', 'What happened after chapter two?', 'Explain chapter IT.', 'What happens in this chapter?', 'Compare chapter four and five.', 'Explain chapter one hundred.', 'Summarize Part Two, Chapter 1.'])('does not silently broaden an unsupported scope: %s', question => {
    expect(() => parseChapterScope(question)).toThrow(expect.objectContaining({ code: 'CHAPTER_SCOPE_UNSUPPORTED' }));
  });
});

it('recognizes Roman title headings and excludes Gutenberg end matter', () => {
  const text = `I--FIRST TITLE\n\n${body}\n\nII--SECOND TITLE\n\n${body}\n*** END OF THIS PROJECT GUTENBERG EBOOK TEST ***\nLicense text`;
  const chapters = detectChapters(text);
  expect(chapters.map(c => c.heading)).toEqual(['FIRST TITLE', 'SECOND TITLE']);
  expect(chapters[1].endOffset).toBe(text.indexOf('*** END'));
  expect(chunkText(text).at(-1).chapter).toBeNull();
});
it('requires contents evidence before repairing an OCR chapter-one label', () => {
  const headings = `Chapter l. Welcome\n\n${body}\nChapter 2. Introduction\n\n${body}`;
  expect(detectChapters(headings)).toEqual([]);
  const result = detectChapters(`Table of Contents\n1. Welcome 1\n2. Introduction 8\n\n${body}\n${headings}`);
  expect(result.map(c => c.number)).toEqual([1, 2]);
  expect(result[0].method).toBe('contents-corroborated-ocr');
});
it('retains intervening front matter as unscoped chunks', () => {
  const text = `Chapter 1. Start\n${body}\nPREFACE\n${body}\nChapter 2. Next\n${body}`;
  const chapters = detectChapters(text);
  expect(chapters[0].endOffset).toBe(text.indexOf('PREFACE'));
  const chunks = chunkText(text);
  expect(chunks.find(c => c.content.includes('PREFACE')).chapter).toBeNull();
  expect(chunks.every(c => c.content === text.slice(c.startOffset,c.endOffset))).toBe(true);
});
it('does not interpret ordinary numbered prose or subsections as chapters', () => {
  expect(detectChapters(`1. First exercise\n\n${body}\n\n2. Second exercise\n\n${body}`)).toEqual([]);
  expect(detectChapters(`1.1. First section\n${body}\n1.2. Second section\n${body}`)).toEqual([]);
});
it('matches unique unnumbered body titles to a contents list', () => {
  const text = `Contents\n\nThe Arrival .... 1\nThe Departure .... 8\n\n\nThe Arrival\n\n${body}\n\nThe Departure\n\n${body}`;
  const result = detectChapters(text);
  expect(result.map(c => c.heading)).toEqual(['The Arrival', 'The Departure']);
  expect(result[0].method).toBe('contents-title-match');
  expect(detectChapters(text + `\n\nThe Arrival\n\n${body}`)).toEqual([]);
});

it('detects an unpaginated contents list with book groups and merged OCR titles', () => {
  const text = `Contents\n\nPreface\n\nThe Arrival\n\nBOOK ONE: THE JOURNEY\nThe First Lesson The Second Lesson\n\nEPILOGUE: HOME\n\nAcknowledgements\n\n${body}\n\nPreface\n\n${body}\n\nThe Arrival\n\n${body}\n\nBOOK ONE\n\nTHE JOURNEY\n\nThe First Lesson\n\n${body}\n\nThe Second Lesson\n\n${body}\n\nEPILOGUE\n\n${body}`;
  const chapters = detectChapters(text);
  expect(chapters.map(c => c.heading)).toEqual(['The Arrival', 'The First Lesson', 'The Second Lesson']);
  expect(chapters.at(-1).endOffset).toBe(text.lastIndexOf('EPILOGUE\n'));
  expect(detectChapters(text + `\n\nThe Arrival\n\n${body}`)).toEqual([]);
  expect(detectChapters(text.replace(`The Second Lesson\n\n${body}`, `Missing Lesson\n\n${body}`))).toEqual([]);
});
