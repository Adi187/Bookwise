// Conservative checks shared by preflight samples and full-file validation.
export function readableText(text) {
  return text.trim().length >= 80 &&
    ![...text].some(char => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char)) &&
    !/<!doctype\s+html|<html\b|<body\b/i.test(text) &&
    (text.match(/\uFFFD/g)?.length || 0) <= text.length * 0.01 &&
    (text.match(/\p{L}/gu)?.length || 0) >= text.length * 0.3;
}
