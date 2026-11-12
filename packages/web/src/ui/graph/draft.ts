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

/** An edge added, replacing one between the same two ends. */
export function connect(g: Graph, edge: GraphEdge): Graph {
  return { ...g, edges: [...g.edges.filter((e) => edgeKey(e) !== edgeKey(edge)), edge] };
}

/**
 * The edge an output dragged to an input makes: its two ends, and the type of the output, which
 * the check compares with the input's (`connection` as React Flow gives it; a connector's out
 * card stands for its node, `cards.ts`).
 */
export function edgeOf(
  c: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null },
  plugins: ReadonlyMap<string, PluginView>,
  g: Graph
): GraphEdge {
  const from = g.nodes.find((n) => n.id === c.source);
  const type =
    c.sourceHandle == null
      ? undefined
      : plugins.get(from?.plugin ?? '')?.outputs[c.sourceHandle]?.type;
  return {
    from: c.sourceHandle == null ? c.source : `${c.source}.${c.sourceHandle}`,
    to: `${c.target.endsWith('::out') ? c.target.slice(0, -'::out'.length) : c.target}.${c.targetHandle ?? ''}`,
    ...(type === undefined ? {} : { type }),
  };
}

/** An edge's chats and commands changed (an empty list taken away). */
/** What an edge's panel changes: what it carries; a key set to undefined is taken away. */
export type EdgeChange = {
  [K in 'reads' | 'senders' | 'sends' | 'commands']?: GraphEdge[K] | undefined;
};

export function updateEdge(g: Graph, key: string, change: EdgeChange): Graph {
  return {
    ...g,
    edges: g.edges.map((e) => {
      if (edgeKey(e) !== key) return e;
      const out: Record<string, unknown> = { ...e };
      for (const [k, v] of Object.entries(change))
        if (v === undefined || (k === 'commands' && Array.isArray(v) && v.length === 0))
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
