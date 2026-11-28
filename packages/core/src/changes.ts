/**
 * What changed, for the views open (docs/bot-os.md D173, #87 phase 3): the nodes whose reads may
 * answer differently now, pushed to the web UI instead of its asking every few seconds.
 *
 * A node is **touched** where the core sees it change: a write to its store (a document or a file,
 * the core's own documents in its namespace included, such as its timers: one choke point in the
 * store, `Stores`' `changed`), an event it publishes, its state (started, stopped, failed), a
 * setting of its changed, and `ctx.changed()`, for a plugin whose reads change without any of
 * those (a connection's status, a queue held in memory). The touches are **coalesced** over
 * `CHANGE_COALESCE_MS`, then **propagated along interface edges**: a node that reads another's
 * interface is touched with it, and so on (a view of donations hears a change of the game state
 * that donations reads). Each listener then hears the set at once. Nothing is kept: a listener
 * that was not there hears nothing, and reads again when it comes (the view's safety refresh, its
 * first asks).
 */
import { type Clock, type TimerHandle } from './clock.ts';

/** How long touches gather before they are told, in milliseconds (D173). */
export const CHANGE_COALESCE_MS = 500;

export type ChangeListener = (nodes: ReadonlySet<string>) => void;

export class Changes {
  private readonly clock: Clock;
  private readonly readers: (node: string) => readonly string[];
  private readonly listeners = new Set<ChangeListener>();
  private pending = new Set<string>();
  private timer: TimerHandle | undefined;

  /**
   * `readers(node)`: the nodes that read `node`'s interface through an edge of theirs, the
   * graph's as it runs.
   */
  constructor(clock: Clock, readers: (node: string) => readonly string[]) {
    this.clock = clock;
    this.readers = readers;
  }

  /** A node changed: told with the others within `CHANGE_COALESCE_MS`, if anyone listens. */
  touch(node: string): void {
    if (this.listeners.size === 0) return;
    this.pending.add(node);
    this.timer ??= this.clock.setTimeout(() => this.flush(), CHANGE_COALESCE_MS);
  }

  /** Hears each set of nodes changed, propagated; returns the way to stop. */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.clock.clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
      }
    };
  }

  /** The nodes touched, with every node that reads them, however far along interface edges. */
  propagate(touched: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const todo = [...touched];
    for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
      if (out.has(n)) continue;
      out.add(n);
      for (const r of this.readers(n)) if (!out.has(r)) todo.push(r);
    }
    return out;
  }

  private flush(): void {
    this.timer = undefined;
    const nodes = this.propagate(this.pending);
    this.pending = new Set();
    if (nodes.size === 0) return;
    for (const l of [...this.listeners]) {
      try {
        l(nodes);
      } catch {
        // A listener's failure (a closed stream) is its own; the others still hear.
      }
    }
  }
}
