/**
 * The owner's notices (docs/bot-os-api.md §4.16, bot-os.md D91): what happened in the instance
 * that needs the owner's attention, as it happens, for a node that tells the owner (`owner-notice`)
 * rather than for the owner to find in the log. One feed per instance:
 *
 * - **raised** by the core (`failed`, `cascade`, `drift`, `coalesced`, `warning`) at the point
 *   where it acts, and by a plugin through `ctx.notice` (a state node's `refused`, D72), each with
 *   the node it is about, and one owner-facing line naming nodes by id;
 * - **heard** by the nodes whose manifest declares `notices: true` (`ctx.notices`): each new
 *   subscriber first hears the notices raised since the instance started (the newest
 *   `NOTICES_KEPT`), so that what happened before it started (the load's warnings, a node failed
 *   as it started) still reaches it; then each as it is raised.
 *
 * Kept in memory only: the event log has the records each notice was raised beside.
 */

/** The kinds the core and the shell's plugins raise; a plugin may raise its own. */
export const NOTICE_KINDS = [
  'refused',
  'coalesced',
  'drift',
  'cascade',
  'failed',
  'warning',
] as const;
export type CoreNoticeKind = (typeof NOTICE_KINDS)[number];

/** A notice's kind: lower-case words and dashes (`refused`, a plugin's `watchdog`). */
export const NOTICE_KIND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** How many of the notices raised since the start a new subscriber hears first. */
export const NOTICES_KEPT = 200;

/** One thing for the owner's attention. */
export interface Notice {
  /**
   * What happened: an event a state node refused (`refused`), a send several nodes shared
   * (`coalesced`), a parser's drift that paused what acts on it (`drift`), a node a runtime stop's
   * cascade made inactive (`cascade`), a node failed (`failed`), a warning of the graph's check
   * (`warning`), or a plugin's own kind.
   */
  kind: string;
  /** When, in ms. */
  t: number;
  /** The node it is about, by id; none for the instance's (a warning of no node). */
  node?: string;
  /** One line, for the owner, naming nodes by id. */
  text: string;
  /**
   * What it is, by fields a listener may group by: a refused event's `event` type and `reason`; a
   * coalesced send's `chat`, `text` and the other nodes (`with`); a drift's `paused` nodes; the
   * reason of a cascade or a failure.
   */
  detail?: Readonly<Record<string, unknown>>;
}

/** A node's way to the notices, when its manifest declares `notices: true`. */
export interface NoticesHandle {
  /**
   * Hears every notice: those raised since the instance started first, in order, then each as it
   * is raised. Returns the way to stop.
   */
  subscribe(handler: (notice: Notice) => void): () => void;
}

interface Subscriber {
  plugin: string;
  handler: (notice: Notice) => void;
}

export interface NoticesOptions {
  /** A subscriber that threw, logged against its node. */
  error?: (plugin: string, line: string) => void;
  /** Takes the secrets out of what is raised. */
  redact?: (text: string) => string;
}

/** The instance's feed of notices. */
export class Notices {
  private readonly o: NoticesOptions;
  private readonly kept: Notice[] = [];
  private subscribers: Subscriber[] = [];

  constructor(options: NoticesOptions = {}) {
    this.o = options;
  }

  /** Raises a notice: kept, and heard by every subscriber. */
  raise(notice: Notice): void {
    if (!NOTICE_KIND.test(notice.kind)) throw new Error(`not a notice kind: ${notice.kind}`);
    const n: Notice = { ...notice, text: this.o.redact?.(notice.text) ?? notice.text };
    this.kept.push(n);
    if (this.kept.length > NOTICES_KEPT) this.kept.shift();
    for (const s of [...this.subscribers]) this.deliver(s, n);
  }

  /** The notices raised since the start, the newest `NOTICES_KEPT`, in order. */
  recent(): Notice[] {
    return [...this.kept];
  }

  /** Subscribes a node: what was raised so far first, then what is raised. */
  subscribe(plugin: string, handler: (notice: Notice) => void): () => void {
    const s: Subscriber = { plugin, handler };
    for (const n of [...this.kept]) this.deliver(s, n);
    this.subscribers.push(s);
    return () => {
      this.subscribers = this.subscribers.filter((x) => x !== s);
    };
  }

  /** Every subscription of a node dropped: it is down. */
  drop(plugin: string): void {
    this.subscribers = this.subscribers.filter((s) => s.plugin !== plugin);
  }

  private deliver(s: Subscriber, n: Notice): void {
    try {
      s.handler(n);
    } catch (e) {
      this.o.error?.(s.plugin, `a notice's handler: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
