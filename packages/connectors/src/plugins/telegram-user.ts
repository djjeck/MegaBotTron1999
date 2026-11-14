/**
 * The `telegram-user` connector plugin (docs/bot-os-api.md §4.5): the owner's own Telegram
 * account, on GramJS (packages/connectors/src/transport/telegram-user.ts). Its API id, API
 * hash and session string are Docker secrets (P9), which it alone receives; other plugins get a
 * handle, which hears only the chats their reach reads, and send through the account's outbox,
 * within the chats and commands their reach names. It monitors the chats of its configuration
 * only (groups by id, private chats by `@username`), or every chat of the account when it names
 * none (its surfaces, bot-os.md D63); each edge reads a subset (D62). At each connection it
 * catches up on what its readers' chats said while it was down (D62), keeping the last message id
 * seen in each chat in its store.
 */
import {
  commandIntervalS,
  definePlugin,
  liveGraceS,
  type Plugin,
  unansweredAt,
  unansweredAtBy,
} from '@megabottron1999/core';
import { z } from 'zod';
import {
  createTelegramClient,
  type GramClient,
  TelegramUserConnector,
  USER_CHAT,
  type UserCredentials,
} from '#src/transport/telegram-user.ts';

export const TELEGRAM_USER = 'telegram-user';
export const USER_SECRETS = [
  'telegram_user_api_id',
  'telegram_user_api_hash',
  'telegram_user_session',
] as const;

/**
 * The plugin's configuration: the chats it monitors, a group by id or a private chat by `@username`
 * (or the other's id); none: every chat of the account.
 */
export const telegramUserConfig = z.object({
  chats: z
    .array(z.string().regex(USER_CHAT, 'expected a group id (-100…) or a @username'))
    .optional()
    .describe(
      'The chats it monitors: a group by its id (-100…), a private chat by @username; unset: every chat'
    ),
  commandIntervalS,
  unansweredAt,
  unansweredAtBy,
  liveGraceS,
});
export type TelegramUserConfig = z.infer<typeof telegramUserConfig>;

/** the owner's credentials from the three secrets, or why they are not credentials. */
export function userCredentials(
  get: (name: (typeof USER_SECRETS)[number]) => string
): UserCredentials {
  const apiId = get('telegram_user_api_id');
  const apiHash = get('telegram_user_api_hash');
  const session = get('telegram_user_session');
  const problems = [
    ...(/^[1-9]\d{0,9}$/u.test(apiId) ? [] : ['telegram_user_api_id is not an API id']),
    ...(/^[0-9a-f]{32}$/u.test(apiHash) ? [] : ['telegram_user_api_hash is not 32 hex digits']),
    ...(session === '' ? ['telegram_user_session is empty'] : []),
  ];
  if (problems.length > 0) throw new Error(problems.join('; '));
  return { apiId: Number(apiId), apiHash, session };
}

/**
 * The `telegram-user` plugin, on its node's account (`telegram:<name>`; `telegram:owner`, or
 * `telegram:<self>`, until a node names one); `client` makes the GramJS client from the
 * credentials (tests pass a fake).
 */
export function telegramUserPlugin(
  o: {
    self?: string;
    client?: (credentials: UserCredentials) => GramClient;
  } = {}
): Plugin {
  const account = `telegram:${o.self ?? 'owner'}`;
  const make = o.client ?? ((c: UserCredentials): GramClient => createTelegramClient(c));
  return definePlugin({
    manifest: {
      id: TELEGRAM_USER,
      version: '0.1.0',
      kinds: ['connector'],
      description: "The owner's own Telegram account: the chats it monitors",
      account,
      config: telegramUserConfig,
      // The chats its config lists; unset, every chat (D89). A chat goes by its id and its
      // @username, which its connector tells apart (D90).
      monitors: { config: 'chats', aliases: true },
      secrets: [...USER_SECRETS],
    },
    create: (ctx) => {
      const connector = new TelegramUserConnector({
        account: ctx.account ?? account,
        client: make(userCredentials((name) => ctx.secrets?.get(name) ?? '')),
        chats: (ctx.config as TelegramUserConfig).chats,
        clock: ctx.clock,
        log: (line) => ctx.log.info(line),
        notify: (text) => ctx.notify(text),
        warn: (line) => ctx.log.warn(line),
        record: (type, fields) => ctx.record(type, fields),
        store: ctx.store,
        readers: () => ctx.readers?.() ?? [],
        liveGraceMs: (ctx.config as TelegramUserConfig).liveGraceS * 1000,
      });
      const config = ctx.config as TelegramUserConfig;
      connector.limits = {
        commandIntervalMs: config.commandIntervalS * 1000,
        unansweredAt: config.unansweredAt,
        ...(config.unansweredAtBy === undefined ? {} : { unansweredAtBy: config.unansweredAtBy }),
      };
      return { connector, start: () => connector.start(), stop: () => connector.stop() };
    },
  });
}
