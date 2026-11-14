/**
 * What each node costs (docs/bot-os.md D77), to find the top offenders: the time its handlers take
 * where the core hands it an event, a message or a timer, measured around each call; and what a
 * node's instance says of its own (`Instance.cost`: a script's worker thread, its CPU, its heap and
 * its handlers' calls). Time is the process's own (`performance.now()`), real time, never a
 * plugin's clock: the dev kit's is virtual. Kept in memory, from the start.
 */

/** A node's handlers, as the core dispatched to them. */
export interface DispatchCost {
  /** Calls: events, messages and timers handed to it. */
  calls: number;
  /** Their time, synchronous parts only, in milliseconds. */
  ms: number;
  /** The longest one. */
  maxMs: number;
}

/** What a node's instance says it costs (`Instance.cost`): a script's worker, for one. */
export interface OwnCost {
  /** Where it runs: `worker`, a thread of its own. */
  runs?: 'worker' | 'in-process';
  /** Its handlers' calls, and their time from each call to its end, awaited parts included. */
  calls?: number;
  errors?: number;
  ms?: number;
  maxMs?: number;
  /**
   * The CPU time (user and system) its thread spent running its own code, in milliseconds: a
   * script's first run and its runs from each message until idle (D87), not the thread's upkeep.
   */
  cpuMs?: number;
  /** Its heap in use, in bytes. */
  heapBytes?: number;
}

/** A node's cost, as `GET /status` gives it (`PluginControl.cost`). */
export interface NodeCost {
  dispatch: DispatchCost;
  own?: OwnCost;
}

/** The handlers' time per node, as the core dispatches to them. */
export class Costs {
  private readonly byNode = new Map<string, DispatchCost>();

  /** Runs `fn`, a handler of `node`'s, and counts its time; what it returns. */
  time<T>(node: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - start;
      let c = this.byNode.get(node);
      if (c === undefined) this.byNode.set(node, (c = { calls: 0, ms: 0, maxMs: 0 }));
      c.calls += 1;
      c.ms += ms;
      if (ms > c.maxMs) c.maxMs = ms;
    }
  }

  /** A node's, so far: none yet, all zero. */
  of(node: string): DispatchCost {
    const c = this.byNode.get(node);
    return c === undefined ? { calls: 0, ms: 0, maxMs: 0 } : { ...c };
  }
}
