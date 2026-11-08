/**
 * Ports (docs/bot-os-api.md §2.1, P17, D27): what a plugin consumes (its inputs, drawn on the left)
 * and what it produces (its outputs, on the right), each of a port type the core defines. An edge of
 * the instance's graph (packages/core/src/graph.ts) binds an input to an output of the same
 * type; the edges are the permissions (P6): a plugin reaches a connector, an outbox, an interface
 * or a namespace's events only through an input an edge binds.
 *
 * - `chat`: a chat connection of a network, a connector's account. Bound, it carries the chats the
 *   plugin reads and sends to, and the commands it may send (what a manifest's `reach` lists).
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
export const PORT_TYPES = ['chat', 'events', 'interface'] as const;
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
  chat: {
    id: 'chat',
    description:
      'A chat connection of a network: an account a connector holds, bound with the chats read and sent to, and the commands sent',
    shape: 'circle',
    colour: '#2f7ed8',
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

/** What a bound chat carries: the chats read and sent to, and the commands (first words) sent. */
export const chatBindingSchema = z.strictObject({
  reads: chats.default([]),
  sends: chats.default([]),
  /** The commands it may send, by their first word (`!roll`); none: any text. */
  commands: chats.optional(),
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

/**
 * An input port, as a manifest declares it. `bind` is the edge the programmatic wiring gives it
 * by default (the core's default graph); an explicit graph binds it as it says.
 */
export const inputSchema = z.discriminatedUnion('type', [
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
    namespace: z.union([
      z.string().regex(ID),
      z.strictObject({ config: z.string().regex(/^[A-Za-z_$][\w$]*$/u, 'expected a config key') }),
    ]),
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
/** An input port as a manifest declares it: an events input's namespace may come from config. */
export type DeclaredInput = z.output<typeof inputSchema>;
export type InputPortInput = z.input<typeof inputSchema>;
/** An events input's namespace as declared: a namespace, or the config key that names one. */
export type NamespaceSource = Extract<DeclaredInput, { type: 'events' }>['namespace'];
/** An input port of a node: its namespace resolved (`resolveInputs`), as the graph compares it. */
export type InputPort =
  | Exclude<DeclaredInput, { type: 'events' }>
  | (Omit<Extract<DeclaredInput, { type: 'events' }>, 'namespace'> & { namespace: string });

/** An output port: derived from the manifest, never written by hand. */
export type OutputPort =
  | { type: 'chat'; network: string }
  | { type: 'events'; namespace: string }
  | { type: 'interface'; plugin: string; members: string[] };

/**
 * A port in words: `chat of irc`, `events of dice`, `interface of dice`; an events input whose
 * namespace its node's config names, unresolved, `events of config on`.
 */
export function describePort(p: DeclaredInput | InputPort | OutputPort): string {
  if (p.type === 'chat') return `chat of ${p.network ?? 'any network'}`;
  if (p.type === 'events')
    return `events of ${typeof p.namespace === 'string' ? p.namespace : `config ${p.namespace.config}`}`;
  return p.plugin === undefined
    ? `interface with ${p.members.join(', ')}`
    : `interface of ${p.plugin}`;
}

/** Why an output cannot feed an input, or undefined if it can. */
export function mismatch(input: InputPort, output: OutputPort): string | undefined {
  const no = `${describePort(output)} cannot bind ${describePort(input)}`;
  if (input.type === 'chat')
    return output.type === 'chat' && (input.network ?? output.network) === output.network
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
 * A node's input ports, each events input's namespace resolved from its node's `config` when the
 * manifest says it comes from there (`{ config: key }`): the namespace the key's value names, or
 * the event type's. One whose key is not set is left out if it is optional (the node has no such
 * port), and is a problem if it is required; one whose value names no namespace is a problem.
 * Each problem names the port; the caller names the node.
 */
export function resolveInputs(
  inputs: Readonly<Record<string, DeclaredInput>>,
  config: Readonly<Record<string, unknown>> | undefined
): { ports: Record<string, InputPort>; problems: string[] } {
  const ports: Record<string, InputPort> = {};
  const problems: string[] = [];
  for (const [name, p] of Object.entries(inputs)) {
    if (p.type !== 'events' || typeof p.namespace === 'string') {
      ports[name] = p as InputPort;
      continue;
    }
    const key = p.namespace.config;
    const value = config?.[key];
    const ns = namespaceOf(value);
    if (ns !== undefined) ports[name] = { ...p, namespace: ns };
    else if (value !== undefined && value !== null)
      problems.push(
        `input port ${name}: its namespace comes from config ${key}, and ${JSON.stringify(value)} names no event type or namespace`
      );
    else if (!p.optional)
      problems.push(`input port ${name}: its namespace comes from config ${key}, which is not set`);
  }
  return { ports, problems };
}
