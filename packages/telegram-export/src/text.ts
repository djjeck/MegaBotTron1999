/**
 * The string helpers the readers share, from a game's grammar library (the wiki generator's
 * reader imports them from there), only those the readers use. Pure functions, no Node APIs.
 *
 * "Whitespace" here is the Unicode whitespace set below, used consistently for stripping and regex
 * classes. It differs from JavaScript's `\s` and `trim()`: it includes U+001C..U+001F and U+0085
 * and excludes U+FEFF. Ordering works on code points, not UTF-16 code units, so that emoji and
 * other astral characters sort after U+FFFF.
 */

/** The whitespace characters. */
const WS_CHARS = '\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0         ' + '       　';
const WS_SET = new Set(WS_CHARS);

/** Regex source of a character class matching one whitespace character. */
export const WS_CLASS =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

/** Regex source of a character class matching one word character (use with the `u` flag). */
export const WORD_CLASS = '[\\p{L}\\p{N}_]';

/** Removes leading and trailing whitespace. */
export function stripWs(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WS_SET.has(s[start] as string)) start++;
  while (end > start && WS_SET.has(s[end - 1] as string)) end--;
  return s.slice(start, end);
}

/**
 * Orders strings by code point. JS `<` and the default `sort()` compare UTF-16 code units, which
 * orders astral characters (emoji) before U+E000..U+FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Only surrogates (U+D800..U+DFFF) are out of code-point order: lift them above U+FFFF.
    const fx = x >= 0xd800 && x <= 0xdfff ? x + 0x10000 : x;
    const fy = y >= 0xd800 && y <= 0xdfff ? y + 0x10000 : y;
    return fx - fy;
  }
  return a.length - b.length;
}

/** Lexicographic order of string lists, elements compared by code point. */
export function compareStringLists(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareCodePoints(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

const ND = /^\p{Nd}$/u;

/** Value of a Unicode decimal digit (category Nd); Nd digits come in contiguous runs 0..9. */
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0) as number;
  let start = cp;
  while (ND.test(String.fromCodePoint(start - 1))) start--;
  cp -= start;
  return cp % 10;
}

const DECIMAL_INT_RE = new RegExp(`^${WS_CLASS}*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)${WS_CLASS}*$`, 'u');

/**
 * Parses a base-10 integer: surrounding whitespace, an optional sign, any Unicode decimal digits and
 * single underscores between digits. Throws on anything else.
 */
export function parseDecimalInt(s: string): number {
  const m = DECIMAL_INT_RE.exec(s);
  if (!m) throw new Error(`not a decimal integer: ${JSON.stringify(s)}`);
  let value = 0;
  for (const ch of (m[2] as string).replaceAll('_', '')) value = value * 10 + digitValue(ch);
  return m[1] === '-' ? -value : value;
}
