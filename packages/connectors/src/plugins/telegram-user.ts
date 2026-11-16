/**
 * The `telegram-user` connector plugin (docs/bot-os-api.md §4.5): the owner's own Telegram
 * account, on GramJS (packages/connectors/src/transport/telegram-user.ts). Its API id, API hash and
 * session string come from a login in its node's panel (bot-os.md D116, D118, `user-login.ts`: by
 * QR code or by phone), kept in its store, never Docker secrets; without them it runs needing a
 * login (`LoginNeeded`). Other plugins get a
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
 * The `telegram-user` plugin, on its node's account (`telegram:<node id>`, D119; its manifest's
 * `telegram:owner` only in the programmatic wiring); `client` makes the GramJS client from the
 * credentials (tests pass a fake).
 */
export function telegramUserPlugin(
  o: {
    client?: (credentials: UserCredentials) => GramClient;
    /** Makes the client a login from its node uses (tests pass a fake). */
    loginClient?: (
      api: Omit<UserCredentials, 'session'>,
      session: StringSession
    ) => UserLoginClient;
  } = {}
): Plugin {
  const account = 'telegram:owner';
  const make = o.client ?? ((c: UserCredentials): GramClient => createTelegramClient(c));
  const makeLogin =
    o.loginClient ??
    ((api: Omit<UserCredentials, 'session'>, session: StringSession): UserLoginClient =>
      createTelegramClient({ ...api, session: '' }, session));
  // The account each of its nodes is logged in as, by node (D121): one is refused on a second node.
  const held = new Map<string, string>();
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
      // Its credentials from a login in its node's panel, kept in its store (D116, D118).
      login: true,
    },
    create: (ctx) => {
      // Its credentials, sealed at rest under bot_os_key (D123).
      const store = ctx.secrets?.store ?? ctx.store;
      const kept = store.read<LoginDoc>(LOGIN_DOC);
      const credentials: UserCredentials | undefined =
        kept?.session === undefined
          ? undefined
          : { apiId: kept.apiId, apiHash: kept.apiHash, session: kept.session };
      if (credentials !== undefined && kept?.user !== undefined) held.set(ctx.id, kept.user);
      const log = (line: string): void => ctx.log.info(line);
      const loginOf = (c?: TelegramUserConnector): UserLogin =>
        new UserLogin({
          store,
          clock: ctx.clock,
          source: credentials === undefined ? undefined : 'store',
          self: () => c?.self(),
          client: makeLogin,
          taken: (user) => [...held].find(([node, u]) => node !== ctx.id && u === user)?.[0],
          claim: (user) => (user === undefined ? held.delete(ctx.id) : held.set(ctx.id, user)),
          ...(c === undefined ? {} : { logOut: () => c.logOut() }),
          remember: (value) => ctx.secrets?.remember(value),
          log,
        });
      if (credentials === undefined) {
        const login = loginOf();
        return {
          connector: new LoginNeeded(ctx.account ?? account, 'telegram'),
          login,
          stop: () => (held.delete(ctx.id), login.drop()),
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
          held.delete(ctx.id);
          await login.drop();
          await connector.stop();
        },
      };
    },
  });
}
