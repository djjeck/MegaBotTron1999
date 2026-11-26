/**
 * An export's messages as the owner's Telegram account (`telegram-user`) would have delivered them
 * (packages/connectors/src/transport/telegram-user.ts): `Inbound`s of its account, in time order,
 * for a replay through real plugins (replay.ts). A per-replay mapping says what an export does not:
 * whose messages are the account's own, how the connector names each chat (as its config lists
 * it: an HTML export has no chat ids), and each sender's username (an export has display names,
 * and ids at most).
 *
 * As `telegram-user` delivers a message: `chat` as the connector names it (a group's id, a private
 * chat's `@username` or id, D90), its other names in `aliases`, `private` for a chat with one user
 * or bot, `sender` the username without `@` (`''` without one), `own` for the account's own (a
 * forward is its forwarder's), `id` and `replyTo` as strings, `time` in milliseconds, the text as
 * written (`/cmd@Bot` included), and a text file's content in `document`.
 */
import { type Inbound } from '@megabottron1999/core';
import { windowsDateSeconds } from './dates.ts';
import { PRIVATE_TYPES } from './json.ts';
import { type ExportMessage } from './messages.ts';

/** How the connector names a chat of the export. */
export interface ChatMapping {
  /** Its name, as the connector's config lists it: a group's id, a private chat's `@username`. */
  chat: string;
  /** Whether it is a private chat; by default, as a JSON export's kind says, else unsaid. */
  private?: boolean;
  /** Its other names (its id and its `@username`); the export's chat id is added when it differs. */
  aliases?: readonly string[];
}

/** What a replay knows that the export does not. */
export interface ReplayMapping {
  /** The account it replays as, `telegram:<name>`; by default `telegram:owner`, `telegram-user`'s. */
  account?: string;
  /**
   * The owner, the account's own user: their messages are the account's own (`own`), from
   * `username` (without `@`). Known by display name (`names`), or by id (`ids`: `user<id>`, as a
   * JSON export or a macOS HTML export gives it).
   */
  owner: { username?: string; names?: readonly string[]; ids?: readonly string[] };
  /**
   * The chats, by title or by the export's chat id (`chat_id`): a name, or a `ChatMapping`. A chat
   * not given is named by its chat id (JSON), else by its title.
   */
  chats?: Readonly<Record<string, string | ChatMapping>>;
  /**
   * The senders' usernames, without `@`, by id (`user<id>`) or by display name, the id first. A
   * sender not given has none (`''`), as `telegram-user` delivers one without a username.
   */
  senders?: Readonly<Record<string, string>>;
}

export interface InboundOptions {
  /** Whether they are history (`playback`, D83), not news: live by default. */
  playback?: boolean;
}

/** The text's length in UTF-8 bytes. */
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** A chat's mapping: given by its id or its title, else its id or title as its name. */
function chatOf(m: ExportMessage, mapping: ReplayMapping): ChatMapping {
  const given =
    (m.chat_id === undefined ? undefined : mapping.chats?.[m.chat_id]) ??
    (m.chat === null ? undefined : mapping.chats?.[m.chat]);
  const c: ChatMapping =
    given === undefined
      ? { chat: m.chat_id ?? m.chat ?? '?' }
      : typeof given === 'string'
        ? { chat: given }
        : given;
  const aliases = [...(c.aliases ?? [])];
  if (m.chat_id !== undefined && m.chat_id !== c.chat && !aliases.includes(m.chat_id))
    aliases.push(m.chat_id);
  const priv =
    c.private ?? (m.chat_type === undefined ? undefined : PRIVATE_TYPES.has(m.chat_type));
  return {
    chat: c.chat,
    ...(priv === undefined ? {} : { private: priv }),
    ...(aliases.length === 0 ? {} : { aliases }),
  };
}

/** Whether the owner wrote it: by id, else by display name. */
function isOwn(m: ExportMessage, mapping: ReplayMapping): boolean {
  const { names = [], ids = [] } = mapping.owner;
  if (m.sender_id !== undefined && ids.includes(m.sender_id)) return true;
  return m.sender !== null && names.includes(m.sender);
}

/** A sender's username, by id, else by display name; none for one not given. */
function senderOf(m: ExportMessage, mapping: ReplayMapping): string | undefined {
  const s = mapping.senders ?? {};
  return (
    (m.sender_id === undefined ? undefined : s[m.sender_id]) ??
    (m.sender === null ? undefined : s[m.sender])
  );
}

/** A username as `Inbound` carries it: none, rather than `''`, for a sender without one. */
const usernameOf = (u: string | undefined): { senderUsername?: string } =>
  u === undefined || u === '' ? {} : { senderUsername: u };

/**
 * The messages of an export (merged and sorted, mergeExports) as `Inbound`s of the account, in time
 * order. A message without a date takes the time of the one before it (else after it), as the
 * merge placed it.
 */
export function toInbounds(
  messages: readonly ExportMessage[],
  mapping: ReplayMapping,
  options: InboundOptions = {}
): Inbound[] {
  const account = mapping.account ?? 'telegram:owner';
  const times = windowsSeconds(messages);
  const out = messages.map((m, i): Inbound => {
    const chat = chatOf(m, mapping);
    const mine = isOwn(m, mapping);
    return {
      account,
      network: 'telegram',
      chat: chat.chat,
      ...(chat.aliases === undefined ? {} : { aliases: chat.aliases }),
      ...(chat.private === undefined ? {} : { private: chat.private }),
      ...usernameOf(mine ? mapping.owner.username : senderOf(m, mapping)),
      text: m.text,
      time: (times[i] as number) * 1000,
      id: String(m.id),
      ...(m.reply_to === null ? {} : { replyTo: String(m.reply_to) }),
      playback: options.playback ?? false,
      own: mine,
      ...(m.file_text === undefined
        ? {}
        : {
            document: {
              name: m.file_name ?? '',
              mime: 'text/plain',
              size: utf8Length(m.file_text),
              text: m.file_text,
            },
          }),
    };
  });
  // Stable: messages of one instant keep the merge's order.
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.time - b.m.time || a.i - b.i)
    .map((x) => x.m);
}

/** Each message's instant (seconds): its date's, else its neighbour's, else 0. */
function windowsSeconds(messages: readonly ExportMessage[]): number[] {
  const own = messages.map((m) => windowsDateSeconds(m.date));
  let prev: number | null = null;
  const filled = own.map((t) => (prev = t ?? prev));
  let next: number | null = null;
  const out: number[] = new Array<number>(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    next = own[i] ?? next;
    out[i] = filled[i] ?? next ?? 0;
  }
  return out;
}
