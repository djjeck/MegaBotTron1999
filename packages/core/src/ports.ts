/**
 * Ports (docs/bot-os-api.md §2.1, P17, D27): what a plugin consumes (its inputs, drawn on the left)
 * and what it produces (its outputs, on the right), each of a port type the core defines. An edge of
 * the instance's graph (packages/core/src/graph.ts) binds an input to an output of the same
 * type; the edges are the permissions (P6): a plugin reads a chat, sends through an outbox, uses an
 * interface or hears a namespace's events only through a port an edge binds.
 *
 * - `chat-in`: the chats a plugin reads, from a connector's account (bot-os.md D60). A connector's
 *   output; a parser's input, on its left. Bound, it carries the chats read (`reads`).
 * - `chat-out`: what a plugin sends, to a connector's account. A plugin's output, on its right; the
 *   connector's input. Bound, it carries the chats sent to (`sends`) and the commands sent
 *   (`commands`). Data flows left to right: the connector reads on the left of the graph, and is
 *   written to on its right.
 * - The old `chat` input of a manifest (module API 1), and the `requires`/`reach` shorthand, are
 *   read as both: a chat-in input and a chat-out output of the same name (`normalise`).
 * - `events`: the events of a namespace, from the plugins that register it. The manifest names the
 *   namespace, or the key of its node's config that does (`{ config: 'on' }`), so that a plugin
 *   that learns what it listens to from its config (the reactor) has the port resolved per node.
 * - `interface`: a plugin's declared interface (§2): its reads and actions; an input names the
 *   members it uses, none for a plugin it only needs started first. An input that names no plugin
 *   is a contract: any interface that declares its members binds it.
 *
 * Nothing in here knows of any game or any network.
 */
import { z } from 'zod';

/** The port types, by their stable id. */
export const PORT_TYPES = ['chat-in', 'chat-out', 'events', 'interface'] as const;
export type PortType = (typeof PORT_TYPES)[number];

/** What the UI shows of a port type: stable, so that a drawing keeps its look. */
export interface PortTypeInfo {
  id: PortType;
  /** A human description. */
  description: string;
  /** A shape hint for the drawing. */
  shape: 'circle' | 'diamond' | 'square';
  /** A colour hint, as CSS. */
  colour: string;
}

export const PORT_TYPE_INFO: Readonly<Record<PortType, PortTypeInfo>> = {
  'chat-in': {
    id: 'chat-in',
    description:
      'The chats read from a connector’s account: from the connector, on its left, to a plugin that reads them',
    shape: 'circle',
    colour: '#2f7ed8',
  },
  'chat-out': {
    id: 'chat-out',
    description:
      'What a plugin sends through a connector’s account, the chats sent to and the commands sent: from the plugin to the connector, on its right',
    shape: 'circle',
    colour: '#8a4fd1',
  },
  events: {
    id: 'events',
    description: 'The typed events of a namespace (a game, or a plugin’s own), as published',
    shape: 'diamond',
    colour: '#d97b29',
  },
  interface: {
    id: 'interface',
    description: 'A plugin’s declared interface: its reads and actions, and its start before',
    shape: 'square',
    colour: '#3a9a5b',
  },
};

/** A port's name in a manifest: lower-case words and dashes, as an id. */
export const PORT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/** A network, the part of an account before the colon (`irc`, `telegram-bot`). */
export const NETWORK = /^[a-z][a-z0-9-]*$/u;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const chats = z.array(z.string().min(1));

/** A chat-in edge's `reads` meaning every chat its connector monitors (bot-os.md D62). */
export const ANY_CHAT = '*';
/** In a chat-in edge's `senders`, the account's own messages (bot-os.md D62). */
export const ME = 'me';

/**
 * What a bound chat carries: the chats read (a chat-in edge's: a list, or `'*'`, any chat its
 * connector monitors) and the senders read from (`senders`: usernames, with `me` for the account's
 * own messages; none: anyone), the chats sent to and the commands (first words) sent (a chat-out
 * edge's). Each edge carries only its own: the others are empty.
 */
/** A chat-in's reads: the chats, or `'*'`. */
export const readsSchema = z.union([z.literal(ANY_CHAT), chats]);

export const chatBindingSchema = z.strictObject({
  reads: readsSchema.default([]),
  /** The senders it hears, by username (`@QuestBot`), `me` for the account's own; none: anyone. */
  senders: chats.optional(),
  sends: chats.default([]),
  /** The commands it may send, by their first word (`!roll`); none: any text. */
  commands: chats.optional(),
  /**
   * A queued send's least seconds between two sends of a command in one chat (bot-os.md D73), by
   * the command's first word; a command not named: the connector's default.
   */
  minIntervalS: z.record(z.string().min(1), z.number().nonnegative()).optional(),
});
export type ChatBinding = z.output<typeof chatBindingSchema>;

const common = {
  /** What it is for, for the UI and the agents. */
  help: z.string().min(1).optional(),
  /**
   * An optional input may be left unbound, imposes no order and fails nothing: the plugin asks for
   * it when it needs it (`ctx.useOptional`), and does without while its other end is not running.
   */
  optional: z.boolean().default(false),
};

/** A key of a node's config, as a port names it. */
const configKey = z.strictObject({
  config: z.string().regex(/^[A-Za-z_$][\w$]*$/u, 'expected a config key'),
});

/**
 * An input port, as a manifest declares it. `bind` is the edge the programmatic wiring gives it
 * by default (the core's default graph); an explicit graph binds it as it says.
 */
export const inputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chat-in'),
    /** The network it reads; none: any. */
    network: z.string().regex(NETWORK).optional(),
    /**
     * The key of its node's config that, set, gives the node this port; unset, the node has none
     * (`resolveInputs`): a reactor reads a chat only with a `match`.
     */
    when: configKey.optional(),
    ...common,
    bind: z
      .strictObject({
        node: z.string().regex(ID),
        reads: chatBindingSchema.shape.reads,
        senders: chatBindingSchema.shape.senders,
      })
      .optional(),
  }),
  /**
   * The old chat input (module API 1): read as a chat-in input and a chat-out output of the same
   * name, its `bind` split between them.
   */
  z.strictObject({
    type: z.literal('chat'),
    /** The network it connects to; none: any. */
    network: z.string().regex(NETWORK).optional(),
    ...common,
    bind: z.strictObject({ node: z.string().regex(ID), ...chatBindingSchema.shape }).optional(),
  }),
  z.strictObject({
    type: z.literal('events'),
    /**
     * Its namespace; or `{ config: key }`, the key of its node's config whose value names it (a
     * namespace, or an event type of it), resolved per node (`resolveInputs`).
     */
    namespace: z.union([z.string().regex(ID), configKey]),
    ...common,
    /** By default, every other node whose plugin registers the namespace. */
    bind: z.strictObject({ nodes: z.array(z.string().regex(ID)) }).optional(),
  }),
  z
    .strictObject({
      type: z.literal('interface'),
      /**
       * The plugin whose interface it uses; none: any plugin whose interface declares the members
       * (a contract), so that each instance of one plugin may use another's.
       */
      plugin: z.string().regex(ID).optional(),
      /** The members it uses (`state.game`, `actions.review`); none: it only needs it first. */
      members: z.array(z.string().min(1)).default([]),
      ...common,
      /** By default, the node whose id is the plugin's; a contract has no default. */
      bind: z.strictObject({ node: z.string().regex(ID) }).optional(),
    })
    .refine((p) => p.plugin !== undefined || p.members.length > 0, {
      message: 'an interface input names its plugin, or the members it uses',
      path: ['members'],
    }),
]);

/**
 * An output port a manifest declares: a chat-out, what it sends through a connector's account
 * (the others, a connector's chat-in, events and interface, are derived from the manifest).
 * Required unless `optional`: the plugin needs the connector started first.
 */
export const outputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chat-out'),
    /** The network it sends on; none: any. */
    network: z.string().regex(NETWORK).optional(),
    /**
     * The commands it sends, by their first word, declared (bot-os.md D74): an edge from it may
     * allow only these (the check refuses one that allows another, or any text), and a new edge
     * drawn from it starts with them. None: whatever its edge allows.
     */
    commands: chats.min(1).optional(),
    /**
     * The least seconds between two queued sends of a command in one chat, by its first word, as
     * the plugin needs them (D73, D74): its edge's own `minIntervalS` wins for a command it names.
     */
    minIntervalS: chatBindingSchema.shape.minIntervalS,
    ...common,
    bind: z
      .strictObject({
        node: z.string().regex(ID),
        sends: chatBindingSchema.shape.sends,
        commands: chatBindingSchema.shape.commands,
        minIntervalS: chatBindingSchema.shape.minIntervalS,
      })
      .optional(),
  }),
]);
export type DeclaredOutput = z.output<typeof outputSchema>;
export type OutputPortInput = z.input<typeof outputSchema>;

/** An input port as a manifest writes it, the old `chat` included. */
export type DeclaredInput = z.output<typeof inputSchema>;
export type InputPortInput = z.input<typeof inputSchema>;
/** A connector's chat-out input, derived from its account: what the plugins send through it. */
export interface ChatOutInput {
  type: 'chat-out';
  network?: string;
  optional: boolean;
  help?: string;
}
/**
 * An input port of a manifest as the core holds it: the old `chat` read as a chat-in (and a
 * chat-out output), a connector's chat-out added.
 */
export type ManifestInputPort = Exclude<DeclaredInput, { type: 'chat' }> | ChatOutInput;
/** An events input's namespace as declared: a namespace, or the config key that names one. */
export type NamespaceSource = Extract<DeclaredInput, { type: 'events' }>['namespace'];
/** An input port of a node: its namespace resolved (`resolveInputs`), as the graph compares it. */
export type InputPort =
  | Exclude<ManifestInputPort, { type: 'events' }>
  | (Omit<Extract<DeclaredInput, { type: 'events' }>, 'namespace'> & { namespace: string });

/** An output port: a connector's chat-in, a declared chat-out, and the derived events and interface. */
export type OutputPort =
  | { type: 'chat-in'; network: string }
  | DeclaredOutput
  | { type: 'events'; namespace: string }
  | { type: 'interface'; plugin: string; members: string[] };

/**
 * A port in words: `chat-in of irc`, `chat-out of any network`, `events of dice`, `interface of
 * dice`; an events input whose namespace its node's config names, unresolved, `events of config on`.
 */
export function describePort(p: ManifestInputPort | InputPort | OutputPort): string {
  if (p.type === 'chat-in' || p.type === 'chat-out')
    return `${p.type} of ${p.network ?? 'any network'}`;
  if (p.type === 'events')
    return `events of ${typeof p.namespace === 'string' ? p.namespace : `config ${p.namespace.config}`}`;
  return p.plugin === undefined
    ? `interface with ${p.members.join(', ')}`
    : `interface of ${p.plugin}`;
}

/** Why an output cannot feed an input, or undefined if it can. */
export function mismatch(input: InputPort, output: OutputPort): string | undefined {
  const no = `${describePort(output)} cannot bind ${describePort(input)}`;
  if (input.type === 'chat-in')
    return output.type === 'chat-in' && (input.network ?? output.network) === output.network
      ? undefined
      : no;
  if (input.type === 'chat-out')
    return output.type === 'chat-out' &&
      (output.network === undefined ||
        input.network === undefined ||
        output.network === input.network)
      ? undefined
      : no;
  if (input.type === 'events')
    return output.type === 'events' && input.namespace === output.namespace ? undefined : no;
  if (output.type !== 'interface' || (input.plugin ?? output.plugin) !== output.plugin) return no;
  const missing = input.members.filter((m) => !output.members.includes(m));
  return missing.length === 0
    ? undefined
    : `${output.plugin} does not declare ${missing.join(', ')}`;
}

/**
 * The namespace a config value names: a namespace (`dice`), or an event type's (`dice.roll`);
 * undefined if it names neither.
 */
export function namespaceOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ns = value.includes('.') ? value.slice(0, value.indexOf('.')) : value;
  return ID.test(ns) ? ns : undefined;
}

/**
 * A node's input ports, each resolved from its node's `config` when the manifest says so: an
 * events input's namespace (`{ config: key }`), the namespace the key's value names, or the event
 * type's; a chat-in input's presence (`when: { config: key }`), there only while the key is set.
 * An events input whose key is not set is left out if it is optional (the node has no such port),
 * and is a problem if it is required; one whose value names no namespace is a problem. Each problem
 * names the port; the caller names the node.
 */
export function resolveInputs(
  inputs: Readonly<Record<string, ManifestInputPort>>,
  config: Readonly<Record<string, unknown>> | undefined
): { ports: Record<string, InputPort>; problems: string[] } {
  const ports: Record<string, InputPort> = {};
  const problems: string[] = [];
  const set = (key: string): boolean => config?.[key] !== undefined && config[key] !== null;
  for (const [name, p] of Object.entries(inputs)) {
    if (p.type === 'chat-in' && p.when !== undefined) {
      if (set(p.when.config)) ports[name] = p;
      continue;
    }
    if (p.type !== 'events' || typeof p.namespace === 'string') {
      ports[name] = p as InputPort;
      continue;
    }
    const key = p.namespace.config;
    const value = config?.[key];
    const ns = namespaceOf(value);
    if (ns !== undefined) ports[name] = { ...p, namespace: ns };
    else if (set(key))
      problems.push(
        `input port ${name}: its namespace comes from config ${key}, and ${JSON.stringify(value)} names no event type or namespace`
      );
    else if (!p.optional)
      problems.push(`input port ${name}: its namespace comes from config ${key}, which is not set`);
  }
  return { ports, problems };
}
