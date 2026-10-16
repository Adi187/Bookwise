export async function askQuestion(request, id, question, signal) {
  const data = await request(`/sources/${encodeURIComponent(id)}/questions`, { body: { question }, signal });
  const chapterCountAnswer = data?.answerSource === 'chapter_index' && data.model === null && Number.isInteger(data.chapterCount) && data.chapterCount > 0;
  if (typeof data?.answer !== 'string' || typeof data.question !== 'string' || typeof data.insufficientEvidence !== 'boolean' ||
      !Array.isArray(data.references) || !data.references.every(ref => typeof ref?.chunkId === 'string' && typeof ref.excerpt === 'string' && (ref.chapter === null || typeof ref.chapter === 'string')) ||
      (data.insufficientEvidence ? data.references.length !== 0 : (data.references.length === 0 && !chapterCountAnswer))) throw new Error('We could not read the answer. Please try again.');
  return data;
}
