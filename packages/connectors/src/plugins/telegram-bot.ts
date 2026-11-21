/**
 * The `telegram-bot` connector plugin (docs/bot-os-api.md §4.5): a Telegram bot, on grammY
 * (packages/connectors/src/transport/telegram-bot.ts). Its token is pasted in its node's panel
 * (bot-os.md D116, D118, `bot-login.ts`: checked with `getMe`, kept in its store, never a Docker
 * secret); without one it runs needing a login (`LoginNeeded`). It makes the bot from the token at
 * `create`, connects and
 * polls at `start` (once the app listens), and stops it at `stop`. Other plugins get a handle, and
 * send through the account's outbox.
 *
 * Configured with the owner's Telegram user id (`owner`), it is a chat surface
 * (packages/connectors/src/transport/telegram-surface.ts): it answers the owner's controls in the
 * owner's chat, and the plugins' commands that a commands edge from its `commands`
 * output serves (bot-os.md D109), in the chats that edge names, polling only once the core has
 * served it the commands. Without an `owner` it is no surface, and its commands edges answer
 * nothing. It reports nothing on its own (bot-os.md D94): an `owner-notice` node sends the owner's notices
 * through it, those with buttons to the owner's chat through its surface, whose taps run them. The token stays in the connector's store, and nothing hands it out:
 * no plugin, and not the wiring, gets the bot (P9).
 *
 * Its interface offers `photo` (D151): the photo of a message it heard or sent, kept by its
 * `file_id` (the Bot API fetches no message by its id), downloaded when a plugin bound to it asks.
 *
 * Its `home` (bot-os.md D105) is the command of the owner's main card: the core's own cards
 * (`/plugins`, `/settings`) end with a button back to it, labelled `homeLabel`.
 *
 * Whom and where it works for (bot-os.md D128, its gate, `telegram-gate.ts`): `groups`, any group
 * it is added to but those in `blockGroups`, or only those in `onlyGroups`; `people`, anyone but
 * those in `blockPeople`, or only those in `onlyPeople`; its owner always. In a group it does not
 * work in, nothing reaches a plugin, a command or a message; a command of a person it does not work
 * for is dropped in any chat, what they say still read. Each command dropped is recorded
 * (`telegram-bot.denied`, on the Events page) and counted in its node's view and on its card;
 * silent, unless `denyReply` sets a line to answer a person with.
 */
import {
  commandIntervalS,
  definePlugin,
  liveGraceS,
  LoginNeeded,
  PHOTO_ACTION,
  photoAction,
  type Plugin,
  type StateView,
  unansweredAt,
  unansweredAtBy,
} from '@megabottron1999/core';
import { type Bot } from 'grammy';
import { z } from 'zod';
import { BOT_LOGIN_DOC, BotLogin, type BotLoginDoc, botOf } from '#src/transport/bot-login.ts';
import { createBot, TelegramBotConnector } from '#src/transport/telegram-bot.ts';
import { Gate } from '#src/transport/telegram-gate.ts';
import { TelegramSurface } from '#src/transport/telegram-surface.ts';

export const TELEGRAM_BOT = 'telegram-bot';

/** The chats a list of the gate names, picked among its chats (D96, D128). */
const chatList = z.array(z.string().min(1));

/**
 * Its configuration, in its node of the graph (v0's `TELEGRAM_AUTHOR_ID` and `TELEGRAM_GROUP_ID`
 * were environment variables): with an owner, a chat surface, and the owner's chat (bot-os.md D56);
 * where and for whom it works, its gate (D128), each a choice and then the list of that choice
 * alone (`choices`, `shownWhen`: the form shows them so, D127).
 */
export const telegramBotConfig = z
  .object({
    owner: z
      .number()
      .int()
      .optional()
      .describe(
        'You, its owner, picked among its chats once you have written to the bot: your private chat with it answers your commands (/plugins, /settings) and runs the buttons of the notices an owner-notice node sends there; unset, it answers no owner command'
      ),
    groups: z
      .enum(['any', 'only'])
      .default('any')
      .meta({
        description:
          'The groups it works in: in any other, it answers no command and its plugins hear nothing',
        choices: { any: 'Any group it is added to', only: 'Only these groups' },
      }),
    onlyGroups: chatList.optional().meta({
      description: 'The groups it works in, picked among its chats; none: no group',
      shownWhen: { groups: 'only' },
    }),
    blockGroups: chatList.optional().meta({
      description:
        'Optional: groups it ignores all the same, picked among its chats; unset: it works in every group',
      shownWhen: { groups: 'any' },
    }),
    people: z
      .enum(['anyone', 'only'])
      .default('anyone')
      .meta({
        description:
          'Whose commands it answers, in groups and private chats; its owner’s always. What others say still reaches the plugins that read the chat',
        choices: { anyone: 'Anyone', only: 'Only these people' },
      }),
    onlyPeople: chatList.optional().meta({
      description:
        'The people and bots whose commands it answers, picked among its chats; its owner is always allowed, listed or not',
      shownWhen: { people: 'only' },
    }),
    blockPeople: chatList.optional().meta({
      description:
        'Optional: people and bots whose commands it ignores all the same, picked among its chats (never its owner); unset: it answers anyone',
      shownWhen: { people: 'anyone' },
    }),
    chats: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'The chats it monitors for the plugins, picked among its chats; unset: every chat it hears'
      ),
    denyReply: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\n]*$/u, 'one line')
      .optional()
      .describe(
        'One line it answers a person’s command it does not take with, at most once in 10 minutes per person; unset: it ignores them without a word'
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
  .superRefine((c, ctx) => {
    // A list of the choice not made would hold unseen in the form (D127): refused, not ignored.
    const only = (key: string, list: unknown, applies: boolean, when: string): void => {
      if (list !== undefined && !applies)
        ctx.addIssue({ code: 'custom', path: [key], message: `set only with ${when}` });
    };
    only('onlyGroups', c.onlyGroups, c.groups === 'only', 'groups: only');
    only('blockGroups', c.blockGroups, c.groups === 'any', 'groups: any');
    only('onlyPeople', c.onlyPeople, c.people === 'only', 'people: only');
    only('blockPeople', c.blockPeople, c.people === 'anyone', 'people: anyone');
    if (c.owner !== undefined && (c.blockPeople ?? []).includes(String(c.owner)))
      ctx.addIssue({
        code: 'custom',
        path: ['blockPeople'],
        message: 'its owner cannot be blocked: it always works for them',
      });
  });
export type TelegramBotConfig = z.infer<typeof telegramBotConfig>;

/** What its view shows (D100): the commands it denied since it started. */
const VIEW_SCHEMA = z.toJSONSchema(
  z.object({
    count: z.number().describe('Commands denied since it started'),
    last: z
      .object({
        t: z.number().describe('When'),
        chat: z.string().describe('In the chat'),
        chatTitle: z.string().optional().describe('Its title'),
        sender: z.string().describe('Of whom: as its list names them, else by @username or id'),
        by: z.enum(['group', 'person']).describe('Why: a group, or a person, it does not work for'),
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
    /** Polling waits for this too (tests); with an owner, it waits for the commands. */
    listen?: Promise<unknown>;
    /** Makes the bot from its token (tests pass a stub). */
    bot?: (token: string, warn: (line: string) => void) => Bot;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Plugin {
  // Its network's; a node's account is `telegram-bot:<node id>` (D119).
  const account = 'telegram-bot:bot';
  const make = o.bot ?? createBot;
  // The bot each of its nodes holds, by node (D121): a token is refused on a second node.
  const held = new Map<string, string>();
  return definePlugin({
    manifest: {
      id: TELEGRAM_BOT,
      version: '0.1.0',
      kinds: ['connector'],
      description:
        'A Telegram bot: the owner’s commands, the public commands, and the chats it monitors',
      account,
      // Its token from its node's panel, kept in its store (D116, D118).
      login: true,
      // A message's photo, fetched on demand for the plugins an edge binds to it (D151).
      interface: { actions: { photo: PHOTO_ACTION } },
      config: telegramBotConfig,
      // The chats its config lists; unset, every chat (D89). A chat goes by its id and its
      // @username, which its connector tells apart (D90).
      monitors: { config: 'chats', aliases: true },
      // Its owner and its gate's lists are picked among its chats, never typed as ids (D96); its
      // owner's chat is where an owner-notice edge naming no chat sends (D97).
      configChats: [
        { key: 'owner', kinds: ['private'], owner: true },
        { key: 'onlyGroups', kinds: ['group'] },
        { key: 'blockGroups', kinds: ['group'] },
        // People and bots it recognises, not chats it sends to (D100, D128).
        { key: 'onlyPeople', kinds: ['private', 'bot'], sender: true },
        { key: 'blockPeople', kinds: ['private', 'bot'], sender: true },
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
      // Its credentials, sealed at rest under bot_os_key (D123).
      const kept = ctx.secrets?.store ?? ctx.store;
      const token = kept.read<BotLoginDoc>(BOT_LOGIN_DOC)?.token;
      if (token !== undefined) held.set(ctx.id, botOf(token));
      const ref: { connector?: TelegramBotConnector } = {};
      const login = new BotLogin({
        store: kept,
        clock: ctx.clock,
        source: token === undefined ? undefined : 'store',
        self: () => ref.connector?.self(),
        taken: (bot) => [...held].find(([node, b]) => node !== ctx.id && b === bot)?.[0],
        claim: (bot) => (bot === undefined ? held.delete(ctx.id) : held.set(ctx.id, bot)),
        check: (t) => make(t, log).api.getMe(),
        remember: (value) => ctx.secrets?.remember(value),
        log,
      });
      if (token === undefined)
        return {
          connector: new LoginNeeded(ctx.account ?? account, 'telegram'),
          login,
          interface: { actions: { photo: photoAction(undefined) } },
          stop: () => void held.delete(ctx.id),
        };
      const bot = make(token, log);
      // Where and for whom it works (D128), asked before anything else hears an update.
      const gate = new Gate({
        groups:
          config.groups === 'only'
            ? { only: config.onlyGroups ?? [] }
            : { block: config.blockGroups },
        people:
          config.people === 'only'
            ? { only: config.onlyPeople ?? [] }
            : { block: config.blockPeople },
        owner: config.owner,
        reply: config.denyReply,
        now: () => ctx.clock.now(),
      });
      // The surface hears the connector's status; the connector polls once the surface listens.
      const surface =
        config.owner === undefined
          ? undefined
          : new TelegramSurface({
              bot,
              owner: config.owner,
              // No menu in a group it does not work in; a chat named otherwise, as named.
              menuIn: (chat) =>
                !/^-\d+$/u.test(chat) ||
                gate.refusesGroup({ id: Number(chat), type: 'supergroup' }) === undefined,
              log,
              now: () => ctx.clock.now(),
              onStatus: (l) => void ref.connector?.onStatus(l),
              ...(config.home === undefined
                ? {}
                : { home: { label: config.homeLabel, action: config.home } }),
            });
      const listen = Promise.all([o.listen, surface?.listening]);
      const c = new TelegramBotConnector({
        account: ctx.account ?? account,
        bot,
        log,
        listen,
        ...(config.chats === undefined ? {} : { chats: config.chats }),
        ownerId: config.owner,
        store: ctx.store,
        now: () => ctx.clock.now(),
        ...(gate.active
          ? { gate, onDenied: (d) => ctx.record(`${TELEGRAM_BOT}.denied`, { ...d }) }
          : {}),
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
        // What it denied since it started (D128), for its node's panel and its card.
        ...(!gate.active
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
        interface: { actions: { photo: photoAction(c, log) } },
        start: () => c.start(),
        stop: async () => {
          held.delete(ctx.id);
          surface?.stop();
          await c.stop();
        },
      };
    },
  });
}
