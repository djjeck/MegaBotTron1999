/**
 * The HTML reader: Telegram Desktop HTML export pages -> messages (docs/telegram-export.md, the
 * export from Windows and, §11, from macOS). Ported from the wiki generator's reader (#60), which is
 * validated across a large inbox of groups and private chats; its choices are kept.
 *
 * Generic: it knows no bot. Texts are kept as written, `/cmd@Bot` included.
 *
 * Pure logic only (no Node APIs): pages come in as strings. Reading the pages of one export, and
 * merging the exports of a run, is merge.ts; finding the pages on disk is files.ts.
 */
import {
  formatOffset,
  isTimeZone,
  parseWindowsDate,
  type WallClock,
  wallClockOffset,
  windowsDateSeconds,
  type ZonedDate,
} from './dates.ts';
import { type Attrs, feedHtml, type HtmlEvents } from './html-events.ts';
import { type ExportMessage } from './messages.ts';
import { pathName } from './paths.ts';
import { compareCodePoints, parseDecimalInt, stripWs, WORD_CLASS, WS_CLASS } from './text.ts';

/**
 * A page file name as Telegram writes it, matched against the whole path:
 * `messages.html` (page 1), then `messages2.html`, `messages3.html`, ... (no zero
 * padding; `messages1.html` and `messages01.html` are not pages).
 */
export const PAGE = /(^|\/)messages(?:[2-9]|[1-9][0-9]+)?\.html(?=\n?$)/u;
const PAGE_KEY = /messages((?:[2-9]|[1-9][0-9]+)?)\.html(?=\n?$)/u;
/** Reply link target: `#go_to_message<N>` or `messagesK.html#go_to_message<N>`, N possibly negative. */
const GO_TO_MESSAGE = /go_to_message(-?\p{Nd}+)/u;
/** `Bob Stone via @gif`: a message sent through an inline bot; the suffix is not part of the name. */
const VIA_BOT = new RegExp(`${WS_CLASS}+via${WS_CLASS}+@${WORD_CLASS}+$`, 'u');
/** The class of a message's attached file, linked or not (docs/telegram-export.md §5.6). */
export const MEDIA_FILE = /(?:^|\s)media_file(?:\s|$)/u;
/** macOS export avatar: `photos/author_<numeric Telegram user id>.jpg`. */
const AUTHOR_PHOTO = /(?:^|\/)author_(-?[0-9]+)\.[A-Za-z0-9]+$/u;

interface Current {
  id: number;
  from?: string;
  fwd_from?: string;
  date?: string | null;
  reply_to?: number;
  text?: string;
  ctx: string;
  joined: boolean;
  /** Has a `forwarded body` block. */
  forwarded?: boolean;
  /** Telegram user id from the sender's avatar file (macOS export). */
  authorId?: string;
  /** Link of the attached file (`a.media_file`), as written. */
  file?: string;
}

/**
 * Extracts messages from one messagesN.html page.
 *
 * Per message: id, timestamp, sender (and its user id, where a macOS export gives it), text, the
 * id it replies to, for forwarded messages the original author (the inner from_name), and the
 * content of an attached text file that the export holds (the files given to feed). The state machine
 * also handles the markup's irregular cases: joined messages and joined forwards, which
 * inherit their sender or original author; a trailing `via @bot` in a name; negative ids
 * in reply links; and service entries (day separators, pins), which close the current
 * message without adding to it.
 */
export class ExportParser implements HtmlEvents {
  readonly messages: ExportMessage[] = [];
  chat: string | null = null;
  /** Sender of the last message entry; joined messages inherit it. */
  lastSender: string | null;
  /** User id of the last message entry's sender, if known; joined messages inherit it. */
  lastSenderId: string | null;
  /** Original author of the last message entry if it was a forward, else null. */
  private lastFwdFrom: string | null = null;
  private cur: Current | null = null;
  private capture: 'from_name' | 'text' | null = null;
  private captureDepth = 0;
  private buf: string[] = [];
  private skipSpan = 0; // inside a <span class="... date ..."> within from_name
  private depth = 0; // div depth inside the current message
  private fwdDepth: number | null = null; // div depth of the "forwarded body" block
  private inHeader = false;
  /** Inside `div.page_header`, before the first history entry (macOS chat title). */
  private inPageHeader = false;
  /** Div depth of the message's own `pull_left userpic_wrap` (not the forwarded one). */
  private userpicDepth: number | null = null;
  /** That block has ended: later images (reactions, forwards) are not the sender's. */
  private userpicDone = false;

  /** `lastSender` and `lastSenderId` come from the previous page of the same export. */
  constructor(lastSender: string | null = null, lastSenderId: string | null = null) {
    this.lastSender = lastSender;
    this.lastSenderId = lastSenderId;
  }

  /** The text files of the page being fed, by link (Page.files). */
  private files: ReadonlyMap<string, string> = new Map();

  /** Feeds one page, with the text files it links to that the export holds (Page.files). */
  feed(html: string, files: ReadonlyMap<string, string> = new Map()): void {
    this.files = files;
    feedHtml(html, this);
  }

  close(): void {
    this.flush();
  }

  starttag(tag: string, a: Attrs): void {
    const cls = a.get('class') || '';
    if (tag === 'div' && cls === 'text bold' && this.chat === null) {
      this.inHeader = true;
      return;
    }
    if (tag === 'div' && /^page_header(?:\s|$)/u.test(cls)) this.inPageHeader = true;
    // macOS export: the title is `div.name bold` in the header (no `div.text bold`).
    if (tag === 'div' && cls === 'name bold' && this.chat === null && this.inPageHeader) {
      this.inHeader = true;
      return;
    }
    if (tag === 'div' && cls === 'history') this.inPageHeader = false;
    if (tag === 'div' && cls.startsWith('message default')) {
      this.inPageHeader = false;
      this.flush();
      const id = a.get('id');
      if (id === undefined || id === null)
        throw new Error(`message div without id: class="${cls}"`);
      this.cur = {
        id: parseDecimalInt(id.startsWith('message') ? id.slice('message'.length) : id),
        ctx: '',
        joined: /(^|\s)joined(\s|$)/u.test(cls),
      };
      this.depth = 0;
      this.fwdDepth = null;
      this.userpicDepth = null;
      this.userpicDone = false;
      return;
    }
    if (tag === 'div' && /^message service(?:\s|$)/u.test(cls)) {
      // A service entry ends the current message; its own content is ignored.
      this.flush();
      return;
    }
    const cur = this.cur;
    if (cur === null) return;
    if (tag === 'br' && this.capture) {
      this.buf.push('\n');
      return;
    }
    if (tag === 'span' && this.capture === 'from_name' && cls.includes('date')) {
      this.skipSpan++;
      return;
    }
    if (tag === 'a' && MEDIA_FILE.test(cls) && a.get('href')) cur.file = a.get('href') as string;
    if (tag === 'a' && cur.ctx.includes('reply_to')) {
      const m = GO_TO_MESSAGE.exec(a.get('href') || '');
      if (m) cur.reply_to = parseDecimalInt(m[1] as string);
    }
    if (tag === 'img') {
      this.avatar(a);
      return;
    }
    if (tag !== 'div') return;
    this.depth++;
    if (this.capture) return;
    if (cls === 'pull_left userpic_wrap' && this.userpicDepth === null && !this.userpicDone) {
      this.userpicDepth = this.depth;
    } else if (cls.startsWith('forwarded body')) {
      this.fwdDepth = this.depth;
      cur.forwarded = true;
    } else if (cls.includes('date details') && a.has('title') && this.fwdDepth === null) {
      cur.date = a.get('title') ?? null;
    } else if (cls.startsWith('reply_to')) {
      cur.ctx = 'reply_to';
    } else if (cls === 'from_name' || cls === 'text') {
      this.capture = cls;
      this.captureDepth = this.depth;
      this.buf = [];
    }
  }

  startendtag(tag: string, a: Attrs): void {
    if (this.capture && tag === 'br') this.buf.push('\n');
    if (tag === 'img' && this.cur !== null) this.avatar(a);
  }

  /** `<img class="userpic" src="photos/author_<id>.jpg">` in the sender's avatar block. */
  private avatar(a: Attrs): void {
    const cur = this.cur;
    if (
      cur === null ||
      this.userpicDepth === null ||
      this.userpicDone ||
      this.depth < this.userpicDepth
    )
      return;
    const m = AUTHOR_PHOTO.exec(a.get('src') || '');
    if (m) cur.authorId = m[1] as string;
  }

  endtag(tag: string): void {
    const cur = this.cur;
    if (cur === null) return;
    if (tag === 'span' && this.skipSpan) {
      this.skipSpan--;
      return;
    }
    if (tag !== 'div') return;
    if (this.capture && this.depth === this.captureDepth) {
      const value = stripWs(this.buf.join(''));
      if (this.capture === 'from_name') {
        const name = value.replace(VIA_BOT, '');
        if (this.fwdDepth !== null) cur.fwd_from = name;
        else cur.from = name;
      } else {
        cur.text = value;
      }
      this.capture = null;
    }
    if (cur.ctx === 'reply_to') cur.ctx = '';
    if (this.fwdDepth !== null && this.depth === this.fwdDepth) this.fwdDepth = null;
    if (this.userpicDepth !== null && !this.userpicDone && this.depth === this.userpicDepth)
      this.userpicDone = true;
    this.depth--;
  }

  data(text: string): void {
    if (this.inHeader) {
      this.chat = stripWs(text);
      this.inHeader = false;
    }
    if (this.capture && !this.skipSpan) this.buf.push(text);
  }

  private flush(): void {
    const cur = this.cur;
    if (cur === null) return;
    const sender = cur.from || this.lastSender;
    this.lastSender = sender;
    // The id goes with the name: a message with its own sender block has its own avatar.
    const senderId = cur.authorId ?? (cur.from ? null : this.lastSenderId);
    this.lastSenderId = senderId;
    // A joined forward without an inner from_name has the previous forward's author.
    let fwdFrom = cur.fwd_from ?? null;
    if (!fwdFrom && cur.forwarded && cur.joined && this.lastFwdFrom) fwdFrom = this.lastFwdFrom;
    this.lastFwdFrom = cur.forwarded ? fwdFrom : null;
    if (cur.text !== undefined) {
      const m: ExportMessage = {
        chat: this.chat,
        id: cur.id,
        date: cur.date ?? null,
        sender,
        forwarded_from: fwdFrom,
        reply_to: cur.reply_to ?? null,
        text: cur.text,
      };
      if (senderId !== null) m.sender_id = `user${senderId}`;
      const fileText = cur.file === undefined ? undefined : this.files.get(cur.file);
      if (fileText !== undefined) {
        m.file_name = pathName(cur.file as string);
        m.file_text = fileText;
      }
      this.messages.push(m);
    }
    this.cur = null;
  }
}

/** Page number of a page path: `messages.html` is 1, `messages10.html` is 10. */
export function pageKey(path: string): number {
  const m = PAGE_KEY.exec(pathName(path));
  if (!m) throw new Error(`not an export page: ${path}`);
  return m[1] ? parseDecimalInt(m[1]) : 1;
}

type SortKey = [ts: number, chat: string, id: number];
type Sortable = Pick<ExportMessage, 'date' | 'chat' | 'id'>;

/**
 * Sort key: (instant, chat or "", id); ids only order within one chat. `ts` overrides
 * the instant of the message's own date (see sortMessages).
 */
export function sortKey(m: Sortable, ts: number = windowsDateSeconds(m.date) ?? 0): SortKey {
  return [ts, m.chat || '', m.id];
}

function compareSortKeys(a: SortKey, b: SortKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return compareCodePoints(a[1], b[1]) || a[2] - b[2];
}

/**
 * Instants for sorting: a message whose date is missing or unparsable takes the instant
 * of the nearest earlier message (by id) of its chat that has one, else of the nearest
 * later one, so it keeps its place by id; 0 if no message of the chat has a date.
 */
function sortInstants<T extends Sortable>(xs: readonly T[]): Map<T, number> {
  const byChat = new Map<string, T[]>();
  for (const m of xs) {
    const k = m.chat || '';
    const list = byChat.get(k);
    if (list) list.push(m);
    else byChat.set(k, [m]);
  }
  const out = new Map<T, number>();
  for (const list of byChat.values()) {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    const own = sorted.map((m) => windowsDateSeconds(m.date));
    let prev: number | null = null;
    const filled = own.map((t) => (prev = t ?? prev));
    let next: number | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      next = own[i] ?? next;
      out.set(sorted[i] as T, filled[i] ?? next ?? 0);
    }
  }
  return out;
}

/** Stable sort by sortKey, undated messages placed by id within their chat (sortInstants). */
export function sortMessages<T extends Sortable>(xs: readonly T[]): T[] {
  const ts = sortInstants(xs);
  return xs
    .map((m) => ({ m, k: sortKey(m, ts.get(m)) }))
    .sort((a, b) => compareSortKeys(a.k, b.k))
    .map((x) => x.m);
}

/**
 * The export a page belongs to: its label minus the last path component (`\` read
 * as `/`; a bare file name is in the current folder, "."). The last sender is carried
 * to the next page only within one export.
 */
export function exportKey(label: string): string {
  const s = label.replaceAll('\\', '/');
  const i = s.lastIndexOf('/');
  return i < 0 ? '.' : s.slice(0, i);
}

// ---- macOS export dates -------------------------------------------------------------

/** `UTC±HH:MM`, the offset label of a Windows date title. */
const offsetLabel = (minutes: number): string => `UTC${formatOffset(minutes)}`;

const sameWallClock = (w: WallClock, d: ZonedDate): boolean =>
  w.year === d.year &&
  w.month === d.month &&
  w.day === d.day &&
  w.hour === d.hour &&
  w.minute === d.minute &&
  w.second === d.second;

// ---- dates without offset across exports ----------------------------------------------

/** One copy of a message, as the offsets of macOS dates are inferred from it. */
export interface DatedCopy {
  m: Pick<ExportMessage, 'chat' | 'id' | 'date'>;
  /** The export it was read from (any key that tells exports apart). */
  exp: string;
  /** Wall clock of a date title without offset (macOS export), else null. */
  local: WallClock | null;
}

/** The UTC offset, in minutes east of UTC, of each offset-less date of an export. */
export type ExportOffset = (w: WallClock) => number;

/**
 * The UTC offset of the dates of each export with offset-less dates: the offset of the
 * other exports in the run that share messages with it (same chat and id) and show the
 * same wall clock for them (the most frequent, if several), which reproduces their
 * labelling; else, for each date, the offset `timeZone` had then (none given: an error). Writes one line per
 * such export to `warnings`, naming it by `label`.
 */
export function exportOffsets(
  copies: readonly DatedCopy[],
  timeZone: string | undefined,
  warnings: string[],
  label: (exp: string) => string
): Map<string, ExportOffset> {
  const out = new Map<string, ExportOffset>();
  const local = new Map<string, DatedCopy[]>();
  for (const c of copies) {
    if (c.local === null) continue;
    const list = local.get(c.exp);
    if (list) list.push(c);
    else local.set(c.exp, [c]);
  }
  if (local.size === 0) return out;
  if (timeZone !== undefined && !isTimeZone(timeZone))
    throw new Error(`unknown time zone: ${timeZone}`);
  const native = new Map<string, { exp: string; parts: ZonedDate }[]>();
  for (const c of copies) {
    const parts = c.local === null ? parseWindowsDate(c.m.date) : null;
    if (parts === null) continue;
    const k = JSON.stringify([c.m.chat, c.m.id]);
    const list = native.get(k);
    if (list) list.push({ exp: c.exp, parts });
    else native.set(k, [{ exp: c.exp, parts }]);
  }
  for (const [exp, list] of local) {
    // Each shared message: the offsets of its other copies with the same wall clock.
    const shared: (number | null)[][] = [];
    const votes = new Map<number, number>();
    for (const c of list) {
      const others = (native.get(JSON.stringify([c.m.chat, c.m.id])) ?? []).filter(
        (n) => n.exp !== exp
      );
      if (others.length === 0) continue;
      const labels = others.map((n) =>
        sameWallClock(c.local as WallClock, n.parts) ? n.parts.offsetMinutes : null
      );
      shared.push(labels);
      for (const l of new Set(labels)) if (l !== null) votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    const best =
      [...votes].sort(
        (a, b) => b[1] - a[1] || compareCodePoints(offsetLabel(a[0]), offsetLabel(b[0]))
      )[0]?.[0] ?? null;
    const disagree = shared.filter((labels) => labels.some((l) => l !== best)).length;
    const n = shared.length;
    if (best !== null) {
      out.set(exp, () => best);
      let line = `${label(exp)}: dates without a UTC offset, read as ${offsetLabel(best)} as the other exports of the same chat (${n} messages in common)`;
      if (disagree > 0)
        line += `; in ${disagree} of them another export shows another date or another offset`;
      warnings.push(line);
    } else {
      if (timeZone === undefined)
        throw new Error(
          `${label(exp)}: dates without a UTC offset, and no other export of the chat to take it from: give the time zone the export was made in`
        );
      out.set(exp, (w) => wallClockOffset(w, timeZone));
      let line = `${label(exp)}: dates without a UTC offset, read in the time zone ${timeZone}`;
      if (n > 0)
        line += `; the ${n} messages in common with other exports of the same chat show other dates there`;
      warnings.push(line);
    }
  }
  return out;
}
