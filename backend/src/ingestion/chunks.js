import { getEncoding } from 'js-tiktoken';
import { detectChapters } from './chapters.js';

const encoding = getEncoding('cl100k_base');
export const tokenCount = text => encoding.encode(text, [], []).length;
export const LEGACY_PIPELINE_VERSION = 'plain-utf8-cl100k-500-75-v1';
export const PIPELINE_VERSION = 'plain-utf8-cl100k-500-75-chapters-v2';

export function cleanText(text) {
  // Keep content, notices and ordering; offsets reference this cleaned representation.
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function chunkText(text, { targetTokens = 500, overlapTokens = 75, chapters = detectChapters(text) } = {}) {
  const sections = [];
  let cursor = 0;
  for (const chapter of chapters) {
    if (chapter.startOffset > cursor) sections.push({ startOffset: cursor, endOffset: chapter.startOffset, title: null });
    sections.push(chapter);
    cursor = chapter.endOffset;
  }
  if (cursor < text.length) sections.push({ startOffset: cursor, endOffset: text.length, title: null });
  const chunks = [];
  for (const section of sections) {
    const content = text.slice(section.startOffset, section.endOffset);
    if (!content.trim()) continue;
    for (const chunk of chunkSpan(content, { targetTokens, overlapTokens })) {
      chunks.push({ ...chunk, chunkIndex: chunks.length, chapter: section.title,
        startOffset: chunk.startOffset + section.startOffset, endOffset: chunk.endOffset + section.startOffset });
    }
  }
  if (!chunks.length) throw new Error('No usable text chunks.');
  if (chunks.length > 10000) throw new Error('Too many chunks.');
  return chunks;
}

function chunkSpan(text, { targetTokens, overlapTokens }) {
  if (!Number.isInteger(targetTokens) || targetTokens < 8 || !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= targetTokens) throw new Error('Invalid chunk configuration.');
  const units = [];
  const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
  function splitSpan(start, end) {
    while (start < end) {
      let high = Math.min(end, start + targetTokens * 16);
      if (high === end && tokenCount(text.slice(start, end)) <= targetTokens) { units.push({ start, end }); break; }
      let low = start + 1;
      let best = start;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (tokenCount(text.slice(start, mid)) <= targetTokens) { best = mid; low = mid + 1; }
        else high = mid - 1;
      }
      if (best > start && /[\uD800-\uDBFF]/.test(text[best - 1])) best--;
      if (best <= start) throw new Error('Cannot split text within token limit.');
      units.push({ start, end: best });
      start = best;
    }
  }
  for (const match of text.matchAll(/\S[\s\S]*?(?=\n[ \t]*\n|$)/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0].length <= targetTokens * 16 && tokenCount(match[0]) <= targetTokens) units.push({ start, end });
    else for (const segment of sentences.segment(match[0])) splitSpan(start + segment.index, start + segment.index + segment.segment.length);
  }
  const chunks = [];
  let index = 0;
  while (index < units.length) {
    let next = index + 1;
    while (next < units.length && tokenCount(text.slice(units[index].start, units[next].end)) <= targetTokens) next++;
    const startOffset = units[index].start;
    const endOffset = units[next - 1].end;
    const content = text.slice(startOffset, endOffset);
    if (content.trim()) chunks.push({ chunkIndex: chunks.length, startOffset, endOffset, chapter: null, content, tokenCount: tokenCount(content) });
    if (chunks.length > 10000) throw new Error('Too many chunks.');
    if (next === units.length) break;
    // Repeat complete units only when they fit the overlap budget and guarantee progress.
    let overlap = next;
    while (overlap - 1 > index && tokenCount(text.slice(units[overlap - 1].start, endOffset)) <= overlapTokens &&
        tokenCount(text.slice(units[overlap - 1].start, units[next].end)) <= targetTokens) overlap--;
    index = overlap;
  }
  if (!chunks.length) throw new Error('No usable text chunks.');
  return chunks;
}
