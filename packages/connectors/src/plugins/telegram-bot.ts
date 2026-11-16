/**
 * The `telegram-bot` connector plugin (docs/bot-os-api.md §4.5): a Telegram bot, on grammY
 * (packages/connectors/src/transport/telegram-bot.ts). Its token is pasted in its node's panel
 * (bot-os.md D116, `bot-login.ts`: checked with `getMe`, kept in its store), or else the
 * `telegram_bot_token` Docker secret (P9), which it alone receives; without either it runs needing a
 * login (`LoginNeeded`). It makes the bot from the token at `create`, connects and
 * polls at `start` (once the app listens), and stops it at `stop`. Other plugins get a handle, and
 * send through the account's outbox.
 *
 * Configured with the owner's Telegram user id (`owner`) and, optionally, a group (`group`), it is a
 * chat surface (packages/connectors/src/transport/telegram-surface.ts): it answers the owner's
 * controls in the owner's chat, and the plugins' commands that a commands edge from its `commands`
 * output serves (bot-os.md D109), in the chats that edge names, polling only once the core has
 * served it the commands. Without an `owner` it is no surface, and its commands edges answer
 * nothing. It reports nothing on its own (bot-os.md D94): an `owner-notice` node sends the owner's notices
 * through it, those with buttons to the owner's chat through its surface, whose taps run them. The token stays in the connector's secrets, and nothing hands it out:
 * no plugin, and not the wiring, gets the bot (P9).
 *
 * Its `home` (bot-os.md D105) is the command of the owner's main card: the core's own cards
 * (`/plugins`, `/settings`) end with a button back to it, labelled `homeLabel`.
 *
 * Its `deny` list (bot-os.md D100) names the people and bots, picked among its chats, whose
 * commands in a group it drops before any plugin sees them; each drop is recorded
 * (`telegram-bot.denied`, on the Events page) and counted in its node's view and on its card.
 * Silent, unless `denyReply` sets a line to answer with. Its owner is never denied.
 */
import {
  commandIntervalS,
  definePlugin,
  liveGraceS,
  LoginNeeded,
  type Plugin,
  type StateView,
  unansweredAt,
  unansweredAtBy,
} from '@megabottron1999/core';
import { type Bot } from 'grammy';
import { z } from 'zod';
import { BOT_LOGIN_DOC, BotLogin, type BotLoginDoc } from '#src/transport/bot-login.ts';
import { createBot, TelegramBotConnector } from '#src/transport/telegram-bot.ts';
import { DenyList } from '#src/transport/telegram-deny.ts';
import { TelegramSurface } from '#src/transport/telegram-surface.ts';

export const TELEGRAM_BOT = 'telegram-bot';
export const BOT_TOKEN = 'telegram_bot_token';

/**
 * Its configuration, in its node of the graph (v0's `TELEGRAM_AUTHOR_ID` and `TELEGRAM_GROUP_ID`
 * were environment variables): with an owner, a chat surface, and the owner's chat (bot-os.md D56).
 */
export const telegramBotConfig = z
  .object({
    owner: z
      .number()
      .int()
      .optional()
      .describe(
        'The owner, picked among its chats (by their user id): their private chat with the bot alone answers the owner’s commands, and runs the buttons of the notices an owner-notice node sends there'
      ),
    group: z
      .number()
      .int()
      .optional()
      .describe(
        'A group, picked among its chats, whose members may use the plugins’ public commands'
      ),
    chats: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'The chats it monitors for the plugins, picked among its chats; unset: every chat it hears'
      ),
    deny: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'People and bots whose commands in a group it ignores, picked among its chats (never its owner); private chats are unaffected'
      ),
    denyReply: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\n]*$/u, 'one line')
      .optional()
      .describe(
        'One line it answers a denied command with, at most once in 10 minutes per person; unset: it ignores them without a word'
      ),
    home: z
      .string()
      .regex(
        /^(?:\/\w+(?: +\S[^\n]*)?|\w+(?::[^\n]*)?)$/u,
        'a command: /menu, /menu args, or menu:args'
      )
      .refine((s) => Buffer.byteLength(s) <= 64, 'at most 64 bytes, a Telegram button’s most')
      .optional()
      .describe(
        'The owner’s main card: the command that the back button at the foot of the core’s cards (/plugins, /settings) runs, as typed (/menu) or short (menu); unset: no back button'
      ),
    homeLabel: z
      .string()
      .min(1)
      .max(32)
      .default('🏠 Home')
      .describe('The back button’s label, when it has a home'),
    commandIntervalS,
    unansweredAt,
    unansweredAtBy,
    liveGraceS,
  })
  .refine((c) => c.owner === undefined || !(c.deny ?? []).includes(String(c.owner)), {
    path: ['deny'],
    message: 'its owner cannot be denied',
  });
export type TelegramBotConfig = z.infer<typeof telegramBotConfig>;

/** What its view shows (D100): the commands it denied since it started. */
const VIEW_SCHEMA = z.toJSONSchema(
  z.object({
    count: z.number().describe('Commands denied since it started'),
    last: z
      .object({
        t: z.number().describe('When'),
        chat: z.string().describe('In the group'),
        chatTitle: z.string().optional().describe('Its title'),
        sender: z.string().describe('Of whom, as its deny list names them'),
        command: z.string().describe('The command'),
        replied: z.boolean().describe('Answered with its reply line'),
      })
      .optional()
      .describe('The last one'),
  }),
  { io: 'output', unrepresentable: 'any' }
);

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
      description:
        'A Telegram bot: the owner’s commands, the public commands, and the chats it monitors',
      account,
      secrets: [BOT_TOKEN],
      // Its token from its node's panel, its secret a fallback (D116).
      login: true,
      config: telegramBotConfig,
      // The chats its config lists; unset, every chat (D89). A chat goes by its id and its
      // @username, which its connector tells apart (D90).
      monitors: { config: 'chats', aliases: true },
      // Its owner and its group are picked among its chats, never typed as ids (D96); its owner's
      // chat is where an owner-notice edge naming no chat sends (D97).
      configChats: [
        { key: 'owner', kinds: ['private'], owner: true },
        { key: 'group', kinds: ['group'] },
        // Whom it denies: people and bots it recognises, not chats it sends to (D100).
        { key: 'deny', kinds: ['private', 'bot'], sender: true },
      ],
      // The plugins' commands it answers, each where and to whom its edge says (D109).
      outputs: {
        commands: {
          type: 'commands',
          help: 'The plugins’ chat commands it answers (with an owner set): each edge says which, in which chats, to whom',
        },
      },
    },
    create: (ctx) => {
      const log = (line: string): void => ctx.log.info(line);
      const config = ctx.config as TelegramBotConfig;
      const kept = ctx.store.read<BotLoginDoc>(BOT_LOGIN_DOC)?.token;
      const secret = ctx.secrets?.has(BOT_TOKEN) === true;
      const token = kept ?? (secret ? ctx.secrets?.get(BOT_TOKEN) : undefined);
      const ref: { connector?: TelegramBotConnector } = {};
      const login = new BotLogin({
        store: ctx.store,
        clock: ctx.clock,
        source: kept !== undefined ? 'store' : token === undefined ? undefined : 'secrets',
        secrets: secret,
        self: () => ref.connector?.self(),
        check: (t) => make(t, log).api.getMe(),
        remember: (value) => ctx.secrets?.remember(value),
        log,
      });
      if (token === undefined)
        return { connector: new LoginNeeded(ctx.account ?? account, 'telegram'), login };
      const bot = make(token, log);
      // The surface hears the connector's status; the connector polls once the surface listens.
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
              ...(config.home === undefined
                ? {}
                : { home: { label: config.homeLabel, action: config.home } }),
            });
      const listen = Promise.all([o.listen, surface?.listening]);
      const deny =
        config.deny === undefined || config.deny.length === 0
          ? undefined
          : new DenyList({
              deny: config.deny,
              owner: config.owner,
              reply: config.denyReply,
              now: () => ctx.clock.now(),
            });
      const c = new TelegramBotConnector({
        account: ctx.account ?? account,
        bot,
        log,
        listen,
        ...(config.chats === undefined ? {} : { chats: config.chats }),
        known: [
          ...(config.owner === undefined ? [] : [{ id: config.owner, role: 'owner' as const }]),
          ...(config.group === undefined ? [] : [{ id: config.group, role: 'group' as const }]),
        ],
        store: ctx.store,
        now: () => ctx.clock.now(),
        ...(deny === undefined
          ? {}
          : { deny, onDenied: (d) => ctx.record(`${TELEGRAM_BOT}.denied`, { ...d }) }),
        liveGraceMs: config.liveGraceS * 1000,
        ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
        // Buttons a node sends to the owner's chat go through the surface, whose taps run them.
        ...(surface === undefined || config.owner === undefined
          ? {}
          : {
              ownerChat: {
                chat: String(config.owner),
                send: (text, buttons, format) => surface.send(text, buttons, format),
              },
            }),
      });
      ref.connector = c;
      c.limits = {
        commandIntervalMs: config.commandIntervalS * 1000,
        unansweredAt: config.unansweredAt,
        ...(config.unansweredAtBy === undefined ? {} : { unansweredAtBy: config.unansweredAtBy }),
      };
      return {
        connector: c,
        // What it denied since it started (D100), for its node's panel and its card.
        ...(deny === undefined
          ? {}
          : {
              view: {
                read: (): StateView => ({ schema: VIEW_SCHEMA, state: c.denied() }),
                summary: () => {
                  const n = c.denied().count;
                  return n === 0 ? undefined : `${n} command${n === 1 ? '' : 's'} denied`;
                },
              },
            }),
        ...(surface === undefined ? {} : { surface }),
        login,
        start: () => c.start(),
        stop: async () => {
          surface?.stop();
          await c.stop();
        },
      };
    },
  });
}
