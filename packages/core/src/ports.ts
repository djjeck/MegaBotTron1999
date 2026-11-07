/**
 * Ports (docs/bot-os-api.md §2.1, P17, D27): what a plugin consumes (its inputs, drawn on the left)
 * and what it produces (its outputs, on the right), each of a port type the core defines. An edge of
 * the instance's graph (packages/core/src/graph.ts) binds an input to an output of the same
 * type; the edges are the permissions (P6): a plugin reaches a connector, an outbox, an interface
 * or a namespace's events only through an input an edge binds.
 *
 * - `chat`: a chat connection of a network, a connector's account. Bound, it carries the chats the
 *   plugin reads and sends to, and the commands it may send (what a manifest's `reach` lists).
 * - `events`: the events of a namespace, from the plugins that register it.
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
    namespace: z.string().regex(ID),
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
export type InputPort = z.output<typeof inputSchema>;
export type InputPortInput = z.input<typeof inputSchema>;

/** An output port: derived from the manifest, never written by hand. */
export type OutputPort =
  | { type: 'chat'; network: string }
  | { type: 'events'; namespace: string }
  | { type: 'interface'; plugin: string; members: string[] };

/** A port in words: `chat of irc`, `events of dice`, `interface of dice`. */
export function describePort(p: InputPort | OutputPort): string {
  if (p.type === 'chat') return `chat of ${p.network ?? 'any network'}`;
  if (p.type === 'events') return `events of ${p.namespace}`;
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
