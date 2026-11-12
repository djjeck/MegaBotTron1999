/**
 * The graph's history (docs/bot-os-api.md §2.3, bot-os.md D61): every graph written to the file
 * (a save, a rollback) kept as a version in the volume, `<data>/graph-history/<id>.json`, the id
 * its time (ISO 8601, `:` written `-`, and `-1`, `-2`… after it for two in the same millisecond):
 *
 * ```json
 * {
 *   "time": "2026-11-12T10:00:00.000Z",
 *   "source": "save",
 *   "summary": "+ node examine; − edge a.chat → b.chat; ~ node x: config",
 *   "restores": "2026-11-11T09-30-00.000Z",
 *   "start": { "result": "ran", "at": "2026-11-12T10:00:05.000Z" },
 *   "graph": { "version": 2, "nodes": [], "edges": [] }
 * }
 * ```
 *
 * - `source`: a save (`PUT /graph/file`), a rollback (which names the version it `restores`), a
 *   file found at a start that no version holds (written by hand: `found`), or one of the files the
 *   history replaced (`graph.previous.json`, `graph.json`), taken in at its first start
 *   (`migrated`).
 * - `summary`: what changed from the version before, on one line.
 * - `start`: how the instance last started on it: it `ran`, or it was `refused`, with why; none if
 *   it never started on it.
 *
 * Versions are kept 7 days, and never fewer than the 5 latest; the others are pruned at each new
 * one. This store knows nothing of graphs: the graph file (`graph-file.ts`) says what to keep.
 *
 * Nothing in here knows of any game.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The history's directory, in the data volume. */
export const GRAPH_HISTORY_DIR = 'graph-history';
/** How long a version is kept, in days… */
export const HISTORY_DAYS = 7;
/** …but never fewer than this many of the latest. */
export const HISTORY_KEEP = 5;

const DAY = 86_400_000;

/** How the instance last started on a version: it ran, or it was refused, with why. */
export interface GraphStart {
  result: 'ran' | 'refused';
  /** When, as ISO 8601. */
  at: string;
  problems?: string[];
}

/** Where a version comes from. */
export type GraphVersionSource = 'save' | 'rollback' | 'found' | 'migrated';

/** A version of the graph, without its graph. */
export interface GraphVersionMeta {
  id: string;
  /** When it was written, as ISO 8601. */
  time: string;
  source: GraphVersionSource;
  /** What changed from the version before, on one line. */
  summary: string;
  /** A rollback's: the version it restored. */
  restores?: string;
  /** How the instance last started on it; none if it never did. */
  start?: GraphStart;
}

/** A version of the graph, with its graph as written. */
export interface GraphVersion extends GraphVersionMeta {
  graph: unknown;
}

/** An id that names a file of the history, and nothing outside it. */
const ID = /^[0-9A-Za-z][0-9A-Za-z.-]*$/u;
const SOURCES: readonly string[] = ['save', 'rollback', 'found', 'migrated'];

/** Newest first: by time, then by id (`…Z-1` after `…Z`). */
const newestFirst = (a: GraphVersionMeta, b: GraphVersionMeta): number =>
  a.time !== b.time
    ? b.time.localeCompare(a.time)
    : b.id.length - a.id.length || b.id.localeCompare(a.id);

/** The graph's versions, in a directory of their own. */
export class GraphHistory {
  readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  private path(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Every version kept, newest first, with its graph; a file that does not read is left out. */
  private all(): GraphVersion[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .flatMap((n) => {
        const v = n.endsWith('.json') ? this.get(n.slice(0, -'.json'.length)) : undefined;
        return v === undefined ? [] : [v];
      })
      .sort(newestFirst);
  }

  /** Every version kept, newest first, without its graph. */
  list(): GraphVersionMeta[] {
    return this.all().map(({ graph: _, ...meta }) => meta);
  }

  /** The newest version, if any. */
  latest(): GraphVersion | undefined {
    return this.all()[0];
  }

  /** A version, by its id; undefined for one not kept, or that does not read. */
  get(id: string): GraphVersion | undefined {
    if (!ID.test(id)) return undefined;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(fs.readFileSync(this.path(id), 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const { time, source, summary, restores, start, graph } = r;
    if (typeof time !== 'string' || typeof source !== 'string' || !SOURCES.includes(source))
      return undefined;
    return {
      id,
      time,
      source: source as GraphVersionSource,
      summary: typeof summary === 'string' ? summary : '',
      ...(typeof restores === 'string' ? { restores } : {}),
      ...(typeof start === 'object' && start !== null ? { start: start as GraphStart } : {}),
      graph,
    };
  }

  /**
   * Keeps a graph as the newest version, written at `time` (now by default), then prunes the
   * history. Its metadata.
   */
  record(
    graph: unknown,
    meta: { source: GraphVersionSource; summary: string; restores?: string; time?: number }
  ): GraphVersionMeta {
    fs.mkdirSync(this.dir, { recursive: true });
    const time = new Date(meta.time ?? this.now()).toISOString();
    const base = time.replaceAll(':', '-');
    let id = base;
    for (let n = 1; fs.existsSync(this.path(id)); n++) id = `${base}-${n}`;
    const version: GraphVersion = {
      id,
      time,
      source: meta.source,
      summary: meta.summary,
      ...(meta.restores === undefined ? {} : { restores: meta.restores }),
      graph,
    };
    this.write(version);
    this.prune();
    const { graph: _, ...out } = version;
    return out;
  }

  /** Says how the instance started on a version; false if there is no such version. */
  started(id: string, start: GraphStart): boolean {
    const v = this.get(id);
    if (v === undefined) return false;
    this.write({ ...v, start });
    return true;
  }

  /** Removes the versions older than `HISTORY_DAYS` days, keeping the `HISTORY_KEEP` latest. */
  prune(): void {
    const cutoff = this.now() - HISTORY_DAYS * DAY;
    this.all().forEach((v, i) => {
      if (i >= HISTORY_KEEP && Date.parse(v.time) < cutoff) fs.rmSync(this.path(v.id));
    });
  }

  /** A version written atomically: a temporary file, then a rename. */
  private write({ id, ...v }: GraphVersion): void {
    const file = this.path(id);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  }
}
