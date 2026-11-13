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
import { z } from 'zod';
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

/** An account's limits, below the network's own; one not given does not limit. */
export interface Limits {
  minIntervalMs?: number;
  maxPerHour?: number;
  /**
   * The least time between two sends of one command in one chat that a queued send waits for
   * (bot-os.md D73), where the edge names none for it; none: 0.
   */
  commandIntervalMs?: number;
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
  /** The other nodes a coalesced queued send went for (bot-os.md D73). */
  with?: string[];
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
 * A connector's default interval between two queued sends of one command in one chat (bot-os.md
 * D73), a field of its config: where a chat-out edge names none for a command.
 */
export const commandIntervalS = z
  .number()
  .min(0)
  .default(0)
  .describe(
    'The least seconds between two queued sends of one command in one chat, where the edge names none (0: only the account’s pace)'
  );

/**
 * What one edge lets a sender send: its chats, and its commands by first word (none: any text);
 * `dryRun`, logged as sent and never sent (bot-os.md D64).
 */
export interface Reach {
  sends: readonly string[];
  commands?: readonly string[] | undefined;
  /**
   * The least seconds between two sends of a command (by first word) in one chat, for a queued
   * send (bot-os.md D73); a command not named: the connector's `commandIntervalMs`.
   */
  minIntervalS?: Readonly<Record<string, number>> | undefined;
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
  /** Where every attempt, and every step of the queue, goes: the event log. */
  record?: (r: SendRecord | QueueRecord) => void;
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
  /**
   * Queues a send (bot-os.md D73): in its turn, spaced within the account's limits and its
   * command's interval in that chat, coalesced with the same text another node has waiting for the
   * same chat, and dropped if its `cancel` holds before it goes. Awaited, its outcome.
   */
  enqueue(chat: string, text: string, options?: QueueOptions): QueuedSend;
  /** Sends now or refuses, and waits for the network's answer: the message's id. */
  deliver(chat: string, text: string, options?: SendOptions): Promise<DeliverResult>;
}

/** An event as a cancel tests it: the bus's, `{ type, t, ...payload }`. */
export interface CancelEvent {
  type: string;
  t: number;
  [field: string]: unknown;
}

/**
 * When a queued send is dropped before it goes (bot-os.md D73), each condition enough: an event of
 * `on` (a type or a namespace the node hears) whose fields equal `when` (dotted paths, as a
 * reaction's; a list at a path matches a value it contains) and pass `test`, a plugin's own; or
 * the time: `deadline` (ms), or `withinMs` from now, after which it expires.
 */
export interface CancelWhen {
  on?: string | readonly string[];
  when?: Readonly<Record<string, unknown>>;
  test?: (event: CancelEvent) => boolean;
  deadline?: number;
  withinMs?: number;
}

export interface QueueOptions extends SendOptions {
  cancel?: CancelWhen;
}

/** What came of a queued send: the send's outcome, or dropped before it went. */
export type QueueOutcome = SendResult['outcome'] | 'cancelled' | 'expired';

export interface QueuedResult {
  text: string;
  outcome: QueueOutcome;
  reason?: string;
  /** The event that cancelled it. */
  event?: CancelEvent;
}

/**
 * A queued send's handle (bot-os.md D73): awaited (or `result`), its outcome; `status()` now;
 * `cancel()` drops it if it still waits (true then).
 */
export interface QueuedSend extends PromiseLike<QueuedResult> {
  readonly id: number;
  readonly result: Promise<QueuedResult>;
  status(): 'waiting' | QueueOutcome;
  cancel(reason?: string): boolean;
}

/** A step of the queue, as the log keeps it (`core.queue`). */
export type QueueRecord = {
  type: 'core.queue';
  t: number;
  account: string;
  plugin: string;
  chat: string;
  text: string;
  event: 'queued' | 'coalesced' | QueueOutcome;
  reason?: string;
  /** The event that cancelled it, by type. */
  by?: string;
};

/** A queued send, as the owner sees it (the connector's panel, `GET /plugins/<id>/queue`). */
export interface QueueEntryView {
  chat: string;
  text: string;
  command: string;
  queuedAt: number;
  /** When it may go at the earliest: its command's interval, and the account's pace. */
  waitingUntil: number;
  intervalS: number;
  /** Each node that asked for it (several, coalesced), with its conditions. */
  nodes: {
    plugin: string;
    origin: string;
    cancel?: { on?: string[]; when?: Record<string, unknown>; test?: boolean; deadline?: number };
  }[];
}

/**
 * The sends coalesced since the instance started (bot-os.md D73), which may say that two nodes
 * duplicate a piece of logic: how many times a node joined another's waiting send, and each pair
 * of nodes that shared one, with how many times.
 */
export interface CoalescedView {
  count: number;
  pairs: { nodes: [string, string]; count: number }[];
}

/** One node's share of a queued send. */
interface Member {
  id: number;
  plugin: string;
  options: SendOptions;
  cancel?: CancelWhen;
  deadline?: number;
  intervalMs: number;
  status: 'waiting' | QueueOutcome;
  settle: (r: QueuedResult) => void;
  timer?: TimerHandle;
}

/** A send waiting in its chat's queue: one text, for one or more nodes. */
interface Waiting {
  chat: string;
  text: string;
  command: string;
  queuedAt: number;
  members: Member[];
}

const HOUR = 3_600_000;
/** A command's first word, as the reach and the intervals name it. */
const firstWord = (text: string): string => text.split(/\s/u, 1)[0] ?? '';

export class Outbox {
  readonly account: string;
  private readonly o: OutboxOptions;
  /** Times of the sends (and dry runs) in the last hour. */
  private recent: number[] = [];
  /** No send before this: a flood wait. */
  private heldUntil = Number.NEGATIVE_INFINITY;
  /** What waits, in the order queued: each chat's queue, side by side (bot-os.md D73). */
  private waitingList: Waiting[] = [];
  /** When each command was last sent in each chat (`<chat> <command>`), dry runs counted. */
  private readonly lastSent = new Map<string, number>();
  private members = 0;
  private timer: TimerHandle | undefined;
  /** The sends coalesced since it was made: how many, and per pair of nodes (`[a, b]`, as JSON). */
  private merges = 0;
  private readonly mergedPairs = new Map<string, number>();

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

  /** How many sends wait in the queue (a coalesced one once). */
  get waiting(): number {
    return this.waitingList.length;
  }

  send(plugin: string, chat: string, text: string, options: SendOptions = {}): SendResult {
    const v = this.check(plugin, chat, text, options);
    const result = 'refused' in v ? v.refused : this.attempt(chat, text, v.dryRun);
    this.sent(chat, text, result);
    this.log(plugin, chat, options, result, v.mode);
    return result;
  }

  /** Notes when a command went (or went as a dry run), for its interval (D73). */
  private sent(chat: string, text: string, r: { outcome: string }): void {
    if (r.outcome === 'sent' || r.outcome === 'dry-run')
      this.lastSent.set(`${chat} ${firstWord(text)}`, this.o.clock.now());
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
    this.sent(chat, text, result);
    this.log(plugin, chat, options, result, v.mode);
    return result;
  }

  /**
   * Queues a send (bot-os.md D73). Refused at once, as `send` refuses, what can never go now. The
   * same text waiting for the same chat, anywhere in the queue, takes this node too if another
   * node queued it (coalesced: one send, a handle each); a node's own same send again is a send of
   * its own.
   * It goes in its turn: the oldest send whose command's interval in its chat has passed since that
   * command last went (the edges', the connector's by default), within the account's pace; a send
   * of another command does not wait behind it. Until then, its cancel may drop it.
   */
  enqueue(plugin: string, chat: string, text: string, options: QueueOptions = {}): QueuedSend {
    const { cancel, ...sendOptions } = options;
    const id = ++this.members;
    let settle!: (r: QueuedResult) => void;
    const result = new Promise<QueuedResult>((r) => (settle = r));
    const member: Member = {
      id,
      plugin,
      options: sendOptions,
      ...(cancel === undefined ? {} : { cancel }),
      intervalMs: 0,
      status: 'waiting',
      settle: (r) => {
        if (member.status !== 'waiting') return;
        member.status = r.outcome;
        if (member.timer !== undefined) this.o.clock.clearTimeout(member.timer);
        settle(r);
      },
    };
    const handle: QueuedSend = {
      id,
      result,
      status: () => member.status,
      cancel: (reason = 'cancelled by its node') => this.cancelQueued(id, reason),
      then: (onDone, onFail) => result.then(onDone, onFail),
    };
    // What can never go now waits for nothing: refused at once.
    const v = this.check(plugin, chat, text, sendOptions);
    if ('refused' in v) {
      this.log(plugin, chat, sendOptions, v.refused, v.mode);
      member.settle(v.refused);
      return handle;
    }
    member.intervalMs = this.intervalOf(plugin, chat, text, sendOptions);
    const deadline =
      cancel?.withinMs === undefined
        ? cancel?.deadline
        : Math.min(cancel.deadline ?? Infinity, this.o.clock.now() + cancel.withinMs);
    if (deadline !== undefined) member.deadline = deadline;
    // Coalesced with the same text for the same chat, wherever it waits, but only another node's:
    // a node's own repeated send (buying an item twice) stays a send of its own.
    const same = this.waitingList.find(
      (w) => w.chat === chat && w.text === text && !w.members.some((m) => m.plugin === plugin)
    );
    if (same === undefined)
      this.waitingList.push({
        chat,
        text,
        command: firstWord(text),
        queuedAt: this.o.clock.now(),
        members: [member],
      });
    else {
      this.merges += 1;
      for (const other of new Set(same.members.map((m) => m.plugin))) {
        const key = JSON.stringify([other, plugin].sort());
        this.mergedPairs.set(key, (this.mergedPairs.get(key) ?? 0) + 1);
      }
      same.members.push(member);
    }
    this.queueLog(plugin, chat, text, same === undefined ? 'queued' : 'coalesced');
    if (deadline !== undefined)
      member.timer = this.o.clock.setTimeout(
        () => this.drop(id, { text, outcome: 'expired', reason: 'its deadline passed' }),
        Math.max(0, deadline - this.o.clock.now())
      );
    this.pump();
    return handle;
  }

  /**
   * Drops one node's share of a queued send if it still waits (its handle's `cancel`, or the core
   * for an event of its `cancel.on`): cancelled, with why and the event. False if it went already.
   */
  cancelQueued(id: number, reason: string, event?: CancelEvent): boolean {
    const w = this.waitingList.find((x) => x.members.some((m) => m.id === id));
    if (w === undefined) return false;
    return this.drop(id, {
      text: w.text,
      outcome: 'cancelled',
      reason,
      ...(event === undefined ? {} : { event }),
    });
  }

  /** Drops what a node queued (it stopped, or the instance stops): cancelled, with why. */
  dropQueued(plugin: string | undefined, reason: string): void {
    for (const w of [...this.waitingList])
      for (const m of [...w.members])
        if (plugin === undefined || m.plugin === plugin)
          this.drop(m.id, { text: w.text, outcome: 'cancelled', reason });
  }

  /** What waits, in order, as the owner sees it. */
  pending(): QueueEntryView[] {
    const pace = this.o.clock.now() + this.wait();
    return this.waitingList.map((w) => ({
      chat: w.chat,
      text: w.text,
      command: w.command,
      queuedAt: w.queuedAt,
      waitingUntil: Math.max(pace, this.readyAt(w)),
      intervalS: this.intervalMsOf(w) / 1000,
      nodes: w.members.map((m) => {
        const c = m.cancel;
        const on = c?.on === undefined ? undefined : typeof c.on === 'string' ? [c.on] : [...c.on];
        return {
          plugin: m.plugin,
          origin: m.options.origin ?? m.plugin,
          ...(c === undefined ||
          (on === undefined && c.test === undefined && m.deadline === undefined)
            ? {}
            : {
                cancel: {
                  ...(on === undefined ? {} : { on }),
                  ...(c.when === undefined ? {} : { when: { ...c.when } }),
                  ...(c.test === undefined ? {} : { test: true }),
                  ...(m.deadline === undefined ? {} : { deadline: m.deadline }),
                },
              }),
        };
      }),
    }));
  }

  /** The sends coalesced since it was made, and the pairs of nodes that shared them, most first. */
  coalesced(): CoalescedView {
    const pairs = [...this.mergedPairs]
      .map(([key, count]) => ({ nodes: JSON.parse(key) as [string, string], count }))
      .sort((x, y) => y.count - x.count || x.nodes.join(' ').localeCompare(y.nodes.join(' ')));
    return { count: this.merges, pairs };
  }

  /** A member settled before its send went: out of its send, logged, and the queue moves on. */
  private drop(id: number, r: QueuedResult): boolean {
    const w = this.waitingList.find((x) => x.members.some((m) => m.id === id));
    const m = w?.members.find((x) => x.id === id);
    if (w === undefined || m === undefined) return false;
    w.members = w.members.filter((x) => x !== m);
    if (w.members.length === 0) this.waitingList = this.waitingList.filter((x) => x !== w);
    m.settle(r);
    this.queueLog(m.plugin, w.chat, w.text, r.outcome, r.reason, r.event?.type);
    this.pump();
    return true;
  }

  /**
   * A sender's interval for a command in a chat (D73): the longest its edges that let it send it
   * name, else the connector's default.
   */
  private intervalOf(plugin: string, chat: string, text: string, options: SendOptions): number {
    const word = firstWord(text);
    const named = (this.reachesOf(this.o.policy?.(plugin, options.port)) ?? [])
      .filter((r) => r.sends.includes(chat))
      .flatMap((r) => (r.minIntervalS?.[word] === undefined ? [] : [r.minIntervalS[word] * 1000]));
    return named.length > 0 ? Math.max(...named) : (this.o.limits?.()?.commandIntervalMs ?? 0);
  }

  private intervalMsOf(w: Waiting): number {
    return Math.max(0, ...w.members.map((m) => m.intervalMs));
  }

  /** When a waiting send's command may go again in its chat. */
  private readyAt(w: Waiting): number {
    const last = this.lastSent.get(`${w.chat} ${w.command}`);
    return last === undefined ? Number.NEGATIVE_INFINITY : last + this.intervalMsOf(w);
  }

  /** Sends the oldest send whose command's interval has passed, when the account may; again. */
  private pump(): void {
    if (this.timer !== undefined) this.o.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (;;) {
      if (this.waitingList.length === 0) return;
      const now = this.o.clock.now();
      const pace = this.wait();
      const next = this.waitingList.find((w) => this.readyAt(w) <= now);
      if (pace > 0 || next === undefined) {
        const soonest = Math.min(...this.waitingList.map((w) => this.readyAt(w)));
        const ms = Math.max(pace, soonest - now, 0);
        this.timer = this.o.clock.setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, ms);
        return;
      }
      this.issue(next);
    }
  }

  /**
   * A waiting send goes: each node's checks again (one refused is told so, and the others go),
   * then one send, for real if any of them sends through a live edge, else a dry run; logged once
   * (`core.send`, with the other nodes it went for), and each node told.
   */
  private issue(w: Waiting): void {
    this.waitingList = this.waitingList.filter((x) => x !== w);
    const going: { m: Member; dryRun: boolean; mode: Mode }[] = [];
    for (const m of w.members) {
      const v = this.check(m.plugin, w.chat, w.text, m.options);
      if ('refused' in v) {
        this.log(m.plugin, w.chat, m.options, v.refused, v.mode);
        m.settle(v.refused);
        this.queueLog(m.plugin, w.chat, w.text, 'refused', v.refused.reason);
      } else going.push({ m, dryRun: v.dryRun, mode: v.mode });
    }
    const lead = going.find((g) => !g.dryRun) ?? going[0];
    if (lead === undefined) return;
    const result = this.attempt(w.chat, w.text, lead.dryRun);
    this.sent(w.chat, w.text, result);
    const others = [
      ...new Set(going.filter((g) => g.m.plugin !== lead.m.plugin).map((g) => g.m.plugin)),
    ];
    this.log(lead.m.plugin, w.chat, lead.m.options, result, lead.mode, others);
    for (const g of going) {
      const outcome = result.outcome === 'sent' && g.dryRun ? 'dry-run' : result.outcome;
      const r: QueuedResult = {
        text: w.text,
        outcome,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
      g.m.settle(r);
      this.queueLog(g.m.plugin, w.chat, w.text, outcome, result.reason);
    }
  }

  private queueLog(
    plugin: string,
    chat: string,
    text: string,
    event: QueueRecord['event'],
    reason?: string,
    by?: string
  ): void {
    this.o.record?.({
      type: 'core.queue',
      t: this.o.clock.now(),
      account: this.account,
      plugin,
      chat,
      text,
      event,
      ...(reason === undefined ? {} : { reason }),
      ...(by === undefined ? {} : { by }),
    });
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
      limits?.minIntervalMs === undefined || last === undefined
        ? 0
        : last + limits.minIntervalMs - now,
      limits?.maxPerHour === undefined ||
        first === undefined ||
        this.recent.length < limits.maxPerHour
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
      if (
        limits.minIntervalMs !== undefined &&
        last !== undefined &&
        now - last < limits.minIntervalMs
      )
        return refuse('too soon');
      if (limits.maxPerHour !== undefined && this.recent.length >= limits.maxPerHour)
        return refuse('hourly limit');
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
    mode: Mode,
    coalesced: readonly string[] = []
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
      ...(coalesced.length === 0 ? {} : { with: [...coalesced] }),
    });
  }
}
