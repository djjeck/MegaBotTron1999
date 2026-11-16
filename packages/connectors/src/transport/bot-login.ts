/**
 * A `telegram-bot` connector's login from its node (docs/bot-os.md D116, #11): the token @BotFather
 * gives, pasted in its node's panel, checked with Telegram (`getMe`: "connected as @ExampleBot")
 * and kept in the connector's store (`login`), which the next start reads: its only place, no
 * Docker secret (D118). Forgetting it drops it from the store; revoking it is
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

/** The store's document of the login: the bot's token, and whom it is (`@ExampleBot`, D120). */
export const BOT_LOGIN_DOC = 'login';
export interface BotLoginDoc {
  token: string;
  as?: string;
}

/** What a token looks like: the bot's id, a colon, and its secret. */
const TOKEN = /^\d+:[\w-]{20,}$/u;
/** How long Telegram has to say who a token's bot is. */
export const CHECK_MS = 20_000;

export interface BotLoginOptions {
  store: Store;
  clock: Clock;
  /** Where its token came from at the start: undefined, it needs a login. */
  source: 'store' | undefined;
  /** Whom the running connector is, once connected. */
  self: () => string | undefined;
  /**
   * The node of the same plugin that holds the bot of this id already, if any (D121): two nodes
   * polling one bot's token conflict on Telegram.
   */
  taken?: (bot: string) => string | undefined;
  /** This node holds the bot of this id now, or none (`undefined`, its token forgotten). */
  claim?: (bot: string | undefined) => void;
  /** Asks Telegram who a token's bot is (`getMe`); rejects for a token it refuses. */
  check: (token: string) => Promise<{ username?: string | undefined }>;
  /** Marks a value secret, to be redacted (`ctx.secrets.remember`). */
  remember: (value: string) => void;
  log: (line: string) => void;
}

/** The bot's id, the part of its token before the colon: what tells two tokens of one bot. */
export const botOf = (token: string): string => token.slice(0, token.indexOf(':'));

const CANCEL: LoginAction = { name: 'cancel', label: 'Cancel' };

/** The login of a `telegram-bot` connector (`Instance.login`). */
export class BotLogin implements Login {
  private readonly o: BotLoginOptions;
  private source: 'store' | undefined;
  private as: string | undefined;
  private changed = false;
  /** The owner asked to paste a token though it has one. */
  private replacing = false;
  private error: string | undefined;

  constructor(o: BotLoginOptions) {
    this.o = o;
    this.source = o.source;
    const kept = o.store.read<BotLoginDoc>(BOT_LOGIN_DOC);
    if (kept !== undefined) o.remember(kept.token);
    this.as = kept?.as;
  }

  state(): LoginState {
    const base = {
      ...(this.source === undefined ? {} : { source: this.source }),
      ...(this.changed ? { restart: true } : {}),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
    // Whom it is: the running bot's name, else the one its login kept (D120).
    const live = this.changed ? undefined : this.o.self();
    const as = live ?? this.as;
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
    const note = this.changed ? 'Restart to connect with it.' : undefined;
    return {
      status: 'done',
      ...base,
      ...who,
      ...(note === undefined ? {} : { note }),
      actions: [
        { name: 'replace', label: 'Use another token' },
        {
          name: 'logout',
          label: 'Forget the token',
          confirm:
            'Forget the bot’s token? The connector stops at the restart until a token is pasted again. To revoke the token itself, send /revoke to @BotFather.',
        },
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
        this.o.claim?.(undefined);
        this.source = undefined;
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
    const bot = botOf(token);
    const other = this.o.taken?.(bot);
    if (other !== undefined) {
      this.error = `this bot’s token is used by the node ${other} already: two connectors polling one bot conflict on Telegram. Forget the token there first, or make another bot with @BotFather.`;
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
    this.as = me.username === undefined ? undefined : `@${me.username}`;
    this.o.store.write(BOT_LOGIN_DOC, {
      token,
      ...(this.as === undefined ? {} : { as: this.as }),
    } satisfies BotLoginDoc);
    this.o.claim?.(bot);
    this.source = 'store';
    this.changed = true;
    this.replacing = false;
    this.o.log(`its token is kept: connected as @${me.username ?? '?'}; a restart connects it`);
    return this.state();
  }
}
