/**
 * The clock the core and every plugin read (docs/bot-os-api.md §4.1): the time and timers,
 * injected, so that tests and the arena run on a virtual clock. Nothing in the core or a plugin
 * reads `Date.now()` or calls the global timers directly.
 */

/** A timer set on a clock, to clear it by. */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
}

/** The wall clock and Node's timers; its timers do not keep the process alive. */
export function wallClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let next = 1;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = next++;
      const t = setTimeout(
        () => {
          timers.delete(id);
          fn();
        },
        Math.max(0, ms)
      );
      t.unref();
      timers.set(id, t);
      return { id };
    },
    clearTimeout(handle) {
      if (handle === undefined) return;
      clearTimeout(timers.get(handle.id));
      timers.delete(handle.id);
    },
  };
}

interface Due {
  id: number;
  at: number;
  /** The order it was set in, which breaks ties of time. */
  seq: number;
  fn: () => void;
}

const before = (a: Due, b: Due): boolean => a.at < b.at || (a.at === b.at && a.seq < b.seq);

/**
 * A clock that moves only when told (the dev kit's, docs/bot-os-api.md §4.10): `advance` runs every
 * timer due on the way, in time order (the order set for timers due at the same time), each at its
 * own time. A simulator drives it one timer at a time instead (`nextAt`, `runNext`), interleaving
 * events of its own; its timers are a heap, so that a night of a few hundred thousand runs in
 * seconds.
 */
export class VirtualClock implements Clock {
  private time: number;
  private next = 1;
  private seq = 0;
  private heap: Due[] = [];
  /** The timers set and not yet run or cleared, by id; the heap drops the others lazily. */
  private readonly live = new Map<number, Due>();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.at(this.time + Math.max(0, ms), fn);
  }

  /** A timer at the time `t` (now, if `t` has passed). */
  at(t: number, fn: () => void): TimerHandle {
    const due: Due = { id: this.next++, at: Math.max(this.time, t), seq: this.seq++, fn };
    this.live.set(due.id, due);
    this.push(due);
    return { id: due.id };
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    if (handle !== undefined) this.live.delete(handle.id);
  }

  /** How many timers are set. */
  get pending(): number {
    return this.live.size;
  }

  /** When the next timer is due, or undefined if none is set. */
  nextAt(): number | undefined {
    return this.top()?.at;
  }

  /** Moves the clock to the next timer and runs it; false if none is set. */
  runNext(): boolean {
    const due = this.top();
    if (due === undefined) return false;
    this.pop();
    this.live.delete(due.id);
    this.time = Math.max(this.time, due.at);
    due.fn();
    return true;
  }

  /** Moves the clock `ms` on, running the timers due on the way. */
  advance(ms: number): void {
    this.advanceTo(this.time + ms);
  }

  /** Moves the clock to `t` (never back), running the timers due on the way. */
  advanceTo(t: number): void {
    for (let at = this.nextAt(); at !== undefined && at <= t; at = this.nextAt()) this.runNext();
    this.time = Math.max(this.time, t);
  }

  /** The next live timer, the cleared ones above it dropped. */
  private top(): Due | undefined {
    for (let due = this.heap[0]; due !== undefined; due = this.heap[0]) {
      if (this.live.has(due.id)) return due;
      this.pop();
    }
    return undefined;
  }

  private push(due: Due): void {
    const h = this.heap;
    h.push(due);
    for (let i = h.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!before(h[i] as Due, h[parent] as Due)) break;
      [h[i], h[parent]] = [h[parent] as Due, h[i] as Due];
      i = parent;
    }
  }

  private pop(): void {
    const h = this.heap;
    const last = h.pop();
    if (h.length === 0 || last === undefined) return;
    h[0] = last;
    for (let i = 0; ;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && before(h[l] as Due, h[m] as Due)) m = l;
      if (r < h.length && before(h[r] as Due, h[m] as Due)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m] as Due, h[i] as Due];
      i = m;
    }
  }
}
