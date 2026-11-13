/**
 * The editor's draft graph (docs/bot-os.md D55): the saved file's graph, changed node by node and
 * edge by edge in the UI before it is checked, saved and applied. Pure functions of the graph as
 * the file holds it (`{ version: 2, nodes, edges }`), so that the editor's changes are tested
 * apart from React. Nothing here checks the graph: the core does (`POST /graph/check`).
 */
import type {
  Graph,
  GraphEdge,
  GraphNode,
  GraphProblem,
  NodeView,
  PluginView,
  PortView,
} from '#src/ui/api.ts';

export const EMPTY_GRAPH: Graph = { version: 2, nodes: [], edges: [] };

/** A node's or an instance's id, as the core's graph allows it: lower-case words and dashes. */
export const NODE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The saved file's graph, as the draft starts from it: its nodes and edges as they are (the core
 * says what is wrong with them), anything that is not a node or an edge left out.
 */
export function asGraph(raw: unknown): Graph {
  if (!isRecord(raw)) return EMPTY_GRAPH;
  const nodes = Array.isArray(raw['nodes']) ? raw['nodes'] : [];
  const edges = Array.isArray(raw['edges']) ? raw['edges'] : [];
  return {
    version: 2,
    nodes: nodes.filter(
      (n): n is GraphNode =>
        isRecord(n) && typeof n['id'] === 'string' && typeof n['plugin'] === 'string'
    ),
    edges: edges.filter(
      (e): e is GraphEdge =>
        isRecord(e) && typeof e['from'] === 'string' && typeof e['to'] === 'string'
    ),
  };
}

/** JSON with its keys sorted, so that two graphs that mean the same compare equal. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    isRecord(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]])
        )
      : x
  );

export const sameGraph = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** An edge's key, by its two ends, as the core's diff names it. */
export const edgeKey = (e: { from: string; to: string }): string => `${e.from} → ${e.to}`;

/** An end of an edge: its node, and its port (none for a bare `node`). */
export function endOf(end: string): { node: string; port: string | undefined } {
  const dot = end.indexOf('.');
  return dot < 0
    ? { node: end, port: undefined }
    : { node: end.slice(0, dot), port: end.slice(dot + 1) };
}

/** A free id for a new node of `plugin`: the plugin's id, then `-2`, `-3`… */
export function freeId(plugin: string, taken: ReadonlySet<string>): string {
  if (!taken.has(plugin)) return plugin;
  let n = 2;
  while (taken.has(`${plugin}-${n}`)) n++;
  return `${plugin}-${n}`;
}

/** Why a node's id cannot be used, or undefined. */
export function idProblem(id: string, taken: ReadonlySet<string>): string | undefined {
  if (!NODE_ID.test(id)) return 'lower-case words and dashes, such as dice-roller';
  if (id === 'core') return '`core` is the core’s own';
  if (taken.has(id)) return `a node ${id} is in the graph already`;
  return undefined;
}

/** The instance a node runs on: its own, or its id. */
export const instanceOf = (n: GraphNode): string => n.instance ?? n.id;

/** A node added, as given (the editor adds a new one disabled, D64). */
export function addNode(g: Graph, node: GraphNode): Graph {
  const { instance, ...rest } = node;
  return {
    ...g,
    nodes: [...g.nodes, instance === undefined || instance === node.id ? rest : node],
  };
}

/** The graph without a node, nor the edges at either end of it. Its instance is kept (§2.2). */
export function removeNode(g: Graph, id: string): Graph {
  return {
    ...g,
    nodes: g.nodes.filter((n) => n.id !== id),
    edges: g.edges.filter((e) => endOf(e.from).node !== id && endOf(e.to).node !== id),
  };
}

/** A node changed: each field given set, each given as undefined (or empty) taken away. */
export function updateNode(g: Graph, id: string, change: Partial<GraphNode>): Graph {
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      if (n.id !== id) return n;
      const out: Record<string, unknown> = { ...n };
      for (const [k, v] of Object.entries(change)) {
        const empty = v === undefined || v === '' || (isRecord(v) && Object.keys(v).length === 0);
        if (empty) delete out[k];
        else out[k] = v;
      }
      return out as GraphNode;
    }),
  };
}

/** A node's port renamed: an input (`in`) or an output (`out`), from its old name to its new. */
export interface PortMove {
  side: 'in' | 'out';
  from: string;
  to: string;
}

/**
 * The edges bound to a node's port moved to its new name, as its panel renames it (a script
 * node's, D78): an input's at their `to` end, an output's at their `from`, the rest kept.
 */
export function movePort(g: Graph, node: string, move: PortMove): Graph {
  const was = `${node}.${move.from}`;
  const now = `${node}.${move.to}`;
  return {
    ...g,
    edges: g.edges.map((e) =>
      move.side === 'in'
        ? e.to === was
          ? { ...e, to: now }
          : e
        : e.from === was
          ? { ...e, from: now }
          : e
    ),
  };
}

/** A node's port removed (a script node's, D84): an input (`in`) or an output (`out`). */
export interface PortRemoval {
  side: 'in' | 'out';
  removed: string;
}

/** What a node's panel did to one of its ports, beside its config: renamed it, or removed it. */
export type PortChange = PortMove | PortRemoval;

/**
 * The edges bound to a node's port removed with it, as its panel removes it (D84): an input's at
 * their `to` end, an output's at their `from`, so that none is left dangling.
 */
export function removePort(g: Graph, node: string, removal: PortRemoval): Graph {
  const end = `${node}.${removal.removed}`;
  return {
    ...g,
    edges: g.edges.filter((e) => (removal.side === 'in' ? e.to : e.from) !== end),
  };
}

/** The edges bound to a node's port, as its panel renames or removes it. */
export const portChanged = (g: Graph, node: string, change: PortChange): Graph =>
  'removed' in change ? removePort(g, node, change) : movePort(g, node, change);

/** The edges bound to a node's port: an input's (`in`) at their `to` end, an output's at `from`. */
export const edgesOfPort = (
  edges: readonly GraphEdge[],
  node: string,
  side: 'in' | 'out',
  port: string
): GraphEdge[] => edges.filter((e) => (side === 'in' ? e.to : e.from) === `${node}.${port}`);

/** An edge added, replacing one between the same two ends. */
export function connect(g: Graph, edge: GraphEdge): Graph {
  return { ...g, edges: [...g.edges.filter((e) => edgeKey(e) !== edgeKey(edge)), edge] };
}

/**
 * The edge an output dragged to an input makes: its two ends, and the type of the output, which
 * the check compares with the input's (`connection` as React Flow gives it; a connector's out
 * card stands for its node, `cards.ts`). A chat-out edge starts a dry run (D64): it sends for
 * real only once the owner says so.
 */
export function edgeOf(
  c: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null },
  plugins: ReadonlyMap<string, PluginView>,
  g: Graph,
  /** The nodes whose ports their config declares, by id (`POST /graph/check`'s `views`, D74). */
  views: Readonly<Record<string, PluginView>> = {}
): GraphEdge {
  const from = g.nodes.find((n) => n.id === c.source);
  const output =
    c.sourceHandle == null
      ? undefined
      : (views[c.source] ?? plugins.get(from?.plugin ?? ''))?.outputs[c.sourceHandle];
  const type = output?.type;
  // A chat-out output that declares its commands (D74): its edge starts allowing those.
  const commands = output?.type === 'chat-out' ? output.commands : undefined;
  return {
    from: c.sourceHandle == null ? c.source : `${c.source}.${c.sourceHandle}`,
    to: `${c.target.endsWith('::out') ? c.target.slice(0, -'::out'.length) : c.target}.${c.targetHandle ?? ''}`,
    ...(type === undefined ? {} : { type }),
    ...(commands === undefined ? {} : { commands: [...commands] }),
    ...(type === 'chat-out' ? { dryRun: true } : {}),
  };
}

/**
 * What an edge's panel changes: what it carries, and a chat-out's dry run (D64); a key set to
 * undefined is taken away.
 */
export type EdgeChange = {
  [K in 'reads' | 'senders' | 'sends' | 'commands' | 'minIntervalS' | 'dryRun']?:
    GraphEdge[K] | undefined;
};

export function updateEdge(g: Graph, key: string, change: EdgeChange): Graph {
  return {
    ...g,
    edges: g.edges.map((e) => {
      if (edgeKey(e) !== key) return e;
      const out: Record<string, unknown> = { ...e };
      for (const [k, v] of Object.entries(change))
        if (
          v === undefined ||
          (k === 'commands' && Array.isArray(v) && v.length === 0) ||
          (k === 'minIntervalS' && typeof v === 'object' && Object.keys(v).length === 0)
        )
          delete out[k];
        else out[k] = v;
      return out as GraphEdge;
    }),
  };
}

export function removeEdge(g: Graph, key: string): Graph {
  return { ...g, edges: g.edges.filter((e) => edgeKey(e) !== key) };
}

/** A check's problems, by where the editor shows them. */
export interface PlacedProblems {
  /** On a node (the whole node: no port, config or setting named). */
  nodes: Map<string, string[]>;
  /** On a port, by `node.port`. */
  ports: Map<string, string[]>;
  /** On an edge, by its key. */
  edges: Map<string, string[]>;
  /** On a field of a node's config or settings, by node, then key. */
  config: Map<string, Record<string, string[]>>;
  settings: Map<string, Record<string, string[]>>;
  /** Nowhere in particular. */
  other: string[];
}

const push = <K>(m: Map<K, string[]>, k: K, text: string): void => {
  m.set(k, [...(m.get(k) ?? []), text]);
};

/** Where each problem is shown: an edge, a port, a field, a node, or the list of the rest. */
export function placeProblems(problems: readonly GraphProblem[]): PlacedProblems {
  const out: PlacedProblems = {
    nodes: new Map(),
    ports: new Map(),
    edges: new Map(),
    config: new Map(),
    settings: new Map(),
    other: [],
  };
  const field = (
    m: Map<string, Record<string, string[]>>,
    node: string,
    key: string,
    text: string
  ) => {
    const at = m.get(node) ?? {};
    at[key] = [...(at[key] ?? []), text];
    m.set(node, at);
  };
  for (const p of problems) {
    if (p.edge !== undefined) push(out.edges, edgeKey(p.edge), p.text);
    else if (p.node !== undefined && p.config !== undefined)
      field(out.config, p.node, p.config, p.text);
    else if (p.node !== undefined && p.setting !== undefined)
      field(out.settings, p.node, p.setting, p.text);
    else if (p.node !== undefined && p.port !== undefined)
      push(out.ports, `${p.node}.${p.port}`, p.text);
    else if (p.node !== undefined) push(out.nodes, p.node, p.text);
    else out.other.push(p.text);
  }
  return out;
}

/** A node as the editor draws it: its plugin's declarations, with the node's own. */
/** A namespace, as the core's ids are written. */
const NAMESPACE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/**
 * A node's input ports, each events input whose namespace its config names (`config`) resolved
 * from the node's config as written, as the core resolves it (bot-os-api.md §2.1): the value's
 * namespace, or its event type's. Unresolved, an optional one is not there, and a required one is
 * left for the check to refuse. A chat-in input there only with a config key (`when`, the
 * reactor's `match`) is not there while the key is unset.
 */
export function inputsOf(
  inputs: Readonly<Record<string, PortView>>,
  config: Readonly<Record<string, unknown>> | undefined
): Record<string, PortView> {
  const out: Record<string, PortView> = {};
  for (const [name, p] of Object.entries(inputs)) {
    if (p.type === 'chat-in' && p.when !== undefined) {
      if (config?.[p.when] !== undefined && config[p.when] !== null) out[name] = p;
      continue;
    }
    if (p.type !== 'events' || p.config === undefined) {
      out[name] = p;
      continue;
    }
    const value = config?.[p.config];
    const ns = typeof value === 'string' ? value.split('.')[0] : undefined;
    if (ns !== undefined && NAMESPACE.test(ns))
      out[name] = { ...p, namespace: ns, label: `events of ${ns}` };
    else if (!p.optional) out[name] = p;
  }
  return out;
}

export function viewOf(node: GraphNode, plugin: PluginView | undefined): NodeView {
  const base: PluginView = plugin ?? {
    plugin: node.plugin,
    version: '?',
    description: `the plugin ${node.plugin} is not offered by this instance`,
    kinds: [],
    inputs: {},
    outputs: {},
    interface: { reads: [], actions: [], commands: [] },
    secrets: [],
    configSecrets: [],
    events: [],
  };
  const account = node.account ?? base.account;
  const { account: _, ...rest } = base;
  return {
    ...rest,
    inputs: inputsOf(base.inputs, node.config),
    id: node.id,
    ...(account === undefined ? {} : { account }),
    ...(node.config === undefined ? {} : { config: node.config }),
  };
}

/** A free port name: `base`, then `base-2`, `base-3`… */
export function freeName(base: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(base)) return base;
  let n = 2;
  while (t.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * An edge dropped on a node whose inputs its config declares (docs/bot-os.md D80, D84): bound to
 * the input of the node that takes the output (an events input of its namespace; an interface
 * input of its plugin, unbound) when there is one. When there are several: to the one bound to
 * that output already, or else to the one not bound yet if only one is not; else to none, the
 * inputs that would take it named (`choose`) for the owner to drop it on the port of one, as the
 * editor cannot guess which a script means. With none, to a new one, written in the node's config
 * where its plugin says (`configInputs`) and named after the namespace or the plugin, unique in
 * the node: an events input of the output's namespace, or an interface input of its node's plugin
 * and no member, which the owner picks in the node's panel (the check says so until then).
 * Undefined when the node declares no inputs of the output's type, or the output is unknown.
 */
export function dropOn(
  g: Graph,
  from: { node: string; port: string },
  to: string,
  plugins: ReadonlyMap<string, PluginView>,
  /** The nodes whose ports their config declares, by id (`POST /graph/check`'s `views`, D74). */
  views: Readonly<Record<string, PluginView>> = {}
): { graph: Graph; port: string; added: boolean } | { choose: string[] } | undefined {
  const target = g.nodes.find((n) => n.id === to);
  const source = g.nodes.find((n) => n.id === from.node);
  if (target === undefined || source === undefined || to === from.node) return undefined;
  const spec = plugins.get(target.plugin)?.configInputs;
  const output = (views[source.id] ?? plugins.get(source.plugin))?.outputs[from.port];
  if (spec === undefined || output === undefined) return undefined;
  const type = output.type;
  if (type !== 'events' && type !== 'interface') return undefined;
  if (!spec.types.includes(type)) return undefined;
  const namespace = type === 'events' ? output.namespace : undefined;
  if (type === 'events' && namespace === undefined) return undefined;
  const declared = isRecord(target.config?.[spec.key])
    ? (target.config[spec.key] as Record<string, unknown>)
    : {};
  const bound = new Set(g.edges.map((e) => e.to));
  const takes = ([name, p]: [string, unknown]): boolean =>
    isRecord(p) &&
    p['type'] === type &&
    (type === 'events'
      ? p['namespace'] === namespace
      : p['plugin'] === source.plugin && !bound.has(`${to}.${name}`));
  const taking = Object.entries(declared)
    .filter(takes)
    .map(([name]) => name);
  const free = taking.filter((name) => !bound.has(`${to}.${name}`));
  // One bound to this very output already takes it again: dropping twice changes nothing.
  const again = taking.find((name) =>
    g.edges.some((e) => e.to === `${to}.${name}` && e.from === `${from.node}.${from.port}`)
  );
  const kept = again ?? (taking.length === 1 ? taking[0] : free.length === 1 ? free[0] : undefined);
  if (kept === undefined && taking.length > 1) return { choose: taking };
  const port = kept ?? freeName(namespace ?? source.plugin, Object.keys(declared));
  const grown =
    kept !== undefined
      ? g
      : updateNode(g, to, {
          config: {
            ...target.config,
            [spec.key]: {
              ...declared,
              [port]:
                type === 'events'
                  ? { type, namespace }
                  : { type, plugin: source.plugin, members: [] },
            },
          },
        });
  const edge = edgeOf(
    { source: from.node, sourceHandle: from.port, target: to, targetHandle: port },
    plugins,
    grown,
    views
  );
  return { graph: connect(grown, edge), port, added: kept === undefined };
}
