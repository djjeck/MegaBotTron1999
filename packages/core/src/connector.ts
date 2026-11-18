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
import { type Buttons, type ChatCommand, type CommandButton } from './commands.ts';
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
  /** Who: a nick, a username. */
  sender: string;
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
 * and its senders (`senders`: usernames, `me` for the account's own; none: anyone).
 */
export interface ReadFilter {
  reads: readonly string[] | '*';
  senders?: readonly string[] | undefined;
}

/** A name compared as networks do: without case, and without a leading `@`. */
const plainName = (s: string): string => s.replace(/^@/u, '').toLowerCase();

/** Whether `m` was said in `chat`, by its name or any of its `aliases` (D90), without case. */
export function inChat(m: Pick<Inbound, 'chat' | 'aliases'>, chat: string): boolean {
  const name = chat.toLowerCase();
  return [m.chat, ...(m.aliases ?? [])].some((c) => c.toLowerCase() === name);
}

/**
 * Whether a read filter hears `m`: in one of its chats (any, for `'*'`), by the chat's name or any
 * of its `aliases` (D90), compared without case, and from one of its senders (anyone, without `senders`). `me` is the account's own messages
 * (`own`, or sent as the account's own name, `self`).
 */
export function hears(filter: ReadFilter, m: Inbound, self?: string): boolean {
  if (filter.reads !== '*' && !filter.reads.some((c) => inChat(m, c))) return false;
  if (filter.senders === undefined) return true;
  const sender = plainName(m.sender);
  return filter.senders.some((f) =>
    f === 'me'
      ? m.own === true || (self !== undefined && sender === plainName(self))
      : sender !== '' && plainName(f) === sender
  );
}

/** What a plugin gets of a connector: it reads, and knows the status; it cannot send. */
export interface ConnectorHandle {
  readonly account: string;
  readonly network: string;
  status(): ConnectorStatus;
  /** The account's own name on the network (a nick, a username), once connected. */
  self(): string | undefined;
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
   * `format`, the text is Markdown, which a network that formats sends formatted; `buttons`, as
   * `send` takes them.
   */
  deliver?(
    chat: string,
    text: string,
    options?: ConnectorSendOptions & { format?: TextFormat }
  ): Promise<{ id?: string }>;
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
    onMessage: (h) =>
      c.onMessage((m) => {
        if (filter === undefined || hears(filter, m, c.self())) h(m);
      }),
    onStatus: (h) => c.onStatus(h),
    ...(c.onEdit === undefined
      ? {}
      : {
          onEdit: (h: (m: Inbound) => void) =>
            (c.onEdit as NonNullable<Connector['onEdit']>)((m) => {
              if (filter === undefined || hears(filter, m, c.self())) h(m);
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
  private messages: ((m: Inbound) => void)[] = [];
  private edits: ((m: Inbound) => void)[] = [];
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

  /** The account's own name on the network, as it learnt it. */
  protected named(name: string | undefined): void {
    this.name = name;
  }

  /** A change of status: kept, and to every listener. */
  protected changed(status: ConnectorStatus): void {
    this.current = status;
    for (const h of [...this.statuses]) h({ ...status });
  }
}
