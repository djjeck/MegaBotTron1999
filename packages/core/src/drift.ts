/**
 * Parser drift (docs/bot-os-api.md §4.7, P5): every message a parser claims but cannot read is
 * reported, with the text that failed, and too many of them stop what acts on that parser (D64).
 *
 * - The parser contract: each message a parser sees is `not-mine` (not its bot's), `read`, or
 *   `unread` (its bot's, in a form it does not know).
 * - Each unread message is logged (`core.drift`, with its text), counted per parser, and told to
 *   the owner: the first at once, then at most once an hour, with how many came meanwhile.
 * - Unrecoverable (bot-os.md D21): more than `unreadAt` (5) unread messages from one parser within
 *   `windowMin` (15) minutes. Then `pause` is called once with why, and not again until the rate
 *   has fallen back under the threshold.
 */
import { type Clock } from './clock.ts';

/** What a parser made of one message. */
export type Reading<E = unknown> =
  | { kind: 'not-mine' }
  | { kind: 'read'; events: E[] }
  | { kind: 'unread'; text: string; lines: string[]; events: E[] };

/** A parser's reports, through its context. */
export interface DriftReporter {
  /** A message of its bot it read. */
  read(t?: number): void;
  /** A message of its bot it could not read, with the lines it did not know. */
  unread(m: { text: string; lines?: readonly string[]; t?: number }): void;
}

/** When drift is unrecoverable: more than `unreadAt` unread messages in `windowMin` minutes. */
export interface DriftThreshold {
  unreadAt: number;
  windowMin: number;
}

export const DEFAULT_DRIFT: DriftThreshold = { unreadAt: 5, windowMin: 15 };

export interface DriftCounts {
  parser: string;
  read: number;
  unread: number;
  /** Unread within the window now. */
  recent: number;
  /** Whether the parser's dependents were paused for it, and the rate has not fallen back yet. */
  tripped: boolean;
}

/** A drift record of the log. */
export interface DriftRecord {
  type: 'core.drift';
  t: number;
  plugin: string;
  event: 'unread' | 'pause';
  [field: string]: unknown;
}

export interface DriftOptions {
  clock: Clock;
  record?: (r: DriftRecord) => void;
  notify?: (text: string) => void;
  /** The threshold of a parser: its manifest's, or the default. */
  threshold?: (parser: string) => DriftThreshold;
  /** Stops what acts on the parser (bot-os.md D64); returns the plugins stopped. */
  pause: (parser: string, reason: string) => string[];
}

interface Counter {
  read: number;
  unread: number;
  times: number[];
  tripped: boolean;
  /** When the owner was last told of an unread message, and how many came since. */
  toldAt: number;
  untold: number;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The text of a message as told and logged: short enough for a notification. */
const excerpt = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

export class DriftMonitor {
  private readonly o: DriftOptions;
  private readonly counters = new Map<string, Counter>();

  constructor(options: DriftOptions) {
    this.o = options;
  }

  /** A parser's way to report. */
  reporter(parser: string): DriftReporter {
    return {
      read: () => {
        this.counter(parser).read++;
      },
      unread: (m) => this.unread(parser, m.text, m.lines ?? [], m.t ?? this.o.clock.now()),
    };
  }

  /** Every parser's counts, by id. */
  counts(): DriftCounts[] {
    const now = this.o.clock.now();
    return [...this.counters].map(([parser, c]) => ({
      parser,
      read: c.read,
      unread: c.unread,
      recent: this.recent(parser, c, now).length,
      tripped: c.tripped,
    }));
  }

  private counter(parser: string): Counter {
    let c = this.counters.get(parser);
    if (c === undefined) {
      c = {
        read: 0,
        unread: 0,
        times: [],
        tripped: false,
        toldAt: Number.NEGATIVE_INFINITY,
        untold: 0,
      };
      this.counters.set(parser, c);
    }
    return c;
  }

  private threshold(parser: string): DriftThreshold {
    return this.o.threshold?.(parser) ?? DEFAULT_DRIFT;
  }

  private recent(parser: string, c: Counter, now: number): number[] {
    const windowMs = this.threshold(parser).windowMin * MINUTE;
    c.times = c.times.filter((x) => now - x <= windowMs);
    return c.times;
  }

  private unread(parser: string, text: string, lines: readonly string[], t: number): void {
    const c = this.counter(parser);
    const now = this.o.clock.now();
    c.unread++;
    c.times.push(t);
    this.o.record?.({
      type: 'core.drift',
      t,
      plugin: parser,
      event: 'unread',
      text,
      ...(lines.length === 0 ? {} : { lines: [...lines] }),
    });
    if (now - c.toldAt >= HOUR) {
      const more = c.untold === 0 ? '' : ` (and ${c.untold} more since the last told)`;
      this.o.notify?.(`Drift: ${parser} could not read a message${more}: ${excerpt(text)}`);
      c.toldAt = now;
      c.untold = 0;
    } else c.untold++;
    const { unreadAt, windowMin } = this.threshold(parser);
    const recent = this.recent(parser, c, now).length;
    if (recent <= unreadAt) {
      c.tripped = false;
      return;
    }
    if (c.tripped) return;
    c.tripped = true;
    const reason = `drift: ${parser} could not read ${recent} messages in ${windowMin} minutes`;
    const paused = this.o.pause(parser, reason);
    this.o.record?.({ type: 'core.drift', t: now, plugin: parser, event: 'pause', reason, paused });
    this.o.notify?.(
      paused.length === 0
        ? `Drift: ${reason}; nothing that acts depends on it`
        : `Drift: ${reason}; stopped ${paused.join(', ')} until you clear the stop in the editor`
    );
  }
}
