/**
 * A Telegram bot account, run in-process with grammY, as a connector of the core
 * (docs/bot-os-api.md §4.5). The process owns the one `Bot` its token allows:
 * it creates it with `@grammyjs/auto-retry`, starts polling and retries a failed start.
 *
 * It hears the messages Telegram delivers the bot (with privacy mode on: commands addressed to it in
 * a group, and everything in a private chat), and sends through the account's outbox. Its chat
 * surface (packages/connectors/src/transport/telegram-surface.ts) answers the commands
 * on the bot it holds, and it tells a plugin whether it administers a chat (`isAdmin`).
 */
import { autoRetry } from '@grammyjs/auto-retry';
import { type Connector, ConnectorBase, FloodWait, type TextFormat } from '@megabottron1999/core';
import { Bot, GrammyError } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';
import { markdownToTelegramHtml } from 'grammy-switchboard';

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

export interface BotConnectorOptions {
  /** `telegram-bot:<name>`. */
  account: string;
  bot: Bot;
  log: (line: string) => void;
  /** Polling waits for this: the app installs its handlers on the bot first. */
  listen?: Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

export class TelegramBotConnector extends ConnectorBase implements Connector {
  /** The bot, for its chat surface (packages/connectors/src/transport/telegram-surface.ts). */
  readonly bot: Bot;
  private readonly o: BotConnectorOptions;
  private started = false;

  constructor(options: BotConnectorOptions) {
    super(options.account, 'telegram');
    this.o = options;
    this.bot = options.bot;
    // First in the bot's chain, so it hears every message before the app's handlers.
    this.bot.on('message', async (ctx, next) => {
      const m = ctx.message;
      const text = m.text ?? m.caption;
      if (text !== undefined)
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
            playback: false,
          });
        } catch (e) {
          this.o.log(`a listener failed on message ${m.message_id}: ${String(e)}`);
        }
      await next();
    });
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
