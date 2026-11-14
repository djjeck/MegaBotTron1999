/**
 * The instance's graph in its volume (docs/bot-os-api.md §2.3, bot-os.md D50): `<data>/graph.json`
 * is the only source of the instance's composition, its nodes and their edges. The core reads it at
 * start; the owner reads, checks, saves and rolls it back through the control API, and a restart
 * applies it (P8).
 *
 * - A missing file is an empty graph. A file that does not read, or that the check refuses, starts
 *   the instance with no nodes, and the file is kept as it is: the problems are reported (the
 *   status, the control API, the owner), for the owner to fix in the UI, so it never crash-loops.
 * - Every graph written (a save, a rollback) is kept as a version of the history
 *   (`graph-history.ts`, bot-os.md D61), with what changed from the one before; at each start the
 *   history says whether the instance ran the file's version or refused it. A rollback writes a
 *   version kept back as the newest. The history replaced `graph.previous.json`, which the first
 *   start with a history takes into it.
 * - A file of version 1 (one chat edge for reads and sends) is converted to version 2 as it is
 *   read (bot-os.md D60): the instance runs it, `GET /graph/file` shows it, and the check and a
 *   save take it, as version 2; the file itself is rewritten only by the next save, or rollback.
 * - A problem is located where it can be: its node, its edge, its port, its config or setting key,
 *   for the editor to mark.
 *
 * Nothing in here knows of any game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type Graph, GRAPH_VERSION, type GraphEdge, type GraphNode } from './graph.ts';
import {
  GRAPH_HISTORY_DIR,
  GraphHistory,
  type GraphVersion,
  type GraphVersionSource,
  HISTORY_DAYS,
  HISTORY_KEEP,
} from './graph-history.ts';
import {
  GRAPH_FILE,
  graphText,
  lineDiff,
  PREVIOUS_GRAPH_FILE,
  stableJson,
  writeGraphFile,
} from './graph-view.ts';

/**
 * One problem of a graph, located where it can be; a warning (bot-os.md D89) has the same shape,
 * and refuses nothing.
 */
export interface GraphProblem {
  /** The problem, in words, as the load says it. */
  text: string;
  /** The node it is about. */
  node?: string;
  /** The edge it is about, as the graph writes it. */
  edge?: { from: string; to: string };
  /** The port of `node` it is about. */
  port?: string;
  /** The key of `node`'s configuration, or of its settings, it is about. */
  config?: string;
  setting?: string;
}

/** What changes from one graph to another: nodes by id, edges by their two ends. */
export interface GraphDiff {
  nodes: { added: string[]; removed: string[]; changed: { id: string; fields: string[] }[] };
  edges: {
    added: { from: string; to: string }[];
    removed: { from: string; to: string }[];
    changed: { from: string; to: string; fields: string[] }[];
  };
}

/**
 * A graph checked: the graph as the core holds it, or the problems; and, either way, its warnings
 * (bot-os.md D89), which refuse nothing (none given: none).
 */
export type GraphCheck =
  | { ok: true; graph: Graph; warnings?: GraphProblem[] }
  | { ok: false; problems: GraphProblem[]; warnings?: GraphProblem[] };

/** What the graph's file needs of the core. */
export interface GraphChecker {
  /** Checks a graph against the plugins the instance offers, as the load does. */
  check(raw: unknown): GraphCheck;
  /** A graph file of an older version as the current one (bot-os.md D60); none: as it is. */
  upgrade?(raw: unknown): unknown;
  /** The graph the instance runs. */
  graph(): Graph | undefined;
  /** Why the saved graph was not run at start; none when it was. */
  graphProblems(): GraphProblem[];
  /** The nodes whose ports their config declares, as the editor draws them (bot-os.md D74). */
  nodeViews?(raw: unknown): Record<string, unknown>;
  /**
   * A graph written to the file (a save or a rollback), after the one before it: the audited
   * config keys it changed are recorded, with who wrote it (bot-os.md D75).
   */
  written?(before: unknown, after: Graph, o: SaveBy & { source: string; version?: string }): void;
}

/** Who writes the graph: the web UI's session, or the loopback's control API (bot-os.md D75). */
export interface SaveBy {
  by?: string;
}

/** A change to the graph's file refused, with why; `status`, the HTTP status it answers with. */
export class GraphFileError extends Error {
  readonly problems: GraphProblem[];
  readonly status: number | undefined;
  constructor(message: string, problems: GraphProblem[] = [], status?: number) {
    super(message);
    this.problems = problems;
    this.status = status;
  }
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const list = (v: unknown, key: string): unknown[] => {
  const a = record(v)?.[key];
  return Array.isArray(a) ? (a as unknown[]) : [];
};
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** An edge's two ends, as a graph (checked or not) writes them. */
function ends(e: unknown): { from: string; to: string } | undefined {
  const from = text(record(e)?.['from']);
  const to = text(record(e)?.['to']);
  return from === undefined || to === undefined ? undefined : { from, to };
}

/**
 * Where a problem of the load is (its words as the core says them), in the graph `raw` that was
 * checked: its node, edge, port, configuration key or setting.
 */
export function locateProblem(problem: string, raw: unknown): GraphProblem {
  const out: GraphProblem = { text: problem };
  const schema = /^graph: (nodes|edges)\.(\d+)(?:\.([^:]+))?:/u.exec(problem);
  if (schema !== null) {
    const item = list(raw, schema[1] as string)[Number(schema[2])];
    if (schema[1] === 'nodes') {
      const id = text(record(item)?.['id']);
      if (id !== undefined) out.node = id;
      const field = schema[3]?.split('.');
      if (field?.[0] === 'config' && field[1] !== undefined) out.config = field[1];
      if (field?.[0] === 'settings' && field[1] !== undefined) out.setting = field[1];
    } else {
      const edge = ends(item);
      if (edge !== undefined) out.edge = edge;
    }
    return out;
  }
  const node = /^(?:node|plugin) (\S+): /u.exec(problem);
  if (node !== null) out.node = node[1] as string;
  const port = /^node \S+: (?:no (?:input|output) port|(?:input|output) port) ([^\s:(]+)/u.exec(
    problem
  );
  if (port !== null) out.port = port[1] as string;
  const key = /^plugin \S+: (config|settings) ([^\s:]+):/u.exec(problem);
  if (key?.[1] === 'config' && key[2] !== '(all)') out.config = key[2] as string;
  if (key?.[1] === 'settings') out.setting = key[2] as string;
  const edge = /^edge (\S+) → (\S+):/u.exec(problem) ?? /\(edge (\S+) → (\S+)\)$/u.exec(problem);
  if (edge !== null) out.edge = { from: edge[1] as string, to: edge[2] as string };
  const cycle = /^a cycle of required edges: (\S+)/u.exec(problem);
  if (cycle !== null) out.node = cycle[1] as string;
  return out;
}

/** JSON with its keys sorted: two values that mean the same print the same. */
const stable = stableJson;

/** The fields of two records that differ, sorted. */
const changedFields = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => stable(a[k]) !== stable(b[k]))
    .sort();

/** What changes from `before` to `after`, two graphs as files hold them (checked or not). */
export function graphDiff(before: unknown, after: unknown): GraphDiff {
  const nodes = (g: unknown): Map<string, Record<string, unknown>> =>
    new Map(
      list(g, 'nodes').flatMap((n) => {
        const r = record(n);
        const id = text(r?.['id']);
        return r === undefined || id === undefined ? [] : [[id, r] as const];
      })
    );
  const edges = (
    g: unknown
  ): Map<string, { from: string; to: string; value: Record<string, unknown> }> =>
    new Map(
      list(g, 'edges').flatMap((e) => {
        const at = ends(e);
        return at === undefined
          ? []
          : [[`${at.from} → ${at.to}`, { ...at, value: record(e) ?? {} }] as const];
      })
    );
  const [a, b] = [nodes(before), nodes(after)];
  const [x, y] = [edges(before), edges(after)];
  return {
    nodes: {
      added: [...b.keys()].filter((id) => !a.has(id)),
      removed: [...a.keys()].filter((id) => !b.has(id)),
      changed: [...b].flatMap(([id, n]) => {
        const old = a.get(id);
        if (old === undefined) return [];
        const fields = changedFields(old, n);
        return fields.length === 0 ? [] : [{ id, fields }];
      }),
    },
    edges: {
      added: [...y].filter(([k]) => !x.has(k)).map(([, e]) => ({ from: e.from, to: e.to })),
      removed: [...x].filter(([k]) => !y.has(k)).map(([, e]) => ({ from: e.from, to: e.to })),
      changed: [...y].flatMap(([k, e]) => {
        const old = x.get(k);
        const fields = old === undefined ? [] : changedFields(old.value, e.value);
        return fields.length === 0 ? [] : [{ from: e.from, to: e.to, fields }];
      }),
    },
  };
}

/** Whether two graphs are the same, keys in any order. */
export const sameGraph = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** How many changes a summary names before it counts the rest. */
const SUMMARY_ITEMS = 8;

/**
 * A diff on one line, for the history (`+ node examine; − edge a.chat → b.chat; ~ node x: config`):
 * `+` added, `−` removed, `~` changed (with the fields that changed); `no change` for none.
 */
export function diffSummary(d: GraphDiff, max = SUMMARY_ITEMS): string {
  const edge = (e: { from: string; to: string }): string => `edge ${e.from} → ${e.to}`;
  const items = [
    ...d.nodes.added.map((id) => `+ node ${id}`),
    ...d.nodes.removed.map((id) => `− node ${id}`),
    ...d.nodes.changed.map((c) => `~ node ${c.id}: ${c.fields.join(', ')}`),
    ...d.edges.added.map((e) => `+ ${edge(e)}`),
    ...d.edges.removed.map((e) => `− ${edge(e)}`),
    ...d.edges.changed.map((e) => `~ ${edge(e)}: ${e.fields.join(', ')}`),
  ];
  if (items.length === 0) return 'no change';
  const shown = items.slice(0, max).join('; ');
  return items.length > max ? `${shown}; … ${items.length - max} more` : shown;
}

const EMPTY: Graph = { version: GRAPH_VERSION, nodes: [], edges: [] };

/** Strings, of a list that should hold only them. */
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/**
 * A graph as a file holds it (checked or not) in the shape `graphText` prints: its nodes with an
 * id, and its edges with their two ends; a value of the wrong type is left out.
 */
export function printable(raw: unknown): Graph {
  const obj = (v: unknown): Record<string, unknown> | undefined => record(v);
  return {
    version: GRAPH_VERSION,
    nodes: list(raw, 'nodes').flatMap((n): GraphNode[] => {
      const r = record(n);
      const id = text(r?.['id']);
      if (r === undefined || id === undefined) return [];
      const [instance, account] = [text(r['instance']), text(r['account'])];
      const [config, settings] = [obj(r['config']), obj(r['settings'])];
      return [
        {
          id,
          plugin: text(r['plugin']) ?? '?',
          ...(instance === undefined ? {} : { instance }),
          ...(account === undefined ? {} : { account }),
          ...(r['disabled'] === true ? { disabled: true } : {}),
          ...(config === undefined ? {} : { config }),
          ...(settings === undefined ? {} : { settings }),
        },
      ];
    }),
    edges: list(raw, 'edges').flatMap((e): GraphEdge[] => {
      const at = ends(e);
      if (at === undefined) return [];
      const r = record(e) ?? {};
      const type = text(r['type']);
      const [reads, sends, commands] = [
        strings(r['reads']),
        strings(r['sends']),
        strings(r['commands']),
      ];
      const spacing = record(r['minIntervalS']);
      const intervals =
        spacing === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(spacing).filter(
                (x): x is [string, number] => typeof x[1] === 'number' && x[1] >= 0
              )
            );
      return [
        {
          ...at,
          ...(type === undefined ? {} : { type: type as NonNullable<GraphEdge['type']> }),
          ...(reads === undefined ? {} : { reads }),
          ...(sends === undefined ? {} : { sends }),
          ...(commands === undefined ? {} : { commands }),
          ...(intervals === undefined ? {} : { minIntervalS: intervals }),
          ...(r['dryRun'] === true ? { dryRun: true } : {}),
        },
      ];
    }),
  };
}

/** What the file holds: nothing, its graph unchecked, or why it does not read. */
export type GraphFileRead =
  { exists: false } | { exists: true; raw: unknown } | { exists: true; error: string };

/** A graph file of an older version as the current one; none: as it is. */
type Upgrade = (raw: unknown) => unknown;
const asIs: Upgrade = (raw) => raw;

/** The graph's file in a data directory, and its history (`<dir>/graph-history/`). */
export class GraphFile {
  readonly dir: string;
  readonly history: GraphHistory;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
    this.history = new GraphHistory(path.join(dir, GRAPH_HISTORY_DIR), now);
  }

  get file(): string {
    return path.join(this.dir, GRAPH_FILE);
  }

  /** Where releases before the history kept the graph before the last change. */
  get previous(): string {
    return path.join(this.dir, PREVIOUS_GRAPH_FILE);
  }

  /** The file's graph, unchecked. */
  /**
   * The saved file's nodes, each with its plugin, as it is (disabled ones too); none when it does
   * not read. Removing a module checks them (module-store.ts).
   */
  nodes(): { id: string; plugin: string }[] {
    const r = this.read();
    return list(r.exists && 'raw' in r ? r.raw : undefined, 'nodes').flatMap((n) => {
      const { id, plugin } = record(n) ?? {};
      return typeof id === 'string' && typeof plugin === 'string' ? [{ id, plugin }] : [];
    });
  }

  read(): GraphFileRead {
    let source: string;
    try {
      source = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
      return { exists: true, error: `${GRAPH_FILE} does not read: ${(e as Error).message}` };
    }
    try {
      return { exists: true, raw: JSON.parse(source) as unknown };
    } catch (e) {
      return { exists: true, error: `${GRAPH_FILE} is not JSON: ${(e as Error).message}` };
    }
  }

  /**
   * The instances the file's nodes name (each node's `instance`, or its id), whether or not the
   * graph checks; undefined when the file does not read, so that nothing is taken for unused.
   */
  references(): Set<string> | undefined {
    const r = this.read();
    if (!r.exists) return new Set();
    if ('error' in r) return undefined;
    return new Set(
      list(r.raw, 'nodes').flatMap((n) => {
        const id = text(record(n)?.['instance']) ?? text(record(n)?.['id']);
        return id === undefined ? [] : [id];
      })
    );
  }

  /** The newest version of the history, if it is the file's graph. */
  current(upgrade: Upgrade = asIs): GraphVersion | undefined {
    const r = this.read();
    const newest = this.history.latest();
    return newest !== undefined &&
      r.exists &&
      'raw' in r &&
      sameGraph(upgrade(newest.graph), upgrade(r.raw))
      ? newest
      : undefined;
  }

  /** Keeps `graph` as the newest version, its summary what changed from the one before. */
  private keep(
    graph: unknown,
    upgrade: Upgrade,
    meta: { source: GraphVersionSource; restores?: string; time?: number }
  ): void {
    const before = this.history.latest();
    this.history.record(graph, {
      ...meta,
      summary: diffSummary(graphDiff(upgrade(before?.graph ?? EMPTY), upgrade(graph))),
    });
  }

  /**
   * The file's graph kept as a version when no version holds it (written by hand, or before the
   * history), `source` and `time` its own; the newest version, if it is the file's graph.
   */
  private keepFile(
    upgrade: Upgrade,
    source: GraphVersionSource,
    time?: number
  ): GraphVersion | undefined {
    const r = this.read();
    if (!r.exists || !('raw' in r)) return undefined;
    if (this.current(upgrade) === undefined)
      this.keep(r.raw, upgrade, { source, ...(time === undefined ? {} : { time }) });
    return this.current(upgrade);
  }

  /**
   * Writes a graph, kept as the newest version of the history (a rollback's naming the version it
   * `restores`); false if nothing changed. A file that no version holds is kept first.
   */
  save(
    graph: Graph,
    o: { source?: 'save' | 'rollback' | 'migrated'; restores?: string; upgrade?: Upgrade } = {}
  ): boolean {
    const upgrade = o.upgrade ?? asIs;
    this.keepFile(upgrade, 'found');
    fs.mkdirSync(this.dir, { recursive: true });
    const changed = writeGraphFile(this.dir, graph);
    // A file rewritten in the current version, the same graph, is no new version.
    if (changed && this.current(upgrade) === undefined)
      this.keep(graph, upgrade, {
        source: o.source ?? 'save',
        ...(o.restores === undefined ? {} : { restores: o.restores }),
      });
    return changed;
  }

  /**
   * At each start, once the core has loaded the file (`core.load()`): the history taken in from
   * the files before it if it has no version yet (`graph.previous.json`, then `graph.json`, at
   * their files' times; the first then removed), the file kept as a version if none holds it, and
   * that version marked as run or refused, with why.
   */
  started(core: Pick<GraphChecker, 'upgrade' | 'graphProblems'>): void {
    const upgrade: Upgrade = core.upgrade === undefined ? asIs : (raw) => core.upgrade?.(raw);
    const version = this.adopt(upgrade);
    if (version === undefined) return;
    const problems = core.graphProblems();
    const at = new Date(this.now()).toISOString();
    this.history.started(
      version.id,
      problems.length === 0
        ? { result: 'ran', at }
        : { result: 'refused', at, problems: problems.map((p) => p.text) }
    );
  }

  /**
   * The history taken in from the files before it if it has no version yet (`graph.previous.json`,
   * then `graph.json`, at their files' times; the first then removed), and the file kept as a
   * version if none holds it: the newest version, if it is the file's graph. At each start, and
   * before the core's first write of a start (the modes' migration, bot-os.md D64).
   */
  adopt(upgrade: Upgrade = asIs): GraphVersion | undefined {
    const first = this.history.latest() === undefined;
    let after: number | undefined;
    if (first) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(this.previous, 'utf8'));
        after = fs.statSync(this.previous).mtimeMs;
      } catch {
        raw = undefined;
      }
      if (after !== undefined) {
        this.keep(raw, upgrade, { source: 'migrated', time: after });
        fs.rmSync(this.previous);
      }
    }
    let time: number | undefined;
    if (first)
      try {
        time = Math.max(fs.statSync(this.file).mtimeMs, (after ?? -Infinity) + 1);
      } catch {
        time = undefined;
      }
    return this.keepFile(upgrade, first ? 'migrated' : 'found', time);
  }
}

/** The owner's way to the graph's file, through the control API (§4.11). */
export interface GraphFileControls {
  /** The saved file, its text, and whether it differs from the graph the instance runs. */
  file(): unknown;
  /** A proposed graph checked, not saved: its problems, its text, how it differs from the file. */
  check(raw: unknown): unknown;
  /** A graph checked and saved; refused (GraphFileError) with its problems. */
  save(raw: unknown, by?: string): unknown;
  /** The version before the current one back; refused (GraphFileError) when there is none. */
  rollback(by?: string): unknown;
  /** Why the saved graph was not run at start: none when it was. */
  problems(): GraphProblem[];
  /** The history's versions, newest first, without their graphs. */
  history(): unknown;
  /** One version: its graph, its text, and how the current graph would change to it. */
  version(id: string): unknown;
  /** One version written as the current graph, kept as a new version that names it. */
  rollbackTo(id: string, by?: string): unknown;
}

/**
 * The control API's graph routes (`GET /graph/file`, `POST /graph/check`, `PUT /graph/file`,
 * `POST /graph/rollback`, `GET /graph/history`, `GET /graph/history/<id>`,
 * `POST /graph/history/<id>/rollback`), on a graph file and the core that checks it; `redact`
 * takes the secrets out of what is shown.
 */
export function graphFileControls(
  file: GraphFile,
  core: GraphChecker,
  redact: <T>(v: T) => T = (v) => v
): GraphFileControls {
  /** A graph as the current version writes it, an older file's converted (D60). */
  const current: Upgrade = (raw) => (core.upgrade === undefined ? raw : core.upgrade(raw));
  /** The saved graph, unchecked, or undefined. */
  const saved = (): unknown => {
    const r = file.read();
    return r.exists && 'raw' in r ? r.raw : undefined;
  };
  const textOf = (raw: unknown): string => graphText(printable(current(raw)));
  const version = (id: string): GraphVersion => {
    const v = file.history.get(id);
    if (v === undefined) throw new GraphFileError(`there is no version ${id}`, [], 404);
    return v;
  };
  /** Who wrote it, and what it changed of the audited keys (D75), recorded once written. */
  const written = (before: unknown, after: Graph, source: string, by: string | undefined): void => {
    const version = file.history.latest()?.id;
    core.written?.(before, after, {
      source,
      ...(by === undefined ? {} : { by }),
      ...(version === undefined ? {} : { version }),
    });
  };
  const rollbackTo = (id: string, by?: string): unknown => {
    const target = current(version(id).graph);
    const checked = core.check(target);
    const graph = checked.ok ? checked.graph : (target as Graph);
    const now = saved();
    if (now !== undefined && sameGraph(current(now), graph))
      throw new GraphFileError(`version ${id} is the current graph already`, [], 409);
    file.save(graph, { source: 'rollback', restores: id, upgrade: current });
    written(now === undefined ? EMPTY : current(now), graph, 'rollback', by);
    return redact({
      rolledBack: true,
      version: file.history.latest()?.id,
      restores: id,
      restart: !sameGraph(graph, core.graph()),
      ...(checked.ok ? {} : { problems: checked.problems }),
    });
  };
  return {
    file: () => {
      const r = file.read();
      const running = core.graph();
      const checked = r.exists && 'raw' in r ? core.check(r.raw) : undefined;
      const differs = !r.exists
        ? (running?.nodes.length ?? 0) > 0
        : checked === undefined || !checked.ok || !sameGraph(checked.graph, running);
      return redact({
        exists: r.exists,
        ...(r.exists && 'raw' in r ? { graph: current(r.raw), text: textOf(r.raw) } : {}),
        ...(r.exists && 'error' in r ? { error: r.error } : {}),
        ...(checked !== undefined && !checked.ok ? { problems: checked.problems } : {}),
        ...((checked?.warnings?.length ?? 0) > 0 ? { warnings: checked?.warnings } : {}),
        differs,
      });
    },
    check: (raw) => {
      const checked = core.check(raw);
      return redact({
        ok: checked.ok,
        problems: checked.ok ? [] : checked.problems,
        warnings: checked.warnings ?? [],
        diff: graphDiff(current(saved() ?? EMPTY), current(raw)),
        text: checked.ok ? graphText(checked.graph) : textOf(raw),
        // The nodes whose ports their config declares (D74), drawn as the draft declares them.
        ...(core.nodeViews === undefined ? {} : { views: core.nodeViews(current(raw)) }),
      });
    },
    save: (raw, by) => {
      const checked = core.check(raw);
      if (!checked.ok) throw new GraphFileError('the graph is refused', checked.problems);
      const before = current(saved() ?? EMPTY);
      const changed = file.save(checked.graph, { upgrade: current });
      if (changed) written(before, checked.graph, 'save', by);
      return {
        saved: changed,
        restart: !sameGraph(checked.graph, core.graph()),
        // Saved all the same (D89): a warning refuses nothing.
        warnings: checked.warnings ?? [],
      };
    },
    rollback: (by) => {
      // The version before the current one: the second newest, or the newest when the file is
      // not it (written by hand since), which the rollback keeps first.
      const versions = file.history.list();
      const target = file.current(current) === undefined ? versions[0] : versions[1];
      if (target === undefined)
        throw new GraphFileError('there is no version before the current one to roll back to');
      return rollbackTo(target.id, by);
    },
    problems: () => core.graphProblems(),
    history: () => {
      const versions = file.history.list();
      const now = file.current(current)?.id;
      const lastGood = versions.find((v) => v.start?.result === 'ran')?.id;
      return redact({
        versions,
        ...(now === undefined ? {} : { current: now }),
        ...(lastGood === undefined ? {} : { lastGood }),
        keep: { days: HISTORY_DAYS, latest: HISTORY_KEEP },
      });
    },
    version: (id) => {
      const v = version(id);
      const now = saved() ?? EMPTY;
      const then = current(v.graph);
      const checked = core.check(then);
      const [before, after] = [textOf(now), textOf(then)];
      return redact({
        ...v,
        graph: then,
        current: file.current(current)?.id === id,
        diff: graphDiff(current(now), then),
        text: after,
        currentText: before,
        lines: lineDiff(before, after),
        ...(checked.ok ? {} : { problems: checked.problems }),
      });
    },
    rollbackTo,
  };
}
