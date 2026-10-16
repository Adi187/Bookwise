// Conservative English numbered-heading support. Ambiguous structure stays unlabelled.
const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
export const NUMBER_PATTERN = `(?:[1-9]\\d{0,2}(?:st|nd|rd|th)?|[ivxlcdm]+|${tens.join('|')})(?:[ -](?:${small.slice(1, 10).join('|')}))?|(?:${[...small.slice(1), ...ordinal].sort((a, b) => b.length - a.length).join('|')})`;
export function chapterNumber(value) {
  const text = value.trim().toLowerCase();
  if (/^[1-9]\d{0,2}(?:st|nd|rd|th)?$/.test(text)) return parseInt(text, 10);
  if (small.includes(text)) return small.indexOf(text) || null;
  if (ordinal.includes(text)) return ordinal.indexOf(text) + 1;
  const parts = text.split(/[ -]/);
  if (tens.includes(parts[0]) && parts.length <= 2 && (!parts[1] || small.slice(1, 10).includes(parts[1]))) return (tens.indexOf(parts[0]) + 2) * 10 + (parts[1] ? small.indexOf(parts[1]) : 0);
  const roman = text.toUpperCase();
  if (!roman || !/^(?=.)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let sum = 0;
  for (let i = 0; i < roman.length; i++) sum += values[roman[i]] < (values[roman[i + 1]] || 0) ? -values[roman[i]] : values[roman[i]];
  return sum <= 999 ? sum : null;
}

export const CHAPTER_DETECTOR_VERSION = 'numbered-headings-v4';
export function detectChapters(text) {
  const explicit = [];
  const roman = [];
  const numeric = [];
  const lines = [...text.matchAll(/^.*$/gm)];
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const earlierTitles = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (i) earlierTitles.add(normalize(lines[i - 1][0].replace(/\s+\d+\s*$/, '')));
    const line = lines[i][0].trim();
    const offset = lines[i].index;
    if (/^chapter\s+page$/i.test(line)) continue;
    if (!line || line.length > 160 || /\.{2,}|\s\d+\s*$/.test(line)) continue;
    const match = /^chapter\s+(.+)$/i.exec(line);
    if (match) {
      const value = match[1];
      const parsed = new RegExp(`^(${NUMBER_PATTERN})(?:[.:—–]|--|\\s+-|$)(.*)$`, 'i').exec(value);
      let number = parsed ? chapterNumber(parsed[1]) : chapterNumber(value);
      let heading = parsed?.[2]?.trim() || '';
      let method = 'explicit-numbered-heading';
      // OCR l -> 1 only when the contents explicitly corroborates the same title.
      const ocr = /^l\.\s+(.+)$/i.exec(value);
      if (ocr) {
        const title = normalize(ocr[1]);
        const corroborated = lines.slice(0, i).some(entry => {
          const toc = /^\s*1\.\s+(.+?)\s+\d+\s*$/.exec(entry[0]);
          return toc && normalize(toc[1]) === title;
        });
        if (corroborated) { number = 1; heading = ocr[1]; method = 'contents-corroborated-ocr'; }
      }
      if (number || /^[\w -]{1,24}$/.test(value)) explicit.push({ number, heading, startOffset: offset, method });
      continue;
    }
    // Without a chapter prefix, require an isolated title line, not numbered prose.
    if (lines[i - 1]?.[0].trim() || lines[i + 1]?.[0].trim()) continue;
    const bare = /^([IVXLCDM]+|[1-9]\d{0,2})(?:--|[.—–:]|\s+-)\s*(\S.*)$/.exec(line);
    if (!bare || !/[A-Za-z]/.test(bare[2])) continue;
    const isRoman = /^[IVXLCDM]+$/.test(bare[1]);
    if (isRoman && bare[2] !== bare[2].toUpperCase()) continue;
    if (!isRoman) {
      // Plain numbered titles need matching contents entries to exclude exercise lists.
      if (!earlierTitles.has(normalize(line))) continue;
    }
    (isRoman ? roman : numeric).push({ number: chapterNumber(bare[1]), heading: bare[2], startOffset: offset, method: isRoman ? 'roman-title-sequence' : 'contents-numbered-title' });
  }
  // Title-only chapters require corroboration in a contents list and unique body headings.
  const titled = [];
  if (!explicit.length && !roman.length && !numeric.length) {
    const contents = lines.findIndex(entry => /^(?:table of )?contents$/i.test(entry[0].trim()));
    if (contents >= 0) {
      const entries = [];
      for (let i = contents + 1; i < lines.length && i < contents + 200; i++) {
        const line = lines[i][0].trim();
        if (!line) continue;
        const entry = /^([A-Za-z][A-Za-z ,’'?!:—-]{2,100}?)(?:\s*\.{2,}\s*|\s+)(\d+)$/.exec(line);
        if (!entry) break;
        if (/^(?:preface|foreword|notes|bibliography|index|appendix|acknowledg)/i.test(entry[1])) continue;
        entries.push({ heading: entry[1].trim(), after: lines[i].index });
      }
      if (entries.length >= 2) {
        const after = entries.at(-1).after;
        for (const entry of entries) {
          const matches = lines.filter((line, i) => line.index > after &&
            normalize(line[0]) === normalize(entry.heading) &&
            !lines[i - 1]?.[0].trim() && !lines[i + 1]?.[0].trim());
          if (matches.length !== 1) { titled.length = 0; break; }
          titled.push({ number: titled.length + 1, heading: entry.heading, startOffset: matches[0].index, method: 'contents-title-match' });
        }
      }
    }
  }
  // Some OCR contents lists omit page numbers and join adjacent titles.
  // Require a front-matter terminator and a complete match to unique body titles.
  if (!explicit.length && !roman.length && !numeric.length && !titled.length) {
    const contents = lines.findIndex(entry => /^(?:table of )?contents$/i.test(entry[0].trim()));
    const end = contents < 0 ? -1 : lines.findIndex((entry, i) => i > contents &&
      /^(?:acknowledg(?:e)?ments|preface|foreword|introduction)$/i.test(entry[0].trim()) &&
      lines.slice(i + 1, i + 8).some((next, j, following) => next[0].trim().length > 160 || (next[0].trim().length > 50 && following[j + 1]?.[0].trim().length > 50)));
    if (end > contents && end - contents < 200) {
      const toc = [];
      let continuation = false;
      for (let i = contents + 1; i < end; i++) {
        const line = lines[i][0].trim();
        if (!line) continue;
        if (/^(?:preface|foreword|introduction|acknowledg|epilogue)/i.test(line)) { continuation = false; continue; }
        if (/^(?:book|part)\s+/i.test(line)) { continuation = true; continue; }
        if (continuation && line === line.toUpperCase()) continue;
        continuation = false;
        toc.push(normalize(line));
      }
      const matches = [];
      for (let i = end + 1; i < lines.length; i++) {
        const line = lines[i][0].trim();
        if (line.length < 3 || line.length > 100 || lines[i - 1]?.[0].trim() || lines[i + 1]?.[0].trim()) continue;
        const heading = normalize(line);
        if (/^[A-Za-z]/.test(line) && heading && toc.some(entry => entry.includes(heading))) matches.push({ heading: line, normalized: heading, startOffset: lines[i].index });
      }
      // Flattening permits merged OCR titles, but excludes missing or duplicate titles.
      if (matches.length >= 2 && new Set(matches.map(item => item.normalized)).size === matches.length &&
          matches.map(item => item.normalized).join('') === toc.join('')) {
        for (const item of matches) titled.push({ number: titled.length + 1, heading: item.heading,
          startOffset: item.startOffset, method: 'contents-title-match' });
      }
    }
  }
  const candidates = explicit.length ? explicit : roman.length ? roman : numeric.length ? numeric : titled;
  const headings = candidates.filter((item, i) =>
    !(i && item.startOffset - candidates[i - 1].startOffset < 240) &&
    !(i + 1 < candidates.length && candidates[i + 1].startOffset - item.startOffset < 240));
  if (headings.length < 2 || headings[0].number !== 1) return [];
  const boundaries = [];
  for (const heading of headings) {
    if (!heading.number) return [];
    if (heading.number === boundaries.at(-1)?.number) continue;
    if (heading.number !== boundaries.length + 1) return [];
    boundaries.push(heading);
  }
  if (boundaries.length < 2) return [];
  return boundaries.map((item, i) => {
    let endOffset = boundaries[i + 1]?.startOffset ?? text.length;
    const region = text.slice(item.startOffset + 1, endOffset);
    // Exclude recognizable front/back matter from chapter evidence.
    const end = /^(?:\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG|[ \t]*(?:PREFACE|EPILOGUE|ACKNOWLEDGEMENTS|ACKNOWLEDGMENTS|NOTES|BIBLIOGRAPHY|INDEX)[ \t]*$)/im.exec(region);
    if (end) endOffset = item.startOffset + 1 + end.index;
    return { ...item, title: `Chapter ${item.number}`, endOffset, detectorVersion: CHAPTER_DETECTOR_VERSION, confidence: 'structurally-validated' };
  });
}
