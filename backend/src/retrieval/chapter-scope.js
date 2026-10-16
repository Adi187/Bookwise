import { BookError } from '../books/errors.js';
import { chapterNumber, NUMBER_PATTERN } from '../ingestion/chapters.js';
const unsupported = () => new BookError(422, 'CHAPTER_SCOPE_UNSUPPORTED', 'Please ask about one numbered chapter at a time, for example “What happens at the end of Chapter 1?”');
export function parseChapterScope(question) {
  const countQuestion = question.trim().replace(/\s+/g, ' ').replace(/[?.,!]+$/, '').trim();
  if (/^(?:please[ ,]+)?(?:how many chapters(?: (?:are (?:there(?: in (?:this|the) book)?|in (?:this|the) book)|does (?:this|the) book (?:have|contain)))?|what(?: is|'s|’s) the (?:total )?(?:number of chapters|chapter count)(?: (?:in|of) (?:this|the) book)?)\s*[?.!]*$/i.test(countQuestion)) return { mode: 'count' };
  if (!/\bchapters?(?=\b|\d)/i.test(question)) return null;
  if (/\bchapters\b/i.test(question) || new RegExp(`\\bpart\\s+(?:${NUMBER_PATTERN})(?![\\w-])`, 'i').test(question) ||
      /\b(?:before|after|through|across|between|beyond)\s+(?:the\s+)?chapter\b/i.test(question)) throw unsupported();
  const forward = new RegExp(`\\bchapter\\s*(${NUMBER_PATTERN})(?![\\w-])`, 'gi');
  const backward = new RegExp(`\\b(${NUMBER_PATTERN}|last|final|opening)\\s+chapter\\b`, 'gi');
  const matches = [...question.matchAll(forward), ...question.matchAll(backward)];
  if (matches.length !== 1) throw unsupported();
  const match = matches[0];
  const tail = question.slice(match.index + match[0].length);
  if (/^\s*(?:[-–—]|to\b|through\b|hundred\b|thousand\b)/i.test(tail) ||
      new RegExp(`^\\s*(?:and|[&,/])\\s+(?:${NUMBER_PATTERN})(?![\\w-])`, 'i').test(tail)) throw unsupported();
  const value = match[1].toLowerCase();
  const number = ['last', 'final'].includes(value) ? 'last' : value === 'opening' ? 1 : chapterNumber(value);
  if (!number) throw unsupported();
  const end = /\b(?:end|ends|ended|ending|conclusion|closing)\b|\b(?:last|final)\s+(?:paragraph|page|scene|event|sentence)s?\b/i.test(question);
  const start = /\b(?:beginning|begins|begin|start|starts|opening)\b|\bfirst\s+(?:paragraph|page|scene|event|sentence)s?\b/i.test(question);
  const summary = /\b(?:summari[sz]e|summary|overview|outline|recap)\b|\bwhat\s+(?:happens|happened|occurs|occurred)\b/i.test(question);
  return { number, mode: end && !start ? 'ending' : start && !end ? 'beginning' : summary || (end && start) ? 'overview' : 'semantic' };
}
