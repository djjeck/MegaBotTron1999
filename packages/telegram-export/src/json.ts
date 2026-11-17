/**
 * The JSON reader: Telegram Desktop's machine-readable export (`result.json`,
 * docs/telegram-export.md §13) -> the messages the HTML reader gives (messages.ts), so that both
 * merge and replay alike. Its texts are read as the HTML reader reads them (the visible text,
 * stripped, `/cmd@Bot` as written); unlike the HTML, it gives the chat's id and kind and the
 * sender's id, and every date with its instant.
 *
 * Pure logic, no Node APIs: the export comes in parsed, its attached text files as strings
 * (files.ts reads them from disk).
 */
import { formatWindowsDate, offsetAt, parseJsonDate, type WallClock } from './dates.ts';
import { TEXT_FILE_LINK } from './listing.ts';
import { type ExportRecord } from './merge.ts';
import { type ExportMessage } from './messages.ts';
import { pathName } from './paths.ts';
import { stripWs } from './text.ts';

/** One chat of a JSON export, as Telegram Desktop writes it (the fields read). */
interface JsonChat {
  name?: string | null;
  type?: string;
  id?: number;
  messages?: unknown[];
}

/** The kinds of chat whose id is a user's (or a bot's): a private chat. */
export const PRIVATE_TYPES: ReadonlySet<string> = new Set([
  'personal_chat',
  'bot_chat',
  'saved_messages',
  'replies',
  'verification_codes',
]);

/**
 * A chat's id as the network names it (GramJS's marked id, as `telegram-user` names a chat: bot-os.md
 * D90), from the export's bare id and kind: a user's as it is, `-<id>` for a basic group,
 * `-100<id>` for a supergroup or a channel; undefined for a kind it does not know.
 */
export function markedChatId(type: string | undefined, id: number | undefined): string | undefined {
  if (id === undefined || type === undefined) return undefined;
  if (PRIVATE_TYPES.has(type)) return String(id);
  if (type === 'private_group') return `-${id}`;
  if (/_(?:supergroup|channel)$/u.test(type)) return `-100${id}`;
  return undefined;
}

/**
 * A message's visible text: `text` as a string, or an array of strings and entity objects (`{ type,
 * text, … }`), each object's `text` as shown; stripped, as the HTML reader strips it.
 */
export function jsonText(text: unknown): string {
  if (typeof text === 'string') return stripWs(text);
  if (!Array.isArray(text)) return '';
  const parts = text.map((p: unknown) => {
    if (typeof p === 'string') return p;
    const t = (p as { text?: unknown } | null)?.text;
    return typeof t === 'string' ? t : '';
  });
  return stripWs(parts.join(''));
}

const MONTHS = [
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

/** A wall clock in the macOS HTML form, for the merge to give it an offset (§11.3). */
function macForm(w: WallClock): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${w.day} ${MONTHS[w.month - 1]} ${w.year}, ${p(w.hour)}:${p(w.minute)}:${p(w.second)}`;
}

/**
 * A message's date in the Windows form: its wall clock (`date`) with the offset its instant
 * (`date_unixtime`) gives it. Without an instant (an older export), the wall clock in the macOS
 * form, which the merge gives an offset as it does a macOS export's; null without a date.
 */
function jsonDate(date: unknown, unix: unknown): string | null {
  const w = parseJsonDate(typeof date === 'string' ? date : null);
  if (w === null) return null;
  const epoch = typeof unix === 'string' && /^[0-9]+$/u.test(unix) ? Number(unix) : unix;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch)) return macForm(w);
  const offset = offsetAt(w, epoch);
  if (offset !== null) return formatWindowsDate({ ...w, offsetMinutes: offset });
  // Not a whole number of minutes apart: the instant, in UTC.
  const d = new Date(epoch * 1000);
  return formatWindowsDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    offsetMinutes: 0,
  });
}

/** The chats of a JSON export: the one of a chat's export, or every chat of an account's. */
export function jsonChats(json: unknown): JsonChat[] {
  if (typeof json !== 'object' || json === null) return [];
  const o = json as Record<string, unknown>;
  if (Array.isArray(o['messages'])) return [o as JsonChat];
  const list = (k: string): JsonChat[] => {
    const l = (o[k] as { list?: unknown } | undefined)?.list;
    return Array.isArray(l)
      ? (l.filter((c) => typeof c === 'object' && c !== null) as JsonChat[])
      : [];
  };
  return [...list('chats'), ...list('left_chats')];
}

/**
 * The attached text files a JSON export links to (`file`: `files/<name>.txt`, relative to the
 * export's folder), once each, in order: for an adapter to read into `files`.
 */
export function jsonTextFiles(json: unknown): string[] {
  const out = new Set<string>();
  for (const chat of jsonChats(json))
    for (const m of chat.messages ?? []) {
      const file = (m as { file?: unknown } | null)?.file;
      if (typeof file === 'string' && TEXT_FILE_LINK.test(file)) out.add(file);
    }
  return [...out];
}

/** A number, or undefined for anything else. */
const num = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isInteger(x) ? x : undefined;
/** A string, or null for anything else. */
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/**
 * Reads a JSON export (parsed: a chat's export, or an account's with every chat) into a record.
 * Only messages with a visible text are kept, as the HTML reader keeps them: service messages,
 * and media without a caption, are left out. `files`: the attached text files the export holds,
 * by their `file` path (jsonTextFiles).
 */
export function readJsonExport(
  json: unknown,
  label: string,
  files: ReadonlyMap<string, string> = new Map()
): ExportRecord {
  const chats = jsonChats(json);
  if (chats.length === 0) throw new Error(`${label}: not a Telegram JSON export`);
  const messages: ExportMessage[] = [];
  for (const chat of chats) {
    const chatId = markedChatId(chat.type, num(chat.id));
    for (const raw of chat.messages ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const id = num(r['id']);
      if (r['type'] !== 'message' || id === undefined) continue;
      const text = jsonText(r['text']);
      if (text === '') continue;
      const reply = num(r['reply_to_message_id']);
      const m: ExportMessage = {
        chat: str(chat.name),
        id,
        date: jsonDate(r['date'], r['date_unixtime']),
        sender: str(r['from']) === null ? null : stripWs(r['from'] as string),
        forwarded_from:
          str(r['forwarded_from']) === null ? null : stripWs(r['forwarded_from'] as string),
        reply_to: reply ?? null,
        text,
      };
      if (chatId !== undefined) m.chat_id = chatId;
      if (typeof chat.type === 'string') m.chat_type = chat.type;
      const from = str(r['from_id']);
      if (from !== null) m.sender_id = from;
      const file = str(r['file']);
      const fileText = file === null ? undefined : files.get(file);
      if (fileText !== undefined) {
        m.file_name = str(r['file_name']) ?? pathName(file as string);
        m.file_text = fileText;
      }
      messages.push(m);
    }
  }
  return { folder: label, pages: 0, messages };
}
