/**
 * A `telegram-bot` connector's login from its node (docs/bot-os.md D116, #11): the token @BotFather
 * gives, pasted in its node's panel, checked with Telegram (`getMe`: "connected as @ExampleBot")
 * and kept in the connector's store (`login`), which the next start reads before the
 * `telegram_bot_token` Docker secret. Forgetting it drops it from the store; revoking it is
 * @BotFather's (`/revoke`). The token is marked secret as soon as it is typed (`remember`), so that
 * the core redacts it from whatever it prints, records or answers.
 */
import {
  type Clock,
  type Login,
  type LoginAction,
  type LoginState,
  type Store,
} from '@megabottron1999/core';
import { GrammyError } from 'grammy';

/** The store's document of the login: the bot's token. */
export const BOT_LOGIN_DOC = 'login';
export interface BotLoginDoc {
  token: string;
}

/** What a token looks like: the bot's id, a colon, and its secret. */
const TOKEN = /^\d+:[\w-]{20,}$/u;
/** How long Telegram has to say who a token's bot is. */
export const CHECK_MS = 20_000;

export interface BotLoginOptions {
  store: Store;
  clock: Clock;
  /** Where its token came from at the start: undefined, it needs a login. */
  source: 'store' | 'secrets' | undefined;
  /** The `telegram_bot_token` secret is provided: its fallback. */
  secrets: boolean;
  /** Whom the running connector is, once connected. */
  self: () => string | undefined;
  /** Asks Telegram who a token's bot is (`getMe`); rejects for a token it refuses. */
  check: (token: string) => Promise<{ username?: string | undefined }>;
  /** Marks a value secret, to be redacted (`ctx.secrets.remember`). */
  remember: (value: string) => void;
  log: (line: string) => void;
}

const CANCEL: LoginAction = { name: 'cancel', label: 'Cancel' };

/** The login of a `telegram-bot` connector (`Instance.login`). */
export class BotLogin implements Login {
  private readonly o: BotLoginOptions;
  private source: 'store' | 'secrets' | undefined;
  private as: string | undefined;
  private changed = false;
  /** The owner asked to paste a token though it has one. */
  private replacing = false;
  private error: string | undefined;

  constructor(o: BotLoginOptions) {
    this.o = o;
    this.source = o.source;
    const kept = o.store.read<BotLoginDoc>(BOT_LOGIN_DOC)?.token;
    if (kept !== undefined) o.remember(kept);
  }

  state(): LoginState {
    const base = {
      ...(this.source === undefined ? {} : { source: this.source }),
      ...(this.changed ? { restart: true } : {}),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
    const as = this.changed ? this.as : (this.as ?? this.o.self());
    const who = as === undefined ? {} : { as: as.startsWith('@') ? as : `@${as}` };
    if (this.source === undefined || this.replacing)
      return {
        status: 'needed',
        ...base,
        ...who,
        step: {
          title: 'The bot’s token',
          text: 'In Telegram, open @BotFather: /newbot makes a bot, /token gives an existing one’s token. Paste it here: it is checked with Telegram, then kept in this connector’s store.',
          link: { href: 'https://t.me/BotFather', label: '@BotFather' },
          fields: [{ name: 'token', label: 'Token', secret: true, placeholder: '123456789:AA…' }],
        },
        actions: [
          { name: 'token', label: 'Check and save', submit: true, primary: true },
          ...(this.replacing ? [CANCEL] : []),
        ],
      };
    const note =
      this.source === 'secrets'
        ? this.changed
          ? 'Its token is forgotten: at the restart it uses the telegram_bot_token Docker secret again, unless a token is pasted here.'
          : 'Its token is the telegram_bot_token Docker secret. A token pasted here takes its place; the secret stays a fallback.'
        : this.changed
          ? 'Restart to connect with it.'
          : undefined;
    return {
      status: 'done',
      ...base,
      ...who,
      ...(note === undefined ? {} : { note }),
      actions: [
        {
          name: 'replace',
          label: this.source === 'secrets' ? 'Paste a token' : 'Use another token',
        },
        ...(this.source === 'store'
          ? [
              {
                name: 'logout',
                label: 'Forget the token',
                confirm:
                  'Forget the bot’s token? The connector stops at the restart until a token is pasted again (or uses its Docker secret, if there is one). To revoke the token itself, send /revoke to @BotFather.',
              },
            ]
          : []),
      ],
    };
  }

  async act(action: string, values: Readonly<Record<string, string>>): Promise<LoginState> {
    this.error = undefined;
    switch (action) {
      case 'replace':
        this.replacing = true;
        return this.state();
      case 'cancel':
        this.replacing = false;
        return this.state();
      case 'token':
        if (this.source !== undefined && !this.replacing)
          throw new Error('the login does not ask for a token now');
        return this.token((values['token'] ?? '').trim());
      case 'logout':
        if (this.source !== 'store') throw new Error('the login does not offer logout now');
        this.o.store.remove(BOT_LOGIN_DOC);
        this.source = this.o.secrets ? 'secrets' : undefined;
        this.as = undefined;
        this.changed = true;
        this.o.log('its token is forgotten');
        return this.state();
      default:
        throw new Error(`the login does not offer ${action} now`);
    }
  }

  private async token(token: string): Promise<LoginState> {
    this.o.remember(token);
    if (!TOKEN.test(token)) {
      this.error = 'not a bot token: @BotFather gives one as 123456789:AA…';
      return this.state();
    }
    let me: { username?: string | undefined };
    try {
      me = await new Promise((resolve, reject) => {
        const timer = this.o.clock.setTimeout(
          () => reject(new Error('no answer from Telegram')),
          CHECK_MS
        );
        this.o.check(token).then(
          (r) => (this.o.clock.clearTimeout(timer), resolve(r)),
          (e: unknown) => (this.o.clock.clearTimeout(timer), reject(e as Error))
        );
      });
    } catch (e) {
      this.error = `Telegram refused it: ${e instanceof GrammyError ? e.description : e instanceof Error ? e.message : String(e)}`;
      return this.state();
    }
    this.o.store.write(BOT_LOGIN_DOC, { token } satisfies BotLoginDoc);
    this.source = 'store';
    this.as = me.username;
    this.changed = true;
    this.replacing = false;
    this.o.log(`its token is kept: connected as @${me.username ?? '?'}; a restart connects it`);
    return this.state();
  }
}
