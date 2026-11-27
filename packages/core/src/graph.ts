/**
 * The instance's wiring as data (docs/bot-os-api.md §2.1, P17, D27): a graph whose nodes are plugin
 * instances, each with its id, its plugin and its configuration, and whose edges bind an input port
 * of one node to an output port of another, of the same type (packages/core/src/ports.ts).
 * It is checked with zod and against the manifests at start, and every problem names the node and
 * the port; the core runs it (packages/core/src/core.ts), and the edges are the permissions
 * (P6).
 *
 * - A plugin may be instantiated more than once, each node with its own id, configuration, store
 *   and settings. A node's kept state (its store, timers, settings and stop) belongs to the
 *   _instance_ it names (`/data/instances/<instance>/`, the node's id when it names none), which
 *   outlives the node: a node of the same plugin may take it up again.
 * - The programmatic wiring is the default graph: a node per plugin registered, each input bound as
 *   its manifest's `bind` says. Any other graph (a file) replaces it as a whole.
 * - A required input left unbound, an edge between ports of two types, an input of one edge bound
 *   twice, an unknown plugin, node or port, and a cycle of required edges fail the start. An edge
 *   naming a port its node's manifest no longer declares at all (an upgrade dropped it) is stale:
 *   dropped from the graph, with a warning, and the rest runs (bot-os.md D154).
 * - A chat runs left to right (bot-os.md D60): a chat-in edge from a connector's output to a
 *   reader's input, with its `reads`; a chat-out edge from a sender's output to the connector's
 *   input, with its `sends` and `commands`. A connector's chat-out input takes any number of edges;
 *   a sender's chat-out output, one, and a required one left unbound fails the start, as an input
 *   does.
 * - An events input whose namespace its node's config names (`{ config: key }`) is resolved per
 *   node, from the config as its plugin's schema makes it (`resolveInputs`): a required one the
 *   config leaves unresolved fails the start, naming the node.
 * - A node may name the `group` it is drawn in (bot-os.md D69), which the run ignores.
 * - A plugin's chat commands are served through a commands edge (bot-os.md D109), from a
 *   connector's commands output to the plugin's commands input, with which commands it `serves`
 *   (none: all), the `chats` it answers in and every private chat (`privateChats`), who may ask
 *   (`senders`, `owner` for the connector's owner; none: anyone) and its `dryRun`. No edge, no chat
 *   command. Either end takes any number of them, two between the same nodes refused.
 * - A simulated person's attention (bot-os.md D133) runs from the node that holds it, its
 *   `attention` output, to each node that plays in its sittings, their `attention` input: any number
 *   of edges leave the output, one reaches an input. It carries nothing.
 * - A node may be `disabled` by the owner: checked as any other, never started. A chat-out edge, or
 *   a commands edge, may be a `dryRun`: what it sends is logged as sent, never sent (bot-os.md D64). A node whose
 *   required ports bind one that is down (disabled, stopped or inactive) is inactive
 *   (`nodeStates`); an optional one bound to it counts as unbound.
 *
 * Nothing in here knows of any game.
 */
import { z } from 'zod';
import { ACCOUNT_ID, type Manifest, parseManifest, PLUGIN_ID } from './manifest.ts';
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
import { selectorIssues, type WidgetIssue, widgetIssues } from './widgets.ts';

/**
 * The format of the graph file; a change that old files cannot be read with bumps it. Version 2
 * splits each chat edge into a chat-in (reads) and a chat-out (sends) edge (bot-os.md D60). A file
 * of another version is refused, with why (bot-os.md D110: the conversion of version 1 is gone).
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
      /** Disabled by the owner (bot-os.md D64): checked, never started; absent, enabled. */
      disabled: z.boolean().optional(),
      /**
       * The group it is drawn in, a swimlane of the editor (bot-os.md D69): any name, not empty and
       * without spaces at its ends. Only the drawing reads it; absent, no group.
       */
      group: z
        .string()
        .refine((g) => g !== '' && g.trim() === g, 'expected a name, without spaces at its ends')
        .optional(),
      /**
       * A view's path (bot-os.md D170): it is served at `/v/<path>/`; absent, its id. Only a view
       * has one, and no two views one.
       */
      path: z.string().regex(PLUGIN_ID, 'expected lower-case words and dashes').optional(),
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
        /**
         * A chat-in's: the senders heard (usernames, `me` the account's own); a commands edge's:
         * who may ask (usernames or ids, `owner` the connector's owner, D109); none: anyone.
         */
        senders: z.array(z.string().min(1)).optional(),
        /** A chat-out's: the chats sent to, and the commands sent (first words). */
        sends: z.array(z.string().min(1)).optional(),
        commands: z.array(z.string().min(1)).optional(),
        /**
         * A chat-out's: the least seconds between two queued sends of a command in one chat, by
         * its first word (D73); a command not named, the connector's default.
         */
        minIntervalS: z.record(z.string().min(1), z.number().nonnegative()).optional(),
        /**
         * A chat-out's: it lets photos through where it names its `commands` (D150), which a
         * photo, having no first word, is never among.
         */
        photos: z.boolean().optional(),
        /**
         * A commands edge's (D109): the commands it serves, by name, of its plugin's; absent, all
         * of them.
         */
        serves: z.array(z.string().min(1)).optional(),
        /** A commands edge's: the chats it answers in, as its connector names them. */
        chats: z.array(z.string().min(1)).optional(),
        /** A commands edge's: it answers in every private chat with the account too. */
        privateChats: z.boolean().optional(),
        /**
         * A chat-out's, or a commands edge's: what it sends, or answers, is logged as sent, never
         * sent (D64, D109); absent, live.
         */
        dryRun: z.boolean().optional(),
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

/**
 * A graph refused, with every problem; `warnings`, what the check would warn of as well (bot-os.md
 * D89), as far as it got.
 */
export class GraphError extends Error {
  readonly problems: string[];
  readonly warnings: string[];
  constructor(problems: string[], warnings: string[] = []) {
    super(problems.join('\n'));
    this.problems = problems;
    this.warnings = warnings;
  }
}

/**
 * The chats a connector's node monitors, as its manifest's `monitors` reads them from its config
 * (bot-os.md D89), as written there, with the key: `'all'`, every chat (declared so, or the key
 * unset); none when the manifest does not say (unknown).
 */
export function monitoredChats(
  manifest: Manifest,
  config: Readonly<Record<string, unknown>> | undefined
): { key: string; chats: string[] } | 'all' | undefined {
  const m = manifest.monitors;
  if (m === undefined || m === 'all') return m;
  const parsed = manifest.config?.safeParse(config ?? {});
  const made = parsed?.success === true ? (parsed.data as Record<string, unknown>) : config;
  const value = made?.[m.config];
  if (value === undefined || value === null) return 'all';
  const chats = (Array.isArray(value) ? (value as unknown[]) : [value]).filter(
    (c): c is string => typeof c === 'string'
  );
  return { key: m.config, chats };
}

/**
 * The chats of a chat-in edge's `reads` that a connector monitoring `monitored` does not hear
 * (bot-os.md D89, D90). A chat goes by itself and by every name `names` gives it (its running
 * connector's `chatNames`: an id and a `@username`, say), compared without case; it is heard when
 * one of its names is one of a monitored chat's. Where a chat may go by several names (`aliases`,
 * the manifest's) and `names` knows neither it nor every monitored chat, it cannot be told: unknown,
 * not wrong, and so not returned.
 */
export function unmonitoredReads(
  reads: readonly string[],
  monitored: readonly string[],
  aliases: boolean,
  names: (chat: string) => readonly string[] | undefined = () => undefined
): string[] {
  const known = (chat: string): string[] | undefined => {
    const n = names(chat);
    return n === undefined ? undefined : [chat, ...n].map((c) => c.toLowerCase());
  };
  const heard = new Set<string>();
  let allKnown = true;
  for (const m of monitored) {
    const k = known(m);
    if (k === undefined) allKnown = false;
    for (const c of k ?? [m.toLowerCase()]) heard.add(c);
  }
  return reads.filter((chat) => {
    const k = known(chat);
    if ((k ?? [chat.toLowerCase()]).some((c) => heard.has(c))) return false;
    return !aliases || k !== undefined || allKnown;
  });
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
  /** A commands edge's (D109): what it serves, where, and to whom. */
  commands?: CommandsBinding;
  /** A chat-out's, or a commands edge's: a dry run (D64, D109). */
  dryRun?: boolean;
}

/** What a commands edge carries (bot-os.md D109). */
export interface CommandsBinding {
  /** The commands it serves, by name; none: all of its plugin's. */
  serves?: string[];
  /** The chats it answers in, as its connector names them. */
  chats: string[];
  /** Every private chat with the account too. */
  privateChats: boolean;
  /** Who may ask, by username or id, `owner` for the connector's owner; none: anyone. */
  senders?: string[];
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
  /** The settings a fresh instance starts with. */
  settings?: Record<string, unknown>;
  /** Disabled by the owner (D64): never started. */
  disabled?: boolean;
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
 * A node's own manifest (bot-os.md D74): its plugin's, or, for a plugin whose ports its node's
 * config declares (`manifest.node`), what that makes of the node's config (as the plugin's schema
 * makes it, or as written when the schema refuses it, the load then saying why) and its id,
 * checked as any manifest, of the plugin's id. A manifest refused is the node's problem, and the
 * plugin's own stands in for it.
 */
export function nodeManifest(
  base: Manifest,
  id: string,
  config: Readonly<Record<string, unknown>> | undefined
): { manifest: Manifest; problem?: string } {
  if (base.node === undefined) return { manifest: base };
  const parsed = base.config?.safeParse(config ?? {});
  const made = parsed?.success === true ? (parsed.data as Record<string, unknown>) : (config ?? {});
  try {
    const m = parseManifest(base.node(made, id));
    if (m.id !== base.id)
      return { manifest: base, problem: `node ${id}: its manifest is of ${m.id}, not ${base.id}` };
    return { manifest: m };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { manifest: base, problem: `node ${id}: ${why.replace(/^plugin \S+: /u, '')}` };
  }
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
 * Why a connector has no chat port, for an edge that names one (bot-os.md D148): it has no chat
 * (`chat: false`), a service connector. Empty for any other node.
 */
const noChat = (manifest: Manifest, node: string): string =>
  manifest.kinds.includes('connector') && !manifest.chat
    ? `: ${node} is a service connector, with no chat to read or send through (D148)`
    : '';

/**
 * Whether a port an edge names is gone from its node (bot-os.md D154): its manifest declares no
 * port of that name, input or output, and it is not a service connector's chat (D148, refused
 * with why). An edge to or from it is stale, dropped with a warning; one naming a port the
 * manifest declares the other way round, or an input its config leaves out (an events namespace
 * from a config not set, a gated input), stays a problem.
 */
const gone = (manifest: Manifest, port: string, node: string, chat: boolean): boolean =>
  manifest.inputs[port] === undefined &&
  manifest.outputs[port] === undefined &&
  (!chat || noChat(manifest, node) === '');

/**
 * The programmatic wiring's graph: a node per plugin, its id the plugin's, with its configuration
 * (`config`, by id), and each port bound as its manifest's `bind` says (an events input, by
 * default, to every other node registering its namespace; an interface input to the node of its
 * plugin's id; a chat-in input from its connector, a chat-out output to it). A port whose default
 * other end is not there is left unbound. A connector's node names its manifest's account, which a
 * test or the dev kit gives its connector; a node of a graph file names none (`nodeAccount`).
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
          : input.type === 'chat-in' || input.type === 'interface' || input.type === 'attention'
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
      const { node, sends, commands, minIntervalS } = output.bind;
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
        ...(minIntervalS === undefined ? {} : { minIntervalS: { ...minIntervalS } }),
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
        // The programmatic wiring runs a connector on its manifest's account (a test's, a kit's).
        ...(m.account === undefined ? {} : { account: m.account }),
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
 * wiring runs a plugin meant for several instances (the player's, one per bot), its other
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
export const networkOf = (account: string): string => account.slice(0, account.indexOf(':'));

/**
 * A connector node's account (§4.5, bot-os.md D119): the one its graph node names, else
 * `<network>:<node id>`, its network its plugin's (its manifest's `account`'s). Node ids are unique,
 * so accounts are. Undefined for a node that is not a connector's.
 */
export function nodeAccount(
  id: string,
  manifest: { account?: string | undefined },
  named?: string
): string | undefined {
  if (named !== undefined) return named;
  return manifest.account === undefined ? undefined : `${networkOf(manifest.account)}:${id}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a graph against the manifests of the plugins the image has (by plugin id): the graph as
 * the core holds it (each edge's ends and type written out), its nodes, in the graph's order, and
 * its warnings (bot-os.md D89), which refuse nothing: a chat-in edge that reads a chat its
 * connector's config does not monitor (`monitoredChats`, `unmonitoredReads`; each chat by any of
 * its names, as `chatNames` says, D90); an edge dropped for naming a port its node no longer has
 * (`gone`, D154). A GraphError lists every problem, each naming its node and port.
 */
export function resolveGraph(
  raw: unknown,
  plugins: ReadonlyMap<string, Manifest>,
  /** The plugin of an instance kept already, by its id; undefined for a fresh one. */
  instanceOf: (instance: string) => string | undefined = () => undefined,
  /**
   * Every name a connector's node, of a plugin, knows a chat by, as its running connector says
   * (bot-os.md D90); undefined when it cannot tell (not running, not connected, a chat it never
   * saw).
   */
  chatNames: (node: string, plugin: string, chat: string) => readonly string[] | undefined = () =>
    undefined
): { graph: Graph; nodes: ResolvedNode[]; warnings: string[] } {
  if (isRecord(raw) && typeof raw['version'] === 'number' && raw['version'] !== GRAPH_VERSION)
    throw new GraphError([
      `graph: version: a graph of version ${raw['version']}, which this release does not read (it reads version ${GRAPH_VERSION})`,
    ]);
  const parsed = graphSchema.safeParse(raw);
  if (!parsed.success)
    throw new GraphError(
      parsed.error.issues.map(
        (i) => `graph: ${i.path.map(String).join('.') || '(graph)'}: ${i.message}`
      )
    );
  const problems: string[] = [];
  const warnings: string[] = [];
  const nodes = new Map<string, ResolvedNode>();
  const accounts = new Map<string, string>();
  const instances = new Map<string, string>();
  for (const n of parsed.data.nodes) {
    const base = plugins.get(n.plugin);
    if (nodes.has(n.id)) {
      problems.push(`node ${n.id}: in the graph twice`);
      continue;
    }
    if (base === undefined) {
      problems.push(`node ${n.id}: its plugin ${n.plugin} is not in the image`);
      continue;
    }
    // A node whose ports its config declares has a manifest of its own (D74).
    const { manifest, problem } = nodeManifest(base, n.id, n.config);
    if (problem !== undefined) problems.push(problem);
    // What its config makes it do that the owner may not mean: warned of, not refused (D138).
    for (const w of manifest.warns?.(n.config ?? {}) ?? []) warnings.push(`node ${n.id}: ${w}`);
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
    const account = nodeAccount(n.id, manifest, n.account);
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
      ...(n.disabled === true ? { disabled: true } : {}),
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
      // A port its node's manifest no longer declares, as either end (an upgrade dropped it): the
      // edge is stale, dropped and warned of, and the rest runs (D154).
      if (gone(to.manifest, toPort, toNode, toPort === 'chat' || e.type === 'chat-out')) {
        warnings.push(`${name} dropped: ${toNode} has no input port ${toPort}`);
        continue;
      }
      problems.push(
        `node ${toNode}: no input port ${toPort}` +
          (declared?.type === 'events' &&
          typeof declared.namespace !== 'string' &&
          'config' in declared.namespace
            ? `: its namespace comes from config ${declared.namespace.config}, which is not set`
            : toPort === 'chat' || e.type === 'chat-out'
              ? noChat(to.manifest, toNode)
              : '')
      );
      continue;
    }
    let port = fromPort;
    if (port === undefined) {
      const fits = fitting(input, from.manifest);
      if (fits.length !== 1) {
        const why =
          fits.length === 0 && input.type === 'chat-in' ? noChat(from.manifest, fromNode) : '';
        problems.push(
          why === ''
            ? `${name}: ${fits.length === 0 ? 'no' : 'more than one'} output of ${fromNode} fits ${describePort(input)}; name it`
            : `${name}: no output of ${fromNode} fits ${describePort(input)}${why}`
        );
        continue;
      }
      port = (fits[0] as [string, OutputPort])[0];
    }
    let output = from.manifest.outputs[port];
    if (output === undefined) {
      if (gone(from.manifest, port, fromNode, port === 'chat' || e.type === 'chat-in')) {
        warnings.push(`${name} dropped: ${fromNode} has no output port ${port}`);
        continue;
      }
      problems.push(
        `node ${fromNode}: no output port ${port}` +
          (port === 'chat' || e.type === 'chat-in' ? noChat(from.manifest, fromNode) : '')
      );
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
    if (e.reads !== undefined && input.type !== 'chat-in') {
      problems.push(`${name}: only a chat-in edge carries reads`);
      continue;
    }
    if (e.senders !== undefined && input.type !== 'chat-in' && input.type !== 'commands') {
      problems.push(`${name}: only a chat-in or a commands edge carries senders`);
      continue;
    }
    if (
      (e.sends !== undefined ||
        e.commands !== undefined ||
        e.minIntervalS !== undefined ||
        e.photos !== undefined) &&
      input.type !== 'chat-out'
    ) {
      problems.push(
        `${name}: only a chat-out edge carries sends, commands, minIntervalS and photos`
      );
      continue;
    }
    if (e.dryRun !== undefined && input.type !== 'chat-out' && input.type !== 'commands') {
      problems.push(`${name}: only a chat-out or a commands edge carries dryRun`);
      continue;
    }
    if (
      (e.serves !== undefined || e.chats !== undefined || e.privateChats !== undefined) &&
      input.type !== 'commands'
    ) {
      problems.push(`${name}: only a commands edge carries serves, chats and privateChats`);
      continue;
    }
    // A commands edge serves only the commands its plugin declares (D109).
    const unknown =
      input.type === 'commands' ? (e.serves ?? []).filter((c) => !input.commands.includes(c)) : [];
    if (unknown.length > 0) {
      problems.push(
        `node ${toNode}: input port ${toPort} has no command ${unknown.join(', ')} (${name})`
      );
      continue;
    }
    const bound = to.inputs.get(toPort) as Binding[];
    // An events input whose namespace is its edge's (D156) takes one edge: its namespace is that.
    if (input.type === 'events' && input.edge === true && bound.length > 0) {
      problems.push(
        `node ${toNode}: input port ${toPort} takes one edge: its namespace is the node its edge comes from (${name})`
      );
      continue;
    }
    if (
      input.type !== 'events' &&
      input.type !== 'chat-out' &&
      input.type !== 'commands' &&
      bound.length > 0
    ) {
      problems.push(`node ${toNode}: input port ${toPort} is bound twice`);
      continue;
    }
    if (bound.some((b) => b.node === fromNode && b.port === port)) {
      problems.push(`${name}: twice in the graph`);
      continue;
    }
    const sending = from.outputs.get(port);
    // An output of several edges (D97), one per connector: owner-notice's.
    const many = output.type === 'chat-out' && output.many === true;
    if (sending !== undefined && sending.length > 0 && !many) {
      problems.push(`node ${fromNode}: output port ${port} is bound twice`);
      continue;
    }
    // A chat-out output that declares its commands (D74): its edge allows those, or fewer.
    const declared = output.type === 'chat-out' ? output.commands : undefined;
    if (declared !== undefined) {
      const extra =
        e.commands === undefined
          ? undefined
          : e.commands.filter((c) => !declared.includes(c.split(/\s/u)[0] ?? c));
      if (e.commands === undefined || (extra?.length ?? 0) > 0) {
        problems.push(
          `node ${fromNode}: output port ${port} sends only ${declared.join(', ')}: ${
            e.commands === undefined
              ? 'its edge allows any text, name its commands'
              : `its edge allows ${(extra as string[]).join(', ')} too`
          } (${name})`
        );
        continue;
      }
    }
    const written =
      input.type === 'chat-in'
        ? { reads: e.reads ?? [], ...(e.senders === undefined ? {} : { senders: e.senders }) }
        : input.type === 'chat-out'
          ? {
              sends: e.sends ?? [],
              ...(e.commands === undefined ? {} : { commands: e.commands }),
              ...(e.minIntervalS === undefined ? {} : { minIntervalS: e.minIntervalS }),
              ...(e.photos === undefined ? {} : { photos: e.photos }),
              ...(e.dryRun === undefined ? {} : { dryRun: e.dryRun }),
            }
          : undefined;
    const served: CommandsBinding | undefined =
      input.type === 'commands'
        ? {
            ...(e.serves === undefined ? {} : { serves: [...e.serves] }),
            chats: [...(e.chats ?? [])],
            privateChats: e.privateChats === true,
            ...(e.senders === undefined ? {} : { senders: [...e.senders] }),
          }
        : undefined;
    const { dryRun: _dry, ...carried } = (written ?? {}) as Record<string, unknown>;
    const chat: ChatBinding | undefined =
      written === undefined ? undefined : ({ reads: [], sends: [], ...carried } as ChatBinding);
    const dryRun = e.dryRun === true ? { dryRun: true } : {};
    const carries = {
      ...(chat === undefined ? {} : { chat }),
      ...(served === undefined ? {} : { commands: served }),
      ...dryRun,
    };
    bound.push({ node: fromNode, port, type: input.type, ...carries });
    // Its namespace, from its edge (D156): the events output's it comes from.
    if (input.type === 'events' && input.edge === true && output.type === 'events')
      to.ports[toPort] = { ...input, namespace: output.namespace };
    sending?.push({ node: toNode, port: toPort, type: input.type, ...carries });
    edges.push({
      from: `${fromNode}.${port}`,
      to: e.to,
      type: input.type,
      ...(written ?? {}),
      ...(input.type === 'commands'
        ? {
            ...(e.serves === undefined ? {} : { serves: e.serves }),
            chats: e.chats ?? [],
            ...(e.privateChats === true ? { privateChats: true } : {}),
            ...(e.senders === undefined ? {} : { senders: e.senders }),
            ...(e.dryRun === undefined ? {} : { dryRun: e.dryRun }),
          }
        : {}),
    });
    // A commands edge that names no chat answers nowhere: warned of, not refused (D109).
    if (input.type === 'commands' && (e.chats ?? []).length === 0 && e.privateChats !== true)
      warnings.push(
        `node ${toNode}: input port ${toPort} is served in no chat: its edge names none (${name})`
      );
    // A chat read that its connector does not monitor is never heard (D89): warned of, not refused.
    const monitored =
      input.type === 'chat-in' && Array.isArray(e.reads)
        ? monitoredChats(from.manifest, from.config)
        : undefined;
    if (monitored !== undefined && monitored !== 'all') {
      const aliases = typeof from.manifest.monitors === 'object' && from.manifest.monitors.aliases;
      for (const chat of unmonitoredReads(
        e.reads as string[],
        monitored.chats,
        aliases === true,
        (c) => chatNames(fromNode, from.manifest.id, c)
      ))
        warnings.push(
          `node ${toNode}: input port ${toPort} reads ${chat}, which ${fromNode} does not monitor (its ${monitored.key}: ${monitored.chats.length === 0 ? 'none' : monitored.chats.join(', ')}) (edge ${e.from} → ${e.to})`
        );
    }
  }
  for (const n of nodes.values())
    for (const [port, input] of Object.entries(n.ports)) {
      if (input.optional || named.has(`${n.id}.${port}`) || (n.inputs.get(port)?.length ?? 0) > 0)
        continue;
      const target =
        input.type === 'chat-in' || input.type === 'attention'
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
  for (const n of nodes.values()) problems.push(...oneChatProblems(n));
  problems.push(...viewProblems(parsed.data.nodes, nodes));
  if (problems.length > 0) throw new GraphError(problems, warnings);
  return {
    graph: { version: parsed.data.version, nodes: parsed.data.nodes, edges },
    nodes: [...nodes.values()],
    warnings,
  };
}

/**
 * What the views of a graph refuse (bot-os.md D170): a path on a node that is no view, two views of
 * one path (a view's is its node's `path`, else its id), and each section, and the selector, as the
 * node bound to its input declares its reads and actions: a read it has not, an input it refuses, a
 * path its output has not, an action its rows cannot run. An input left unbound is checked when
 * it is bound.
 */
function viewProblems(
  written: readonly { id: string; path?: string | undefined }[],
  nodes: ReadonlyMap<string, ResolvedNode>
): string[] {
  const out: string[] = [];
  const paths = new Map<string, string>();
  for (const w of written) {
    const n = nodes.get(w.id);
    if (n === undefined) continue;
    const view = n.manifest.view;
    if (view === undefined) {
      if (w.path !== undefined) out.push(`node ${n.id}: only a view has a path`);
      continue;
    }
    const at = w.path ?? n.id;
    const other = paths.get(at);
    if (other !== undefined) out.push(`node ${n.id}: the path /v/${at}/ is ${other}'s`);
    else paths.set(at, n.id);
    const boundTo = (port: string): ResolvedNode | undefined => {
      const b = n.inputs.get(port)?.[0];
      return b === undefined ? undefined : nodes.get(b.node);
    };
    const said = (where: string, port: string, of: ResolvedNode, issues: WidgetIssue[]): void => {
      for (const i of issues)
        out.push(
          `node ${n.id}: view ${[where, ...i.path].join('.')}: ${i.message} (from ${port}, bound to ${of.id})`
        );
    };
    if (view.selector !== undefined) {
      const of = boundTo(view.selector.from);
      if (of !== undefined)
        said(
          'selector',
          view.selector.from,
          of,
          selectorIssues(view.selector, of.manifest.interface.state ?? {})
        );
    }
    view.sections.forEach((sec, i) => {
      const of = boundTo(sec.from);
      if (of === undefined) return;
      const issues = widgetIssues(
        sec,
        of.manifest.interface.state ?? {},
        of.manifest.interface.actions ?? {},
        { selector: view.selector !== undefined }
      );
      said(`sections.${i}`, sec.from, of, issues);
    });
  }
  return out;
}

/** A view node's path (D170): its own, else its id. */
export const viewPath = (n: { id: string; path?: string | undefined }): string => n.path ?? n.id;

/**
 * What a node's ports of one chat refuse (bot-os.md D97): the edge of a chat-out output declared
 * `single` names exactly one chat, matching its pattern; the edge of a chat-in input `sameAs` that
 * output reads that chat (any case) and no other. An unbound port is said elsewhere.
 */
function oneChatProblems(n: ResolvedNode): string[] {
  const out: string[] = [];
  for (const [port, bound] of n.outputs) {
    const output = n.manifest.outputs[port];
    const b = bound[0];
    if (output?.type !== 'chat-out' || output.single === undefined || b === undefined) continue;
    const sends = b.chat?.sends ?? [];
    const what = output.single.expected ?? 'the chat it sends to';
    const edge = `(edge ${n.id}.${port} → ${b.node}.${b.port})`;
    const pattern = output.single.pattern;
    if (sends.length !== 1)
      out.push(
        `node ${n.id}: output port ${port} sends to one chat, ${what}: its edge names ${sends.length === 0 ? 'none' : sends.join(', ')} ${edge}`
      );
    else if (pattern !== undefined && !new RegExp(pattern, 'u').test(sends[0] as string))
      out.push(
        `node ${n.id}: output port ${port} sends to ${what}, not ${String(sends[0])} ${edge}`
      );
  }
  for (const [port, input] of Object.entries(n.ports)) {
    if (input.type !== 'chat-in' || input.sameAs === undefined) continue;
    const b = n.inputs.get(port)?.[0];
    const sends = n.outputs.get(input.sameAs)?.[0]?.chat?.sends ?? [];
    const chat = sends[0];
    // No one chat to read: the output's problem says why.
    if (b === undefined || chat === undefined || sends.length !== 1) continue;
    const reads = b.chat?.reads ?? [];
    if (reads !== '*' && reads.length === 1 && reads[0]?.toLowerCase() === chat.toLowerCase())
      continue;
    const read = reads === '*' ? 'every chat' : reads.length === 0 ? 'none' : reads.join(', ');
    out.push(
      `node ${n.id}: input port ${port} reads ${chat}, the chat its output ${input.sameAs} sends to, and no other: its edge reads ${read} (edge ${b.node}.${b.port} → ${n.id}.${port})`
    );
  }
  return out;
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

/** Why a node is not started (bot-os.md D64), as the load finds it. */
export type NodeDown =
  | { state: 'disabled' }
  | { state: 'stopped' }
  | {
      state: 'inactive';
      /** The node a required port of it binds that is down, and that node's state. */
      needs: string;
      because: 'disabled' | 'stopped' | 'inactive';
    };

/** A node down, in words: `disabled`, `stopped`, `inactive: needs tg (disabled)`. */
export const downText = (d: NodeDown): string =>
  d.state === 'inactive' ? `inactive: needs ${d.needs} (${d.because})` : d.state;

/**
 * The nodes that are not started, in load order (bot-os.md D64): those `disabled` in the graph,
 * those `stopped` (kept in their instance), and, derived, those a required port of which binds a
 * node down, transitively: inactive, naming the first such node in the order of its ports. An
 * optional port bound to a node down counts as unbound, and does not make it inactive. A disabled
 * node is disabled, whether or not it is stopped too.
 */
export function nodeStates(
  ordered: readonly ResolvedNode[],
  stopped: (node: ResolvedNode) => boolean
): Map<string, NodeDown> {
  const down = new Map<string, NodeDown>();
  for (const n of ordered) {
    if (n.disabled === true) down.set(n.id, { state: 'disabled' });
    else if (stopped(n)) down.set(n.id, { state: 'stopped' });
    else {
      const needs = requiredOf(n).find((r) => down.has(r));
      if (needs !== undefined)
        down.set(n.id, {
          state: 'inactive',
          needs,
          because: (down.get(needs) as NodeDown).state,
        });
    }
  }
  return down;
}
