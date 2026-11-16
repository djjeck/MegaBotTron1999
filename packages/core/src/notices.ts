/**
 * The owner's notices (docs/bot-os-api.md §4.16, bot-os.md D91): what happened in the instance
 * that needs the owner's attention, as it happens, for a node that tells the owner (`owner-notice`)
 * rather than for the owner to find in the log. One feed per instance:
 *
 * - **raised** by the core (`failed`, `cascade`, `drift`, `coalesced`, `warning`, `stalled`,
 *   `graph-refused`, `backoff`, `unanswered`) at the point where it acts, by a plugin through
 *   `ctx.notice` (a state node's `refused`, D72) and through `ctx.notify` (`told`, with its buttons, D94), each with the node it
 *   is about, and one owner-facing line naming nodes by id;
 * - **recorded** in the event log as it is raised (`core.notice`), so that the editor's events
 *   panel shows every notice, told or not: with no node to tell the owner, it is all there is
 *   (D94: the core tells no chat itself);
 * - **heard** by the nodes whose manifest declares `notices: true` (`ctx.notices`): each new
 *   subscriber first hears the notices raised since the instance started (the newest
 *   `NOTICES_KEPT`), so that what happened before it started (the load's warnings, a node failed
 *   as it started) still reaches it; then each as it is raised.
 *
 * Kept in memory for the subscribers; the event log keeps each as `core.notice`.
 */
import { type Buttons } from './commands.ts';

/** The kinds the core and the shell's plugins raise; a plugin may raise its own. */
export const NOTICE_KINDS = [
  'refused',
  'coalesced',
  'drift',
  'cascade',
  'failed',
  'warning',
  'stalled',
  'unreachable',
  'told',
  'graph-refused',
  'backoff',
  'unanswered',
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
   * (`warning`), a node the send-queue watchdog paused (`stalled`, bot-os.md D93), a plugin's
   * message for the owner (`told`, `ctx.notify`, D94), the saved graph refused at the load, no node
   * running (`graph-refused`, D94), a send the network refused (`unreachable`, D95), a node the
   * retry-loop guard holds back (`backoff`, D98), a command no answer came for (`unanswered`,
   * D107), or a plugin's own kind.
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
   * reason of a cascade or a failure; a stall's `account`, `chat`, `command`, `count` and `reason`;
   * a drift's `unread` message; a told message's `buttons`; a refused graph's `problems`; a send
   * refused's `account`, `chat` and `reason`; a backoff's `account`, `chat`, `command`, `reason`
   * and `count`; an unanswered command's `account`, `chat`, `command` and `withinS`; a migration's
   * `edges` added.
   */
  detail?: Readonly<Record<string, unknown>>;
}

/**
 * The buttons a `told` notice carries (`ctx.notify`, D94), each a command a tap runs, for a node
 * that tells it where a tap can run them; none when it carries none, or not as rows of buttons.
 */
export function buttonsOf(notice: Notice): Buttons | undefined {
  const b = notice.detail?.['buttons'];
  const isButton = (x: unknown): boolean =>
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { label?: unknown }).label === 'string' &&
    typeof (x as { action?: unknown }).action === 'string';
  return Array.isArray(b) &&
    b.length > 0 &&
    b.every((row) => Array.isArray(row) && row.every(isButton))
    ? (b as Buttons)
    : undefined;
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
