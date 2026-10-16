import { retrievePassages } from '../retrieval/retrieve.js';
import { ANSWER_MODEL, validateAnswer } from './generate.js';
export async function askBook({ pool, embed, generate, identifier, question, retrieve = retrievePassages }) {
  const evidence = await retrieve({ pool, embed, identifier, question });
  if (Number.isInteger(evidence.chapterCount) && evidence.chapterCount > 0) {
    return { archiveIdentifier: evidence.archiveIdentifier, editionId: evidence.editionId,
      publishedVersion: evidence.publishedVersion, question: evidence.question, model: null, answerSource: 'chapter_index', chapterCount: evidence.chapterCount,
      answer: `This edition has ${evidence.chapterCount} detected ${evidence.chapterCount === 1 ? 'chapter' : 'chapters'}, according to its chapter index.`,
      insufficientEvidence: false, references: [] };
  }
  if (evidence.chapterCount === null) {
    return { archiveIdentifier: evidence.archiveIdentifier, editionId: evidence.editionId,
      publishedVersion: evidence.publishedVersion, question: evidence.question, model: null, answerSource: 'chapter_index',
      answer: 'I couldn’t reliably determine the chapter count from this edition’s text. Its chapter headings or table of contents may be missing or unclear.',
      insufficientEvidence: true, references: [] };
  }
  const result = validateAnswer(await generate(evidence), evidence.passages);
  return { archiveIdentifier: evidence.archiveIdentifier, editionId: evidence.editionId,
    publishedVersion: evidence.publishedVersion, question: evidence.question, model: ANSWER_MODEL, ...result };
}
