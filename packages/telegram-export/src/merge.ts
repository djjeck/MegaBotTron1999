/**
 * The exports of a run, read and merged: `readHtmlExport` reads the pages of one HTML export into
 * a record, `readJsonExport` (json.ts) one JSON export, and `mergeExports` joins the records of a
 * run into one list of messages, de-duplicated by (chat, id) and sorted in time order.
 * `parsePages` is the HTML part of the two in a row. Generic: no bot, no game. Pure logic, no Node
 * APIs.
 *
 * Merging needs all the records of a run: the dates of a macOS HTML export get their UTC offset
 * from the other exports that share messages with it, and de-duplication, sorting and the placing
 * of undated messages look across exports. So a record keeps a macOS date as written, and the
 * merge converts it. (As the wiki generator's reader (#60) does, without its stubs and salted sender keys,
 * which are its own.)
 */
import { formatWindowsDate, parseMacDate, parseWindowsDate } from './dates.ts';
import {
  type DatedCopy,
  exportKey,
  type ExportOffset,
  exportOffsets,
  ExportParser,
  sortMessages,
} from './html.ts';
import { type ExportMessage, type Page } from './messages.ts';
import { compareCodePoints } from './text.ts';

/** What a reader keeps of one export: plain JSON data. */
export interface ExportRecord {
  /** The export's folder, as its page labels give it (exportKey); a JSON export's file. */
  folder: string;
  /** HTML pages read; 0 for a JSON export. */
  pages: number;
  /** Its messages, in export order; a macOS date as written (no offset yet). */
  messages: ExportMessage[];
}

/** The pages of one input path split by export (exportKey): consecutive pages of one folder. */
export function splitExports(pages: Iterable<Page>): Page[][] {
  const out: Page[][] = [];
  let prev: string | null = null;
  for (const page of pages) {
    const exp = exportKey(page.label);
    if (exp !== prev) out.push([]);
    (out[out.length - 1] as Page[]).push(page);
    prev = exp;
  }
  return out;
}

/**
 * Reads the pages of one HTML export (one folder: pages with one exportKey, in page order) into a
 * record, the sender of a joined message carried across page breaks. Throws on pages of two
 * folders, and on none.
 */
export function readHtmlExport(pages: Iterable<Page>): ExportRecord {
  let folder: string | null = null;
  let count = 0;
  let lastSender: string | null = null;
  let lastSenderId: string | null = null;
  const messages: ExportMessage[] = [];
  for (const page of pages) {
    const exp = exportKey(page.label);
    if (folder === null) folder = exp;
    else if (exp !== folder)
      throw new Error(`pages of two exports in one record: ${folder}, ${exp}`);
    count++;
    const p: ExportParser = new ExportParser(lastSender, lastSenderId);
    p.feed(page.html, page.files);
    p.close();
    lastSender = p.lastSender;
    lastSenderId = p.lastSenderId;
    messages.push(...p.messages);
  }
  if (folder === null) throw new Error('an export without pages');
  return { folder, pages: count, messages };
}

export interface MergeOptions {
  /**
   * The IANA time zone (`Europe/Rome`) of the computer that made the exports, for the dates of
   * macOS HTML exports, which have no offset, when the run gives none (exportOffsets). Needed only
   * then: a run that needs it and has none throws (the wiki's reader always asks for it).
   */
  timeZone?: string;
}

export interface MergeResult {
  /**
   * De-duplicated by (chat, id), the copy read last winning, except that a date read with its UTC
   * offset is kept over one converted from a macOS export, and a known sender id, chat id and
   * kind, and file text are kept; sorted by sortKey.
   */
  messages: ExportMessage[];
  /** Number of exports (records). */
  exports: number;
  /** Chat titles, sorted by code point; a missing or empty title is "?". */
  chats: string[];
  /** Lines for the user about the UTC offset given to the dates of macOS exports. */
  warnings: string[];
}

/** The optional fields a copy without them takes from another copy of its message. */
const KEPT = ['chat_id', 'chat_type', 'sender_id', 'file_name', 'file_text'] as const;

/**
 * Joins the records of a run, in order, into one list of messages. Gives macOS dates their UTC
 * offset (exportOffsets) and converts them to the Windows form, so that every date has one format,
 * then de-duplicates and sorts. The records are left unchanged.
 */
export function mergeExports(
  records: readonly ExportRecord[],
  options: MergeOptions = {}
): MergeResult {
  // The records' own messages are copied: the dates are converted in place.
  const copies: (DatedCopy & { m: ExportMessage })[] = [];
  records.forEach((r, i) => {
    for (const e of r.messages)
      copies.push({ m: { ...e }, exp: String(i), local: parseMacDate(e.date) });
  });
  const warnings: string[] = [];
  const label = (exp: string): string => (records[Number(exp)] as ExportRecord).folder;
  const offsets = exportOffsets(copies, options.timeZone, warnings, label);
  const byKey = new Map<string, { m: ExportMessage; local: boolean }>();
  for (const c of copies) {
    const m = c.m;
    let local = c.local !== null;
    if (c.local !== null)
      m.date = formatWindowsDate({
        ...c.local,
        offsetMinutes: (offsets.get(c.exp) as ExportOffset)(c.local),
      });
    const k = JSON.stringify([m.chat, m.id]);
    const prev = byKey.get(k);
    if (prev !== undefined) {
      // One date per message: a converted date gives way to one Telegram wrote with its offset.
      if (local && !prev.local && parseWindowsDate(prev.m.date) !== null) {
        m.date = prev.m.date;
        local = false;
      }
      // An export made without its files, or one that does not say, takes another copy's.
      for (const f of KEPT)
        if (m[f] === undefined && prev.m[f] !== undefined) m[f] = prev.m[f] as string;
    }
    byKey.set(k, { m, local });
  }
  const messages = sortMessages([...byKey.values()].map((c) => c.m));
  const chats = [...new Set(messages.map((m) => m.chat || '?'))].sort(compareCodePoints);
  return { messages, exports: records.length, chats, warnings };
}

/**
 * Parses the pages of each input path: each export of each path (splitExports) read into a record
 * (readHtmlExport), then the records merged (mergeExports).
 */
export function parsePages(
  paths: Iterable<Iterable<Page>>,
  options: MergeOptions = {}
): MergeResult {
  const records: ExportRecord[] = [];
  for (const pages of paths) for (const p of splitExports(pages)) records.push(readHtmlExport(p));
  return mergeExports(records, options);
}

/** The report line after parsing: how many exports, and their chats. */
export function summaryLine(r: Pick<MergeResult, 'exports' | 'chats'>): string {
  return `exports: ${r.exports}; chats: ${r.chats.join(', ')}`;
}
