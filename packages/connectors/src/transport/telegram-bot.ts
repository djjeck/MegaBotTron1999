/**
 * A Telegram bot account, run in-process with grammY, as a connector of the core
 * (docs/bot-os-api.md §4.5). The process owns the one `Bot` its token allows:
 * it creates it with `@grammyjs/auto-retry`, starts polling and retries a failed start.
 *
 * It hears the messages Telegram delivers the bot (with privacy mode on: commands addressed to it in
 * a group, and everything in a private chat), and sends through the account's outbox. Its chat
 * surface (packages/connectors/src/transport/telegram-surface.ts) answers the commands
 * on the bot it holds, and it tells a plugin whether it administers a chat (`isAdmin`).
 *
 * Its surfaces (bot-os.md D63): the Bot API cannot list a bot's chats, so it keeps those it has
 * seen in updates in its store, and adds one searched for by its id or `@username` (`getChat`).
 * Given `chats`, it monitors only those (by id or `@username`); none, every chat it hears. What was
 * said while it was down Telegram keeps for the bot (up to a day) and delivers at its next poll: its
 * own catch-up, whose messages, older than the connection, it marks `playback` and `missed`.
 * Telegram delivers an update again when its poll was not confirmed (the process killed before it
 * stopped): each message is delivered to the readers at most once all the same, against the last
 * message id delivered in its chat, kept in its store (`last-seen`, docs/bot-os.md D66).
 */
import { autoRetry } from '@grammyjs/auto-retry';
import {
  type Connector,
  ConnectorBase,
  FloodWait,
  type InboundDocument,
  readDocument,
  type Surface,
  type SurfaceQuery,
  type TextFormat,
} from '@megabottron1999/core';
import { Bot, GrammyError } from 'grammy';
import { type Chat, type Document, type UserFromGetMe } from 'grammy/types';
import { markdownToTelegramHtml } from 'grammy-switchboard';
import { SeenLedger } from './seen-ledger.ts';

// A 429 is waited out as Telegram asks, a few times; network errors and 5xx fail the call, so the
// notifier reports them and the startup retry below keeps its own backoff.
export function createBot(token: string, warn: (line: string) => void): Bot {
  const bot = new Bot(token);
  bot.api.config.use(
    autoRetry({
      maxDelaySeconds: 30,
      maxRetryAttempts: 3,
      rethrowHttpErrors: true,
      rethrowInternalServerErrors: true,
    })
  );
  // grammY's default handler stops polling on the first update a handler throws on; one bad
  // update must not take the remote down, so it is reported and polling goes on.
  bot.catch((e) => warn(`update ${e.ctx.update.update_id} failed: ${String(e.error)}`));
  return bot;
}

/** What starting needs of a grammY `Bot`. */
export interface Startable {
  api: { getMe(): Promise<UserFromGetMe> };
  botInfo: UserFromGetMe;
  start(): Promise<void>;
}

export interface StartOptions {
  /** Where the connection and its failures are reported. */
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Called once the bot is connected, and again after each restart of polling. */
  onStart?: () => void;
  /** Called when polling stops on an error, before it is started again. */
  onStop?: (error: unknown) => void;
  /** Whether to go on: false once the bot was stopped, so a retry under way gives up. */
  running?: () => boolean;
}

/**
 * Whether the bot is an admin (or the creator) of the group, as Telegram says; not when Telegram
 * does not say, or the bot is not connected yet (`bot` undefined).
 */
export async function adminIn(
  api: { getChatMember(chatId: number, userId: number): Promise<{ status: string }> },
  groupId: number,
  bot: () => { id: number } | undefined
): Promise<boolean> {
  const me = bot();
  const status = me && (await api.getChatMember(groupId, me.id).catch(() => undefined))?.status;
  return status === 'administrator' || status === 'creator';
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10 * 60_000;
const POLLING_RESTART_MS = 60_000;

const timerSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Connects (`getMe`) and starts long polling, retrying with a backoff capped at ten minutes until it
 * connects. Polling ends only on an error grammY doesn't retry itself (a revoked token, a second
 * consumer of the same token): it is reported and started again after a minute.
 */
export async function startBotWithRetry(bot: Startable, o: StartOptions): Promise<void> {
  const sleep = o.sleep ?? timerSleep;
  const running = o.running ?? (() => true);
  let delay = FIRST_RETRY_MS;
  for (;;) {
    try {
      bot.botInfo = await bot.api.getMe();
      break;
    } catch (e) {
      o.log(`could not connect, retrying in ${delay / 1000} s: ${String(e)}`);
      await sleep(delay);
      if (!running()) return;
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }
  if (!running()) return;
  o.log(`connected as @${bot.botInfo.username}`);
  o.onStart?.();
  // start() runs the polling loop and resolves only when the bot stops.
  bot.start().catch(async (e: unknown) => {
    o.log(`polling stopped, restarting in a minute: ${String(e)}`);
    o.onStop?.(e);
    await sleep(POLLING_RESTART_MS);
    if (running()) await startBotWithRetry(bot, o);
  });
}

/** The wait Telegram asked for past what auto-retry waits out itself, in ms. */
function floodMs(e: unknown): number | undefined {
  if (!(e instanceof GrammyError) || e.error_code !== 429) return undefined;
  return (e.parameters.retry_after ?? 0) * 1000;
}

/** The store's document of the chats the bot has seen, by id. */
export const SURFACES_DOC = 'surfaces';
/** How many of the latest chats the surfaces list without a search. */
const SURFACES_LIMIT = 50;
/** A chat's last activity is kept again only once it moved by this much. */
const ACTIVE_STEP_MS = 60_000;

/** A chat as the bot saw it, as a surface. */
export function surfaceOf(chat: Chat, lastActive?: number): Surface {
  const title =
    chat.type === 'private'
      ? [chat.first_name, chat.last_name].filter((x) => x !== undefined).join(' ')
      : chat.title;
  return {
    id: String(chat.id),
    title: title || (chat.username === undefined ? String(chat.id) : `@${chat.username}`),
    kind: chat.type === 'private' ? 'private' : chat.type === 'channel' ? 'channel' : 'group',
    ...(lastActive === undefined ? {} : { lastActive }),
  };
}

export interface BotConnectorOptions {
  /** `telegram-bot:<name>`. */
  account: string;
  bot: Bot;
  log: (line: string) => void;
  /** The chats it monitors, by id or `@username`; none: every chat it hears. */
  chats?: readonly string[] | undefined;
  /** Where it keeps the chats it has seen, its surfaces, and the last message delivered in each. */
  store?: { read<T>(name: string): T | undefined; write(name: string, value: unknown): void };
  /** The time now, in ms: what came before its connection was missed. */
  now?: () => number;
  /** Polling waits for this: the app installs its handlers on the bot first. */
  listen?: Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  /** Downloads a file by its id (D82); by default, `getFile` and its URL on the Bot API. */
  download?: (fileId: string) => Promise<Uint8Array>;
}

/**
 * Downloads a file the bot was sent, through the Bot API (`getFile`, then its URL). The URL holds
 * the bot's token, so an error says only the HTTP status, never the URL.
 */
export async function downloadFile(
  bot: Pick<Bot, 'api' | 'token'>,
  fileId: string,
  fetcher: typeof fetch = fetch
): Promise<Uint8Array> {
  const file = await bot.api.getFile(fileId);
  if (file.file_path === undefined) throw new Error('Telegram gave no path for the file');
  const res = await fetcher(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export class TelegramBotConnector extends ConnectorBase implements Connector {
  /** The bot, for its chat surface (packages/connectors/src/transport/telegram-surface.ts). */
  readonly bot: Bot;
  private readonly o: BotConnectorOptions;
  private started = false;
  /** When it connected, in seconds: a message sent before was missed while it was down. */
  private since = 0;
  private readonly chats: Set<string> | undefined;
  private readonly seen: Record<string, Surface>;
  /** The last message id delivered in each chat: one delivered again is not delivered twice. */
  private readonly ledger: SeenLedger;

  constructor(options: BotConnectorOptions) {
    super(options.account, 'telegram');
    this.o = options;
    this.bot = options.bot;
    this.chats =
      options.chats === undefined ? undefined : new Set(options.chats.map((c) => c.toLowerCase()));
    this.seen = { ...(options.store?.read<Record<string, Surface>>(SURFACES_DOC) ?? {}) };
    this.ledger = new SeenLedger(options.store);
    // First in the bot's chain, so it hears every message before the app's handlers.
    this.bot.on('message', async (ctx, next) => {
      const m = ctx.message;
      this.saw(m.chat, m.date * 1000);
      const missed = m.date < this.since;
      const key = String(m.chat.id);
      // Accounted for before it is delivered, once (D66); the app's handlers still hear it.
      const again = this.ledger.covered(key, m.message_id);
      const heard = !again && this.monitors(m.chat);
      // Its file is read before it is accounted for: a stop in between, and Telegram delivers it
      // again (D82).
      const document =
        heard && m.document !== undefined ? await this.document(m.document) : undefined;
      // A file without a caption has no text: its text is then ''.
      const text = m.text ?? m.caption ?? (document === undefined ? undefined : '');
      if (heard) this.ledger.advance(key, m.message_id);
      if (text !== undefined && heard)
        try {
          this.received({
            chat: String(m.chat.id),
            sender: m.from?.username ?? '',
            text,
            time: m.date * 1000,
            id: String(m.message_id),
            ...(m.reply_to_message === undefined
              ? {}
              : { replyTo: String(m.reply_to_message.message_id) }),
            playback: missed,
            ...(missed ? { missed } : {}),
            ...(document === undefined ? {} : { document }),
          });
        } catch (e) {
          this.o.log(`a listener failed on message ${m.message_id}: ${String(e)}`);
        }
      await next();
    });
  }

  /** A message's file (D82): a text file under the limit with its text, any other described. */
  private document(d: Document): Promise<InboundDocument> {
    const download = this.o.download ?? ((id: string) => downloadFile(this.bot, id));
    return readDocument(
      { name: d.file_name, mime: d.mime_type, size: d.file_size },
      () => download(d.file_id),
      this.o.log
    );
  }

  /** Connects and polls, once the app is listening; retried as `startBotWithRetry` does. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.changed({ state: 'connecting', phase: 'connecting' });
    void (this.o.listen ?? Promise.resolve()).then(() => {
      if (!this.started) return;
      return startBotWithRetry(this.bot, {
        log: this.o.log,
        ...(this.o.sleep === undefined ? {} : { sleep: this.o.sleep }),
        running: () => this.started,
        onStart: () => {
          this.since = Math.floor((this.o.now ?? Date.now)() / 1000);
          this.named(this.bot.botInfo.username);
          this.changed({ state: 'connected', phase: 'polling' });
        },
        onStop: (e) =>
          this.changed({ state: 'connecting', phase: 'restarting', detail: String(e) }),
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.changed({ state: 'closed', phase: 'closed' });
    await this.bot.stop();
  }

  /**
   * Its surfaces (bot-os.md D63): the chats it has seen, latest first; with a search, those whose
   * title or id has it, and, searched by its id or `@username`, a chat it has not seen, from
   * Telegram (`getChat`), kept from then on.
   */
  async surfaces(query: SurfaceQuery = {}): Promise<Surface[]> {
    const search = query.search?.trim() ?? '';
    const lower = search.toLowerCase();
    const found = () =>
      Object.values(this.seen)
        .filter(
          (x) =>
            lower === '' ||
            x.title.toLowerCase().includes(lower) ||
            x.id.toLowerCase().includes(lower)
        )
        .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
        .slice(0, query.limit ?? SURFACES_LIMIT);
    if (found().length > 0 || !/^(?:-?\d+|@\w{4,})$/u.test(search)) return found();
    const chat = await this.bot.api
      .getChat(/^-?\d+$/u.test(search) ? Number(search) : search)
      .catch(() => undefined);
    if (chat !== undefined) this.saw(chat);
    return found();
  }

  /** Whether it monitors `chat`: one of its chats (by id or `@username`), or any without. */
  private monitors(chat: Chat): boolean {
    if (this.chats === undefined) return true;
    const name = 'username' in chat && chat.username !== undefined ? `@${chat.username}` : '';
    return this.chats.has(String(chat.id)) || this.chats.has(name.toLowerCase());
  }

  /** A chat seen: kept among its surfaces, when it is new or its activity moved enough. */
  private saw(chat: Chat, lastActive?: number): void {
    const id = String(chat.id);
    const before = this.seen[id];
    const active = Math.max(lastActive ?? 0, before?.lastActive ?? 0);
    if (before !== undefined && active - (before.lastActive ?? 0) < ACTIVE_STEP_MS) return;
    this.seen[id] = surfaceOf(chat, active === 0 ? undefined : active);
    this.o.store?.write(SURFACES_DOC, this.seen);
  }

  /** Whether the bot administers `chat` (a group's id), as Telegram says now. */
  isAdmin(chat: string): Promise<boolean> {
    return adminIn(this.bot.api, Number(chat), () => {
      try {
        return { id: this.bot.botInfo.id };
      } catch {
        // Not connected yet: the bot's information comes with getMe.
        return undefined;
      }
    });
  }

  /** Sends without waiting for the answer, which is logged if it fails; `deliver` waits. */
  send(chat: string, text: string): boolean {
    if (this.status().state !== 'connected') return false;
    this.deliver(chat, text).catch((e: unknown) =>
      this.o.log(`send to ${chat} failed: ${String(e)}`)
    );
    return true;
  }

  /**
   * Sends `text` and waits for Telegram's answer. Markdown goes as Telegram HTML, as the
   * switchboard sends it: if Telegram cannot parse the HTML, the text goes again as written, so a
   * slip of the formatting never costs the message.
   */
  async deliver(
    chat: string,
    text: string,
    options: { format?: TextFormat } = {}
  ): Promise<{ id?: string }> {
    const to = /^-?\d+$/u.test(chat) ? Number(chat) : chat;
    try {
      if (options.format === 'markdown')
        try {
          const sent = await this.bot.api.sendMessage(to, markdownToTelegramHtml(text), {
            parse_mode: 'HTML',
          });
          return { id: String(sent.message_id) };
        } catch (e) {
          if (!(e instanceof GrammyError && /can't parse entities/iu.test(e.description))) throw e;
          this.o.log(`formatting refused, sending plain text: ${e.description}`);
        }
      const sent = await this.bot.api.sendMessage(to, text);
      return { id: String(sent.message_id) };
    } catch (e) {
      const ms = floodMs(e);
      throw ms === undefined ? e : new FloodWait(ms);
    }
  }
}
