/**
 * The `telegram-user` connector plugin (docs/bot-os-api.md §4.5): the owner's own Telegram
 * account, on GramJS (packages/connectors/src/transport/telegram-user.ts). Its API id, API hash and
 * session string come from a login in its node's panel (bot-os.md D116, `user-login.ts`: by QR code
 * or by phone), kept in its store, or else from Docker secrets (P9), which it alone receives;
 * without either it runs needing a login (`LoginNeeded`). Other plugins get a
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
  LoginNeeded,
  type Plugin,
  unansweredAt,
  unansweredAtBy,
} from '@megabottron1999/core';
import { type StringSession } from 'telegram/sessions/index.js';
import { z } from 'zod';
import {
  createTelegramClient,
  type GramClient,
  TelegramUserConnector,
  type UserCredentials,
} from '#src/transport/telegram-user.ts';
import {
  LOGIN_DOC,
  type LoginDoc,
  UserLogin,
  type UserLoginClient,
} from '#src/transport/user-login.ts';

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
    .array(z.string().min(1))
    .optional()
    .describe('The chats it monitors, picked among its chats; unset: every chat'),
  commandIntervalS,
  unansweredAt,
  unansweredAtBy,
  liveGraceS,
});
export type TelegramUserConfig = z.infer<typeof telegramUserConfig>;

/**
 * What is wrong with an API id and hash (my.telegram.org's `api_id` and `api_hash`), each named as
 * `names` says; none for a pair that looks right.
 */
export function apiProblems(
  apiId: string,
  apiHash: string,
  names: { id: string; hash: string } = {
    id: 'telegram_user_api_id',
    hash: 'telegram_user_api_hash',
  }
): string[] {
  return [
    ...(/^[1-9]\d{0,9}$/u.test(apiId) ? [] : [`${names.id} is not an API id`]),
    ...(/^[0-9a-f]{32}$/u.test(apiHash) ? [] : [`${names.hash} is not 32 hex digits`]),
  ];
}

/** the owner's credentials from the three secrets, or why they are not credentials. */
export function userCredentials(
  get: (name: (typeof USER_SECRETS)[number]) => string
): UserCredentials {
  const apiId = get('telegram_user_api_id');
  const apiHash = get('telegram_user_api_hash');
  const session = get('telegram_user_session');
  const problems = [
    ...apiProblems(apiId, apiHash),
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
    /** Makes the client a login from its node uses (tests pass a fake). */
    loginClient?: (
      api: Omit<UserCredentials, 'session'>,
      session: StringSession
    ) => UserLoginClient;
  } = {}
): Plugin {
  const account = `telegram:${o.self ?? 'owner'}`;
  const make = o.client ?? ((c: UserCredentials): GramClient => createTelegramClient(c));
  const makeLogin =
    o.loginClient ??
    ((api: Omit<UserCredentials, 'session'>, session: StringSession): UserLoginClient =>
      createTelegramClient({ ...api, session: '' }, session));
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
      // Its credentials from a login in its node's panel, its secrets a fallback (D116).
      login: true,
    },
    create: (ctx) => {
      const secrets = ctx.secrets;
      const has = USER_SECRETS.every((name) => secrets?.has(name) === true);
      const fromSecrets = has ? userCredentials((name) => secrets?.get(name) ?? '') : undefined;
      const kept = ctx.store.read<LoginDoc>(LOGIN_DOC);
      const credentials: UserCredentials | undefined =
        kept?.session === undefined ? fromSecrets : { ...kept, session: kept.session };
      // The secrets' API pair, when they hold one, spares typing it in.
      const secretApi =
        secrets?.has('telegram_user_api_id') === true &&
        secrets.has('telegram_user_api_hash') &&
        apiProblems(secrets.get('telegram_user_api_id'), secrets.get('telegram_user_api_hash'))
          .length === 0
          ? {
              apiId: Number(secrets.get('telegram_user_api_id')),
              apiHash: secrets.get('telegram_user_api_hash'),
            }
          : undefined;
      const log = (line: string): void => ctx.log.info(line);
      const loginOf = (c?: TelegramUserConnector): UserLogin =>
        new UserLogin({
          store: ctx.store,
          clock: ctx.clock,
          source:
            credentials === undefined
              ? undefined
              : kept?.session === undefined
                ? 'secrets'
                : 'store',
          secrets: has,
          secretApi,
          self: () => c?.self(),
          client: makeLogin,
          ...(c === undefined ? {} : { logOut: () => c.logOut() }),
          remember: (value) => secrets?.remember(value),
          log,
        });
      if (credentials === undefined) {
        const login = loginOf();
        return {
          connector: new LoginNeeded(ctx.account ?? account, 'telegram'),
          login,
          stop: () => login.drop(),
        };
      }
      const connector = new TelegramUserConnector({
        account: ctx.account ?? account,
        client: make(credentials),
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
      const login = loginOf(connector);
      return {
        connector,
        login,
        start: () => connector.start(),
        stop: async () => {
          await login.drop();
          await connector.stop();
        },
      };
    },
  });
}
