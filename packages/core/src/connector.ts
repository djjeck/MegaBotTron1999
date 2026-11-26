/**
 * Accounts and connectors (docs/bot-os-api.md §4.5, docs/bot-os.md §3). An account is one identity
 * on one network, `<network>:<name>` (`irc:alice`, `telegram:alice`, `telegram-bot:ExampleBot`).
 * A connector is bound to one account and holds its credentials (P9): what it reads comes in as
 * `Inbound` messages, each saying which account saw it.
 *
 * A connector plugin's instance offers its `Connector`. Other plugins get a `ConnectorHandle`,
 * which reads the chats its reach names and tells the status, but cannot send: every send goes
 * through the outbox (§4.6).
 */

import { z } from 'zod';
import {
  type Buttons,
  type ChatCommand,
  type CommandButton,
  type CommandPhoto,
} from './commands.ts';
import { type Media } from './media.ts';
import { type Limits, type TextFormat } from './outbox.ts';

/**
 * A file attached to a message (docs/bot-os.md D82): what it is, and its text when the connector
 * read it. A text file (`text/*`, JSON, XML, CSV, or a generic type with a `.txt`, `.csv`,
 * `.tsv`, `.json`, `.md` or `.log` name) of at most `DOCUMENT_MAX_BYTES`, in UTF-8, comes with
 * its text; any other, with why not (`skipped`).
 */
export interface InboundDocument {
  /** Its file name, as sent; `''` when it has none. */
  name: string;
  /** Its media type, in lower case, without parameters; `''` when the network does not say. */
  mime: string;
  /** Its size, in bytes, as the network says (as read, when it was). */
  size: number;
  /** Its content, decoded as UTF-8, a byte-order mark taken off; nothing else changed. */
  text?: string;
  /**
   * Why it has no `text`: not a text type (`type`), larger than the limit (`size`), not UTF-8
   * text (`encoding`), or its download failed (`failed`).
   */
  skipped?: 'type' | 'size' | 'encoding' | 'failed';
}

/** What a message carries besides its text (bot-os.md D161). */
export type InboundMediaKind =
  | 'photo'
  | 'sticker'
  | 'animation'
  | 'video'
  | 'round'
  | 'voice'
  | 'audio'
  | 'file'
  | 'poll'
  | 'location'
  | 'venue'
  | 'contact'
  | 'dice'
  | 'game'
  | 'story'
  | 'other';

/**
 * What a message carries besides its text (bot-os.md D161), described, never downloaded: a sticker
 * and its emoji, a photo, a GIF (`animation`), a video note (`round`), a voice note, a poll and its
 * question… A file of any of them is in `document` as well, with its name.
 */
export interface InboundMedia {
  kind: InboundMediaKind;
  /** A sticker's emoji, a die's (🎲, 🎯…). */
  emoji?: string;
  /**
   * What names it: a poll's question, an audio's performer and title, a venue's, a game's, a
   * contact's name (never a number or a place's coordinates).
   */
  title?: string;
  /** A poll's answers. */
  options?: readonly string[];
}

/**
 * How old a message delivered by a connector's catch-up may be and still count as news, in
 * seconds (bot-os.md D83): from its own time to its delivery. Older, it is played back (history);
 * a quick restart so costs nothing.
 */
export const LIVE_GRACE_S = 120;
/** A connector's config field for it. */
export const liveGraceS = z
  .number()
  .min(0)
  .default(LIVE_GRACE_S)
  .describe(
    'How many seconds old a message caught up after a restart may be and still count as live, not history'
  );

/** The largest file a connector reads the text of (D82): 256 KiB. */
export const DOCUMENT_MAX_BYTES = 256 * 1024;

/** The media types read as text, beside `text/*`. */
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/csv']);
/** The generic types a file of a text name is read under. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream']);
const TEXT_NAME = /\.(?:txt|csv|tsv|json|md|log)$/iu;

/** A media type in lower case, without its parameters (`text/plain; charset=utf-8`). */
const bareType = (mime: string): string => (mime.split(';')[0] ?? '').trim().toLowerCase();

/** Whether a file is read as text (D82): by its media type, or by its name under a generic one. */
export function isTextDocument(name: string, mime: string): boolean {
  const type = bareType(mime);
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) return true;
  return GENERIC_TYPES.has(type) && TEXT_NAME.test(name);
}

/**
 * A message's file, for its `Inbound` (D82): its text, downloaded (`download`, the network's) and
 * decoded, if it is a text file of at most `DOCUMENT_MAX_BYTES` in UTF-8; else what it is, and
 * why not. Never throws: a failed download is `skipped: 'failed'`, told to `warn`, and the message
 * goes on with it.
 */
export async function readDocument(
  file: { name?: string | undefined; mime?: string | undefined; size?: number | undefined },
  download: () => Promise<Uint8Array | undefined>,
  warn: (line: string) => void = () => {}
): Promise<InboundDocument> {
  const name = file.name ?? '';
  const mime = bareType(file.mime ?? '');
  const meta = { name, mime, size: file.size ?? 0 };
  if (!isTextDocument(name, mime)) return { ...meta, skipped: 'type' };
  if (meta.size > DOCUMENT_MAX_BYTES) return { ...meta, skipped: 'size' };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await download();
  } catch (e) {
    warn(`download of ${name || 'a file'} failed: ${String(e)}`);
    return { ...meta, skipped: 'failed' };
  }
  if (bytes === undefined) return { ...meta, skipped: 'failed' };
  const read = { ...meta, size: bytes.byteLength };
  if (read.size > DOCUMENT_MAX_BYTES) return { ...read, skipped: 'size' };
  let text: string;
  try {
    // `ignoreBOM: false` (the default) takes a leading byte-order mark off.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ...read, skipped: 'encoding' };
  }
  // A NUL is valid UTF-8, but no text file's: a binary file under a text name.
  if (text.includes('\0')) return { ...read, skipped: 'encoding' };
  return { ...read, text };
}

/** One message a connector read. */
export interface Inbound {
  /** The account that saw it. */
  account: string;
  /** The network: `irc`, `telegram`, … */
  network: string;
  /** Where: a channel (`#lobby`), a chat's id. */
  chat: string;
  /**
   * The chat's other names, where it has several (a Telegram chat's id and `@username`, bot-os.md
   * D90): a chat-in edge that reads any of them hears it (`hears`).
   */
  aliases?: readonly string[];
  /**
   * Whether the chat is private (with one user or one bot), not a group or a channel, where the
   * network says (both Telegram connectors): read this, not the shape of `chat`'s name, which may
   * be an id either way (D90). Undefined where the connector does not tell.
   */
  private?: boolean;
  /**
   * Who, by the network's stable id (bot-os.md D167): a Telegram user's, bot's or chat's id, in the
   * Bot API's decimal form (`123456789`, a chat's `-100…`). The key to remember a person by: it
   * stays when they change their username. Absent where the network has none (IRC).
   */
  senderId?: string;
  /**
   * Who, by name (D167): a Telegram username without `@`, an IRC nick; absent for a sender without
   * one. A person may change it at any time, and another take it: for display, and for a bot's
   * texts that name people by it, never as a key.
   */
  senderUsername?: string;
  /**
   * The sender's display name, where the network has one (bot-os.md D159): a Telegram user's first
   * and last names, a chat's title when a chat sent it (a channel, a group's anonymous admin).
   */
  senderName?: string;
  /** Whether the sender is a bot, where the network says (bot-os.md D159). */
  senderBot?: boolean;
  text: string;
  /** When it was sent, in milliseconds. */
  time: number;
  /** The network's id of the message, where it has one. */
  id?: string;
  /** The id of the message it replies to. */
  replyTo?: string;
  /**
   * Not news: history replayed at connection (ZNC's buffer), or a message said while the instance
   * was down and delivered once by the connector's catch-up (`missed`) more than its grace
   * (`liveGraceS`, 2 minutes by default, D83) after it was said. Parsers read it; nothing acts on
   * it, nor on the events read from it (`playback: true` in theirs).
   */
  playback: boolean;
  /**
   * Said while the instance was down, delivered once by the connector's catch-up (§4.5); news
   * still (`playback` false) within its grace.
   */
  missed?: boolean;
  /** Sent by the account itself, from any of its devices (a Telegram user's own messages). */
  own?: boolean;
  /** The file it carries, if any (D82); `text` is then its caption, `''` without one. */
  document?: InboundDocument;
  /**
   * What it carries besides its text, where the network says (D161): `text` is then its caption,
   * `''` without one.
   */
  media?: InboundMedia;
  /**
   * An edit of the message `id` (bot-os.md D144): when it was edited, in milliseconds; `text` is
   * its text now, `time` still when it was sent. Only `onEdit` hears it, never `onMessage`.
   */
  edited?: number;
  /**
   * The labels of the buttons a bot set under it, row by row (bot-os.md D145): what it offers to
   * press, a menu's choices, a page's ◀️ and ▶️. None (`[]`) when it has none; absent where the
   * connector cannot tell (a network without buttons): a page whose buttons are `[]` is the whole
   * list, one whose buttons are unknown may not be. An edit gives them as they now are.
   */
  buttons?: readonly (readonly string[])[];
}

/**
 * Messages deleted from a chat (bot-os.md D158), where the network says which: their ids, as
 * `Inbound.id` gave them. Who wrote them, what they said and who deleted them are not told.
 */
export interface Deletion {
  /** The account that saw it. */
  account: string;
  /** The network: `telegram`, … */
  network: string;
  /** Where: a chat's id, as its messages name it. */
  chat: string;
  /** The chat's other names, as its messages give them (D90). */
  aliases?: readonly string[];
  /** The ids of the messages deleted. */
  ids: readonly string[];
  /** When the connector heard of it, in milliseconds: the network does not date a deletion. */
  time: number;
}

export type ConnectorState = 'connecting' | 'connected' | 'closed';

export interface ConnectorStatus {
  state: ConnectorState;
  /** The network's own name for the step (IRC's `registered`, `joined`). */
  phase: string;
  detail?: string;
}

/** What a chat surface is: a private chat (with a person), a group, a channel, a bot's chat. */
export type SurfaceKind = 'private' | 'group' | 'channel' | 'bot';

/** A chat a connector can see (bot-os-api.md §4.5, bot-os.md D63): what the owner picks from. */
export interface Surface {
  /**
   * How the connector's config and the edges name it, the name it can send to (bot-os.md D96): a
   * group's id, a `@username`, `#lobby`; a `telegram-bot`'s chats by id.
   */
  id: string;
  /** Its title, as the network shows it. */
  title: string;
  kind: SurfaceKind;
  /** Its other names (D90): its `@username` where `id` is its id, its id where `id` is a name. */
  aliases?: string[];
  /** When something was last said there, in ms, where the network says. */
  lastActive?: number;
  /**
   * Why the connector cannot send there, where it knows it cannot (D96): a bot's owner who never
   * started it, a group it is not in. Listed so that the owner sees why, not picked blind.
   */
  unreachable?: string;
}

/** Which surfaces to list: those whose title or any name has `search` in it, at most `limit`. */
export interface SurfaceQuery {
  search?: string;
  limit?: number;
}

/**
 * What a chat-in edge reads (bot-os.md D62): its chats (`'*'`: any chat the connector monitors)
 * and its senders (`senders`: ids or usernames, D167, `me` for the account's own; none: anyone).
 */
export interface ReadFilter {
  reads: readonly string[] | '*';
  senders?: readonly string[] | undefined;
}

/** A name compared as networks do: without case, and without a leading `@`. */
const plainName = (s: string): string => s.replace(/^@/u, '').toLowerCase();

/**
 * Whether a `senders` entry is an id (D167): digits, a chat's with a leading `-`. A Telegram
 * username never starts with a digit, so the two cannot be mistaken.
 */
export const isSenderId = (entry: string): boolean => /^-?\d+$/u.test(entry);

/**
 * Whether `entry` names the sender of `m` (D167): an id, its `senderId`; else a username, its
 * `senderUsername`, without case and without a leading `@`.
 */
export function sentBy(m: Pick<Inbound, 'senderId' | 'senderUsername'>, entry: string): boolean {
  if (isSenderId(entry)) return m.senderId === entry;
  return m.senderUsername !== undefined && plainName(m.senderUsername) === plainName(entry);
}

/** The account's own name and id on its network, as a connector knows them. */
export interface Self {
  name?: string | undefined;
  id?: string | undefined;
}

/** Whether `m` was said in `chat`, by its name or any of its `aliases` (D90), without case. */
export function inChat(m: Pick<Inbound, 'chat' | 'aliases'>, chat: string): boolean {
  const name = chat.toLowerCase();
  return [m.chat, ...(m.aliases ?? [])].some((c) => c.toLowerCase() === name);
}

/**
 * Whether a read filter reads the chat of `m`: one of its chats (any, for `'*'`), by its name or any
 * of its `aliases` (D90), without case. All a deletion is filtered by (D158): it has no sender.
 */
export function readsChat(filter: ReadFilter, m: Pick<Inbound, 'chat' | 'aliases'>): boolean {
  return filter.reads === '*' || filter.reads.some((c) => inChat(m, c));
}

/**
 * Whether a read filter hears `m`: in one of its chats (any, for `'*'`), by the chat's name or any
 * of its `aliases` (D90), compared without case, and from one of its senders (anyone, without
 * `senders`), each an id or a username (`sentBy`, D167). `me` is the account's own messages
 * (`own`, or sent by the account's own id or name, `self`).
 */
export function hears(filter: ReadFilter, m: Inbound, self: Self = {}): boolean {
  if (!readsChat(filter, m)) return false;
  if (filter.senders === undefined) return true;
  return filter.senders.some((f) =>
    f === 'me'
      ? m.own === true ||
        (self.id !== undefined && m.senderId === self.id) ||
        (self.name !== undefined && sentBy(m, self.name))
      : sentBy(m, f)
  );
}

/** What a plugin gets of a connector: it reads, and knows the status; it cannot send. */
export interface ConnectorHandle {
  readonly account: string;
  readonly network: string;
  status(): ConnectorStatus;
  /** The account's own name on the network (a nick, a username), once connected. */
  self(): string | undefined;
  /**
   * The account's own id on the network (D167), in `Inbound.senderId`'s form, once connected;
   * undefined on a network without ids (IRC).
   */
  selfId(): string | undefined;
  /** Hears every message; returns the way to stop. */
  onMessage(handler: (m: Inbound) => void): () => void;
  /** Hears every change of status; returns the way to stop. */
  onStatus(handler: (s: ConnectorStatus) => void): () => void;
  /**
   * Hears every edit of a message, live, where the network has them (bot-os.md D144): the message as
   * it now reads, `edited` when. Opt-in: a plugin that never calls it hears no edit, as `onMessage`
   * never does (a command edited after it was sent is not played again, nor a bot's answer read
   * twice). Returns the way to stop; absent on a handle of a connector that has none.
   */
  onEdit?(handler: (m: Inbound) => void): () => void;
  /**
   * Hears every deletion of messages, live, where the network reports them (bot-os.md D158): the
   * chat and the ids. Opt-in, as edits are. Its edge's chats filter it, not its senders: a deletion
   * names none. Returns the way to stop; absent on a handle of a connector that has none.
   */
  onDelete?(handler: (d: Deletion) => void): () => void;
  /**
   * The chats its edge reads (bot-os.md D139): `'*'`, every chat, also for a handle that reads
   * unfiltered. A send it is told of elsewhere counts only in one of these.
   */
  reads?(): readonly string[] | '*';
  /**
   * Whether the account administers `chat`, where the network can say (a Telegram bot in a group); false when it cannot tell.
   */
  isAdmin?(chat: string): Promise<boolean>;
}

/**
 * A chat surface: a connector that answers the plugins' chat commands its commands edges serve
 * (bot-os.md D109), each in the chats its edge names (`ChatCommand.where`), and the owner's
 * controls in the owner's chat, with their cards and buttons. The core serves it the commands once
 * every plugin has started. It reports nothing on its own (bot-os.md D94): what the owner is told
 * goes through a node of the graph (`owner-notice`).
 */
export interface ChatSurface {
  /**
   * The commands to answer (`core.served(node)`: those its edges serve, then the core's own), once
   * every plugin has started; each asked in a chat its `where` does not name is neither listed nor
   * answered there, and is run with the chat's id (`Request.chat`).
   */
  serve(commands: readonly ChatCommand[]): void;
  /**
   * The way back to the owner's main card on this surface, at the foot of the core's own cards
   * (§4.11): its connector's config names it (a `telegram-bot`'s `home`); the core's `home` when
   * none.
   */
  readonly home?: CommandButton;
}

/** What a send to a connector may carry beside its text. */
export interface ConnectorSendOptions {
  /**
   * Rows of buttons, each a command a tap runs (bot-os.md D94): sent where the connector can run
   * them (a `telegram-bot`'s owner's chat), dropped elsewhere.
   */
  buttons?: Buttons;
}

/** What a photo sent through a connector may carry (bot-os.md D150). */
export interface ConnectorPhotoOptions {
  /** The words under it, at most `CAPTION_MAX` characters (the outbox has checked). */
  caption?: string;
  /**
   * The caption is Markdown or Telegram HTML (D164): a connector that formats sends it formatted,
   * any other HTML as the text it shows (`htmlToPlain`).
   */
  format?: TextFormat;
  /** The network's id of a message in that chat it answers. */
  replyTo?: string;
}

/** A connector, as its plugin implements it. */
export interface Connector extends ConnectorHandle {
  /** Its account's limits, which the outbox keeps to: below the network's own. */
  readonly limits?: Limits;
  /**
   * Sends `text` to `chat`; false if it cannot now (not connected). Only the outbox calls it. With
   * `buttons` (`SendOptions.buttons`), a connector whose chat can run them as commands sends them;
   * any other sends the text alone.
   */
  send(chat: string, text: string, options?: ConnectorSendOptions): boolean;
  /**
   * Sends `text` to `chat` and waits for the network's answer: the message's id, where it has one.
   * Rejects if the network refused it (a `FloodWait` when it asks to wait). For networks whose
   * sends answer later (Telegram); only the outbox calls it, through `Outbox.deliver`. With
   * `format`, the text is Markdown or Telegram HTML (D164), which a network that formats sends
   * formatted, and any other sends Markdown as written and HTML as the text it shows
   * (`htmlToPlain`); `buttons`, as `send` takes them.
   */
  deliver?(
    chat: string,
    text: string,
    options?: ConnectorSendOptions & { format?: TextFormat }
  ): Promise<{ id?: string }>;
  /**
   * Sends a photo to `chat` and waits for the network's answer (bot-os.md D150): the message's id,
   * and the network's id of the photo (`photo`), to send it again by. Only the outbox calls it,
   * through its checks; a connector without it cannot send photos (IRC), and the outbox refuses
   * them with why. Rejects as `deliver` does.
   */
  deliverPhoto?(
    chat: string,
    photo: CommandPhoto,
    options?: ConnectorPhotoOptions
  ): Promise<{ id?: string; photo?: string }>;
  /**
   * Fetches the photo of message `message` in `chat`, a chat it monitors (bot-os.md D151): its
   * bytes, of the largest size the network has, as a `Media` (D153), its type read from the bytes
   * (`sniffMime`), and its size in pixels where the network says; null when the message has none. Rejects with why
   * not (not found, not readable, too large: `PHOTO_MAX_BYTES`). Only its plugin's action `photo`
   * (`photoAction`) calls it, for the plugins an edge binds to the connector's interface.
   */
  photo?(chat: string, message: string): Promise<Media | null>;
  /**
   * The chats it can see, most recently active first, those matching `query.search` (bot-os.md
   * D63): what the owner picks the monitored chats and each edge's from. Rejects while it cannot
   * tell (not connected).
   */
  surfaces?(query?: SurfaceQuery): Promise<Surface[]>;
  /**
   * Every name it knows `chat` by, `chat` among them (an id and a `@username`, bot-os.md D90), from
   * the chats it has seen; undefined when it cannot tell (a chat it never saw). For the graph's
   * check, whose warning (D89) then matches a chat however it is named; a connector whose manifest
   * says its chats have `aliases` offers it.
   */
  chatNames?(chat: string): readonly string[] | undefined;
  /**
   * The owner's own chat on the network, where the connector has one (a `telegram-bot`'s `owner`,
   * their private chat with the bot): where `owner-notice` tells the owner by default.
   */
  owner?(): string | undefined;
  /** A chat's title, as the network shows it, where it knows the chat: for the owner's words. */
  chatTitle?(chat: string): string | undefined;
}

/** A connector's own name and id, for `hears`. */
const selfOf = (c: ConnectorHandle): Self => ({ name: c.self(), id: c.selfId() });

/**
 * The handle of a connector: everything but `send`. With `filter`, what a plugin's chat-in edge
 * reads (P6, D62), it hears only those chats and senders (`hears`); without, everything.
 */
export function handleOf(c: Connector, filter?: ReadFilter): ConnectorHandle {
  return {
    account: c.account,
    network: c.network,
    status: () => c.status(),
    self: () => c.self(),
    selfId: () => c.selfId(),
    onMessage: (h) =>
      c.onMessage((m) => {
        if (filter === undefined || hears(filter, m, selfOf(c))) h(m);
      }),
    onStatus: (h) => c.onStatus(h),
    ...(c.onEdit === undefined
      ? {}
      : {
          onEdit: (h: (m: Inbound) => void) =>
            (c.onEdit as NonNullable<Connector['onEdit']>)((m) => {
              if (filter === undefined || hears(filter, m, selfOf(c))) h(m);
            }),
        }),
    ...(c.onDelete === undefined
      ? {}
      : {
          onDelete: (h: (d: Deletion) => void) =>
            (c.onDelete as NonNullable<Connector['onDelete']>)((d) => {
              if (filter === undefined || readsChat(filter, d)) h(d);
            }),
        }),
    reads: () => filter?.reads ?? '*',
    ...(c.isAdmin === undefined
      ? {}
      : { isAdmin: (chat: string) => c.isAdmin?.(chat) ?? Promise.resolve(false) }),
  };
}

/**
 * The listeners and the status a connector keeps: a base its implementations share, so that each
 * only says what it read and how its connection goes.
 */
export class ConnectorBase {
  readonly account: string;
  readonly network: string;
  /** Its account's limits, which the outbox keeps to, as its plugin sets them from its config. */
  limits?: Limits;
  private current: ConnectorStatus = { state: 'closed', phase: 'closed' };
  private name: string | undefined;
  private id: string | undefined;
  private messages: ((m: Inbound) => void)[] = [];
  private edits: ((m: Inbound) => void)[] = [];
  private deletions: ((d: Deletion) => void)[] = [];
  private statuses: ((s: ConnectorStatus) => void)[] = [];

  constructor(account: string, network: string) {
    this.account = account;
    this.network = network;
  }

  status(): ConnectorStatus {
    return { ...this.current };
  }

  self(): string | undefined {
    return this.name;
  }

  selfId(): string | undefined {
    return this.id;
  }

  onMessage(handler: (m: Inbound) => void): () => void {
    this.messages.push(handler);
    return () => {
      this.messages = this.messages.filter((h) => h !== handler);
    };
  }

  onEdit(handler: (m: Inbound) => void): () => void {
    this.edits.push(handler);
    return () => {
      this.edits = this.edits.filter((h) => h !== handler);
    };
  }

  onDelete(handler: (d: Deletion) => void): () => void {
    this.deletions.push(handler);
    return () => {
      this.deletions = this.deletions.filter((h) => h !== handler);
    };
  }

  onStatus(handler: (s: ConnectorStatus) => void): () => void {
    this.statuses.push(handler);
    return () => {
      this.statuses = this.statuses.filter((h) => h !== handler);
    };
  }

  /** A message read: to every listener, in order. */
  protected received(m: Omit<Inbound, 'account' | 'network'>): void {
    const inbound: Inbound = { account: this.account, network: this.network, ...m };
    for (const h of [...this.messages]) h(inbound);
  }

  /** An edit of a message read (D144): to every listener of edits, in order; `edited`, when. */
  protected reread(m: Omit<Inbound, 'account' | 'network'> & { edited: number }): void {
    const inbound: Inbound = { account: this.account, network: this.network, ...m };
    for (const h of [...this.edits]) h(inbound);
  }

  /** Messages deleted (D158): to every listener of deletions, in order. */
  protected deleted(d: Omit<Deletion, 'account' | 'network'>): void {
    const deletion: Deletion = { account: this.account, network: this.network, ...d };
    for (const h of [...this.deletions]) h(deletion);
  }

  /** The account's own name on the network, and its id where it has one (D167), as it learnt them. */
  protected named(name: string | undefined, id?: string): void {
    this.name = name;
    this.id = id;
  }

  /** A change of status: kept, and to every listener. */
  protected changed(status: ConnectorStatus): void {
    this.current = status;
    for (const h of [...this.statuses]) h({ ...status });
  }
}
