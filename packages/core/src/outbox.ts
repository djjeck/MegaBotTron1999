/**
 * The outbox (docs/bot-os-api.md §4.6, bot-os.md §3): one per account, and every send leaves
 * through it. It runs its checks in a fixed order, each refusal
 * with its reason:
 *
 * 1. the caller's own refusal, if it gives one (a game's grammar: not one of its commands);
 * 2. the sender's reach: the chats its chat-out edges send to, and the commands, by their first
 *    word; an edge that is `dryRun` (bot-os.md D64) lets the send through as a dry run, which stops
 *    before the network and is logged as sent;
 * 3. why the sender cannot send now: stopped by the core (a safety stop, drift, the owner), or not
 *    running;
 * 4. a flood wait the network asked for (Telegram's `FLOOD_WAIT`), which holds the account;
 * 5. the account's rate: at least `minIntervalMs` between two sends and at most `maxPerHour` in
 *    any hour, dry runs counted;
 * 6. the connector, which may not be connected.
 *
 * An outbox made outside the core (a module's own, for a game of its own) may still keep its
 * senders' modes (`modes`, module API 1, deprecated): `read-only` refuses, `dry-run` stops before
 * the network, `live` sends.
 *
 * Every attempt is logged (`core.send`), with its outcome. `send` sends now or refuses, for actors
 * that time their sends to the second; `enqueue` waits its turn within the limits; `deliver` sends
 * now or refuses, as `send` does, and waits for the network's answer (Telegram's), with the sent
 * message's id, or `failed` with why if the network refused it.
 */
import { type Clock, type TimerHandle } from './clock.ts';
import { type Connector } from './connector.ts';
import { type Store } from './store.ts';

/**
 * The modes of module API 1 (deprecated, bot-os.md D64): a node's state and its chat-out edges'
 * `dryRun` replaced them. A plugin's `ctx.mode` gives one, derived (`dry-run` or `live`); an outbox
 * made outside the core may still keep them (`Modes`).
 */
export const MODES = ['read-only', 'dry-run', 'live'] as const;
export type Mode = (typeof MODES)[number];
export const isMode = (m: unknown): m is Mode => MODES.includes(m as Mode);

/** An account's limits, below the network's own. */
export interface Limits {
  minIntervalMs: number;
  maxPerHour: number;
}

export type SendResult = {
  text: string;
  outcome: 'sent' | 'dry-run' | 'refused';
  reason?: string;
};

/** A send that waited for the network's answer (`deliver`): its id, or why it failed there. */
export type DeliverResult = {
  text: string;
  outcome: SendResult['outcome'] | 'failed';
  reason?: string;
  /** The network's id of the message sent. */
  id?: string;
};

/** An attempt, as the log keeps it. */
export type SendRecord = DeliverResult & {
  type: 'core.send';
  t: number;
  plugin: string;
  account: string;
  chat: string;
  /** Who in the plugin asked: `strategy`, `control`, … */
  origin: string;
  mode: Mode;
};

/** Thrown by a connector's `send` when the network asks to wait: the account holds that long. */
export class FloodWait extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`flood wait of ${Math.round(ms / 1000)} s`);
    this.ms = ms;
  }
}

/**
 * What one edge lets a sender send: its chats, and its commands by first word (none: any text);
 * `dryRun`, logged as sent and never sent (bot-os.md D64).
 */
export interface Reach {
  sends: readonly string[];
  commands?: readonly string[] | undefined;
  dryRun?: boolean | undefined;
}

/** What the outbox knows of a sender: its reach on this account's connector, and a stop. */
export interface SenderPolicy {
  /**
   * The chats it may send to, and the commands (by first word), of each edge that binds it to this
   * account (§2.1); undefined: anything, for real.
   */
  reach?: Reach | readonly Reach[] | undefined;
  /** Why it cannot send now (`stopped: …`, `not running (…)`), if it cannot. */
  held?: string | undefined;
}

/**
 * Where the modes of module API 1 are kept, plugin by plugin (deprecated, bot-os.md D64): for an
 * outbox made outside the core.
 */
export interface ModeBackend {
  /** A plugin's kept mode, if any. */
  load(plugin: string): unknown;
  save(plugin: string, mode: Mode): void;
}

/** Every plugin's mode in one document, `modes`, of a store (deprecated, bot-os.md D64). */
export function modesIn(store: Pick<Store, 'read' | 'write'>): ModeBackend {
  return {
    load: (plugin) => store.read<Record<string, unknown>>('modes')?.[plugin],
    save: (plugin, mode) =>
      store.write('modes', { ...store.read<Record<string, unknown>>('modes'), [plugin]: mode }),
  };
}

/**
 * The modes of an outbox's senders, kept; `read-only` until one is set (module API 1, deprecated,
 * bot-os.md D64): an outbox made outside the core may keep them (`OutboxOptions.modes`); the core's
 * own outboxes have none, their senders' dry runs being their edges'.
 */
export class Modes {
  private readonly backend: ModeBackend | undefined;
  private readonly modes = new Map<string, Mode>();
  private listeners: ((plugin: string, mode: Mode) => void)[] = [];

  constructor(backend?: ModeBackend) {
    this.backend = backend;
  }

  /** A plugin's mode as set, read from where it is kept at the first ask. */
  private kept(plugin: string): Mode | undefined {
    let m = this.modes.get(plugin);
    if (m === undefined) {
      const loaded = this.backend?.load(plugin);
      if (isMode(loaded)) this.modes.set(plugin, (m = loaded));
    }
    return m;
  }

  /** Whether a plugin's mode was ever set (kept), rather than `read-only` by default. */
  has(plugin: string): boolean {
    return this.kept(plugin) !== undefined;
  }

  get(plugin: string): Mode {
    return this.kept(plugin) ?? 'read-only';
  }

  /** Sets a plugin's mode: the owner sets any; a safety stop only `read-only`. Why not, or undefined. */
  set(plugin: string, mode: Mode, by: 'owner' | 'safety' = 'owner'): string | undefined {
    if (!isMode(mode)) return `not a mode: ${String(mode)}`;
    if (by === 'safety' && mode !== 'read-only') return 'only the owner raises a mode';
    this.modes.set(plugin, mode);
    this.backend?.save(plugin, mode);
    for (const l of [...this.listeners]) l(plugin, mode);
    return undefined;
  }

  /** Hears every change. */
  onChange(listener: (plugin: string, mode: Mode) => void): void {
    this.listeners.push(listener);
  }
}

export interface OutboxOptions {
  account: string;
  /** The account's connector, while it runs. */
  connector: () => Connector | undefined;
  /** The account's limits; none: no rate limit. */
  limits?: () => Limits | undefined;
  clock: Clock;
  /**
   * Its senders' modes (module API 1, deprecated, bot-os.md D64), for an outbox made outside the
   * core; none: a send is a dry run only through a `dryRun` edge (`policy`).
   */
  modes?: Modes;
  /** What the outbox knows of a sender, at each send: through its output `port`, if one is named. */
  policy?: (plugin: string, port?: string) => SenderPolicy;
  /** Where every attempt goes: the event log. */
  record?: (r: SendRecord) => void;
}

export interface SendOptions {
  /** Who in the plugin asks; the plugin's id if not given. */
  origin?: string;
  /** The caller's own reason to refuse it, logged as every attempt is. */
  refuse?: string;
  /**
   * The text is Markdown (`deliver` only): a connector that formats sends it formatted (Telegram's
   * as HTML), any other as written.
   */
  format?: TextFormat;
  /**
   * The chat-out output it goes through (the core's handles set it, `ctx.outbox(port)`): only that
   * output's edge reaches, and makes it a dry run or not; none: every edge to this account.
   */
  port?: string;
}

/** How a text is written: Markdown, or plain when not said. */
export type TextFormat = 'markdown';

/** A plugin's way out through one account's outbox. */
export interface OutboxHandle {
  readonly account: string;
  readonly plugin: string;
  /**
   * How it sends now: `dry-run` when every edge that binds it to this account is a dry run, `live`
   * otherwise (an outbox with `modes`: its mode, `read-only` among them).
   */
  mode(): Mode;
  /** Sends now, or refuses with why. */
  send(chat: string, text: string, options?: SendOptions): SendResult;
  /** Sends in its turn, spaced within the account's limits. */
  enqueue(chat: string, text: string, options?: SendOptions): Promise<SendResult>;
  /** Sends now or refuses, and waits for the network's answer: the message's id. */
  deliver(chat: string, text: string, options?: SendOptions): Promise<DeliverResult>;
}

interface Queued {
  plugin: string;
  chat: string;
  text: string;
  options: SendOptions;
  done: (r: SendResult) => void;
}

const HOUR = 3_600_000;

export class Outbox {
  readonly account: string;
  private readonly o: OutboxOptions;
  /** Times of the sends (and dry runs) in the last hour. */
  private recent: number[] = [];
  /** No send before this: a flood wait. */
  private heldUntil = Number.NEGATIVE_INFINITY;
  private readonly queue: Queued[] = [];
  private timer: TimerHandle | undefined;

  constructor(options: OutboxOptions) {
    this.account = options.account;
    this.o = options;
  }

  /** The way out for one plugin, through its output `port` if named (every edge otherwise). */
  as(plugin: string, port?: string): OutboxHandle {
    const via = (o: SendOptions): SendOptions => (port === undefined ? o : { ...o, port });
    return {
      account: this.account,
      plugin,
      mode: () => this.modeOf(plugin, port),
      send: (chat, text, options = {}) => this.send(plugin, chat, text, via(options)),
      enqueue: (chat, text, options = {}) => this.enqueue(plugin, chat, text, via(options)),
      deliver: (chat, text, options = {}) => this.deliver(plugin, chat, text, via(options)),
    };
  }

  /** How many sends wait in the queue. */
  get waiting(): number {
    return this.queue.length;
  }

  send(plugin: string, chat: string, text: string, options: SendOptions = {}): SendResult {
    const v = this.check(plugin, chat, text, options);
    const result = 'refused' in v ? v.refused : this.attempt(chat, text, v.dryRun);
    this.log(plugin, chat, options, result, v.mode);
    return result;
  }

  /** How a sender sends now (`OutboxHandle.mode`). */
  private modeOf(plugin: string, port?: string): Mode {
    if (this.o.modes !== undefined) return this.o.modes.get(plugin);
    const reaches = this.reachesOf(this.o.policy?.(plugin, port));
    return reaches !== undefined && reaches.length > 0 && reaches.every((r) => r.dryRun === true)
      ? 'dry-run'
      : 'live';
  }

  /** A sender's reaches on this account, as its policy gives them; undefined: anything. */
  private reachesOf(policy: SenderPolicy | undefined): readonly Reach[] | undefined {
    const reach = policy?.reach;
    if (reach === undefined) return undefined;
    return Array.isArray(reach) ? reach : [reach as Reach];
  }

  /**
   * Sends now or refuses, as `send` does, and waits for the network: through the connector's
   * `deliver` where it has one (its `send` otherwise). The rate counts the send when it leaves, so
   * that two at once keep to the limits; a `FloodWait` holds the account and refuses it, any other
   * rejection is `failed` with why. Logged once, with the outcome.
   */
  async deliver(
    plugin: string,
    chat: string,
    text: string,
    options: SendOptions = {}
  ): Promise<DeliverResult> {
    const v = this.check(plugin, chat, text, options);
    let result: DeliverResult =
      'refused' in v ? v.refused : (this.admit(text, v.dryRun) ?? { text, outcome: 'sent' });
    if (result.outcome === 'sent') {
      const connector = this.o.connector();
      const now = this.o.clock.now();
      if (connector?.deliver === undefined) result = this.attempt(chat, text, false);
      else if (connector.status().state !== 'connected')
        result = { text, outcome: 'refused', reason: 'not connected' };
      else {
        this.recent.push(now);
        try {
          const { id } = await connector.deliver(
            chat,
            text,
            options.format === undefined ? undefined : { format: options.format }
          );
          result = { text, outcome: 'sent', ...(id === undefined ? {} : { id }) };
        } catch (e) {
          if (e instanceof FloodWait) {
            this.heldUntil = this.o.clock.now() + e.ms;
            result = { text, outcome: 'refused', reason: e.message };
          } else
            result = {
              text,
              outcome: 'failed',
              reason: e instanceof Error ? e.message : String(e),
            };
        }
      }
    }
    this.log(plugin, chat, options, result, v.mode);
    return result;
  }

  enqueue(
    plugin: string,
    chat: string,
    text: string,
    options: SendOptions = {}
  ): Promise<SendResult> {
    // What can never go now waits for nothing: refused at once.
    const v = this.check(plugin, chat, text, options);
    if ('refused' in v) {
      this.log(plugin, chat, options, v.refused, v.mode);
      return Promise.resolve(v.refused);
    }
    return new Promise((done) => {
      this.queue.push({ plugin, chat, text, options, done });
      this.pump();
    });
  }

  /** Sends the head of the queue when the limits allow, then the next. */
  private pump(): void {
    if (this.timer !== undefined || this.queue.length === 0) return;
    const wait = this.wait();
    if (wait > 0) {
      this.timer = this.o.clock.setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, wait);
      return;
    }
    const next = this.queue.shift() as Queued;
    next.done(this.send(next.plugin, next.chat, next.text, next.options));
    this.pump();
  }

  /** How long until the account may send again. */
  private wait(): number {
    const now = this.o.clock.now();
    this.recent = this.recent.filter((t) => now - t < HOUR);
    const limits = this.o.limits?.();
    const last = this.recent.at(-1);
    const first = this.recent[0];
    return Math.max(
      0,
      this.heldUntil - now,
      limits === undefined || last === undefined ? 0 : last + limits.minIntervalMs - now,
      limits === undefined || first === undefined || this.recent.length < limits.maxPerHour
        ? 0
        : first + HOUR - now
    );
  }

  /**
   * Why a send cannot go whatever the clock (the caller, the reach, the mode, a stop); or, when it
   * may, whether it is a dry run. With the mode it is logged in.
   */
  private check(
    plugin: string,
    chat: string,
    text: string,
    options: SendOptions
  ): ({ refused: SendResult } | { dryRun: boolean }) & { mode: Mode } {
    const policy = this.o.policy?.(plugin, options.port) ?? {};
    const reaches = this.reachesOf(policy);
    const word = text.split(/\s/u, 1)[0] ?? '';
    // The edges that let it send this: through a live one, it goes for real (D64).
    const through = reaches?.filter(
      (r) => r.sends.includes(chat) && (r.commands === undefined || r.commands.includes(word))
    );
    const dryRun =
      this.o.modes === undefined
        ? through !== undefined && through.length > 0 && through.every((r) => r.dryRun === true)
        : this.o.modes.get(plugin) === 'dry-run';
    const mode: Mode =
      this.o.modes === undefined ? (dryRun ? 'dry-run' : 'live') : this.o.modes.get(plugin);
    const refuse = (reason: string) => ({
      refused: { text, outcome: 'refused' as const, reason },
      mode,
    });
    if (options.refuse !== undefined) return refuse(options.refuse);
    if (reaches !== undefined) {
      if (!reaches.some((r) => r.sends.includes(chat)))
        return refuse(`${plugin} does not send to ${chat}`);
      if (through?.length === 0) return refuse(`${word} is not among ${plugin}'s commands`);
    }
    if (mode === 'read-only') return refuse('read-only');
    if (policy.held !== undefined) return refuse(policy.held);
    return { dryRun, mode };
  }

  /**
   * The checks against the clock: a flood wait, the rate, and a dry run (counted, and not sent).
   * The refusal or the dry run; undefined to send.
   */
  private admit(text: string, dryRun: boolean): SendResult | undefined {
    const refuse = (reason: string): SendResult => ({ text, outcome: 'refused', reason });
    const now = this.o.clock.now();
    if (now < this.heldUntil)
      return refuse(`flood wait, ${Math.ceil((this.heldUntil - now) / 1000)} s more`);
    this.recent = this.recent.filter((t) => now - t < HOUR);
    const limits = this.o.limits?.();
    const last = this.recent.at(-1);
    if (limits !== undefined) {
      if (last !== undefined && now - last < limits.minIntervalMs) return refuse('too soon');
      if (this.recent.length >= limits.maxPerHour) return refuse('hourly limit');
    }
    if (dryRun) {
      this.recent.push(now);
      return { text, outcome: 'dry-run' };
    }
    return undefined;
  }

  /** A send the checks allow, against the clock and the network. */
  private attempt(chat: string, text: string, dryRun: boolean): SendResult {
    const refuse = (reason: string): SendResult => ({ text, outcome: 'refused', reason });
    const admitted = this.admit(text, dryRun);
    if (admitted !== undefined) return admitted;
    const now = this.o.clock.now();
    const connector = this.o.connector();
    let sent: boolean;
    try {
      sent = connector?.send(chat, text) ?? false;
    } catch (e) {
      if (!(e instanceof FloodWait)) throw e;
      this.heldUntil = now + e.ms;
      return refuse(e.message);
    }
    if (!sent) return refuse('not connected');
    this.recent.push(now);
    return { text, outcome: 'sent' };
  }

  private log(
    plugin: string,
    chat: string,
    options: SendOptions,
    result: DeliverResult,
    mode: Mode
  ): void {
    this.o.record?.({
      type: 'core.send',
      t: this.o.clock.now(),
      plugin,
      account: this.account,
      chat,
      origin: options.origin ?? plugin,
      mode,
      ...result,
    });
  }
}
