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
 * - A chat runs left to right (bot-os.md D60): a chat-in edge from a connector's output to a
 *   reader's input, with its `reads`; a chat-out edge from a sender's output to the connector's
 *   input, with its `sends` and `commands`. A connector's chat-out input takes any number of edges;
 *   a sender's chat-out output, one, and a required one left unbound fails the start, as an input
 *   does. A version 1 file, with one chat edge for both, is converted on load (`upgradeGraph`).
 * - An events input whose namespace its node's config names (`{ config: key }`) is resolved per
 *   node, from the config as its plugin's schema makes it (`resolveInputs`): a required one the
 *   config leaves unresolved fails the start, naming the node.
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
  readsSchema,
  resolveInputs,
} from './ports.ts';

/**
 * The format of the graph file; a change that old files cannot be read with bumps it. Version 2
 * splits each chat edge into a chat-in (reads) and a chat-out (sends) edge (bot-os.md D60); a
 * version 1 file is converted on load (`upgradeGraph`).
 */
export const GRAPH_VERSION = 2;

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
        /** A chat-in's: the chats read, or `'*'`, any chat its connector monitors (D62). */
        reads: readsSchema.optional(),
        /** A chat-in's: the senders heard (usernames, `me` the account's own); none: anyone. */
        senders: z.array(z.string().min(1)).optional(),
        /** A chat-out's: the chats sent to, and the commands sent (first words). */
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

/** A chat-in's reads, copied: `'*'` as it is, a list anew. */
const copyReads = (r: ChatBinding['reads']): ChatBinding['reads'] => (r === '*' ? r : [...r]);

/** One port's other end. */
export interface Binding {
  /** The node bound, and its port: an input's output, or a chat-out output's input. */
  node: string;
  port: string;
  type: PortType;
  /** A chat-in's reads, or a chat-out's sends and commands. */
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
  /** Its input ports: its manifest's, each events input's namespace resolved from its config. */
  ports: Record<string, InputPort>;
  /** Each of its input ports, with its other ends (none: unbound). */
  inputs: Map<string, Binding[]>;
  /** Each of its chat-out output ports, with the connector it sends through (none: unbound). */
  outputs: Map<string, Binding[]>;
}

/**
 * A node's input ports (`resolveInputs`), from its config as its plugin's schema makes it (with
 * its defaults), or as written when the schema refuses it (the load then says why).
 */
export function nodeInputs(
  manifest: Manifest,
  config: Readonly<Record<string, unknown>> | undefined
): { ports: Record<string, InputPort>; problems: string[] } {
  const parsed = manifest.config?.safeParse(config ?? {});
  const made = parsed?.success === true ? (parsed.data as Record<string, unknown>) : config;
  return resolveInputs(manifest.inputs, made);
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
 * (`config`, by id), and each port bound as its manifest's `bind` says (an events input, by
 * default, to every other node registering its namespace; an interface input to the node of its
 * plugin's id; a chat-in input from its connector, a chat-out output to it). A port whose default
 * other end is not there is left unbound.
 */
export function defaultGraph(
  manifests: readonly Manifest[],
  config: Readonly<Record<string, unknown>> = {}
): Graph {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const portsOf = (m: Manifest): Record<string, InputPort> =>
    nodeInputs(m, config[m.id] as Record<string, unknown> | undefined).ports;
  const edges: GraphEdge[] = [];
  for (const m of manifests) {
    for (const [port, input] of Object.entries(portsOf(m))) {
      const targets =
        input.type === 'events'
          ? (input.bind?.nodes ??
            manifests
              .filter((o) => o.id !== m.id && o.games.registers.includes(input.namespace))
              .map((o) => o.id))
          : input.type === 'chat-in' || input.type === 'interface'
            ? [input.bind?.node ?? (input.type === 'interface' ? input.plugin : undefined)].filter(
                (n) => n !== undefined
              )
            : [];
      for (const target of targets) {
        const other = byId.get(target);
        const out = other === undefined ? undefined : fitting(input, other, true)[0];
        if (out === undefined) continue;
        edges.push({
          from: `${target}.${out[0]}`,
          to: `${m.id}.${port}`,
          type: input.type,
          ...(input.type === 'chat-in' && input.bind !== undefined
            ? {
                reads: copyReads(input.bind.reads),
                ...(input.bind.senders === undefined ? {} : { senders: [...input.bind.senders] }),
              }
            : {}),
        });
      }
    }
    for (const [port, output] of Object.entries(m.outputs)) {
      if (output.type !== 'chat-out' || output.bind === undefined) continue;
      const { node, sends, commands } = output.bind;
      const other = byId.get(node);
      const into =
        other === undefined
          ? undefined
          : Object.entries(portsOf(other)).find(([, i]) => mismatch(i, output) === undefined);
      if (into === undefined) continue;
      edges.push({
        from: `${m.id}.${port}`,
        to: `${node}.${into[0]}`,
        type: 'chat-out',
        sends: [...sends],
        ...(commands === undefined ? {} : { commands: [...commands] }),
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

/** An account's network: the part before its colon. */
const networkOf = (account: string): string => account.slice(0, account.indexOf(':'));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A graph of version 1 as version 2 (bot-os.md D60), against the plugins' manifests; any other
 * graph as it is. Each chat edge of version 1 (its `type` `chat`, or a chat's reads, sends or
 * commands, or an input of a chat port) becomes, by the ports of its target node (its plugin's
 * manifest, its config resolving them):
 *
 * - a chat-in edge, the same two ends, with its `reads`, if the node has a chat-in input of that
 *   name (or has neither: the check then says why);
 * - a chat-out edge from the node's chat-out output of that name to the connector's chat-out input
 *   (`chat`), with its `sends` and `commands`, if it has one;
 * - both, for a node with both (a plugin of module API 1, whose old chat input is both), or one
 *   whose plugin is not known (none given: a tool that prints a file), so that nothing is lost.
 *
 * The other edges and the nodes are kept as they are. Nothing is checked: `resolveGraph` does.
 */
export function upgradeGraph(raw: unknown, plugins: ReadonlyMap<string, Manifest>): unknown {
  if (!isRecord(raw) || raw['version'] !== 1) return raw;
  const known = new Map<string, { manifest: Manifest; ports: Record<string, InputPort> }>();
  for (const n of Array.isArray(raw['nodes']) ? (raw['nodes'] as unknown[]) : []) {
    if (!isRecord(n) || typeof n['id'] !== 'string' || typeof n['plugin'] !== 'string') continue;
    const manifest = plugins.get(n['plugin']);
    if (manifest === undefined) continue;
    const config = isRecord(n['config']) ? n['config'] : undefined;
    known.set(n['id'], { manifest, ports: nodeInputs(manifest, config).ports });
  }
  const upgrade = (e: unknown): unknown[] => {
    if (!isRecord(e) || typeof e['from'] !== 'string' || typeof e['to'] !== 'string') return [e];
    const { from, to, type, reads, sends, commands, ...rest } = e as Record<string, unknown> & {
      from: string;
      to: string;
    };
    const [toNode = '', toPort = ''] = to.split('.');
    const target = known.get(toNode);
    const readsIt = target?.ports[toPort]?.type === 'chat-in';
    const sendsIt = target?.manifest.outputs[toPort]?.type === 'chat-out';
    const chat =
      type === 'chat' ||
      (type === undefined &&
        (reads !== undefined ||
          sends !== undefined ||
          commands !== undefined ||
          readsIt ||
          sendsIt));
    if (!chat) return [e];
    const hasIn = target === undefined || readsIt;
    const hasOut = target === undefined || sendsIt;
    const out: unknown[] = [];
    if (hasIn || !hasOut)
      out.push({ ...rest, from, to, type: 'chat-in', ...(reads === undefined ? {} : { reads }) });
    if (hasOut) {
      const fromNode = from.split('.')[0] as string;
      const into =
        Object.entries(known.get(fromNode)?.manifest.inputs ?? {}).find(
          ([, p]) => p.type === 'chat-out'
        )?.[0] ?? 'chat';
      out.push({
        ...rest,
        from: to,
        to: `${fromNode}.${into}`,
        type: 'chat-out',
        ...(sends === undefined ? {} : { sends }),
        ...(commands === undefined ? {} : { commands }),
      });
    }
    return out;
  };
  return {
    ...raw,
    version: GRAPH_VERSION,
    ...(Array.isArray(raw['edges']) ? { edges: (raw['edges'] as unknown[]).flatMap(upgrade) } : {}),
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
  const parsed = graphSchema.safeParse(upgradeGraph(raw, plugins));
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
      if (manifest.account === undefined)
        problems.push(`node ${n.id}: only a connector has an account`);
      else if (networkOf(n.account) !== networkOf(manifest.account))
        problems.push(
          `node ${n.id}: its account ${n.account} is not of ${manifest.account}'s network`
        );
    }
    if (account !== undefined) {
      const other = accounts.get(account);
      if (other !== undefined) problems.push(`node ${n.id}: the account ${account} is ${other}'s`);
      else accounts.set(account, n.id);
    }
    const { ports: resolved, problems: unresolved } = nodeInputs(manifest, n.config);
    for (const p of unresolved) problems.push(`node ${n.id}: ${p}`);
    // A connector's chat-out input is of its node's account's network.
    const ports =
      account === undefined
        ? resolved
        : Object.fromEntries(
            Object.entries(resolved).map(([k, p]) => [
              k,
              p.type === 'chat-out' ? { ...p, network: networkOf(account) } : p,
            ])
          );
    nodes.set(n.id, {
      id: n.id,
      instance,
      manifest,
      ports,
      ...(account === undefined ? {} : { account }),
      ...(n.config === undefined ? {} : { config: n.config }),
      ...(n.settings === undefined ? {} : { settings: n.settings }),
      ...(n.mode === undefined ? {} : { mode: n.mode }),
      inputs: new Map(Object.keys(ports).map((p) => [p, []])),
      outputs: new Map(
        Object.entries(manifest.outputs).flatMap(([p, o]) =>
          o.type === 'chat-out' ? [[p, []] as [string, Binding[]]] : []
        )
      ),
    });
  }
  const edges: GraphEdge[] = [];
  /** The inputs, and the chat-out outputs, an edge's problem has named already. */
  const named = new Set<string>();
  const namedOut = new Set<string>();
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
    const input = to.ports[toPort];
    if (input === undefined) {
      const declared = to.manifest.inputs[toPort];
      problems.push(
        `node ${toNode}: no input port ${toPort}` +
          (declared?.type === 'events' && typeof declared.namespace !== 'string'
            ? `: its namespace comes from config ${declared.namespace.config}, which is not set`
            : '')
      );
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
    if (output.type === 'chat-in' && from.account !== undefined)
      output = { type: 'chat-in', network: networkOf(from.account) };
    const why = mismatch(input, output);
    named.add(e.to);
    if (output.type === 'chat-out') namedOut.add(`${fromNode}.${port}`);
    if (why !== undefined) {
      problems.push(`node ${toNode}: input port ${toPort}: ${why} (${name})`);
      continue;
    }
    if (e.type !== undefined && e.type !== input.type) {
      problems.push(`${name}: its type is ${input.type}, not ${e.type}`);
      continue;
    }
    if ((e.reads !== undefined || e.senders !== undefined) && input.type !== 'chat-in') {
      problems.push(`${name}: only a chat-in edge carries reads and senders`);
      continue;
    }
    if ((e.sends !== undefined || e.commands !== undefined) && input.type !== 'chat-out') {
      problems.push(`${name}: only a chat-out edge carries sends and commands`);
      continue;
    }
    const bound = to.inputs.get(toPort) as Binding[];
    if (input.type !== 'events' && input.type !== 'chat-out' && bound.length > 0) {
      problems.push(`node ${toNode}: input port ${toPort} is bound twice`);
      continue;
    }
    if (bound.some((b) => b.node === fromNode && b.port === port)) {
      problems.push(`${name}: twice in the graph`);
      continue;
    }
    const sending = from.outputs.get(port);
    if (sending !== undefined && sending.length > 0) {
      problems.push(`node ${fromNode}: output port ${port} is bound twice`);
      continue;
    }
    const written =
      input.type === 'chat-in'
        ? { reads: e.reads ?? [], ...(e.senders === undefined ? {} : { senders: e.senders }) }
        : input.type === 'chat-out'
          ? { sends: e.sends ?? [], ...(e.commands === undefined ? {} : { commands: e.commands }) }
          : undefined;
    const chat: ChatBinding | undefined =
      written === undefined ? undefined : { reads: [], sends: [], ...written };
    bound.push({
      node: fromNode,
      port,
      type: input.type,
      ...(chat === undefined ? {} : { chat }),
    });
    sending?.push({
      node: toNode,
      port: toPort,
      type: input.type,
      ...(chat === undefined ? {} : { chat }),
    });
    edges.push({ from: `${fromNode}.${port}`, to: e.to, type: input.type, ...(written ?? {}) });
  }
  for (const n of nodes.values())
    for (const [port, input] of Object.entries(n.ports)) {
      if (input.optional || named.has(`${n.id}.${port}`) || (n.inputs.get(port)?.length ?? 0) > 0)
        continue;
      const target =
        input.type === 'chat-in'
          ? input.bind?.node
          : input.type === 'interface'
            ? (input.bind?.node ?? input.plugin)
            : undefined;
      problems.push(
        `node ${n.id}: input port ${port} (${describePort(input)}) is not bound` +
          (target === undefined || nodes.has(target) ? '' : `: ${target} is not in the graph`)
      );
    }
  for (const n of nodes.values())
    for (const [port, bound] of n.outputs) {
      const output = n.manifest.outputs[port];
      if (
        output?.type !== 'chat-out' ||
        output.optional ||
        bound.length > 0 ||
        namedOut.has(`${n.id}.${port}`)
      )
        continue;
      const target = output.bind?.node;
      problems.push(
        `node ${n.id}: output port ${port} (${describePort(output)}) is not bound` +
          (target === undefined || nodes.has(target) ? '' : `: ${target} is not in the graph`)
      );
    }
  if (problems.length > 0) throw new GraphError(problems);
  return {
    graph: { version: parsed.data.version, nodes: parsed.data.nodes, edges },
    nodes: [...nodes.values()],
  };
}

/**
 * The nodes a node's required ports bind, in the order of its inputs, then of its chat-out
 * outputs (the connectors it sends through, which start first).
 */
export function requiredOf(node: ResolvedNode): string[] {
  const out: string[] = [];
  for (const [port, bindings] of node.inputs)
    if (node.ports[port]?.optional !== true)
      for (const b of bindings) if (!out.includes(b.node)) out.push(b.node);
  for (const [port, bindings] of node.outputs) {
    const output = node.manifest.outputs[port];
    if (output?.type === 'chat-out' && !output.optional)
      for (const b of bindings) if (!out.includes(b.node)) out.push(b.node);
  }
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
