/**
 * The instance's graph in its volume (docs/bot-os-api.md §2.3, bot-os.md D50): `<data>/graph.json`
 * is the only source of the instance's composition, its nodes and their edges. The core reads it at
 * start; the owner reads, checks, saves and rolls it back through the control API, and a restart
 * applies it (P8).
 *
 * - A missing file is an empty graph. A file that does not read, or that the check refuses, starts
 *   the instance with no nodes, and the file is kept as it is: the problems are reported (the
 *   status, the control API, the owner), for the owner to fix in the UI, so it never crash-loops.
 * - Saving keeps the file before as `graph.previous.json`; a rollback swaps the two.
 * - A file of version 1 (one chat edge for reads and sends) is converted to version 2 as it is
 *   read (bot-os.md D60): the instance runs it, `GET /graph/file` shows it, and the check and a
 *   save take it, as version 2; the file itself is rewritten only by the next save.
 * - A problem is located where it can be: its node, its edge, its port, its config or setting key,
 *   for the editor to mark.
 *
 * Nothing in here knows of any game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type Graph } from './graph.ts';
import { GRAPH_FILE, PREVIOUS_GRAPH_FILE, writeGraphFile } from './graph-view.ts';

/** One problem of a graph, located where it can be. */
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
    changed: { from: string; to: string }[];
  };
}

/** A graph checked: the graph as the core holds it, or the problems. */
export type GraphCheck = { ok: true; graph: Graph } | { ok: false; problems: GraphProblem[] };

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
}

/** A change to the graph's file refused, with why. */
export class GraphFileError extends Error {
  readonly problems: GraphProblem[];
  constructor(message: string, problems: GraphProblem[] = []) {
    super(message);
    this.problems = problems;
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
const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => {
    const r = record(x);
    return r === undefined
      ? x
      : Object.fromEntries(
          Object.keys(r)
            .sort()
            .map((k) => [k, r[k]])
        );
  });

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
  const edges = (g: unknown): Map<string, { from: string; to: string; value: unknown }> =>
    new Map(
      list(g, 'edges').flatMap((e) => {
        const at = ends(e);
        return at === undefined ? [] : [[`${at.from} → ${at.to}`, { ...at, value: e }] as const];
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
        const fields = [...new Set([...Object.keys(old), ...Object.keys(n)])]
          .filter((k) => stable(old[k]) !== stable(n[k]))
          .sort();
        return fields.length === 0 ? [] : [{ id, fields }];
      }),
    },
    edges: {
      added: [...y].filter(([k]) => !x.has(k)).map(([, e]) => ({ from: e.from, to: e.to })),
      removed: [...x].filter(([k]) => !y.has(k)).map(([, e]) => ({ from: e.from, to: e.to })),
      changed: [...y]
        .filter(([k, e]) => x.has(k) && stable(x.get(k)?.value) !== stable(e.value))
        .map(([, e]) => ({ from: e.from, to: e.to })),
    },
  };
}

/** Whether two graphs are the same, keys in any order. */
export const sameGraph = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** What the file holds: nothing, its graph unchecked, or why it does not read. */
export type GraphFileRead =
  { exists: false } | { exists: true; raw: unknown } | { exists: true; error: string };

/** The graph's file, and the one before it, in a data directory. */
export class GraphFile {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get file(): string {
    return path.join(this.dir, GRAPH_FILE);
  }

  get previous(): string {
    return path.join(this.dir, PREVIOUS_GRAPH_FILE);
  }

  /** The file's graph, unchecked. */
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

  /** Writes a graph, the file before kept as the previous one; false if nothing changed. */
  save(graph: Graph): boolean {
    fs.mkdirSync(this.dir, { recursive: true });
    return writeGraphFile(this.dir, graph);
  }

  /** The previous version back in place, and the file it replaces kept as the previous one. */
  rollback(): void {
    let before: string;
    try {
      before = fs.readFileSync(this.previous, 'utf8');
    } catch {
      throw new GraphFileError(`there is no ${PREVIOUS_GRAPH_FILE} to roll back to`);
    }
    let now: string | undefined;
    try {
      now = fs.readFileSync(this.file, 'utf8');
    } catch {
      now = undefined;
    }
    const put = (file: string, content: string): void => {
      fs.writeFileSync(`${file}.tmp`, content);
      fs.renameSync(`${file}.tmp`, file);
    };
    put(this.file, before);
    if (now === undefined) fs.rmSync(this.previous, { force: true });
    else put(this.previous, now);
  }
}

/** The owner's way to the graph's file, through the control API (§4.11). */
export interface GraphFileControls {
  /** The saved file, and whether it differs from the graph the instance runs. */
  file(): unknown;
  /** A proposed graph checked, not saved: its problems, and how it differs from the saved file. */
  check(raw: unknown): unknown;
  /** A graph checked and saved; refused (GraphFileError) with its problems. */
  save(raw: unknown): unknown;
  /** The previous version back; refused (GraphFileError) when there is none. */
  rollback(): unknown;
  /** Why the saved graph was not run at start: none when it was. */
  problems(): GraphProblem[];
}

/**
 * The control API's graph routes (`GET /graph/file`, `POST /graph/check`, `PUT /graph/file`,
 * `POST /graph/rollback`), on a graph file and the core that checks it; `redact` takes the secrets
 * out of what is shown.
 */
export function graphFileControls(
  file: GraphFile,
  core: GraphChecker,
  redact: <T>(v: T) => T = (v) => v
): GraphFileControls {
  /** A graph as the current version writes it, an older file's converted (D60). */
  const current = (raw: unknown): unknown => (core.upgrade === undefined ? raw : core.upgrade(raw));
  /** The saved graph, unchecked, or undefined. */
  const saved = (): unknown => {
    const r = file.read();
    return r.exists && 'raw' in r ? r.raw : undefined;
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
        ...(r.exists && 'raw' in r ? { graph: current(r.raw) } : {}),
        ...(r.exists && 'error' in r ? { error: r.error } : {}),
        ...(checked !== undefined && !checked.ok ? { problems: checked.problems } : {}),
        differs,
      });
    },
    check: (raw) => {
      const checked = core.check(raw);
      return redact({
        ok: checked.ok,
        problems: checked.ok ? [] : checked.problems,
        diff: graphDiff(current(saved() ?? { nodes: [], edges: [] }), current(raw)),
      });
    },
    save: (raw) => {
      const checked = core.check(raw);
      if (!checked.ok) throw new GraphFileError('the graph is refused', checked.problems);
      const changed = file.save(checked.graph);
      return { saved: changed, restart: !sameGraph(checked.graph, core.graph()) };
    },
    rollback: () => {
      file.rollback();
      const raw = saved();
      const checked = raw === undefined ? undefined : core.check(raw);
      return redact({
        rolledBack: true,
        ...(checked === undefined || checked.ok ? {} : { problems: checked.problems }),
      });
    },
    problems: () => core.graphProblems(),
  };
}
