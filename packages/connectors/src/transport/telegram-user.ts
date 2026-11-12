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
 * **Catch-up** (docs/bot-os.md D62, D66): GramJS 2.26.22 has no update catch-up (`client.catchUp()`
 * is an empty stub, and its sessions keep no update state), so at each connection it fetches back
 * the history of the chats its running readers read that it has not accounted for (its ledger, kept
 * in its store: `seen-ledger.ts`), at most `CATCH_UP_CAP` per chat, a page at a time, and delivers
 * it oldest first, marked `missed` and `playback`. Each message reaches the readers at most once,
 * across live delivery, catch-up and restarts; a gap whose fetch failed is fetched again, later in
 * the connection and at the next one, until it is filled. A chat no running reader reads is not
 * fetched: its gap is skipped, and what is heard there live is accounted for all the same.
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
import { LAST_SEEN_DOC, type LedgerStore, SEEN_ABOVE_DOC, SeenLedger } from './seen-ledger.ts';

export { LAST_SEEN_DOC, SEEN_ABOVE_DOC };

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
  /** The message sent: its id, and its chat's marked id (GramJS's `Message.chatId`). */
  sendMessage(
    entity: never,
    params: { message: string }
  ): Promise<{ id: number; chatId?: { toString(): string } | undefined }>;
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

/** How many messages the catch-up fetches back in a chat, at most. */
export const CATCH_UP_CAP = 1000;
/** How many it asks for at a time. */
export const CATCH_UP_PAGE = 100;
/** The pause between two of its requests. */
export const CATCH_UP_PAUSE_MS = 1000;
/** A chat whose catch-up failed is fetched again after `RETRY_MS`, doubled each time, up to this. */
export const CATCH_UP_RETRY_MAX_MS = 3_600_000;
/** How many of each chat's latest ids it remembers having delivered, against a second delivery. */
const RECENT = 200;

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
  /** Where what it delivered of each chat is kept (`LAST_SEEN_DOC`, `SEEN_ABOVE_DOC`). */
  store?: LedgerStore;
  /**
   * What its running readers read (`ctx.readers`): the chats the catch-up fetches. None: no
   * catch-up.
   */
  readers?: () => readonly ReadFilter[];
}

/** A chat to catch up on: its dialog, its name, its marked id, up to which message; its failures. */
interface Gap {
  dialog: RawDialog;
  chat: string;
  key: string;
  upTo: number;
  failures: number;
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
  /** What it has delivered or skipped of each chat, by its marked id, as kept. */
  private readonly ledger: SeenLedger;
  /**
   * Each chat's first id heard live since this connection (its latest at the connection, plus
   * one): every message from it on comes live. Undefined until the dialogs say it; meanwhile,
   * the ids heard live wait in `early`.
   */
  private liveFrom: Map<string, number> | undefined;
  private early = new Map<string, number[]>();
  /** Each chat's latest ids delivered, so that none is delivered twice. */
  private readonly recent = new Map<string, Set<number>>();
  /** The chats to catch up on, in turn, and the connection whose catch-up runs. */
  private queue: Gap[] = [];
  private working: number | undefined;
  private readonly retries = new Set<TimerHandle>();
  /** Each connection's own, so that a catch-up stopped or superseded ends. */
  private generation = 0;

  constructor(options: UserConnectorOptions) {
    super(options.account, 'telegram');
    this.o = options;
    this.ledger = new SeenLedger(options.store, (key, after, before) =>
      this.warn(
        `catch-up of ${key}: too many gaps kept, the one after ${after} up to ${before} skipped`
      )
    );
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
    this.queue = [];
    for (const t of this.retries) this.o.clock.clearTimeout(t);
    this.retries.clear();
    this.liveFrom = undefined;
    this.early = new Map();
    this.recent.clear();
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
      // Its own message, never heard back live from this session: accounted for, so that the
      // catch-up does not deliver it as missed (D66).
      const key = sent.chatId?.toString() ?? (/^-?\d+$/u.test(chat) ? chat : undefined);
      if (key !== undefined) this.accountLive(key, sent.id);
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
      // Once, however often the start is retried; before the dialogs, so nothing falls between:
      // what is heard before the dialogs waits in `early`.
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
      this.plan(dialogs, this.generation);
    } catch (err) {
      if (!this.started) return;
      this.o.log(`start failed, retrying in ${RETRY_MS / 1000} s: ${String(err)}`);
      if (!this.told)
        this.o.notify?.(`the owner's Telegram session failed to start: ${String(err)}`);
      this.told = true;
      this.changed({ state: 'connecting', phase: 'retrying', detail: String(err) });
      this.retry = this.o.clock.setTimeout(() => void this.connect(), RETRY_MS);
    }
  }

  /**
   * A message the account saw: passed on if it is in one of its chats, as an `Inbound`, unless it
   * was delivered already; accounted for before it is (at most once, D66).
   */
  private async heard(m: RawMessage): Promise<void> {
    if (!this.started) return;
    try {
      const chat = await this.chatOf(m);
      if (chat === undefined) return;
      const key = m.chatId?.toString();
      if (key !== undefined && !this.remember(key, m.id)) return;
      let inbound: Omit<Inbound, 'account' | 'network'>;
      try {
        inbound = await this.inbound(m, chat);
      } finally {
        if (key !== undefined) this.accountLive(key, m.id);
      }
      this.received(inbound);
    } catch (err) {
      this.o.log(`message ${m.id} dropped: ${String(err)}`);
    }
  }

  /** An id delivered in a chat, remembered; false if it was already. */
  private remember(key: string, id: number): boolean {
    let ids = this.recent.get(key);
    if (ids === undefined) this.recent.set(key, (ids = new Set()));
    if (ids.has(id)) return false;
    ids.add(id);
    if (ids.size > RECENT) ids.delete(ids.values().next().value as number);
    return true;
  }

  /**
   * An id heard live (or sent) in a chat, accounted for: with every id since the connection's
   * first live one, which all come live; alone if older; waiting in `early` until the dialogs say
   * where the connection's live ids start.
   */
  private accountLive(key: string, id: number): void {
    if (this.liveFrom === undefined) {
      this.early.set(key, [...(this.early.get(key) ?? []), id]);
      return;
    }
    let from = this.liveFrom.get(key);
    if (from === undefined) {
      // A chat the dialogs did not list: its live ids start here.
      from = this.ledger.last(key) === undefined ? id + 1 : id;
      this.liveFrom.set(key, from);
    }
    if (this.ledger.last(key) === undefined) this.ledger.advance(key, id);
    else if (id >= from) this.ledger.mark(key, from, id);
    else this.ledger.mark(key, id);
  }

  /** Whether a running reader reads `chat` (`ctx.readers`): its gap is fetched, or skipped. */
  private read(chat: string): boolean {
    return (this.o.readers?.() ?? []).some(
      (r) => r.reads === '*' || r.reads.some((c) => c.toLowerCase() === chat.toLowerCase())
    );
  }

  /**
   * At connection (D62, D66), from the dialogs: where each chat's live ids start (after its latest
   * message); the ids heard before, accounted for; a chat seen for the first time, accounted for
   * up to its latest message (not fetched); and each chat with a gap, fetched if a running reader
   * reads it, else skipped.
   */
  private plan(dialogs: readonly RawDialog[], generation: number): void {
    const liveFrom = new Map<string, number>();
    const chats: Gap[] = [];
    for (const dialog of dialogs) {
      const chat = this.nameOf(dialog);
      const key = dialog.id?.toString();
      const upTo = dialog.message?.id;
      if (chat === undefined || key === undefined || upTo === undefined) continue;
      liveFrom.set(key, upTo + 1);
      if (this.ledger.last(key) === undefined) this.ledger.advance(key, upTo);
      chats.push({ dialog, chat, key, upTo, failures: 0 });
    }
    this.liveFrom = liveFrom;
    for (const [key, ids] of this.early) for (const id of ids) this.accountLive(key, id);
    this.early = new Map();
    for (const gap of chats) {
      if (this.ledger.gaps(gap.key, gap.upTo).length === 0) continue;
      if (this.read(gap.chat)) this.queue.push(gap);
      else this.ledger.advance(gap.key, gap.upTo);
    }
    void this.work(generation);
  }

  /**
   * The chats to catch up on, one at a time: a chat no running reader reads any more is skipped,
   * one whose fetch fails is logged and queued again later (`RETRY_MS`, doubled each time, up to
   * `CATCH_UP_RETRY_MAX_MS`).
   */
  private async work(generation: number): Promise<void> {
    if (this.working === generation) return;
    this.working = generation;
    try {
      for (;;) {
        const gap = this.queue.shift();
        if (gap === undefined || generation !== this.generation) return;
        if (!this.read(gap.chat)) {
          this.ledger.advance(gap.key, gap.upTo);
          continue;
        }
        try {
          await this.fill(gap, generation);
        } catch (err) {
          if (generation !== this.generation) return;
          gap.failures++;
          const ms = Math.min(RETRY_MS * 2 ** (gap.failures - 1), CATCH_UP_RETRY_MAX_MS);
          this.o.log(`catch-up of ${gap.chat} failed, again in ${ms / 1000} s: ${String(err)}`);
          const timer = this.o.clock.setTimeout(() => {
            this.retries.delete(timer);
            this.queue.push(gap);
            void this.work(generation);
          }, ms);
          this.retries.add(timer);
        }
      }
    } finally {
      if (this.working === generation) this.working = undefined;
    }
  }

  /**
   * One chat's gaps, newest first, fetched a page at a time, at most `CATCH_UP_CAP` messages (past
   * it, the older ones are skipped, warned of and recorded); then delivered oldest first, each
   * accounted for before it goes, so that a stop in between delivers none twice.
   */
  private async fill(gap: Gap, generation: number): Promise<void> {
    const peer = gap.dialog.inputEntity ?? gap.dialog.entity;
    const ranges = this.ledger.gaps(gap.key, gap.upTo);
    const messages: RawMessage[] = [];
    /** The oldest message fetched, when older ones are missing past the cap. */
    let floor: number | undefined;
    for (const [i, [after, upTo]] of ranges.entries()) {
      let offsetId = upTo + 1;
      let complete = false;
      while (messages.length < CATCH_UP_CAP) {
        const page = await this.page(peer, offsetId, after, CATCH_UP_PAGE, generation);
        if (page === undefined) return;
        messages.push(...page);
        if (page.length < CATCH_UP_PAGE) {
          complete = true;
          break;
        }
        offsetId = Math.min(...page.map((m) => m.id));
      }
      if (messages.length < CATCH_UP_CAP) continue;
      // At the cap: is anything still missing below?
      const below: [number, number][] = [
        ...(complete ? [] : [[after, offsetId - 1] as [number, number]]),
        ...ranges.slice(i + 1),
      ];
      for (const [lo, hi] of below) {
        if (hi <= lo) continue;
        const more = await this.page(peer, hi + 1, lo, 1, generation);
        if (more === undefined) return;
        if (more.length === 0) continue;
        floor = Math.min(...messages.map((m) => m.id));
        this.warn(
          `catch-up of ${gap.chat} stopped at ${messages.length} messages, older ones missed`
        );
        this.o.record?.('telegram-user.catch-up', { chat: gap.chat, fetched: messages.length });
        break;
      }
      break;
    }
    if (floor !== undefined) this.ledger.advance(gap.key, floor - 1);
    for (const m of messages.sort((a, b) => a.id - b.id)) {
      if (generation !== this.generation) return;
      if (this.ledger.covered(gap.key, m.id)) continue;
      let inbound: Omit<Inbound, 'account' | 'network'> | undefined;
      if (isText(m))
        try {
          inbound = await this.inbound(m, gap.chat);
        } catch (err) {
          this.o.log(`message ${m.id} dropped: ${String(err)}`);
        }
      if (generation !== this.generation) return;
      this.ledger.advance(gap.key, m.id);
      if (inbound === undefined || !this.remember(gap.key, m.id)) continue;
      this.received({ ...inbound, playback: true, missed: true });
    }
    this.ledger.advance(gap.key, gap.upTo);
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
