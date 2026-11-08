/**
 * The instance's wiring as data (docs/bot-os-api.md §2.1, P17, D27): a graph whose nodes are plugin
 * instances, each with its id, its plugin and its configuration, and whose edges bind an input port
 * of one node to an output port of another, of the same type (packages/core/src/ports.ts).
 * It is checked with zod and against the manifests at start, and every problem names the node and
 * the port; the core runs it (packages/core/src/core.ts), and the edges are the permissions
 * (P6).
 *
 * - A plugin may be instantiated more than once, each node with its own id, configuration, store,
 *   settings and mode. A node's kept state (its store, timers, settings and mode) belongs to the
 *   _instance_ it names (`/data/instances/<instance>/`, the node's id when it names none), which
 *   outlives the node: a node of the same plugin may take it up again.
 * - The programmatic wiring is the default graph: a node per plugin registered, each input bound as
 *   its manifest's `bind` says. Any other graph (a file) replaces it as a whole.
 * - A required input left unbound, an edge between ports of two types, an input of one edge bound
 *   twice, an unknown plugin, node or port, and a cycle of required edges fail the start.
 *
 * Nothing in here knows of any game.
 */
import { z } from 'zod';
import { ACCOUNT_ID, type Manifest, PLUGIN_ID } from './manifest.ts';
import { type Mode, MODES } from './outbox.ts';
import {
  type ChatBinding,
  describePort,
  type InputPort,
  mismatch,
  type OutputPort,
  PORT_TYPES,
  type PortType,
} from './ports.ts';

/** The format of the graph file; a change that old files cannot be read with bumps it. */
export const GRAPH_VERSION = 1;

const SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const FROM = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})?$`, 'u');
const TO = new RegExp(`^${SEGMENT}\\.${SEGMENT}$`, 'u');

export const graphSchema = z.strictObject({
  version: z.literal(GRAPH_VERSION),
  nodes: z.array(
    z.strictObject({
      id: z
        .string()
        .regex(PLUGIN_ID, 'expected lower-case words and dashes')
        .refine((id) => id !== 'core', '`core` is reserved for the core'),
      /** The plugin it is an instance of, by the plugin's id. */
      plugin: z.string().regex(PLUGIN_ID, 'expected a plugin id'),
      /**
       * The instance whose kept state it runs on (`<data>/instances/<instance>/`): an existing one
       * of the same plugin, or a fresh id. The node's own id when not given.
       */
      instance: z
        .string()
        .regex(PLUGIN_ID, 'expected lower-case words and dashes')
        .refine((id) => id !== 'core', '`core` is reserved for the core')
        .optional(),
      /** Its configuration, checked against its plugin's `config` schema. */
      config: z.record(z.string(), z.unknown()).optional(),
      /** A connector instance's own account, in place of its manifest's (`<network>:<name>`). */
      account: z.string().regex(ACCOUNT_ID, 'expected <network>:<name>').optional(),
      /**
       * The settings its instance starts with, checked against its plugin's `settings`: put in
       * force only while the instance keeps none of its own (a fresh one).
       */
      settings: z.record(z.string(), z.unknown()).optional(),
      /** The mode its instance starts in (P10), while the instance keeps none. */
      mode: z.enum(MODES).optional(),
    })
  ),
  edges: z
    .array(
      z.strictObject({
        /** The output: `node.port`, or `node` when one of its outputs fits. */
        from: z.string().regex(FROM, 'expected node or node.port'),
        /** The input: `node.port`. */
        to: z.string().regex(TO, 'expected node.port'),
        /** The ports' type; checked when given, and always written. */
        type: z.enum(PORT_TYPES).optional(),
        /** A chat's: the chats read, those sent to, and the commands sent (first words). */
        reads: z.array(z.string().min(1)).optional(),
        sends: z.array(z.string().min(1)).optional(),
        commands: z.array(z.string().min(1)).optional(),
      })
    )
    .default([]),
});
/** A graph as a file or a wiring writes it. */
export type GraphInput = z.input<typeof graphSchema>;
/** A graph as the core holds it: every edge `node.port` to `node.port`, with its type. */
export type Graph = z.output<typeof graphSchema>;
export type GraphNode = Graph['nodes'][number];
export type GraphEdge = Graph['edges'][number];

export class GraphError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

/** One input's other end. */
export interface Binding {
  /** The node bound, and its output port. */
  node: string;
  port: string;
  type: PortType;
  /** A chat's reads, sends and commands. */
  chat?: ChatBinding;
}

/** A node of a checked graph, with its manifest and what each of its inputs is bound to. */
export interface ResolvedNode {
  id: string;
  /** The instance whose kept state it runs on: the node's own, or its id. */
  instance: string;
  manifest: Manifest;
  /** Its account: the node's own, or its manifest's. */
  account?: string;
  config?: Record<string, unknown>;
  /** The settings and the mode a fresh instance starts with. */
  settings?: Record<string, unknown>;
  mode?: Mode;
  /** Each input of its manifest, with its other ends (none: unbound). */
  inputs: Map<string, Binding[]>;
}

/**
 * The outputs of a manifest that fit an input; `loose`, those of its type and its network,
 * namespace or plugin, whatever members they declare (the default graph binds them, and the check
 * then says what is missing).
 */
const fitting = (input: InputPort, manifest: Manifest, loose = false): [string, OutputPort][] =>
  Object.entries(manifest.outputs).filter(
    ([, out]) =>
      mismatch(input.type === 'interface' && loose ? { ...input, members: [] } : input, out) ===
      undefined
  );

/**
 * The programmatic wiring's graph: a node per plugin, its id the plugin's, with its configuration
 * (`config`, by id), and each input bound as its manifest's `bind` says (an events input, by
 * default, to every other node registering its namespace; an interface input to the node of its
 * plugin's id). An input whose default other end is not there is left unbound.
 */
export function defaultGraph(
  manifests: readonly Manifest[],
  config: Readonly<Record<string, unknown>> = {}
): Graph {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const edges: GraphEdge[] = [];
  for (const m of manifests)
    for (const [port, input] of Object.entries(m.inputs)) {
      const targets =
        input.type === 'events'
          ? (input.bind?.nodes ??
            manifests
              .filter((o) => o.id !== m.id && o.games.registers.includes(input.namespace))
              .map((o) => o.id))
          : input.type === 'chat'
            ? input.bind === undefined
              ? []
              : [input.bind.node]
            : [input.bind?.node ?? input.plugin].filter((n) => n !== undefined);
      for (const target of targets) {
        const other = byId.get(target);
        const out = other === undefined ? undefined : fitting(input, other, true)[0];
        if (out === undefined) continue;
        const chat =
          input.type === 'chat' && input.bind !== undefined
            ? {
                reads: [...input.bind.reads],
                sends: [...input.bind.sends],
                ...(input.bind.commands === undefined
                  ? {}
                  : { commands: [...input.bind.commands] }),
              }
            : {};
        edges.push({
          from: `${target}.${out[0]}`,
          to: `${m.id}.${port}`,
          type: input.type,
          ...chat,
        });
      }
    }
  return {
    version: GRAPH_VERSION,
    nodes: manifests.map((m) => {
      const c = config[m.id];
      return {
        id: m.id,
        plugin: m.id,
        ...(c === undefined ? {} : { config: c as Record<string, unknown> }),
      };
    }),
    edges,
  };
}

/** One instance of a plugin meant for several, as the programmatic wiring lists it. */
export interface InstanceInput {
  /** Its node's id. */
  id: string;
  config?: Record<string, unknown>;
  /** Its edges, to its inputs and from its outputs, as a graph file writes them. */
  edges: GraphInput['edges'];
}

/**
 * The graph with the default node of `plugin` (the one whose id is the plugin's) and its edges
 * replaced by `instances`, each a node of that plugin with its own edges: how the programmatic
 * wiring runs a plugin meant for several instances (the turn-actor's, one per bot), its other
 * plugins left one node each. No instances: the plugin runs nowhere.
 */
export function withInstances(
  graph: GraphInput,
  plugin: string,
  instances: readonly InstanceInput[]
): GraphInput {
  const nodeOf = (end: string): string => end.split('.')[0] as string;
  return {
    ...graph,
    nodes: [
      ...graph.nodes.filter((n) => n.id !== plugin),
      ...instances.map((i) => ({
        id: i.id,
        plugin,
        ...(i.config === undefined ? {} : { config: i.config }),
      })),
    ],
    edges: [
      ...(graph.edges ?? []).filter((e) => nodeOf(e.from) !== plugin && nodeOf(e.to) !== plugin),
      ...instances.flatMap((i) => i.edges ?? []),
    ],
  };
}

/**
 * Checks a graph against the manifests of the plugins the image has (by plugin id): the graph as
 * the core holds it (each edge's ends and type written out), and its nodes, in the graph's order.
 * A GraphError lists every problem, each naming its node and port.
 */
export function resolveGraph(
  raw: unknown,
  plugins: ReadonlyMap<string, Manifest>,
  /** The plugin of an instance kept already, by its id; undefined for a fresh one. */
  instanceOf: (instance: string) => string | undefined = () => undefined
): { graph: Graph; nodes: ResolvedNode[] } {
  const parsed = graphSchema.safeParse(raw);
  if (!parsed.success)
    throw new GraphError(
      parsed.error.issues.map(
        (i) => `graph: ${i.path.map(String).join('.') || '(graph)'}: ${i.message}`
      )
    );
  const problems: string[] = [];
  const nodes = new Map<string, ResolvedNode>();
  const accounts = new Map<string, string>();
  const instances = new Map<string, string>();
  for (const n of parsed.data.nodes) {
    const manifest = plugins.get(n.plugin);
    if (nodes.has(n.id)) {
      problems.push(`node ${n.id}: in the graph twice`);
      continue;
    }
    if (manifest === undefined) {
      problems.push(`node ${n.id}: its plugin ${n.plugin} is not in the image`);
      continue;
    }
    const instance = n.instance ?? n.id;
    const holder = instances.get(instance);
    const kept = instanceOf(instance);
    if (holder !== undefined)
      problems.push(`node ${n.id}: its instance ${instance} is node ${holder}'s`);
    else instances.set(instance, n.id);
    if (kept !== undefined && kept !== n.plugin)
      problems.push(
        `node ${n.id}: its instance ${instance} is of the plugin ${kept}, not ${n.plugin}`
      );
    const account = n.account ?? manifest.account;
    if (n.account !== undefined) {
      const network = (a: string): string => a.slice(0, a.indexOf(':'));
      if (manifest.account === undefined)
        problems.push(`node ${n.id}: only a connector has an account`);
      else if (network(n.account) !== network(manifest.account))
        problems.push(
          `node ${n.id}: its account ${n.account} is not of ${manifest.account}'s network`
        );
    }
    if (account !== undefined) {
      const other = accounts.get(account);
      if (other !== undefined) problems.push(`node ${n.id}: the account ${account} is ${other}'s`);
      else accounts.set(account, n.id);
    }
    nodes.set(n.id, {
      id: n.id,
      instance,
      manifest,
      ...(account === undefined ? {} : { account }),
      ...(n.config === undefined ? {} : { config: n.config }),
      ...(n.settings === undefined ? {} : { settings: n.settings }),
      ...(n.mode === undefined ? {} : { mode: n.mode }),
      inputs: new Map(Object.keys(manifest.inputs).map((p) => [p, []])),
    });
  }
  const edges: GraphEdge[] = [];
  /** The inputs an edge's problem has named already. */
  const named = new Set<string>();
  for (const e of parsed.data.edges) {
    const name = `edge ${e.from} → ${e.to}`;
    const [toNode = '', toPort = ''] = e.to.split('.');
    const [fromNode = '', fromPort] = e.from.split('.');
    const to = nodes.get(toNode);
    const from = nodes.get(fromNode);
    if (to === undefined || from === undefined) {
      problems.push(`${name}: no node ${to === undefined ? toNode : fromNode}`);
      continue;
    }
    if (from === to) {
      problems.push(`${name}: a node cannot feed itself`);
      continue;
    }
    const input = to.manifest.inputs[toPort];
    if (input === undefined) {
      problems.push(`node ${toNode}: no input port ${toPort}`);
      continue;
    }
    let port = fromPort;
    if (port === undefined) {
      const fits = fitting(input, from.manifest);
      if (fits.length !== 1) {
        problems.push(
          `${name}: ${fits.length === 0 ? 'no' : 'more than one'} output of ${fromNode} fits ${describePort(input)}; name it`
        );
        continue;
      }
      port = (fits[0] as [string, OutputPort])[0];
    }
    let output = from.manifest.outputs[port];
    if (output === undefined) {
      problems.push(`node ${fromNode}: no output port ${port}`);
      continue;
    }
    if (output.type === 'chat' && from.account !== undefined)
      output = { type: 'chat', network: from.account.slice(0, from.account.indexOf(':')) };
    const why = mismatch(input, output);
    named.add(e.to);
    if (why !== undefined) {
      problems.push(`node ${toNode}: input port ${toPort}: ${why} (${name})`);
      continue;
    }
    if (e.type !== undefined && e.type !== input.type) {
      problems.push(`${name}: its type is ${input.type}, not ${e.type}`);
      continue;
    }
    const specifics = e.reads !== undefined || e.sends !== undefined || e.commands !== undefined;
    if (specifics && input.type !== 'chat') {
      problems.push(`${name}: only a chat carries reads, sends and commands`);
      continue;
    }
    const bound = to.inputs.get(toPort) as Binding[];
    if (input.type !== 'events' && bound.length > 0) {
      problems.push(`node ${toNode}: input port ${toPort} is bound twice`);
      continue;
    }
    if (bound.some((b) => b.node === fromNode && b.port === port)) {
      problems.push(`${name}: twice in the graph`);
      continue;
    }
    const chat: ChatBinding | undefined =
      input.type === 'chat'
        ? {
            reads: e.reads ?? [],
            sends: e.sends ?? [],
            ...(e.commands === undefined ? {} : { commands: e.commands }),
          }
        : undefined;
    bound.push({
      node: fromNode,
      port,
      type: input.type,
      ...(chat === undefined ? {} : { chat }),
    });
    edges.push({ from: `${fromNode}.${port}`, to: e.to, type: input.type, ...(chat ?? {}) });
  }
  for (const n of nodes.values())
    for (const [port, input] of Object.entries(n.manifest.inputs)) {
      if (input.optional || named.has(`${n.id}.${port}`) || (n.inputs.get(port)?.length ?? 0) > 0)
        continue;
      const target =
        input.type === 'chat'
          ? input.bind?.node
          : input.type === 'interface'
            ? (input.bind?.node ?? input.plugin)
            : undefined;
      problems.push(
        `node ${n.id}: input port ${port} (${describePort(input)}) is not bound` +
          (target === undefined || nodes.has(target) ? '' : `: ${target} is not in the graph`)
      );
    }
  if (problems.length > 0) throw new GraphError(problems);
  return {
    graph: { version: parsed.data.version, nodes: parsed.data.nodes, edges },
    nodes: [...nodes.values()],
  };
}

/** The nodes a node's required inputs bind, in the order of its inputs. */
export function requiredOf(node: ResolvedNode): string[] {
  const out: string[] = [];
  for (const [port, bindings] of node.inputs)
    if (node.manifest.inputs[port]?.optional !== true)
      for (const b of bindings) if (!out.includes(b.node)) out.push(b.node);
  return out;
}

/**
 * The nodes in load order: depth first in the graph's order, what a node's required inputs bind
 * first. A cycle of required edges is a GraphError naming its path.
 */
export function loadOrder(nodes: readonly ResolvedNode[]): ResolvedNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = new Map<string, ResolvedNode>();
  const visiting: string[] = [];
  const visit = (id: string): void => {
    if (ordered.has(id)) return;
    const at = visiting.indexOf(id);
    if (at >= 0)
      throw new GraphError([
        `a cycle of required edges: ${[...visiting.slice(at), id].join(' → ')}`,
      ]);
    visiting.push(id);
    const node = byId.get(id) as ResolvedNode;
    for (const r of requiredOf(node)) visit(r);
    visiting.pop();
    ordered.set(id, node);
  };
  for (const n of nodes) visit(n.id);
  return [...ordered.values()];
}
