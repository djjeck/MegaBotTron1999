/**
 * The instance's record (docs/bot-os-api.md §4.4): every event published on the bus and every
 * record the core and the plugins write, one JSON object per line, in a file per UTC day
 * (`events-2026-10-22.jsonl`). Append-only, so that a run can be replayed and read back.
 *
 * Every record's type is namespaced, `<namespace>.<name>`. Records written before the core had
 * plain types (`message`, `command`, …): the instance gives the table of their namespaced names
 * (`legacy`), under which they are written from now on and read back from the old files, so that
 * a reader sees one name for each kind of record, whatever day it was written.
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

export class EventLog {
  readonly dir: string;
  private readonly legacy: Readonly<Record<string, string>>;

  constructor(dir: string, options: { legacy?: Readonly<Record<string, string>> } = {}) {
    this.dir = dir;
    this.legacy = options.legacy ?? {};
    fs.mkdirSync(dir, { recursive: true });
  }

  /** The file a record of time `t` goes to. */
  fileFor(t: number): string {
    return path.join(this.dir, `events-${new Date(t).toISOString().slice(0, 10)}.jsonl`);
  }

  /** The namespaced name of a type: itself, or its name in the table of old ones. */
  typeOf(type: string): string {
    return Object.hasOwn(this.legacy, type) ? (this.legacy[type] as string) : type;
  }

  /** Appends a record, under its namespaced type. */
  write(record: { type: string; t: number }): void {
    const type = this.typeOf(record.type);
    const out = type === record.type ? record : { ...record, type };
    fs.appendFileSync(this.fileFor(record.t), `${JSON.stringify(out)}\n`);
  }

  /** The start of the first day logged, or undefined for an empty log. */
  firstDay(): number | undefined {
    const days = fs
      .readdirSync(this.dir)
      .map((f) => DAY.exec(f)?.[1])
      .filter((d) => d !== undefined)
      .sort();
    return days[0] === undefined ? undefined : Date.parse(`${days[0]}T00:00:00Z`);
  }

  /** Every record from `since` to `until`, in time order, under its namespaced type. */
  recordsSince(since: number, until: number): LogEntry[] {
    const out: LogEntry[] = [];
    for (let day = since - (since % 86_400_000); day <= until; day += 86_400_000) {
      const file = this.fileFor(day);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line === '') continue;
        let r: { type?: unknown; t?: unknown } & Record<string, unknown>;
        try {
          r = JSON.parse(line) as typeof r;
        } catch {
          // A line cut short by a crash: the rest of the log still counts.
          continue;
        }
        if (typeof r.type === 'string' && typeof r.t === 'number' && r.t >= since && r.t <= until)
          out.push({ ...r, type: this.typeOf(r.type), t: r.t });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
}
