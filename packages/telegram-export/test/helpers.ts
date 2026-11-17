/**
 * Shared fixtures for the readers' tests, ported from the wiki generator's (#60). All data here is
 * invented: tests never read real exports.
 *
 * - tgDate(): Telegram-style timestamps ("27.11.2025 19:14:19 UTC-05:00").
 * - Chat: builds a conversation as the readers' messages, and can render it to Telegram Desktop
 *   HTML pages: the export from Windows (pageHtml / writeExport) or from macOS (macPageHtml /
 *   writeMacExport, docs/telegram-export.md section 11).
 * - runParse(): runs the real readers on folders, returning messages and the log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readExportPaths } from '#src/files.ts';
import { type ExportMessage } from '#src/messages.ts';

/** The made-up bot of the invented exports: its private chat is titled with its name. */
export const BOT = 'QuestBot';

/** A wall-clock instant with its UTC offset. */
export interface Instant {
  epoch: number; // seconds
  offsetMinutes: number;
}

/** 27.11.2025 19:00:00 UTC-05:00 */
export const BASE: Instant = { epoch: Date.UTC(2025, 10, 28, 0, 0, 0) / 1000, offsetMinutes: -300 };

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Telegram export timestamp `seconds` after `base`, shown in `offsetMinutes` (default: base's). */
export function tgDate(seconds = 0, base: Instant = BASE, offsetMinutes?: number): string {
  const off = offsetMinutes ?? base.offsetMinutes;
  const d = new Date((base.epoch + seconds + off * 60) * 1000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return (
    `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCFullYear(), 4)} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

/** A message for the HTML builder. Keys starting with `_` only steer the rendering. */
export interface Item {
  id: number;
  date: string;
  sender: string | null;
  text: string | null;
  reply_to?: number | null;
  forwarded_from?: string | null;
  /** Force (or prevent) rendering as a joined message. */
  _joined?: boolean;
  /** Reply link href, default `#go_to_message<reply_to>`. */
  _reply_href?: string;
  /** Original date shown in a forwarded message's inner from_name. */
  _fwd_date?: string | null;
  /** macOS export: the sender's (invented) Telegram user id, shown as its avatar file name. */
  _user_id?: number;
  /**
   * An attached file shown above the text (its caption): linked from `href`
   * (`files/file.txt`), or, with a null `href`, left out of the export.
   */
  _file?: { href: string | null };
}

/** A day separator: `["day", "27 November 2025"]`. */
export type DayItem = readonly ['day', string];

export type BuiltMessage = Omit<ExportMessage, 'date'> & { date: string } & Pick<
    Item,
    '_joined' | '_reply_href' | '_fwd_date' | '_user_id' | '_file'
  >;

interface AddOptions {
  reply_to?: number;
  forwarded_from?: string;
  msg_id?: number;
  fwd_date?: string;
  /** An attached file (Item._file): its link, or null for one left out of the export. */
  file?: string | null;
}

/** An invented chat. Messages are the readers' messages (`/cmd@Bot` as written). */
export class Chat {
  readonly title: string;
  readonly base: Instant;
  nextId: number;
  readonly messages: BuiltMessage[] = [];
  /** Other files of its export, by path in it (`files/file.txt`): writeExport's `files`. */
  readonly files: Record<string, string> = {};

  constructor(title: string = BOT, startId = 1000, base: Instant = BASE) {
    this.title = title;
    this.base = base;
    this.nextId = startId;
  }

  private add(sender: string, text: string, t: number, o: AddOptions = {}): BuiltMessage {
    const id = o.msg_id ?? this.nextId;
    this.nextId = Math.max(this.nextId, id) + 1;
    const m: BuiltMessage = {
      chat: this.title,
      id,
      date: tgDate(t, this.base),
      sender,
      forwarded_from: o.forwarded_from ?? null,
      reply_to: o.reply_to ?? null,
      text,
    };
    m._fwd_date = o.fwd_date ?? null;
    if (o.file !== undefined) m._file = { href: o.file };
    this.messages.push(m);
    return m;
  }

  user(
    sender: string,
    text: string,
    t: number,
    o: Omit<AddOptions, 'forwarded_from'> = {}
  ): BuiltMessage {
    return this.add(sender, text, t, o);
  }

  bot(text: string, t: number, o: Omit<AddOptions, 'forwarded_from'> = {}): BuiltMessage {
    return this.add(BOT, text, t, o);
  }

  /** `sender` forwards a message written by `originalAuthor`. */
  forward(
    sender: string,
    originalAuthor: string,
    text: string,
    t: number,
    o: Omit<AddOptions, 'forwarded_from'> = {}
  ): BuiltMessage {
    return this.add(sender, text, t, {
      ...o,
      forwarded_from: originalAuthor,
    });
  }

  /** Messages as the readers give them (no private builder keys). */
  clean(): ExportMessage[] {
    return this.messages.map(
      (m) =>
        Object.fromEntries(
          Object.entries(m).filter(([k]) => !k.startsWith('_'))
        ) as unknown as ExportMessage
    );
  }
}

/** HTML-escapes `&`, `<`, `>` and, with `quote`, `"` and `'` (as `&#x27;`). */
export function htmlEscape(s: string, quote = true): string {
  let r = s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (quote) r = r.replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
  return r;
}

/** An attached file's block (docs/telegram-export.md §5.6): linked, or left out of the export. */
function fileHtml(href: string | null): string {
  const body =
    '<div class="fill pull_left"></div><div class="body"><div class="title bold">file.txt</div>' +
    (href === null
      ? '<div class="description">Not included, change data exporting settings to download.</div>'
      : '') +
    '<div class="status details">14.7 KB</div></div>';
  return href === null
    ? `  <div class="media_wrap clearfix"><div class="media clearfix pull_left media_file">${body}</div></div>`
    : `  <div class="media_wrap clearfix"><a class="media clearfix pull_left block_link media_file" href="${htmlEscape(href)}">${body}</a></div>`;
}

export function messageHtml(m: Item, joined: boolean): string {
  const text = m.text === null ? null : htmlEscape(m.text, false).replaceAll('\n', '<br>');
  const parts = [
    `<div class="message default clearfix${joined ? ' joined' : ''}" id="message${m.id}">`,
  ];
  if (!joined) {
    const initial = htmlEscape(Array.from(m.sender || '?')[0] ?? '');
    parts.push(
      ' <div class="pull_left userpic_wrap"><div class="userpic userpic7" ' +
        'style="width: 42px; height: 42px"><div class="initials" ' +
        `style="line-height: 42px">${initial}</div></div></div>`
    );
  }
  parts.push(' <div class="body">');
  parts.push(
    `  <div class="pull_right date details" title="${m.date}">${m.date.slice(11, 16)}</div>`
  );
  if (!joined) parts.push(`  <div class="from_name">${htmlEscape(m.sender as string)} </div>`);
  if (m.reply_to) {
    const href = m._reply_href || `#go_to_message${m.reply_to}`;
    parts.push(
      `  <div class="reply_to details">In reply to <a href="${href}" ` +
        `onclick="return GoToMessage(${m.reply_to})">this message</a></div>`
    );
  }
  if (m.forwarded_from) {
    const fdate = m._fwd_date || '17.02.2026 14:09:52';
    parts.push(
      '  <div class="pull_left forwarded userpic_wrap"><div class="userpic userpic3" ' +
        'style="width: 42px; height: 42px"><div class="initials" ' +
        'style="line-height: 42px">F</div></div></div>'
    );
    parts.push('  <div class="forwarded body">');
    parts.push(
      `   <div class="from_name">${htmlEscape(m.forwarded_from)}<span class="date details" ` +
        `title="${fdate} UTC+01:00"> ${fdate}</span></div>`
    );
    parts.push(`   <div class="text">${text}</div>`);
    parts.push('  </div>');
  } else if (text !== null) {
    if (m._file) parts.push(fileHtml(m._file.href));
    parts.push(`  <div class="text">${text}</div>`);
  } else {
    parts.push(
      '  <div class="media_wrap clearfix"><div class="media"><div class="title bold">Sticker</div></div></div>'
    );
  }
  parts.push(' </div>');
  parts.push('</div>');
  return parts.join('\n');
}

/** One messagesN.html page. items: messages, or day separators. */
export function pageHtml(
  title: string,
  items: readonly (Item | DayItem)[],
  firstJoined = false
): string {
  const out = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"/><title>Exported Data</title></head><body>',
    '<div class="page_wrap">',
    '<div class="page_header"><div class="content"><div class="text bold">',
    htmlEscape(title),
    '</div></div></div>',
    '<div class="page_body chat_page"><div class="history">',
  ];
  let prev: string | null | undefined;
  let sid = -1;
  items.forEach((it, i) => {
    if (Array.isArray(it)) {
      out.push(
        `<div class="message service" id="message${sid}"><div class="body details">${it[1]}</div></div>`
      );
      sid -= 1;
      prev = undefined;
      return;
    }
    const m = it as Item;
    const joined =
      m._joined ??
      ((firstJoined && i === 0) || (prev !== undefined && prev === m.sender && !m.forwarded_from));
    out.push(messageHtml(m, joined));
    prev = m.sender;
  });
  out.push('</div></div></div></body></html>');
  return out.join('\n');
}

export function pageName(n: number): string {
  return n === 1 ? 'messages.html' : `messages${n}.html`;
}

/**
 * Writes pages (lists of items) as messages.html, messages2.html, ... in folder, and
 * `files`, other files of the export by path in it (`files/file.txt`).
 */
export function writeExport(
  folder: string,
  title: string,
  pages: readonly (readonly (Item | DayItem)[])[],
  firstJoined?: ReadonlySet<number>,
  files: Readonly<Record<string, string | Uint8Array>> = {}
): string {
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
  pages.forEach((items, i) => {
    const n = i + 1;
    fs.writeFileSync(
      path.join(folder, pageName(n)),
      pageHtml(title, items, firstJoined?.has(n) ?? false),
      'utf-8'
    );
  });
  return folder;
}

// ---- macOS export ------------------------------------------------------------------

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A Windows date title (tgDate) as the macOS export writes it: `28 November 2025, 00:00:00`, no offset. */
export function macDate(windowsDate: string): string {
  const m = /^(\d\d)\.(\d\d)\.(\d{4}) (\d\d:\d\d:\d\d) UTC/.exec(windowsDate);
  if (!m) return windowsDate;
  return `${Number(m[1])} ${MONTH_NAMES[Number(m[2]) - 1]} ${m[3]}, ${m[4]}`;
}

/** Text as the macOS export writes it: `'` raw, a leading command as a ShowBotCommand('…') anchor. */
function macText(t: string): string {
  const esc = (x: string): string =>
    x
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const cmd = /^\/[^\s]+/.exec(t);
  const body = cmd
    ? `<a onclick="return ShowBotCommand('${esc(cmd[0].slice(1))}')" href="#">${esc(cmd[0])}</a>${esc(t.slice(cmd[0].length))}`
    : esc(t);
  return body.replaceAll('\n', '<br>');
}

/**
 * One message in the macOS markup: unindented, avatar `photos/author_<id>.jpg` when the
 * sender has a user id (`m._user_id`, else `ids[sender]`), sender without trailing space.
 */
export function macMessageHtml(
  m: Item,
  joined: boolean,
  ids: Readonly<Record<string, number>> = {}
): string {
  const uid = m._user_id ?? (m.sender === null ? undefined : ids[m.sender]);
  const parts = [
    `<div class="message default clearfix${joined ? ' joined' : ''}" id="message${m.id}">`,
  ];
  if (!joined) {
    parts.push('<div class="pull_left userpic_wrap">');
    parts.push(
      uid === undefined
        ? '<div class="userpic userpic2" style="width: 42px; height: 42px"><div class="initials" style="line-height: 42px">X</div></div>'
        : `<img class="userpic" style="width: 42px; height: 42px" src="photos/author_${uid}.jpg"/>`
    );
    parts.push('</div>');
  }
  parts.push('<div class="body">');
  parts.push(
    `<div class="pull_right date details" title="${macDate(m.date)}">${m.date.slice(11, 16)}</div>`
  );
  if (!joined) parts.push(`<div class="from_name">${htmlEscape(m.sender as string, false)}</div>`);
  if (m.reply_to) {
    const href = m._reply_href || `#go_to_message${m.reply_to}`;
    parts.push(
      `<div class="reply_to details">In reply to <a href="${href}" onclick="return GoToMessage(${m.reply_to})">this message</a></div>`
    );
  }
  if (m.forwarded_from) {
    // The original author's avatar is not the sender's.
    parts.push(
      '<div class="pull_left forwarded userpic_wrap"><img class="userpic" style="width: 42px; height: 42px" src="photos/author_999000999.jpg"/></div>'
    );
    parts.push('<div class="forwarded body">');
    parts.push(
      `<div class="from_name">${htmlEscape(m.forwarded_from, false)}<span class="date details"> ${m._fwd_date || '17 February 2026, 14:09:52'}</span></div>`
    );
    parts.push(`<div class="text">${macText(m.text ?? '')}</div>`);
    parts.push('</div>');
  } else if (m.text !== null) {
    parts.push(`<div class="text">\n${macText(m.text)}</div>`);
  } else {
    parts.push(
      '<div class="media_wrap clearfix"><div class="media"><div class="title bold">Sticker</div></div></div>'
    );
  }
  parts.push('</div>');
  parts.push('</div>');
  return parts.join('\n');
}

/** One macOS export page: `div.name bold` title, `bot` subtitle in the DM, day separators without id. */
export function macPageHtml(
  title: string,
  items: readonly (Item | DayItem)[],
  ids: Readonly<Record<string, number>> = {}
): string {
  const out = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${htmlEscape(title, false)}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<link href="css/style.css" rel="stylesheet">',
    '<script src="js/script.js" type="text/javascript"></script>',
    '</head>',
    '<body onload="CheckLocation();">',
    '<div class="page_wrap">',
    '<div class="page_header chat_header">',
    '<div class="content bubble">',
    '<img class="userpic" style="width: 44px; height: 44px" src="photos/avatar.jpg"/>',
    '<div class="body">',
    `<div class="name bold">${htmlEscape(title, false)}</div>`,
    `<div class="subtitle details">${title === BOT ? 'bot' : '3 members'}</div>`,
    '</div>',
    '</div>',
    '</div>',
    '<div class="page_body chat_page">',
    '<div class="history">',
  ];
  let prev: string | undefined; // sender and user id of the previous entry
  const who = (m: Item): string =>
    JSON.stringify([m.sender, m._user_id ?? (m.sender === null ? null : ids[m.sender]) ?? null]);
  for (const it of items) {
    if (Array.isArray(it)) {
      out.push(`<div class="message service">\n<div class="body details">${it[1]}</div>\n</div>`);
      prev = undefined;
      continue;
    }
    const m = it as Item;
    const joined = m._joined ?? (prev !== undefined && prev === who(m) && !m.forwarded_from);
    out.push(macMessageHtml(m, joined, ids));
    prev = who(m);
  }
  out.push('</div>', '</div>', '</div>', '</body>', '</html>');
  return out.join('\n');
}

/** Writes a one-page macOS export (messages.html) in folder. */
export function writeMacExport(
  folder: string,
  title: string,
  items: readonly (Item | DayItem)[],
  ids: Readonly<Record<string, number>> = {}
): string {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'messages.html'), macPageHtml(title, items, ids), 'utf-8');
  return folder;
}

/** Runs the readers on paths -> messages and the log's text. */
export function runParse(
  paths: readonly string[],
  timeZone = 'America/New_York' // the zone of BASE in winter
): { msgs: ExportMessage[]; err: string } {
  const lines: string[] = [];
  const { messages } = readExportPaths(paths, (l) => lines.push(l), { timeZone });
  return { msgs: messages, err: lines.map((l) => l + '\n').join('') };
}

// ---- JSON export ---------------------------------------------------------------------

/** A Windows date title (tgDate) as the JSON export writes it: its wall clock, and its instant. */
export function jsonDate(windowsDate: string): { date: string; date_unixtime: string } {
  const m = /^(\d\d)\.(\d\d)\.(\d{4}) (\d\d:\d\d:\d\d) UTC([+-])(\d\d):(\d\d)$/.exec(windowsDate);
  if (!m) throw new Error(`not a date: ${windowsDate}`);
  const date = `${m[3]}-${m[2]}-${m[1]}T${m[4]}`;
  const offset = (m[5] === '-' ? -1 : 1) * (Number(m[6]) * 60 + Number(m[7]));
  const epoch = Date.parse(`${date}Z`) / 1000 - offset * 60;
  return { date, date_unixtime: String(epoch) };
}

/** A text as the JSON export writes it: a leading command as a `bot_command` entity. */
function jsonText(t: string): string | (string | { type: string; text: string })[] {
  const cmd = /^\/\S+/u.exec(t);
  if (cmd === null) return t;
  const rest = t.slice(cmd[0].length);
  return [{ type: 'bot_command', text: cmd[0] }, ...(rest === '' ? [] : [rest])];
}

/**
 * A chat's export in Telegram Desktop's JSON (docs/telegram-export.md §13): its kind and bare id,
 * each sender's `from_id` from `ids` (by display name), a service message before the first.
 */
export function jsonExport(
  chat: Chat,
  type: string,
  id: number,
  ids: Readonly<Record<string, number>> = {}
): Record<string, unknown> {
  const first = chat.messages[0];
  const service =
    first === undefined
      ? []
      : [
          {
            id: first.id - 1,
            type: 'service',
            ...jsonDate(first.date),
            actor: first.sender,
            actor_id: 'user1',
            action: 'pin_message',
            text: '',
            text_entities: [],
          },
        ];
  return {
    name: chat.title,
    type,
    id,
    messages: [
      ...service,
      ...chat.messages.map((m) => {
        const text = jsonText(m.text);
        const uid = m.sender === null ? undefined : ids[m.sender];
        return {
          id: m.id,
          type: 'message',
          ...jsonDate(m.date),
          from: m.sender,
          ...(uid === undefined ? {} : { from_id: `user${uid}` }),
          ...(m.forwarded_from === null ? {} : { forwarded_from: m.forwarded_from }),
          ...(m.reply_to === null ? {} : { reply_to_message_id: m.reply_to }),
          ...(m._file?.href
            ? { file: m._file.href, file_name: 'file.txt', mime_type: 'text/plain' }
            : {}),
          text,
          text_entities: (typeof text === 'string' ? [text] : text).map((p) =>
            typeof p === 'string' ? { type: 'plain', text: p } : p
          ),
        };
      }),
    ],
  };
}
