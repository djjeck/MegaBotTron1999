/**
 * A connector's login from its node (docs/bot-os-api.md §4.5, bot-os.md D116, #11): a connector
 * whose manifest says `login` keeps its credentials in its own store, from a login the owner does
 * in its node's panel, its Docker secrets a fallback. It runs without either, as a connector that
 * needs a login (`LoginNeeded`), so that a new one can be added, applied and logged in.
 *
 * The login itself is the connector's (a bot's token, a user's QR code or phone, …); the core and
 * the web UI know only what it asks next (`LoginState`), drawn generically: a step's title, its
 * how-to and link, a QR code to scan, its fields and the actions offered. The control API serves
 * it (`GET` and `POST /plugins/<id>/login`), behind the web UI's login like the rest of it.
 */
import { type Connector, ConnectorBase, type Surface } from './connector.ts';

/** The phase of a connector that needs a login, which its card shows. */
export const NEEDS_LOGIN = 'needs login';

/** A field of a login step, a line of text. */
export interface LoginField {
  name: string;
  label: string;
  /** Typed unseen, never shown back (a password, a token). */
  secret?: boolean;
  /** An example of what goes there. */
  placeholder?: string;
}

/** A button: an action of the login, with the step's fields (`submit`) or alone. */
export interface LoginAction {
  name: string;
  label: string;
  /** Sends the step's fields with it. */
  submit?: boolean;
  /** The one to press: drawn first and marked. */
  primary?: boolean;
  /** Asked before it runs (a logout): the question. */
  confirm?: string;
}

/** What the login asks now. */
export interface LoginStep {
  title: string;
  /** A short how-to. */
  text?: string;
  /** Where to go for what it asks (my.telegram.org). */
  link?: { href: string; label: string };
  /** A link to show as a QR code, for a phone to scan; it changes as it expires. */
  qr?: string;
  /** When the QR code expires, in ms. */
  expires?: number;
  fields: LoginField[];
}

/** Where a connector's login stands. */
export interface LoginState {
  /** `needed`: no credentials; `pending`: a login under way; `done`: it has credentials. */
  status: 'needed' | 'pending' | 'done';
  /** Where its credentials come from: its store (a login from its node) or its Docker secrets. */
  source?: 'store' | 'secrets';
  /** Whom it is logged in as, where it knows (`@ExampleBot`). */
  as?: string;
  /**
   * Its credentials changed since it started (a login, a logout): a restart puts them in force.
   */
  restart?: boolean;
  /** A line on where it stands (its credentials are the Docker secrets). */
  note?: string;
  /** What it asks now, if anything. */
  step?: LoginStep;
  /** Why the last answer failed, or the login ended; the step asks again where it can. */
  error?: string;
  /** What the owner may do from here. */
  actions: LoginAction[];
}

/** A connector's login, offered by its instance (`Instance.login`). */
export interface Login {
  /** Where it stands now. */
  state(): LoginState;
  /**
   * An action it offers (`LoginState.actions`), with the step's fields as `values`; where it stands
   * next. A refusal of an answer is in the state's `error`, not thrown; it throws for an action it
   * does not offer now.
   */
  act(action: string, values: Readonly<Record<string, string>>): Promise<LoginState>;
}

/**
 * The connector of a node that needs a login: closed, its phase `needs login`, it hears nothing,
 * sends nothing and lists no chat, until a login and a restart give it credentials.
 */
export class LoginNeeded extends ConnectorBase implements Connector {
  constructor(account: string, network: string) {
    super(account, network);
    this.changed({ state: 'closed', phase: NEEDS_LOGIN, detail: 'log in from its node' });
  }

  send(): boolean {
    return false;
  }

  deliver(): Promise<{ id?: string }> {
    return Promise.reject(new Error(`${this.account} needs a login`));
  }

  surfaces(): Promise<Surface[]> {
    return Promise.reject(new Error('it needs a login: log in from its node'));
  }
}

/** The values of a login's answer, from a request's body: each a string, else refused. */
export function loginAnswer(
  body: unknown
): { action: string; values: Record<string, string> } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'expected {"action", "values"}' };
  const { action, values = {} } = body as { action?: unknown; values?: unknown };
  if (typeof action !== 'string' || action === '') return { error: 'action: expected a name' };
  if (typeof values !== 'object' || values === null || Array.isArray(values))
    return { error: 'values: expected an object of strings' };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'string') return { error: `values.${k}: expected a string` };
    out[k] = v;
  }
  return { action, values: out };
}
