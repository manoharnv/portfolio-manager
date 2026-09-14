/**
 * A minimal RFC-4180 CSV reader (quoted fields, embedded commas/newlines,
 * doubled quotes, LF or CRLF, optional BOM). No dependency: the brokers'
 * instrument masters are the only CSVs this repo parses.
 *
 * It **streams** rows instead of materialising the whole file. A scrip
 * master is ~25 MB / ~200k rows, and holding every field of every row at
 * once — then indexing from that — was the difference between a 150 MB and
 * a 500 MB process on the 1 GB VM (docs/11 §11.6). Lines without a quote
 * character, which is nearly all of them, take a `split()` fast path; only a
 * line with a quote goes through the character-level parser, which can span
 * several physical lines.
 */

const QUOTE = 34; // "
const COMMA = 44; // ,
const LF = 10; // \n

/** One record with quotes in it, starting at `start`; may span several lines. */
function parseQuotedRecord(src: string, start: number): { row: string[]; next: number } {
  const n = src.length;
  const row: string[] = [];
  let i = start;
  for (;;) {
    let field = '';
    if (src.charCodeAt(i) === QUOTE) {
      i += 1;
      for (;;) {
        const q = src.indexOf('"', i);
        if (q === -1) {
          // Unterminated quote: the rest of the file is this field.
          field += src.slice(i);
          i = n;
          break;
        }
        field += src.slice(i, q);
        if (src.charCodeAt(q + 1) === QUOTE) {
          field += '"';
          i = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
    }
    // Unquoted text — or whatever trails a closing quote — up to the delimiter.
    // A quote after the first character of a field is a literal.
    let j = i;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === COMMA || c === LF) break;
      j += 1;
    }
    const rest = src.slice(i, j);
    field += rest.includes('\r') ? rest.replace(/\r/g, '') : rest;
    row.push(field);
    if (j >= n) return { row, next: n };
    if (src.charCodeAt(j) === LF) return { row, next: j + 1 };
    i = j + 1; // past the comma
  }
}

/**
 * Yield each record as its fields. Blank lines are dropped rather than
 * yielded as `['']`; empty fields (`a,,b`, trailing commas) are preserved.
 */
export function* parseCsvRows(text: string): Generator<string[], void, undefined> {
  // Strip a UTF-8 BOM; Dhan's file has shipped with one.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let end = src.indexOf('\n', pos);
    if (end === -1) end = n;
    const line = src.slice(pos, end);
    if (!line.includes('"')) {
      pos = end + 1;
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean.length === 0) continue;
      yield clean.split(',');
      continue;
    }
    const parsed = parseQuotedRecord(src, pos);
    pos = parsed.next;
    if (parsed.row.length > 1 || parsed.row[0] !== '') yield parsed.row;
  }
}

/** The whole file at once — tests and small inputs only. */
export function parseCsv(text: string): string[][] {
  return Array.from(parseCsvRows(text));
}
