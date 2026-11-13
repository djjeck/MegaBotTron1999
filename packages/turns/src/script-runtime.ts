/**
 * A script node's runtime (docs/bot-os.md D76): the owner's code, its types stripped, run in a
 * `vm` context that holds the script API alone, so that a script does not reach Node by accident
 * (it is not a security boundary: the isolation is the worker thread it runs in, D76). The same
 * runtime runs in a worker thread, in an instance, and in the main thread, in the dev kit, on its
 * virtual clock (`script-plugin.ts`); what it reaches outside its context is a bridge, a message
 * channel to the main thread in a worker, and direct calls in the main thread.
 *
 * The API mirrors the plugin context (docs/bot-os-api.md §4), so that a script exported as a plugin
 * (D79) reads the same:
 *
 * - `on(type, fn)`: a handler of an event type or a namespace, its node's events inputs' or its own
 *   (`ctx.bus.subscribe`); registered while the script loads, never later.
 * - `use(port).state.<read>(input)`, `use(port).actions.<action>(input)`: the members its interface
 *   input `port` uses (`ctx.use`), each a promise.
 * - `outbox(port).enqueue(chat, text, { cancel })`, or `enqueue(port, chat, text, { cancel })`: a
 *   queued send through its chat-out output `port` (`ctx.outbox(port).enqueue`), a handle awaited
 *   for its outcome, with `status()` and `cancel()`.
 * - `publish(type, payload)`: an event of its own (`ctx.bus.publish`).
 * - `store.read(name)`, `store.write(name, value)`, `store.remove(name)`, `store.names()`: its own
 *   documents (`ctx.store`), read from a copy kept beside it.
 * - `clock.now()` (`ctx.clock`), and `Date`, whose `now()` and `new Date()` are the clock's.
 * - `log(...)`, `log.info`, `log.warn`, `log.error` (`ctx.log`); `console` is the same.
 *
 * Nothing in here imports anything but Node's own modules: the worker loads it as it is.
 */
import vm from 'node:vm';

/** The levels of a log line. */
export type LogLevel = 'info' | 'warn' | 'error';

/** A queued send's outcome, as `ctx.outbox(port).enqueue` gives it (`QueuedResult`). */
export interface SendOutcome {
  text: string;
  outcome: string;
  reason?: string;
  event?: Record<string, unknown>;
}

/** What a script may cancel a queued send on (D73): no predicate of its own, which cannot cross. */
export interface ScriptCancel {
  on?: string | readonly string[];
  when?: Readonly<Record<string, unknown>>;
  deadline?: number;
  withinMs?: number;
}

/** The main thread, as the runtime reaches it. */
export interface ScriptBridge {
  /** A member of the interface its input `port` uses: `state.get`, `actions.sent`. */
  use(port: string, member: string, input: unknown): Promise<unknown>;
  /** Queues a send; `done` hears its outcome. Its id is the runtime's. */
  enqueue(
    id: number,
    port: string,
    chat: string,
    text: string,
    cancel: ScriptCancel | undefined,
    done: (r: SendOutcome) => void
  ): void;
  /** Drops a queued send still waiting: whether it did. */
  cancel(id: number): Promise<boolean>;
  publish(type: string, payload: Record<string, unknown>): void;
  write(name: string, value: unknown): void;
  remove(name: string): void;
  log(level: LogLevel, line: string): void;
  now(): number;
}

/** The runtime's limits. */
export interface ScriptLimits {
  /** How long a handler's run may hold the thread at a stretch, and the script's first run. */
  callMs: number;
}

/** A handler call's end: how long it took, and its error, if it threw. */
export interface CallEnd {
  ms: number;
  error?: string;
}

/** A script that held its thread past its limit: the node is failed with it. */
export class ScriptTimeout extends Error {}

/** An error's message, of any realm: the script's context has its own `Error`. */
const message = (e: unknown): string =>
  typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message
    : String(e);

/** A value of the script's realm, or of the bridge's, as plain data: what may cross a thread. */
const plain = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** The code, wrapped in an async function: a script may `await` at its top level. */
const wrap = (js: string): string => `(async () => {\n${js}\n})()`;

/** Whether vm's limit stopped a run. */
const timedOut = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';

/**
 * Prepares the context's `Date`: its `now()` and a `new Date()` without arguments are the script's
 * clock (the dev kit's virtual one), so a script reads no other time.
 */
const DATE = `(() => {
  const RealDate = Date;
  const now = __now;
  class ScriptDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now()); else super(...a); }
    static now() { return now(); }
  }
  globalThis.Date = ScriptDate;
  delete globalThis.__now;
})()`;

/** Calls a handler within the limit: the event and the handler set on the context first. */
const CALL = new vm.Script('__handler(__event)', { filename: 'script-call' });

export class ScriptRuntime {
  private readonly bridge: ScriptBridge;
  private readonly limits: ScriptLimits;
  private readonly context: vm.Context;
  /** Its handlers, by the pattern each was registered for, in the order registered. */
  private readonly handlers: { pattern: string; fn: (e: unknown) => unknown }[] = [];
  private loading = true;
  private nextSend = 1;
  /** Its own documents, as its store keeps them. */
  private readonly docs: Map<string, unknown>;
  /** The event types it may publish: its own. */
  private readonly own: ReadonlySet<string>;

  constructor(o: {
    bridge: ScriptBridge;
    limits: ScriptLimits;
    /** Its store's documents as they are. */
    documents: Record<string, unknown>;
    /** The event types of its own it may publish. */
    publishes: readonly string[];
    /** Its node's id, for its file name in errors. */
    id: string;
  }) {
    this.bridge = o.bridge;
    this.limits = o.limits;
    this.docs = new Map(Object.entries(o.documents));
    this.own = new Set(o.publishes);
    const log =
      (level: LogLevel) =>
      (...args: unknown[]) =>
        this.bridge.log(
          level,
          args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')
        );
    const info = log('info');
    const logger = Object.assign((...a: unknown[]) => info(...a), {
      info,
      warn: log('warn'),
      error: log('error'),
    });
    const outbox = (port: string) => ({
      enqueue: (chat: string, text: string, options: { cancel?: ScriptCancel } = {}) =>
        this.enqueue(port, chat, text, options.cancel),
    });
    const api = {
      on: (type: string, fn: (e: unknown) => unknown): void => {
        if (!this.loading) throw new Error('on() registers handlers while the script loads only');
        if (typeof type !== 'string' || typeof fn !== 'function')
          throw new TypeError('on(type, fn): an event type or a namespace, and a function');
        this.handlers.push({ pattern: type, fn });
      },
      use: (port: string) => ({
        state: this.members(port, 'state'),
        actions: this.members(port, 'actions'),
      }),
      outbox,
      enqueue: (port: string, chat: string, text: string, options?: { cancel?: ScriptCancel }) =>
        outbox(port).enqueue(chat, text, options),
      publish: (type: string, payload: Record<string, unknown> = {}): void => {
        if (!this.own.has(type))
          throw new Error(
            `publish(${JSON.stringify(type)}): it publishes ${[...this.own].join(', ') || 'no event type'} (declare its events)`
          );
        this.bridge.publish(type, plain(payload));
      },
      store: {
        read: (name: string): unknown => plain(this.docs.get(name)),
        write: (name: string, value: unknown): void => {
          const v = plain(value);
          this.docs.set(name, v);
          this.bridge.write(name, v);
        },
        remove: (name: string): void => {
          this.docs.delete(name);
          this.bridge.remove(name);
        },
        names: (): string[] => [...this.docs.keys()].sort(),
      },
      clock: { now: () => this.bridge.now() },
      log: logger,
      console: { log: info, info, warn: logger.warn, error: logger.error },
      __now: () => this.bridge.now(),
    };
    this.context = vm.createContext(api, {
      name: `script ${o.id}`,
      // No eval nor `Function` of text in its realm.
      codeGeneration: { strings: false, wasm: false },
    });
    vm.runInContext(DATE, this.context);
  }

  /** The patterns its handlers hear, each once, in the order first registered. */
  patterns(): string[] {
    return [...new Set(this.handlers.map((h) => h.pattern))];
  }

  /**
   * Runs the script (JavaScript, its types stripped), its handlers registered as it goes: its
   * synchronous run within the limit (a ScriptTimeout past it), then what it awaits at its top
   * level. A script that throws is refused, with why.
   */
  async load(js: string, file: string): Promise<void> {
    let run: Promise<unknown>;
    try {
      const script = new vm.Script(wrap(js), { filename: file, lineOffset: -1 });
      run = script.runInContext(this.context, { timeout: this.limits.callMs }) as Promise<unknown>;
    } catch (e) {
      if (timedOut(e)) throw new ScriptTimeout(`its first run took over ${this.limits.callMs} ms`);
      throw new Error(message(e));
    }
    try {
      await run;
    } catch (e) {
      throw new Error(message(e));
    } finally {
      this.loading = false;
    }
  }

  /**
   * Calls the handlers of `pattern` with an event, in turn: each one's synchronous run within the
   * limit (a ScriptTimeout past it, which ends the script), then what it awaits. Each call's end is
   * told to `ended`, with its error if it threw or rejected.
   */
  dispatch(
    pattern: string,
    event: unknown,
    ended: (end: CallEnd) => void,
    now: () => number
  ): void {
    for (const h of this.handlers) {
      if (h.pattern !== pattern) continue;
      const started = now();
      let result: unknown;
      this.context['__handler'] = h.fn;
      this.context['__event'] = plain(event);
      try {
        result = CALL.runInContext(this.context, { timeout: this.limits.callMs });
      } catch (e) {
        if (timedOut(e))
          throw new ScriptTimeout(`a handler of ${pattern} took over ${this.limits.callMs} ms`);
        ended({ ms: now() - started, error: message(e) });
        continue;
      } finally {
        delete this.context['__handler'];
        delete this.context['__event'];
      }
      Promise.resolve(result).then(
        () => ended({ ms: now() - started }),
        (e: unknown) => ended({ ms: now() - started, error: message(e) })
      );
    }
  }

  /** The members of an interface part, each a call through the bridge. */
  private members(
    port: string,
    part: 'state' | 'actions'
  ): Record<string, (input?: unknown) => Promise<unknown>> {
    return new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name !== 'string' || name === 'then') return undefined;
          return (input?: unknown) => this.bridge.use(port, `${part}.${name}`, plain(input));
        },
      }
    );
  }

  /** A queued send's handle, as `ctx.outbox(port).enqueue` gives one: awaited, its outcome. */
  private enqueue(port: string, chat: string, text: string, cancel: ScriptCancel | undefined) {
    const id = this.nextSend++;
    let status = 'waiting';
    let settle: (r: SendOutcome) => void = () => {};
    const result = new Promise<SendOutcome>((r) => {
      settle = r;
    });
    this.bridge.enqueue(id, String(port), String(chat), String(text), plain(cancel), (r) => {
      status = r.outcome;
      settle(r);
    });
    return {
      id,
      result,
      then: <A, B>(ok?: (r: SendOutcome) => A, ko?: (e: unknown) => B) => result.then(ok, ko),
      status: () => status,
      cancel: () => this.bridge.cancel(id),
    };
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
