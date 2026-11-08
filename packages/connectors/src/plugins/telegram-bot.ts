/**
 * The `telegram-bot` connector plugin (docs/bot-os-api.md §4.5): a Telegram bot, on grammY
 * (packages/connectors/src/transport/telegram-bot.ts). Its token is the `telegram_bot_token`
 * Docker secret (P9), which it alone receives: it makes the bot from it at `create`, connects and
 * polls at `start` (once the app listens), and stops it at `stop`. Other plugins get a handle, and
 * send through the account's outbox.
 *
 * Configured with the owner's Telegram user id (`owner`) and, optionally, a group (`group`), it is a
 * chat surface (packages/connectors/src/transport/telegram-surface.ts): it answers the
 * plugins' commands and the owner's, and carries the owner's notices, polling only once the core
 * has served it the commands. The token stays in the connector's secrets, and nothing hands it out:
 * no plugin, and not the wiring, gets the bot (P9).
 */
import { definePlugin, type Plugin } from '@megabottron1999/core';
import { type Bot } from 'grammy';
import { z } from 'zod';
import { createBot, TelegramBotConnector } from '#src/transport/telegram-bot.ts';
import { TelegramSurface } from '#src/transport/telegram-surface.ts';

export const TELEGRAM_BOT = 'telegram-bot';
export const BOT_TOKEN = 'telegram_bot_token';

/**
 * Its configuration, in its node of the graph (v0's `TELEGRAM_AUTHOR_ID` and `TELEGRAM_GROUP_ID`
 * were environment variables): with an owner, a chat surface, and the owner's chat (bot-os.md D56).
 */
export const telegramBotConfig = z.object({
  owner: z
    .number()
    .int()
    .optional()
    .describe(
      'The owner’s Telegram user id: their private chat with the bot gets the owner’s notices, and alone answers the owner’s commands'
    ),
  group: z
    .number()
    .int()
    .optional()
    .describe('A group whose members may use the plugins’ public commands'),
});
export type TelegramBotConfig = z.infer<typeof telegramBotConfig>;

export function telegramBotPlugin(
  o: {
    /** The bot's username: the account is `telegram-bot:<name>`. */
    name?: string;
    /** Polling waits for this too (tests); with an owner, it waits for the commands. */
    listen?: Promise<unknown>;
    /** Makes the bot from its token (tests pass a stub). */
    bot?: (token: string, warn: (line: string) => void) => Bot;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Plugin {
  const account = `telegram-bot:${o.name ?? 'bot'}`;
  const make = o.bot ?? createBot;
  return definePlugin({
    manifest: {
      id: TELEGRAM_BOT,
      version: '0.1.0',
      kinds: ['connector'],
      description: 'A Telegram bot: the owner’s notices and commands, and the public commands',
      account,
      secrets: [BOT_TOKEN],
      config: telegramBotConfig,
    },
    create: (ctx) => {
      const log = (line: string): void => ctx.log.info(line);
      const config = ctx.config as TelegramBotConfig;
      const bot = make(ctx.secrets?.get(BOT_TOKEN) ?? '', log);
      // The surface hears the connector's status; the connector polls once the surface listens.
      const ref: { connector?: TelegramBotConnector } = {};
      const surface =
        config.owner === undefined
          ? undefined
          : new TelegramSurface({
              bot,
              owner: config.owner,
              ...(config.group === undefined ? {} : { group: config.group }),
              log,
              now: () => ctx.clock.now(),
              onStatus: (l) => void ref.connector?.onStatus(l),
            });
      const listen = Promise.all([o.listen, surface?.listening]);
      const c = new TelegramBotConnector({
        account: ctx.account ?? account,
        bot,
        log,
        listen,
        ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
      });
      ref.connector = c;
      return {
        connector: c,
        ...(surface === undefined ? {} : { surface }),
        start: () => c.start(),
        stop: async () => {
          surface?.stop();
          await c.stop();
        },
      };
    },
  });
}
