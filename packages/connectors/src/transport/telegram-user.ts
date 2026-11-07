/**
 * A Telegram user account, logged in as a user session with GramJS as a connector of the core
 * (docs/bot-os-api.md §4.5): the owner's own account, for parsers and turn-actors that read and
 * play in its chats.
 *
 * It reads the chats it is given and no other: a group by its id (`-100…`), or a private chat with a
 * bot by the bot's username (`@QuestBot`, P3). The account sees every chat of its owner, and
 * the rest never leaves this module. It sends any text to those chats, but only through the
 * account's outbox, which keeps each plugin to the chats and commands of its reach (§4.6).
 *
 * The session string gives full access to the account: it comes from the deployment's secrets,
 * never from this repository, and is never printed by this module.
 */
import {
  type Clock,
  type Connector,
  ConnectorBase,
  FloodWait,
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
  out: boolean;
  message: string;
  replyTo?: { replyToMsgId?: number | undefined } | undefined;
  chatId?: { toString(): string } | undefined;
  /** A private chat (with a user or a bot), not a group. */
  isPrivate?: boolean | undefined;
  getSender(): Promise<unknown>;
  getChat(): Promise<unknown>;
}

/** The part of GramJS's `TelegramClient` the connector uses; tests pass a fake. */
export interface GramClient {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  /** Fills the entity cache, so a group's id resolves to a peer. */
  getDialogs(params: object): Promise<unknown>;
  getInputEntity(id: number | string): Promise<unknown>;
  /** The logged-in user. */
  getMe(): Promise<unknown>;
  sendMessage(entity: never, params: { message: string }): Promise<{ id: number }>;
  addEventHandler(
    handler: (event: { message: RawMessage }) => Promise<void>,
    builder: NewMessage
  ): void;
}

/** The username of an entity GramJS returned (a user, a bot, a channel posting as itself). */
function username(entity: unknown): string | undefined {
  if (typeof entity !== 'object' || entity === null || !('username' in entity)) return undefined;
  return typeof entity.username === 'string' ? entity.username : undefined;
}

/** A chat the connector reads: a group's id, or a private chat by the other's `@username`. */
export const USER_CHAT = /^(?:-\d+|@\w{4,})$/u;

/** How long a failed start waits before the next. */
export const RETRY_MS = 60_000;

/** The wait GramJS asks for (its `FloodWaitError` and kin carry `seconds`), in ms. */
function floodMs(e: unknown): number | undefined {
  if (!(e instanceof Error) || !('seconds' in e) || typeof e.seconds !== 'number') return undefined;
  return e.seconds * 1000;
}

export interface UserConnectorOptions {
  /** `telegram:<name>`. */
  account: string;
  client: GramClient;
  /** The chats it reads and may send to (`USER_CHAT`). */
  chats: readonly string[];
  clock: Clock;
  log: (line: string) => void;
  /** Told of the first failed start (a revoked session needs a login). */
  notify?: (text: string) => void;
}

export class TelegramUserConnector extends ConnectorBase implements Connector {
  private readonly o: UserConnectorOptions;
  /** Each chat's peer, by the chat in lower case, once started. */
  private readonly peers = new Map<string, unknown>();
  /** The chats as given, by their lower case. */
  private readonly chats: Map<string, string>;
  private started = false;
  private listening = false;
  private told = false;
  private retry: TimerHandle | undefined;

  constructor(options: UserConnectorOptions) {
    super(options.account, 'telegram');
    this.o = options;
    this.chats = new Map(options.chats.map((c) => [c.toLowerCase(), c]));
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
    this.o.clock.clearTimeout(this.retry);
    this.peers.clear();
    this.changed({ state: 'closed', phase: 'closed' });
    await this.o.client.disconnect();
  }

  /** Sends without waiting for the answer, which is logged if it fails; `deliver` waits. */
  send(chat: string, text: string): boolean {
    if (this.status().state !== 'connected' || !this.peers.has(chat.toLowerCase())) return false;
    this.deliver(chat, text).catch((e: unknown) =>
      this.o.log(`send to ${chat} failed: ${String(e)}`)
    );
    return true;
  }

  async deliver(chat: string, text: string): Promise<{ id?: string }> {
    const peer = this.peers.get(chat.toLowerCase());
    if (peer === undefined) throw new Error(`${chat} is not a chat of ${this.account}`);
    try {
      const sent = await this.o.client.sendMessage(peer as never, { message: text });
      return { id: String(sent.id) };
    } catch (e) {
      const ms = floodMs(e);
      throw ms === undefined ? e : new FloodWait(ms);
    }
  }

  private async connect(): Promise<void> {
    const { client } = this.o;
    try {
      await client.connect();
      await client.getDialogs({});
      for (const [key, chat] of this.chats)
        this.peers.set(
          key,
          await client.getInputEntity(chat.startsWith('@') ? chat : Number(chat))
        );
      this.named(username(await client.getMe()));
      if (!this.started) return;
      // Once, however often the start is retried.
      if (!this.listening) client.addEventHandler((e) => this.heard(e.message), new NewMessage({}));
      this.listening = true;
      this.changed({ state: 'connected', phase: 'ready' });
      this.o.log(
        `connected as ${this.self() ?? '(no username)'}, reading ${[...this.chats.values()].join(', ')}`
      );
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

  /** A message the account saw: passed on if it is in one of its chats, as an `Inbound`. */
  private async heard(m: RawMessage): Promise<void> {
    try {
      const chat = await this.chatOf(m);
      if (chat === undefined) return;
      const sender = username(await m.getSender());
      const replyTo = m.replyTo?.replyToMsgId;
      this.received({
        chat,
        sender: sender ?? '',
        text: m.message,
        time: m.date * 1000,
        id: String(m.id),
        ...(replyTo === undefined ? {} : { replyTo: String(replyTo) }),
        playback: false,
        own: m.out,
      });
    } catch (err) {
      this.o.log(`message ${m.id} dropped: ${String(err)}`);
    }
  }

  /** The chat of a message, as given, or undefined for a chat it does not read. */
  private async chatOf(m: RawMessage): Promise<string | undefined> {
    const byId = this.chats.get(m.chatId?.toString() ?? '');
    if (byId !== undefined) return byId;
    if (m.isPrivate !== true) return undefined;
    const other = username(await m.getChat());
    return other === undefined ? undefined : this.chats.get(`@${other}`.toLowerCase());
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
