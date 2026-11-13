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

import { type Buttons, type ChatCommand } from './commands.ts';
import { type Limits, type TextFormat } from './outbox.ts';

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
   * was down and delivered once by the connector's catch-up (`missed`). Parsers read it; nothing
   * acts on it.
   */
  playback: boolean;
  /** Said while the instance was down, delivered once by the connector's catch-up (§4.5). */
  missed?: boolean;
  /** Sent by the account itself, from any of its devices (a Telegram user's own messages). */
  own?: boolean;
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
