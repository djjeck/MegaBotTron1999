/**
 * A `telegram-user` connector's login from its node (docs/bot-os.md D116, #11): the owner's API id
 * and hash, entered once, then a login by QR code (scanned in Telegram's Settings → Devices → Link
 * Desktop Device) or by phone (the number, the code Telegram sends, the 2FA password if set). The
 * session string it gives is kept in the connector's store (`login`, beside the API pair), which
 * the next start reads: their only place, no Docker secret (D118). A logout ends the session on
 * Telegram's side too.
 *
 * GramJS drives a login through callbacks that it awaits (`signInUser`, `signInUserWithQrCode`);
 * here each callback is a question left open (`Attempt`) until the owner's answer comes through
 * the control API. One login at a time, dropped after `LOGIN_TIMEOUT_MS` without an answer. Nothing
 * typed is logged or kept but the session and the API pair; every value typed is marked secret
 * (`remember`), so that the core redacts it from whatever it prints, records or answers.
 */
import {
  type Clock,
  type Login,
  type LoginAction,
  type LoginState,
  type LoginStep,
  type Store,
  type TimerHandle,
} from '@megabottron1999/core';
import {
  type ApiCredentials,
  type QrCodeAuthParams,
  type UserAuthParams,
} from 'telegram/client/auth.js';
import { StringSession } from 'telegram/sessions/index.js';

/** The store's document of the login: the API pair, and the session once logged in. */
export const LOGIN_DOC = 'login';
export interface LoginDoc {
  apiId: number;
  apiHash: string;
  session?: string;
}

/** How long a login waits for an answer before it is dropped. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** How long an answer waits for what the login asks next before it says where it stands. */
export const SETTLE_MS = 15_000;

/** The part of GramJS's `TelegramClient` a login uses; tests pass a fake. */
export interface UserLoginClient {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  signInUser(api: ApiCredentials, params: UserAuthParams): Promise<unknown>;
  signInUserWithQrCode(api: ApiCredentials, params: QrCodeAuthParams): Promise<unknown>;
}

/** What a login asks now. */
type Asked =
  | { kind: 'working' }
  | { kind: 'number' }
  | { kind: 'code'; viaApp: boolean }
  | { kind: 'password'; hint?: string }
  | { kind: 'qr'; url: string; expires: number };

/** The name Telegram shows of a user: `@username`, else their first name. */
export function userName(user: unknown): string | undefined {
  if (typeof user !== 'object' || user === null) return undefined;
  const { username, firstName } = user as { username?: unknown; firstName?: unknown };
  if (typeof username === 'string' && username !== '') return `@${username}`;
  return typeof firstName === 'string' && firstName !== '' ? firstName : undefined;
}

/** A Telegram refusal in words: its RPC error's name (`PHONE_CODE_INVALID`), else its message. */
export function refusal(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'errorMessage' in e) {
    const name = (e as { errorMessage: unknown }).errorMessage;
    if (typeof name === 'string') return `Telegram refused it: ${name}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** One login under way: GramJS's questions, each left open until answered. */
class Attempt {
  asked: Asked = { kind: 'working' };
  error: string | undefined;
  /** Over: logged in, failed or dropped. */
  over = false;
  private open: { kind: Asked['kind']; resolve(v: string): void } | undefined;
  private waiters: (() => void)[] = [];

  /** GramJS asks: the question stays open until `answer`. */
  ask(asked: Asked): Promise<string> {
    if (this.over) return Promise.reject(new Error('AUTH_USER_CANCEL'));
    return new Promise((resolve) => {
      this.open = { kind: asked.kind, resolve };
      this.set(asked);
    });
  }

  /** The owner's answer to the open question of that kind; false if none is open. */
  answer(kind: Asked['kind'], value: string): boolean {
    if (this.open?.kind !== kind) return false;
    const { resolve } = this.open;
    this.open = undefined;
    this.error = undefined;
    this.set({ kind: 'working' });
    resolve(value);
    return true;
  }

  /** A change: the QR code renewed, a question asked, an error, the end. */
  set(asked?: Asked): void {
    if (asked !== undefined) this.asked = asked;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Resolves at the next change, or after `ms`. */
  next(clock: Clock, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = clock.setTimeout(() => resolve(), ms);
      this.waiters.push(() => {
        clock.clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Dropped: the open question is answered empty, and every later one refused. */
  end(): void {
    this.over = true;
    const open = this.open;
    this.open = undefined;
    open?.resolve('');
    this.set();
  }
}

export interface UserLoginOptions {
  store: Store;
  clock: Clock;
  /** Where its credentials came from at the start: undefined, it needs a login. */
  source: 'store' | undefined;
  /** Whom the running connector is logged in as. */
  self: () => string | undefined;
  /** A client to log in with, on the session given (GramJS's, in the image). */
  client: (api: ApiCredentials, session: StringSession) => UserLoginClient;
  /** Ends the running connector's session on Telegram and stops it. */
  logOut?: () => Promise<void>;
  /** Marks a value secret, to be redacted (`ctx.secrets.remember`). */
  remember: (value: string) => void;
  log: (line: string) => void;
}

const MY_TELEGRAM = { href: 'https://my.telegram.org', label: 'my.telegram.org' };
const CANCEL: LoginAction = { name: 'cancel', label: 'Cancel' };

/** The login of a `telegram-user` connector (`Instance.login`). */
export class UserLogin implements Login {
  private readonly o: UserLoginOptions;
  /** Where its credentials are now: changed by a login or a logout since the start. */
  private source: 'store' | undefined;
  private as: string | undefined;
  private changed = false;
  /** The owner asked to type the API pair again. */
  private retyping = false;
  private attempt: Attempt | undefined;
  private client: UserLoginClient | undefined;
  private timer: TimerHandle | undefined;
  private error: string | undefined;

  constructor(o: UserLoginOptions) {
    this.o = o;
    this.source = o.source;
    const doc = this.doc();
    if (doc !== undefined) o.remember(doc.apiHash);
    if (doc?.session !== undefined) o.remember(doc.session);
  }

  private doc(): LoginDoc | undefined {
    return this.o.store.read<LoginDoc>(LOGIN_DOC);
  }

  /** The API pair a login uses: the store's, unless the owner types it again. */
  private api(): ApiCredentials | undefined {
    const doc = this.doc();
    return doc === undefined || this.retyping
      ? undefined
      : { apiId: doc.apiId, apiHash: doc.apiHash };
  }

  state(): LoginState {
    const error = this.attempt?.error ?? this.error;
    const base = {
      ...(this.source === undefined ? {} : { source: this.source }),
      ...(this.changed ? { restart: true } : {}),
      ...(error === undefined ? {} : { error }),
    };
    if (this.attempt !== undefined) {
      const step = this.stepOf(this.attempt.asked);
      return {
        status: 'pending',
        ...base,
        ...(step === undefined ? { note: 'Waiting for Telegram…' } : { step: step.step }),
        actions: [...(step?.actions ?? []), CANCEL],
      };
    }
    const as = this.changed ? this.as : (this.as ?? this.o.self());
    const who = as === undefined ? {} : { as };
    if (this.source !== undefined)
      return {
        status: 'done',
        ...base,
        ...who,
        ...(this.changed ? { note: 'Restart to connect with it.' } : {}),
        actions:
          this.changed || this.o.logOut === undefined
            ? []
            : [
                {
                  name: 'logout',
                  label: 'Log out',
                  confirm:
                    'Log out? The session ends on Telegram too, and the connector stops until it logs in again.',
                },
              ],
      };
    const back = this.retyping ? [CANCEL] : [];
    if (this.api() === undefined)
      return {
        status: 'needed',
        ...base,
        step: {
          title: 'Your app’s API id and hash',
          text: 'Telegram gives each app its own pair: log in at my.telegram.org with your phone number, open API development tools, create an app (any title and short name), and copy its App api_id and App api_hash here. They are kept in this connector’s store. The project cannot ship a pair of its own: one published in a public repository gets banned.',
          link: MY_TELEGRAM,
          fields: [
            { name: 'apiId', label: 'App api_id', placeholder: '1234567' },
            { name: 'apiHash', label: 'App api_hash', secret: true },
          ],
        },
        actions: [{ name: 'api', label: 'Save', submit: true, primary: true }, ...back],
      };
    return {
      status: 'needed',
      ...base,
      step: {
        title: 'Log in to Telegram',
        text: 'Scan a QR code with Telegram on your phone (first choice), or log in with your phone number, the code Telegram sends and your 2FA password if you set one. The session shows in Telegram’s Settings → Devices, where it can be ended.',
        fields: [],
      },
      actions: [
        { name: 'qr', label: 'Log in with a QR code', primary: true },
        { name: 'phone', label: 'Log in with the phone number' },
        { name: 'retype', label: 'Change the API id and hash' },
        ...back,
      ],
    };
  }

  /** The step and its actions for what the login asks; undefined while it waits on Telegram. */
  private stepOf(asked: Asked): { step: LoginStep; actions: LoginAction[] } | undefined {
    const submit = (name: string, label: string): LoginAction[] => [
      { name, label, submit: true, primary: true },
    ];
    switch (asked.kind) {
      case 'working':
        return undefined;
      case 'qr':
        return {
          step: {
            title: 'Scan the QR code',
            text: 'On your phone, open Telegram → Settings → Devices → Link Desktop Device, and scan this code. It renews itself until it is scanned.',
            qr: asked.url,
            expires: asked.expires,
            fields: [],
          },
          actions: [],
        };
      case 'number':
        return {
          step: {
            title: 'Your phone number',
            text: 'The account’s number, international, with its + and country code.',
            fields: [{ name: 'number', label: 'Phone number', placeholder: '+1 555 0100' }],
          },
          actions: submit('number', 'Send me the code'),
        };
      case 'code':
        return {
          step: {
            title: 'The code',
            text: asked.viaApp
              ? 'Telegram sent a code to your Telegram app, in the chat with Telegram.'
              : 'Telegram sent a code by SMS.',
            fields: [{ name: 'code', label: 'Code', placeholder: '12345' }],
          },
          actions: submit('code', 'Log in'),
        };
      case 'password':
        return {
          step: {
            title: 'Your 2FA password',
            text: `The account has a cloud password (two-step verification)${asked.hint === undefined || asked.hint === '' ? '' : `; its hint: ${asked.hint}`}.`,
            fields: [{ name: 'password', label: 'Password', secret: true }],
          },
          actions: submit('password', 'Log in'),
        };
    }
  }

  async act(action: string, values: Readonly<Record<string, string>>): Promise<LoginState> {
    for (const v of Object.values(values)) if (v.trim().length >= 6) this.o.remember(v.trim());
    const value = (name: string): string => (values[name] ?? '').trim();
    const attempt = this.attempt;
    this.error = undefined;
    if (attempt !== undefined) {
      if (action === 'cancel') {
        await this.drop();
        return this.state();
      }
      const kind = action as Asked['kind'];
      if (!['number', 'code', 'password'].includes(action) || !attempt.answer(kind, value(action)))
        throw new Error(`the login does not ask for ${action} now`);
      this.arm();
      await attempt.next(this.o.clock, SETTLE_MS);
      return this.state();
    }
    switch (action) {
      case 'cancel':
        this.retyping = false;
        return this.state();
      case 'retype':
        this.retyping = true;
        return this.state();
      case 'api':
        return this.saveApi(value('apiId'), value('apiHash').toLowerCase());
      case 'qr':
      case 'phone': {
        const api = this.api();
        if (api === undefined || this.source !== undefined)
          throw new Error(`the login does not offer ${action} now`);
        return this.begin(api, action);
      }
      case 'logout':
        return this.logout();
      default:
        throw new Error(`the login does not offer ${action} now`);
    }
  }

  private saveApi(apiId: string, apiHash: string): LoginState {
    const problems = [
      ...(/^[1-9]\d{0,9}$/u.test(apiId) ? [] : ['the api_id is a number']),
      ...(/^[0-9a-f]{32}$/u.test(apiHash) ? [] : ['the api_hash is 32 hex digits']),
    ];
    if (problems.length > 0) {
      this.error = problems.join('; ');
      return this.state();
    }
    const doc = this.doc();
    // A new pair makes the session it had another app's: a session from the store goes with it.
    this.o.store.write(LOGIN_DOC, { apiId: Number(apiId), apiHash });
    if (doc?.session !== undefined && this.source === 'store') {
      this.source = undefined;
      this.changed = true;
    }
    this.retyping = false;
    this.o.log('the API id and hash are kept');
    return this.state();
  }

  /** A login begins: by QR code or by phone, on a client of its own. */
  private async begin(api: ApiCredentials, method: 'qr' | 'phone'): Promise<LoginState> {
    const attempt = new Attempt();
    const session = new StringSession('');
    const client = this.o.client(api, session);
    this.attempt = attempt;
    this.client = client;
    this.arm();
    // A refusal GramJS asks again after (a wrong code): kept, for the question it asks next.
    const onError = (e: Error): Promise<boolean> => {
      attempt.error = refusal(e);
      return Promise.resolve(attempt.over);
    };
    const password = (hint?: string): Promise<string> =>
      attempt.ask({ kind: 'password', ...(hint === undefined ? {} : { hint }) });
    const run = async (): Promise<unknown> => {
      await client.connect();
      return method === 'qr'
        ? client.signInUserWithQrCode(api, {
            qrCode: ({ token, expires }) => {
              attempt.set({
                kind: 'qr',
                url: `tg://login?token=${token.toString('base64url')}`,
                expires: expires * 1000,
              });
              return Promise.resolve();
            },
            password,
            onError,
          })
        : client.signInUser(api, {
            phoneNumber: () => attempt.ask({ kind: 'number' }),
            phoneCode: (viaApp) => attempt.ask({ kind: 'code', viaApp: viaApp === true }),
            password,
            onError,
          });
    };
    run().then(
      (user) => {
        if (attempt.over) return;
        const saved = session.save();
        this.o.remember(saved);
        this.o.store.write(LOGIN_DOC, { ...api, session: saved });
        this.source = 'store';
        this.as = userName(user);
        this.changed = true;
        this.o.log(`logged in as ${this.as ?? 'the account'}; a restart connects it`);
        void this.finish(attempt, undefined);
      },
      (e: unknown) => {
        if (attempt.over) return;
        void this.finish(attempt, attempt.error ?? refusal(e));
      }
    );
    await attempt.next(this.o.clock, SETTLE_MS);
    return this.state();
  }

  /** The login over, logged in or not: its client disconnected, its error kept. */
  private async finish(attempt: Attempt, error: string | undefined): Promise<void> {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    this.error = error;
    this.o.clock.clearTimeout(this.timer);
    const client = this.client;
    this.client = undefined;
    attempt.end();
    try {
      await client?.disconnect();
    } catch {
      // Gone already.
    }
  }

  /** The login under way dropped (cancelled, timed out, the node stopping). */
  async drop(error?: string): Promise<void> {
    const attempt = this.attempt;
    if (attempt === undefined) return;
    await this.finish(attempt, error);
  }

  /** The login is dropped after `LOGIN_TIMEOUT_MS` without an answer. */
  private arm(): void {
    this.o.clock.clearTimeout(this.timer);
    const attempt = this.attempt;
    this.timer = this.o.clock.setTimeout(() => {
      if (this.attempt === attempt) void this.drop('the login timed out: start it again');
    }, LOGIN_TIMEOUT_MS);
  }

  private async logout(): Promise<LoginState> {
    if (this.source !== 'store' || this.changed || this.o.logOut === undefined)
      throw new Error('the login does not offer logout now');
    try {
      await this.o.logOut();
    } catch (e) {
      this.error = `the logout failed: ${refusal(e)}`;
      return this.state();
    }
    const doc = this.doc();
    if (doc !== undefined)
      this.o.store.write(LOGIN_DOC, { apiId: doc.apiId, apiHash: doc.apiHash });
    this.source = undefined;
    this.as = undefined;
    this.changed = true;
    this.o.log('logged out: the session is ended');
    return this.state();
  }
}
