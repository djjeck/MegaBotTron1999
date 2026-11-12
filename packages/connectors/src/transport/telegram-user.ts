/**
 * A Telegram user account, logged in as a user session with GramJS as a connector of the core
 * (docs/bot-os-api.md §4.5): the owner's own account, for parsers and turn-actors that read and
 * play in its chats.
 *
 * It monitors the chats it is given and no other (a group by its id, `-100…`; a private chat by the
 * other's `@username`, or by their id when they have none), or, given none, every chat the account
 * has (its surfaces, bot-os.md D63). The account sees every chat of its owner, and the rest never
 * leaves this module. It sends any text to those chats, but only through the account's outbox,
 * which keeps each plugin to the chats and commands of its reach (§4.6).
 *
 * **Catch-up** (docs/bot-os.md D62): GramJS 2.26.22 has no update catch-up (`client.catchUp()` is
 * an empty stub, and its sessions keep no update state), so at each connection it fetches back the
 * history of the chats its readers read whose latest message is newer than the last it saw (kept
 * in its store), at most `CATCH_UP_CAP` per chat, a page at a time, and delivers it oldest first,
 * marked `missed` and `playback`.
 *
 * The session string gives full access to the account: it comes from the deployment's secrets,
 * never from this repository, and is never printed by this module.
 */
import {
  type Clock,
  type Connector,
  ConnectorBase,
  FloodWait,
  type Inbound,
  type ReadFilter,
  type Surface,
  type SurfaceQuery,
  type TimerHandle,
} from '@megabottron1999/core';
import { TelegramClient } from 'telegram';
import { type UserAuthParams } from 'telegram/client/auth.js';
import { NewMessage } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';

/** The fields of a GramJS message the connector reads. */
export interface RawMessage {
  id: number;
  /** In seconds. */
  date: number;
  out?: boolean | undefined;
  message: string;
  replyTo?: { replyToMsgId?: number | undefined } | undefined;
  chatId?: { toString(): string } | undefined;
  /** A private chat (with a user or a bot), not a group. */
  isPrivate?: boolean | undefined;
  getSender(): Promise<unknown>;
  getChat(): Promise<unknown>;
}

/** The fields of a GramJS dialog the connector reads: one chat of the account. */
export interface RawDialog {
  /** The chat's id, marked (`-100…` for a group or a channel). */
  id?: { toString(): string } | undefined;
  title?: string | undefined;
  /** When its latest message was sent, in seconds. */
  date?: number | undefined;
  isUser?: boolean | undefined;
  isGroup?: boolean | undefined;
  isChannel?: boolean | undefined;
  /** The other user (a bot has `bot`), the group or the channel. */
  entity?: unknown;
  inputEntity?: unknown;
  /** Its latest message. */
  message?: { id: number } | undefined;
}

/** The part of GramJS's `TelegramClient` the connector uses; tests pass a fake. */
export interface GramClient {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  /** The account's chats, latest first (and fills the entity cache, so a group's id resolves). */
  getDialogs(params: { limit?: number }): Promise<Iterable<RawDialog>>;
  getInputEntity(id: number | string): Promise<unknown>;
  /** The logged-in user. */
  getMe(): Promise<unknown>;
  sendMessage(entity: never, params: { message: string }): Promise<{ id: number }>;
  /** A chat's messages, latest first: below `offsetId` (0: from the latest), above `minId`. */
  getMessages(
    entity: never,
    params: { limit: number; offsetId: number; minId: number }
  ): Promise<Iterable<RawMessage>>;
  addEventHandler(
    handler: (event: { message: RawMessage }) => Promise<void>,
    builder: NewMessage
  ): void;
}

/** A string field of an entity GramJS returned, if it has one. */
function field(entity: unknown, key: 'username' | 'bot'): unknown {
  if (typeof entity !== 'object' || entity === null || !(key in entity)) return undefined;
  return (entity as Record<string, unknown>)[key];
}

/** The username of an entity GramJS returned (a user, a bot, a channel posting as itself). */
function username(entity: unknown): string | undefined {
  const u = field(entity, 'username');
  return typeof u === 'string' ? u : undefined;
}

/** A chat the connector monitors: a group's id, a private chat by `@username` or by id. */
export const USER_CHAT = /^(?:-?\d+|@\w{4,})$/u;

/** How long a failed start waits before the next. */
export const RETRY_MS = 60_000;
/** How many of the latest chats the surfaces list without a search. */
export const SURFACES_LIMIT = 50;

/** The store's document of the last message id seen in each chat, by the chat's marked id. */
export const LAST_SEEN_DOC = 'last-seen';
/** How many messages the catch-up fetches back in a chat, at most. */
export const CATCH_UP_CAP = 1000;
/** How many it asks for at a time. */
export const CATCH_UP_PAGE = 100;
/** The pause between two of its requests. */
export const CATCH_UP_PAUSE_MS = 1000;

/** The wait GramJS asks for (its `FloodWaitError` and kin carry `seconds`), in ms. */
function floodMs(e: unknown): number | undefined {
  if (!(e instanceof Error) || !('seconds' in e) || typeof e.seconds !== 'number') return undefined;
  return e.seconds * 1000;
}

/** A message with text (perhaps empty, under a photo), not a service message (a join, a pin). */
function isText(m: object): boolean {
  return typeof (m as { message?: unknown }).message === 'string';
}

/** The kind of a dialog's chat. */
function kindOf(d: RawDialog): Surface['kind'] {
  if (d.isUser === true) return field(d.entity, 'bot') === true ? 'bot' : 'private';
  return d.isChannel === true && d.isGroup !== true ? 'channel' : 'group';
}

export interface UserConnectorOptions {
  /** `telegram:<name>`. */
  account: string;
  client: GramClient;
  /** The chats it monitors and may send to (`USER_CHAT`); none given: every chat it has. */
  chats?: readonly string[] | undefined;
  clock: Clock;
  log: (line: string) => void;
  /** Told of the first failed start (a revoked session needs a login). */
  notify?: (text: string) => void;
  /** Warned of (the plugin's `warn`); `log` without. */
  warn?: (line: string) => void;
  /** Writes to the event log (`ctx.record`): a catch-up that hit its cap. */
  record?: (type: string, fields: Record<string, unknown>) => void;
  /** Where the last message id seen in each chat is kept (`LAST_SEEN_DOC`). */
  store?: { read<T>(name: string): T | undefined; write(name: string, value: unknown): void };
  /** What its readers read (`ctx.readers`): the chats the catch-up fetches. None: no catch-up. */
  readers?: () => readonly ReadFilter[];
}

/** A chat to catch up on: its dialog, its name, its marked id, from and up to which message. */
interface Gap {
  dialog: RawDialog;
  chat: string;
  key: string;
  after: number;
  upTo: number;
}

export class TelegramUserConnector extends ConnectorBase implements Connector {
  private readonly o: UserConnectorOptions;
  /** Each chat's peer, by the chat in lower case, once started. */
  private readonly peers = new Map<string, unknown>();
  /** The chats as given, by their lower case; undefined: every chat. */
  private readonly chats: Map<string, string> | undefined;
  private started = false;
  private listening = false;
  private connected = false;
  private told = false;
  private retry: TimerHandle | undefined;
  /** The last message id seen in each chat, by its marked id, as kept. */
  private readonly lastSeen: Record<string, number>;
  /**
   * The chats whose last id is held while the catch-up runs (all of them until it knows which),
   * with the ids heard live meanwhile: not delivered twice, and kept once the chat is caught up.
   */
  private held: Set<string> | 'all' | undefined;
  private readonly live = new Map<string, Set<number>>();
  /** Each connection's own, so that a catch-up stopped or superseded ends. */
  private generation = 0;

  constructor(options: UserConnectorOptions) {
    super(options.account, 'telegram');
    this.o = options;
    this.lastSeen = { ...(options.store?.read<Record<string, number>>(LAST_SEEN_DOC) ?? {}) };
    this.chats =
      options.chats === undefined
        ? undefined
        : new Map(options.chats.map((c) => [c.toLowerCase(), c]));
  }

  /** Connects, without waiting: a failure is retried every minute, and told the first time. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.changed({ state: 'connecting', phase: 'connecting' });
    void this.connect();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.connected = false;
    this.generation++;
    this.release();
    this.o.clock.clearTimeout(this.retry);
    this.peers.clear();
    this.changed({ state: 'closed', phase: 'closed' });
    await this.o.client.disconnect();
  }

  /** Sends without waiting for the answer, which is logged if it fails; `deliver` waits. */
  send(chat: string, text: string): boolean {
    if (this.status().state !== 'connected' || !this.monitors(chat)) return false;
    this.deliver(chat, text).catch((e: unknown) =>
      this.o.log(`send to ${chat} failed: ${String(e)}`)
    );
    return true;
  }

  async deliver(chat: string, text: string): Promise<{ id?: string }> {
    if (!this.monitors(chat)) throw new Error(`${chat} is not a chat of ${this.account}`);
    try {
      const sent = await this.o.client.sendMessage((await this.peer(chat)) as never, {
        message: text,
      });
      return { id: String(sent.id) };
    } catch (e) {
      const ms = floodMs(e);
      throw ms === undefined ? e : new FloodWait(ms);
    }
  }

  /**
   * Its surfaces (bot-os.md D63): the account's chats, latest first, with their kind and title;
   * with a search, those whose title, username or id has it, among all of them.
   */
  async surfaces(query: SurfaceQuery = {}): Promise<Surface[]> {
    if (!this.connected) throw new Error('not connected');
    const search = query.search?.trim().toLowerCase() ?? '';
    const limit = query.limit ?? SURFACES_LIMIT;
    const dialogs = [...(await this.o.client.getDialogs(search === '' ? { limit } : {}))];
    return dialogs
      .map((d): Surface | undefined => {
        const id = this.nameOf(d);
        if (id === undefined) return undefined;
        const title = d.title ?? id;
        return {
          id,
          title,
          kind: kindOf(d),
          ...(d.date === undefined ? {} : { lastActive: d.date * 1000 }),
        };
      })
      .filter((x): x is Surface => x !== undefined)
      .filter(
        (x) =>
          search === '' ||
          x.title.toLowerCase().includes(search) ||
          x.id.toLowerCase().includes(search)
      )
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, limit);
  }

  /** Whether it monitors `chat`: one of its chats, or any when it was given none. */
  private monitors(chat: string): boolean {
    return this.chats === undefined || this.chats.has(chat.toLowerCase());
  }

  /** A chat's peer: resolved at connection for the chats given, else now. */
  private async peer(chat: string): Promise<unknown> {
    const key = chat.toLowerCase();
    const known = this.peers.get(key);
    if (known !== undefined) return known;
    const peer = await this.o.client.getInputEntity(chat.startsWith('@') ? chat : Number(chat));
    this.peers.set(key, peer);
    return peer;
  }

  private async connect(): Promise<void> {
    const { client } = this.o;
    try {
      await client.connect();
      if (!this.started) return;
      // Held from before the first live message, until the catch-up knows which chats it fetches.
      this.held = 'all';
      // Once, however often the start is retried; before the dialogs, so nothing falls between.
      if (!this.listening) client.addEventHandler((e) => this.heard(e.message), new NewMessage({}));
      this.listening = true;
      const dialogs = [...(await client.getDialogs({}))];
      for (const chat of this.chats?.values() ?? []) await this.peer(chat);
      this.named(username(await client.getMe()));
      if (!this.started) return;
      this.connected = true;
      this.changed({ state: 'connected', phase: 'ready' });
      this.o.log(
        `connected as ${this.self() ?? '(no username)'}, reading ${
          this.chats === undefined ? 'every chat' : [...this.chats.values()].join(', ')
        }`
      );
      void this.catchUp(dialogs, this.generation);
    } catch (err) {
      this.release();
      if (!this.started) return;
      this.o.log(`start failed, retrying in ${RETRY_MS / 1000} s: ${String(err)}`);
      if (!this.told)
        this.o.notify?.(`the owner's Telegram session failed to start: ${String(err)}`);
      this.told = true;
      this.changed({ state: 'connecting', phase: 'retrying', detail: String(err) });
      this.retry = this.o.clock.setTimeout(() => void this.connect(), RETRY_MS);
    }
  }

  /** A message the account saw: passed on if it is in one of its chats, as an `Inbound`. */
  private async heard(m: RawMessage): Promise<void> {
    try {
      const chat = await this.chatOf(m);
      if (chat === undefined) return;
      const key = m.chatId?.toString();
      if (key !== undefined) {
        if (this.holds(key)) {
          const ids = this.live.get(key) ?? new Set<number>();
          ids.add(m.id);
          this.live.set(key, ids);
        } else this.saw(key, m.id);
      }
      this.received(await this.inbound(m, chat));
    } catch (err) {
      this.o.log(`message ${m.id} dropped: ${String(err)}`);
    }
  }

  private holds(key: string): boolean {
    return this.held === 'all' || this.held?.has(key) === true;
  }

  /** The last id seen in a chat moved to the newest of `ids`, if newer than it was: kept. */
  private saw(key: string, ...ids: number[]): void {
    const latest = Math.max(this.lastSeen[key] ?? 0, ...ids);
    if (latest === (this.lastSeen[key] ?? 0)) return;
    this.lastSeen[key] = latest;
    this.o.store?.write(LAST_SEEN_DOC, this.lastSeen);
  }

  /** A chat no longer held: what was heard live in it meanwhile is kept as seen. */
  private unhold(key: string, ...ids: number[]): void {
    if (this.held instanceof Set) this.held.delete(key);
    this.saw(key, ...ids, ...(this.live.get(key) ?? []));
    this.live.delete(key);
  }

  /** Every chat released: the catch-up is over (or never was). */
  private release(): void {
    const keys = [...this.live.keys()];
    this.held = undefined;
    for (const key of keys) this.unhold(key);
  }

  /**
   * At connection (D62): the chats some reader reads whose latest message is newer than the last
   * seen there, each fetched back to it, at most `CATCH_UP_CAP` messages, and delivered oldest
   * first, marked `missed` and `playback`. A chat with no last id is not fetched: its latest id is
   * kept, so that the next connection can.
   */
  private async catchUp(dialogs: readonly RawDialog[], generation: number): Promise<void> {
    const readers = this.o.readers?.() ?? [];
    const all = readers.some((r) => r.reads === '*');
    const read = new Set(
      readers.flatMap((r) => (r.reads === '*' ? [] : r.reads.map((c) => c.toLowerCase())))
    );
    const gaps: Gap[] = [];
    let first = false;
    for (const dialog of dialogs) {
      const chat = this.nameOf(dialog);
      const key = dialog.id?.toString();
      const upTo = dialog.message?.id;
      if (chat === undefined || key === undefined || upTo === undefined) continue;
      const after = this.lastSeen[key];
      if (after === undefined) {
        this.lastSeen[key] = upTo;
        first = true;
      } else if (upTo > after && (all || read.has(chat.toLowerCase())))
        gaps.push({ dialog, chat, key, after, upTo });
    }
    if (first) this.o.store?.write(LAST_SEEN_DOC, this.lastSeen);
    // Only the chats it fetches stay held; the others keep what was heard live.
    const fetched = new Set(gaps.map((g) => g.key));
    for (const key of [...this.live.keys()]) if (!fetched.has(key)) this.unhold(key);
    this.held = fetched;
    for (const gap of gaps) {
      if (generation !== this.generation) return;
      try {
        await this.fill(gap, generation);
      } catch (err) {
        this.o.log(`catch-up of ${gap.chat} failed: ${String(err)}`);
      }
      if (generation === this.generation) this.unhold(gap.key);
    }
    if (generation === this.generation) this.held = undefined;
  }

  /** One chat's gap, fetched a page at a time, then delivered oldest first. */
  private async fill(gap: Gap, generation: number): Promise<void> {
    const peer = gap.dialog.inputEntity ?? gap.dialog.entity;
    const messages: RawMessage[] = [];
    let offsetId = gap.upTo + 1;
    let complete = false;
    while (messages.length < CATCH_UP_CAP) {
      const page = await this.page(peer, offsetId, gap.after, CATCH_UP_PAGE, generation);
      if (page === undefined) return;
      messages.push(...page);
      if (page.length < CATCH_UP_PAGE) {
        complete = true;
        break;
      }
      offsetId = Math.min(...page.map((m) => m.id));
    }
    if (!complete) {
      const more = await this.page(peer, offsetId, gap.after, 1, generation);
      if (more === undefined) return;
      if (more.length > 0) {
        this.warn(
          `catch-up of ${gap.chat} stopped at ${messages.length} messages, older ones missed`
        );
        this.o.record?.('telegram-user.catch-up', { chat: gap.chat, fetched: messages.length });
      }
    }
    const live = this.live.get(gap.key);
    const missed = messages
      .filter((m) => isText(m) && live?.has(m.id) !== true)
      .sort((a, b) => a.id - b.id);
    for (const m of missed) {
      if (generation !== this.generation) return;
      try {
        this.received({ ...(await this.inbound(m, gap.chat)), playback: true, missed: true });
      } catch (err) {
        this.o.log(`message ${m.id} dropped: ${String(err)}`);
      }
    }
    this.unhold(gap.key, gap.upTo);
  }

  /**
   * One page of a chat's history, after the pause between requests: Telegram's `FLOOD_WAIT` is
   * waited out, then asked again. Undefined once the connection it belongs to is over.
   */
  private async page(
    peer: unknown,
    offsetId: number,
    minId: number,
    limit: number,
    generation: number
  ): Promise<RawMessage[] | undefined> {
    let wait = CATCH_UP_PAUSE_MS;
    for (;;) {
      await this.sleep(wait);
      if (generation !== this.generation) return undefined;
      try {
        return [
          ...(await this.o.client.getMessages(peer as never, { limit, offsetId, minId })),
        ].filter((m) => m.id > minId && m.id < offsetId);
      } catch (err) {
        const ms = floodMs(err);
        if (ms === undefined) throw err;
        this.o.log(`catch-up: Telegram asks to wait ${ms / 1000} s`);
        wait = ms;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.o.clock.setTimeout(resolve, ms));
  }

  private warn(line: string): void {
    (this.o.warn ?? this.o.log)(line);
  }

  private async inbound(
    m: RawMessage,
    chat: string
  ): Promise<Omit<Inbound, 'account' | 'network'>> {
    const sender = username(await m.getSender());
    const replyTo = m.replyTo?.replyToMsgId;
    return {
      chat,
      sender: sender ?? '',
      text: m.message,
      time: m.date * 1000,
      id: String(m.id),
      ...(replyTo === undefined ? {} : { replyTo: String(replyTo) }),
      playback: false,
      own: m.out === true,
    };
  }

  /** The name a chat is delivered by: as given, else a group's id, a private chat's @username. */
  private chatName(id: string | undefined, other: string | undefined): string | undefined {
    const at = other === undefined ? undefined : `@${other}`;
    if (this.chats === undefined) return at ?? id;
    return (
      (id === undefined ? undefined : this.chats.get(id.toLowerCase())) ??
      (at === undefined ? undefined : this.chats.get(at.toLowerCase()))
    );
  }

  private nameOf(d: RawDialog): string | undefined {
    return this.chatName(d.id?.toString(), d.isUser === true ? username(d.entity) : undefined);
  }

  /** The chat of a message, as given, or undefined for a chat it does not monitor. */
  private async chatOf(m: RawMessage): Promise<string | undefined> {
    const id = m.chatId?.toString();
    if (m.isPrivate !== true) return this.chatName(id, undefined);
    const byId = this.chats?.get(id?.toLowerCase() ?? '');
    if (byId !== undefined) return byId;
    return this.chatName(id, username(await m.getChat()));
  }
}

export interface UserCredentials {
  apiId: number;
  apiHash: string;
  /** The session string from the login command; empty to log in afresh. */
  session: string;
}

/** A GramJS client for `credentials`, quiet but for errors. */
export function createTelegramClient(
  credentials: UserCredentials,
  session = new StringSession(credentials.session)
): TelegramClient {
  // The logger is given at construction: the constructor already logs (its version banner).
  return new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    baseLogger: new Logger(LogLevel.ERROR),
  });
}

/** The part of GramJS's `TelegramClient` the login uses; tests pass a fake. */
export interface LoginClient {
  start(params: UserAuthParams): Promise<void>;
  disconnect(): Promise<void>;
}

/** Asks the author one question; `secret` answers are not echoed. */
export type Ask = (question: string, secret?: boolean) => Promise<string>;

/**
 * Logs in afresh as the author, asking for the phone number, the code Telegram sends and the 2FA
 * password if the account has one; the session string to store as `TELEGRAM_USER_SESSION`. The
 * first error ends it (a wrong code, too): the author runs it again.
 */
export async function login(
  credentials: Omit<UserCredentials, 'session'>,
  ask: Ask,
  make: (session: StringSession) => LoginClient = (s) =>
    createTelegramClient({ ...credentials, session: '' }, s)
): Promise<string> {
  const session = new StringSession('');
  const client = make(session);
  let failure: Error | undefined;
  try {
    await client.start({
      phoneNumber: () => ask('Phone number (international, +39…): '),
      phoneCode: () => ask('The code Telegram sent: '),
      password: (hint) => ask(`2FA password${hint ? ` (hint: ${hint})` : ''}: `, true),
      // True stops the login; GramJS then throws its own AUTH_USER_CANCEL, so keep the cause.
      onError: (err) => {
        failure = err;
        return Promise.resolve(true);
      },
    });
  } catch (err) {
    throw failure ?? err;
  } finally {
    await client.disconnect();
  }
  return session.save();
}
