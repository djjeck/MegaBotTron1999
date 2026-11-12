/**
 * The instance's record (docs/bot-os-api.md §4.4): every event published on the bus and every
 * record the core and the plugins write, one JSON object per line, in a file per UTC day
 * (`events-2026-10-22.jsonl`). Append-only, so that a run can be replayed and read back. Every
 * record's type is namespaced, `<namespace>.<name>`.
 *
 * A record goes to the file of its own time's day, so a record of an old time (a missed message,
 * published late) is appended to an old day's file. A place in the log is therefore a day's: a
 * reader's cursor says how far into each day file it has read (bot-os.md D72), never one count
 * across the log.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A record as the log holds it. */
export interface LogEntry {
  type: string;
  t: number;
  [field: string]: unknown;
}

const DAY = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const DAY_MS = 86_400_000;

/**
 * Where a record sits in the log (bot-os.md D72): its day file (`2026-11-12`, the UTC day of its
 * `t`), and how far into that file it ends: in bytes for the files, in records for the log in
 * memory.
 */
export interface LogPosition {
  day: string;
  end: number;
}

/**
 * How far a reader has read the log (bot-os.md D72): for each day file, the length of it read, in
 * the unit of its positions; a day it does not name is not read at all. A record of a day that
 * ends at or before that length is behind the cursor; one that ends after it, ahead. Files only
 * grow, so a cursor stays true across restarts, whatever was appended to whichever day since.
 */
export type LogCursor = Record<string, number>;

/** What a reader finds after its cursor: the records, in the log's order, and the cursor past them. */
export interface LogTail {
  entries: { entry: LogEntry; at: LogPosition }[];
  cursor: LogCursor;
}

/** The event log, read back: what a plugin's `ctx.events` reads (§4.4). */
export interface EventReader {
  /** Every record from `since` to `until`, in time order. */
  recordsSince(since: number, until: number): LogEntry[];
  /** The start of the first day logged, or undefined for an empty log. */
  firstDay(): number | undefined;
  /**
   * Every record written after `cursor` (bot-os.md D72): each day file's from where the cursor
   * left it (from its start, for a day it does not name), in the order written, the days merged by
   * time; and the cursor past them, each day at the end of its last whole line.
   */
  after(cursor: LogCursor): LogTail;
}

/** The UTC day of a time, as the log's files name it. */
export const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Whether a position is behind a cursor: read already. */
export const behind = (at: LogPosition, cursor: LogCursor): boolean =>
  at.end <= (cursor[at.day] ?? 0);

type Placed = LogTail['entries'][number];

/**
 * The days' records merged into one sequence: each day's in its own order, the next taken from
 * the day whose next record is the earliest (ties to the earlier day).
 */
function merge(days: Placed[][]): Placed[] {
  const out: Placed[] = [];
  const heads = days.map(() => 0);
  for (;;) {
    let best: number | undefined;
    let earliest: Placed | undefined;
    days.forEach((list, d) => {
      const next = list[heads[d] as number];
      if (next !== undefined && (earliest === undefined || next.entry.t < earliest.entry.t)) {
        best = d;
        earliest = next;
      }
    });
    if (best === undefined || earliest === undefined) return out;
    out.push(earliest);
    heads[best] = (heads[best] as number) + 1;
  }
}

/** An event log in memory: the dev kit's, its history given and its records kept. */
export class MemoryEventLog implements EventReader {
  readonly records: LogEntry[] = [];
  /** Each day's records, in the order written: the day files of the log in memory. */
  private readonly days = new Map<string, LogEntry[]>();

  constructor(history: readonly LogEntry[] = []) {
    for (const r of history) this.write(r);
  }

  /** Appends a record; where it sits: its day, and that day's count of records with it. */
  write<R extends { type: string; t: number }>(record: R): LogPosition {
    const entry: LogEntry = { ...record };
    this.records.push(entry);
    const day = dayOf(record.t);
    const list = this.days.get(day) ?? [];
    this.days.set(day, list);
    list.push(entry);
    return { day, end: list.length };
  }

  recordsSince(since: number, until: number): LogEntry[] {
    return this.records.filter((r) => r.t >= since && r.t <= until).sort((a, b) => a.t - b.t);
  }

  firstDay(): number | undefined {
    const first = Math.min(...this.records.map((r) => r.t));
    return Number.isFinite(first) ? first - (first % DAY_MS) : undefined;
  }

  after(cursor: LogCursor): LogTail {
    const next: LogCursor = { ...cursor };
    const days = [...this.days.keys()].sort().map((day) => {
      const list = this.days.get(day) as LogEntry[];
      const from = Math.min(cursor[day] ?? 0, list.length);
      next[day] = list.length;
      return list.slice(from).map((entry, i) => ({ entry, at: { day, end: from + i + 1 } }));
    });
    return { entries: merge(days), cursor: next };
  }
}

export class EventLog implements EventReader {
  readonly dir: string;
  /** The files this process has written to, each known to end with a whole line. */
  private readonly whole = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** The file a record of time `t` goes to. */
  fileFor(t: number): string {
    return this.fileOf(dayOf(t));
  }

  private fileOf(day: string): string {
    return path.join(this.dir, `events-${day}.jsonl`);
  }

  /**
   * Appends a record; where it sits: its day, and its file's length with it. A file a crash left
   * with half a line gets a line break first, so that the half line stays one unreadable line of
   * its own and the record a whole one.
   */
  write<R extends { type: string; t: number }>(record: R): LogPosition {
    const day = dayOf(record.t);
    const file = this.fileOf(day);
    let line = `${JSON.stringify(record)}\n`;
    if (!this.whole.has(file)) {
      this.whole.add(file);
      if (!endsWhole(file)) line = `\n${line}`;
    }
    fs.appendFileSync(file, line);
    return { day, end: fs.statSync(file).size };
  }

  /** The start of the first day logged, or undefined for an empty log. */
  firstDay(): number | undefined {
    const first = this.days()[0];
    return first === undefined ? undefined : Date.parse(`${first}T00:00:00Z`);
  }

  /** Every record from `since` to `until`, in time order. */
  recordsSince(since: number, until: number): LogEntry[] {
    const out: LogEntry[] = [];
    for (let day = since - (since % DAY_MS); day <= until; day += DAY_MS) {
      const file = this.fileFor(day);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const r = parse(line);
        if (r !== undefined && r.t >= since && r.t <= until) out.push(r);
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  after(cursor: LogCursor): LogTail {
    const next: LogCursor = { ...cursor };
    const days = this.days().map((day) => {
      const file = this.fileOf(day);
      const size = fs.statSync(file).size;
      // A file shorter than the cursor was replaced (a backup put back by hand): what it holds up
      // to its length counts as read, so that nothing of it is read twice.
      const from = Math.min(cursor[day] ?? 0, size);
      next[day] = from;
      const out: Placed[] = [];
      if (size === from) return out;
      const bytes = Buffer.alloc(size - from);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, bytes, 0, bytes.length, from);
      } finally {
        fs.closeSync(fd);
      }
      // Whole lines only: a line not ended yet is read once it is.
      let start = 0;
      for (let nl = bytes.indexOf(10); nl >= 0; nl = bytes.indexOf(10, start)) {
        const r = parse(bytes.subarray(start, nl).toString('utf8'));
        start = nl + 1;
        next[day] = from + start;
        if (r !== undefined) out.push({ entry: r, at: { day, end: from + start } });
      }
      return out;
    });
    return { entries: merge(days), cursor: next };
  }

  /** The days logged, in order. */
  private days(): string[] {
    return fs
      .readdirSync(this.dir)
      .map((f) => DAY.exec(f)?.[1])
      .filter((d) => d !== undefined)
      .sort();
  }
}

/** A line of the log as a record; undefined for an empty line, or one cut short by a crash. */
function parse(line: string): LogEntry | undefined {
  if (line === '') return undefined;
  let r: { type?: unknown; t?: unknown } & Record<string, unknown>;
  try {
    r = JSON.parse(line) as typeof r;
  } catch {
    // A line cut short by a crash: the rest of the log still counts.
    return undefined;
  }
  return typeof r.type === 'string' && typeof r.t === 'number'
    ? { ...r, type: r.type, t: r.t }
    : undefined;
}

/** Whether a file is missing, empty, or ends with a line break. */
function endsWhole(file: string): boolean {
  if (!fs.existsSync(file)) return true;
  const size = fs.statSync(file).size;
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, last, 0, 1, size - 1);
  } finally {
    fs.closeSync(fd);
  }
  return last[0] === 10;
}
