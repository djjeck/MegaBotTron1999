/**
 * Durable named timers, one set per plugin (docs/bot-os-api.md §4.3, P8): "send again in 17
 * minutes" survives a redeploy. Each timer is kept in the plugin's store (the core's `_timers`
 * document) with a small JSON payload, and fires through the plugin's `onTimer(name, payload)`: a
 * timer is data, since it outlives the closures of the process that set it.
 *
 * A timer that came due while the instance was down is settled when the plugin is created, as its
 * policy says: `late: 'fire'` (the default) fires it at once after the plugin's start, unless it is
 * later than its `graceMs`; `late: 'drop'`, or a grace passed, drops it, logged. A dropped timer is
 * gone before `create`, so the plugin never sees it.
 *
 * Timers run on the core's clock, so tests and the arena run them on a virtual one.
 */
import { type Clock, type TimerHandle } from './clock.ts';

export interface TimerOptions {
  /** A small JSON value handed to `onTimer`. */
  payload?: unknown;
  /** What a timer that came due while the instance was down does at the next start. */
  late?: 'fire' | 'drop';
  /** With `late: 'fire'`: the latest it may fire after its time; later, it is dropped. */
  graceMs?: number;
}

export interface Timer {
  at: number;
  payload?: unknown;
}

export interface Scheduler {
  /** Sets the timer `name` for the time `at`, replacing one of that name. */
  at(name: string, at: number, options?: TimerOptions): void;
  /** Sets the timer `name` for `ms` from now, replacing one of that name. */
  after(name: string, ms: number, options?: TimerOptions): void;
  /** Drops the timer `name`; false if there was none. */
  cancel(name: string): boolean;
  /** The timer `name`, if set. */
  get(name: string): Timer | undefined;
  /** The names of the timers set, sorted. */
  names(): string[];
}

/** A timer as the store keeps it. */
export interface KeptTimer {
  at: number;
  payload?: unknown;
  late: 'fire' | 'drop';
  graceMs?: number;
}

/** Node's timers take at most this delay; a later timer is armed again when it wakes. */
export const MAX_DELAY_MS = 2 ** 31 - 1;

const NAME = /^[A-Za-z0-9][\w.:-]*$/u;

export interface PluginSchedulerOptions {
  clock: Clock;
  /** Where the timers are kept. */
  load(): Record<string, KeptTimer> | undefined;
  save(timers: Record<string, KeptTimer>): void;
  /** A timer due: the plugin's `onTimer`. */
  fire(name: string, payload: unknown): void;
  /** A timer dropped at start, as its policy says. */
  dropped(name: string, timer: Timer, lateMs: number): void;
}

/** One plugin's timers: kept on every change, armed only between `arm` and `disarm`. */
export class PluginScheduler implements Scheduler {
  private readonly o: PluginSchedulerOptions;
  private readonly timers: Record<string, KeptTimer>;
  private readonly handles = new Map<string, TimerHandle>();
  private armed = false;

  /** The timers kept, those due while down settled by their policy. */
  constructor(options: PluginSchedulerOptions) {
    this.o = options;
    this.timers = { ...options.load() };
    const now = options.clock.now();
    let changed = false;
    for (const [name, t] of Object.entries(this.timers)) {
      const late = now - t.at;
      if (late <= 0) continue;
      if (t.late === 'drop' || (t.graceMs !== undefined && late > t.graceMs)) {
        delete this.timers[name];
        changed = true;
        options.dropped(name, timerOf(t), late);
      }
    }
    if (changed) this.save();
  }

  at(name: string, at: number, options: TimerOptions = {}): void {
    if (!NAME.test(name)) throw new Error(`not a timer name: ${JSON.stringify(name)}`);
    if (!Number.isFinite(at)) throw new Error(`timer ${name}: not a time: ${at}`);
    this.clear(name);
    this.timers[name] = {
      at,
      late: options.late ?? 'fire',
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    };
    this.save();
    if (this.armed) this.arm1(name);
  }

  after(name: string, ms: number, options: TimerOptions = {}): void {
    this.at(name, this.o.clock.now() + ms, options);
  }

  cancel(name: string): boolean {
    if (!(name in this.timers)) return false;
    this.clear(name);
    delete this.timers[name];
    this.save();
    return true;
  }

  get(name: string): Timer | undefined {
    const t = this.timers[name];
    return t === undefined ? undefined : timerOf(t);
  }

  names(): string[] {
    return Object.keys(this.timers).sort();
  }

  /** Arms every timer kept: the plugin has started. Those overdue fire at once, in time order. */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    const names = Object.keys(this.timers).sort(
      (a, b) => (this.timers[a] as KeptTimer).at - (this.timers[b] as KeptTimer).at
    );
    for (const name of names) this.arm1(name);
  }

  /** Disarms every timer, keeping them: the plugin is stopping. */
  disarm(): void {
    this.armed = false;
    for (const name of [...this.handles.keys()]) this.clear(name);
  }

  private arm1(name: string): void {
    const t = this.timers[name] as KeptTimer;
    const delay = Math.min(Math.max(0, t.at - this.o.clock.now()), MAX_DELAY_MS);
    this.handles.set(
      name,
      this.o.clock.setTimeout(() => {
        this.handles.delete(name);
        if (this.timers[name] !== t) return;
        // Too far for one of Node's timers: armed again for the rest of the way.
        if (this.o.clock.now() < t.at) {
          this.arm1(name);
          return;
        }
        delete this.timers[name];
        this.save();
        this.o.fire(name, t.payload);
      }, delay)
    );
  }

  private clear(name: string): void {
    this.o.clock.clearTimeout(this.handles.get(name));
    this.handles.delete(name);
  }

  private save(): void {
    this.o.save({ ...this.timers });
  }
}

function timerOf(t: KeptTimer): Timer {
  return { at: t.at, ...(t.payload === undefined ? {} : { payload: t.payload }) };
}
