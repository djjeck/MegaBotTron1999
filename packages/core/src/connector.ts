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
import { type Buttons, type ChatCommand } from './commands.ts';
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
  /** How the connector's config and the edges name it: a group's id, a `@username`, `#lobby`. */
  id: string;
  /** Its title, as the network shows it. */
  title: string;
  kind: SurfaceKind;
  /** When something was last said there, in ms, where the network says. */
  lastActive?: number;
}

/** Which surfaces to list: those whose title or id has `search` in it, at most `limit`. */
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

/**
 * Whether a read filter hears `m`: in one of its chats (any, for `'*'`), compared without case,
 * and from one of its senders (anyone, without `senders`). `me` is the account's own messages
 * (`own`, or sent as the account's own name, `self`).
 */
export function hears(filter: ReadFilter, m: Inbound, self?: string): boolean {
  if (filter.reads !== '*' && !filter.reads.some((c) => c.toLowerCase() === m.chat.toLowerCase()))
    return false;
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
   * Whether the account administers `chat`, where the network can say (a Telegram bot in a group); false when it cannot tell.
   */
  isAdmin?(chat: string): Promise<boolean>;
}

/**
 * A chat surface: a connector that answers the plugins' chat commands where they are asked,
 * and carries the owner's notices when it is the owner's (`CoreOptions.owner`). The core serves it
 * the commands once every plugin has started.
 */
export interface ChatSurface {
  /** The commands to answer (`core.commands()`), once every plugin has started. */
  serve(commands: readonly ChatCommand[]): void;
  /** Tells the owner, in order; what comes before `serve` waits for it. */
  tell(text: string, buttons?: Buttons): void;
}

/** A connector, as its plugin implements it. */
export interface Connector extends ConnectorHandle {
  /** Its account's limits, which the outbox keeps to: below the network's own. */
  readonly limits?: Limits;
  /** Sends `text` to `chat`; false if it cannot now (not connected). Only the outbox calls it. */
  send(chat: string, text: string): boolean;
  /**
   * Sends `text` to `chat` and waits for the network's answer: the message's id, where it has one.
   * Rejects if the network refused it (a `FloodWait` when it asks to wait). For networks whose
   * sends answer later (Telegram); only the outbox calls it, through `Outbox.deliver`. With
   * `format`, the text is Markdown, which a network that formats sends formatted.
   */
  deliver?(chat: string, text: string, options?: { format?: TextFormat }): Promise<{ id?: string }>;
  /**
   * The chats it can see, most recently active first, those matching `query.search` (bot-os.md
   * D63): what the owner picks the monitored chats and each edge's from. Rejects while it cannot
   * tell (not connected).
   */
  surfaces?(query?: SurfaceQuery): Promise<Surface[]>;
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
