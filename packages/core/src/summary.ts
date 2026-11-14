/**
 * The owner's summary (docs/bot-os-api.md §4.17, bot-os.md D92, #46): what happened in the instance
 * over a window of time, in a few lines, for a node that tells the owner on a cadence
 * (`owner-notice`), and what the instance runs as it starts.
 *
 * - **Contributed** by the plugins whose manifest declares `summary: true` (`ctx.summary`): each
 *   gives a function of the window (`contribute`) that says, in owner-facing lines naming nodes by
 *   id, what it did in it (a state node's events applied and refused, a parser's answers read), or
 *   nothing when it did nothing. A `Tally` counts what it needs by time, for the windows asked.
 * - **The core's own lines** come first: each node's sends by outcome (but those of the nodes that
 *   tell the owner, `notices: true`, whose sends are the summaries themselves), and the notices
 *   raised (§4.16), counted by kind.
 * - **Collected** by a node that tells the owner (`collect`): a section per contributor that had
 *   something to say. None: nothing happened, and no summary goes.
 * - **The instance** as it runs (`instance`): its release and commit, when it started, and each
 *   node with its plugin and state, for a start notice.
 *
 * Kept in memory only: what a window reaches back to is what happened since the start, at most
 * `TALLY_KEPT_MS` ago.
 */
import { type Clock } from './clock.ts';

/** How far back a tally keeps what it counted: the longest window a summary may cover. */
export const TALLY_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** How many times a tally keeps per key, its oldest dropped beyond: a bound on its memory. */
export const TALLY_MAX = 100_000;

/**
 * What a summary covers: from `since` (included) to `until` (excluded), in ms, so that what
 * happens as one summary goes is in the next.
 */
export interface SummaryWindow {
  since: number;
  until: number;
}

/** A contributor's lines for a window: none when nothing happened in it. */
export type SummaryLines = (window: SummaryWindow) => readonly string[] | undefined;

/** A contributor's part of a summary: its title (its node's id, or the core's own), its lines. */
export interface SummarySection {
  title: string;
  /** The node it is about; none for the core's own sections. */
  node?: string;
  lines: string[];
}

/** A node as a start notice names it. */
export interface NodeSummary {
  id: string;
  plugin: string;
  state: string;
  /** Why it failed, is stopped, or is inactive. */
  reason?: string;
}

/** The instance as it runs, for a start notice. */
export interface InstanceSummary {
  /** The release it runs, and the commit its image was built from, when the wiring says. */
  version?: string;
  commit?: string;
  /** When the core started, in ms. */
  startedAt?: number;
  /** Every node of the graph, in load order. */
  nodes: NodeSummary[];
}

/** A plugin's way to the owner's summary, when its manifest declares `summary: true`. */
export interface SummaryHandle {
  /**
   * Adds its lines to every summary: `lines(window)` says what it did in the window, none when it
   * did nothing. Returns the way to stop.
   */
  contribute(lines: SummaryLines): () => void;
  /**
   * Every contributor's lines for a window, the core's first, then the nodes' in load order; only
   * those with something to say. For a node that tells the owner.
   */
  collect(window: SummaryWindow): SummarySection[];
  /** The instance as it runs: its release, its commit, its start, and each node's state. */
  instance(): InstanceSummary;
}

/**
 * Counts by key and time, for the windows a summary asks: `add` as things happen, `count` or
 * `counts` over a window. Keeps `TALLY_KEPT_MS` back, at most `TALLY_MAX` times per key.
 */
export class Tally {
  private readonly clock: Pick<Clock, 'now'>;
  private readonly times = new Map<string, number[]>();

  constructor(clock: Pick<Clock, 'now'>) {
    this.clock = clock;
  }

  /** One more of `key` now (or `n` more). */
  add(key: string, n = 1): void {
    const now = this.clock.now();
    let ts = this.times.get(key);
    if (ts === undefined) this.times.set(key, (ts = []));
    for (let i = 0; i < n; i++) ts.push(now);
    let old = 0;
    while (old < ts.length && (ts[old] as number) < now - TALLY_KEPT_MS) old++;
    old = Math.max(old, ts.length - TALLY_MAX);
    if (old > 0) ts.splice(0, old);
  }

  /** How many of `key` in the window. */
  count(key: string, w: SummaryWindow): number {
    let n = 0;
    for (const t of this.times.get(key) ?? []) if (t >= w.since && t < w.until) n++;
    return n;
  }

  /** Every key counted in the window, with its count, in the order first added; none at 0. */
  counts(w: SummaryWindow): [string, number][] {
    return [...this.times.keys()].flatMap((k): [string, number][] => {
      const n = this.count(k, w);
      return n > 0 ? [[k, n]] : [];
    });
  }
}

/** `n thing(s)`. */
export const counted = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** The outcomes of a send, in the order a summary lists them. */
const OUTCOMES = ['sent', 'dry-run', 'refused', 'failed', 'cancelled', 'expired'];

interface Contributor {
  node: string;
  lines: SummaryLines;
}

export interface SummariesOptions {
  clock: Pick<Clock, 'now'>;
  /** The nodes in load order (their order in a summary), each with its plugin and state. */
  nodes(): NodeSummary[];
  /** The nodes that tell the owner (`notices: true`): their sends are left out. */
  tellers(): ReadonlySet<string>;
  /** The release and commit, when the wiring says. */
  build?: { version: string; commit?: string };
  /** A contributor that threw, logged against its node. */
  error?: (node: string, line: string) => void;
}

/** The instance's summary: its contributors, and the core's own counts. */
export class Summaries {
  private readonly o: SummariesOptions;
  private contributors: Contributor[] = [];
  /** Sends by node and outcome (`<node> <outcome>`). */
  private readonly sends: Tally;
  /** Notices raised, by kind. */
  private readonly noticeKinds: Tally;
  private startedAt?: number;

  constructor(options: SummariesOptions) {
    this.o = options;
    this.sends = new Tally(options.clock);
    this.noticeKinds = new Tally(options.clock);
  }

  /** The core started. */
  started(): void {
    this.startedAt = this.o.clock.now();
  }

  /** A node's send, with its outcome (the outbox's record of it). */
  sent(node: string, outcome: string): void {
    this.sends.add(`${node} ${outcome}`);
  }

  /** A notice raised. */
  noticed(kind: string): void {
    this.noticeKinds.add(kind);
  }

  /** A node's handle. */
  handle(node: string): SummaryHandle {
    return {
      contribute: (lines) => {
        const c: Contributor = { node, lines };
        this.contributors.push(c);
        return () => {
          this.contributors = this.contributors.filter((x) => x !== c);
        };
      },
      collect: (w) => this.collect(w),
      instance: () => this.instance(),
    };
  }

  instance(): InstanceSummary {
    return {
      ...(this.o.build === undefined ? {} : { version: this.o.build.version }),
      ...(this.o.build?.commit === undefined ? {} : { commit: this.o.build.commit }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      nodes: this.o.nodes(),
    };
  }

  collect(w: SummaryWindow): SummarySection[] {
    const out: SummarySection[] = [];
    const tellers = this.o.tellers();
    const byNode = new Map<string, Map<string, number>>();
    for (const [key, n] of this.sends.counts(w)) {
      const at = key.lastIndexOf(' ');
      const node = key.slice(0, at);
      if (tellers.has(node)) continue;
      const m = byNode.get(node) ?? new Map<string, number>();
      m.set(key.slice(at + 1), n);
      byNode.set(node, m);
    }
    const order = this.o.nodes().map((x) => x.id);
    const rank = (node: string): number => {
      const i = order.indexOf(node);
      return i < 0 ? order.length : i;
    };
    const sendLines = [...byNode]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(
        ([node, m]) =>
          `${node} ${[...m]
            .sort(([a], [b]) => OUTCOMES.indexOf(a) - OUTCOMES.indexOf(b))
            .map(([outcome, n]) => `${n} ${outcome}`)
            .join(', ')}`
      );
    if (sendLines.length > 0) out.push({ title: 'Sends', lines: sendLines });
    const kinds = this.noticeKinds.counts(w);
    if (kinds.length > 0)
      out.push({ title: 'Notices', lines: [kinds.map(([k, n]) => `${n} ${k}`).join(', ')] });
    const contributors = [...this.contributors].sort((a, b) => rank(a.node) - rank(b.node));
    for (const c of contributors) {
      let lines: readonly string[] | undefined;
      try {
        lines = c.lines(w);
      } catch (e) {
        this.o.error?.(c.node, `its summary lines: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const kept = (lines ?? []).filter((l) => l.trim() !== '');
      if (kept.length > 0) out.push({ title: c.node, node: c.node, lines: [...kept] });
    }
    return out;
  }
}
