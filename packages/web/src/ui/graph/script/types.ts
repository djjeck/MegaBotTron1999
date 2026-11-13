/**
 * A script node's API, typed (docs/bot-os.md D78): the `.d.ts` its editor completes from, made per
 * node from its declared ports, and the same, listed, for its API panel. Its interface inputs'
 * members take their input and output types from their zod schemas (as JSON Schema, `GET
 * /available`), turned into TypeScript; its events inputs' event types, their payloads'; each
 * with its help, which the editor shows on hover. Pure functions of the draft and the plugins'
 * views.
 */
import type { GraphEdge, GraphNode, JsonSchema, MemberView, PluginView } from '#src/ui/api.ts';
import { endOf } from '#src/ui/graph/draft.ts';

/** A script node's config, as the draft holds it (anything not of its form left out). */
export interface ScriptPorts {
  inputs: Record<
    string,
    | { type: 'events'; namespace: string; optional?: boolean; help?: string }
    | { type: 'interface'; plugin?: string; members: string[]; optional?: boolean; help?: string }
  >;
  outputs: Record<
    string,
    {
      type: 'chat-out';
      network?: string;
      commands: string[];
      minIntervalS?: Record<string, number>;
      help?: string;
    }
  >;
  events: Record<string, { help: string; fields: Record<string, string> }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The ports a script node's config declares, as written. */
export function portsOf(config: Readonly<Record<string, unknown>> | undefined): ScriptPorts {
  const out: ScriptPorts = { inputs: {}, outputs: {}, events: {} };
  for (const [name, p] of Object.entries(isRecord(config?.['inputs']) ? config['inputs'] : {})) {
    if (!isRecord(p)) continue;
    const optional = p['optional'] === true ? { optional: true } : {};
    const help = text(p['help']) === undefined ? {} : { help: p['help'] as string };
    if (p['type'] === 'events')
      out.inputs[name] = {
        type: 'events',
        namespace: text(p['namespace']) ?? '',
        ...optional,
        ...help,
      };
    else if (p['type'] === 'interface')
      out.inputs[name] = {
        type: 'interface',
        ...(text(p['plugin']) === undefined ? {} : { plugin: p['plugin'] as string }),
        members: strings(p['members']),
        ...optional,
        ...help,
      };
  }
  for (const [name, p] of Object.entries(isRecord(config?.['outputs']) ? config['outputs'] : {})) {
    if (!isRecord(p)) continue;
    const spacing = isRecord(p['minIntervalS'])
      ? Object.fromEntries(
          Object.entries(p['minIntervalS']).filter(
            (e): e is [string, number] => typeof e[1] === 'number'
          )
        )
      : undefined;
    out.outputs[name] = {
      type: 'chat-out',
      ...(text(p['network']) === undefined ? {} : { network: p['network'] as string }),
      commands: strings(p['commands']),
      ...(spacing === undefined ? {} : { minIntervalS: spacing }),
      ...(text(p['help']) === undefined ? {} : { help: p['help'] as string }),
    };
  }
  for (const [name, e] of Object.entries(isRecord(config?.['events']) ? config['events'] : {})) {
    if (!isRecord(e)) continue;
    out.events[name] = {
      help: text(e['help']) ?? '',
      fields: Object.fromEntries(
        Object.entries(isRecord(e['fields']) ? e['fields'] : {}).filter(
          (f): f is [string, string] => typeof f[1] === 'string'
        )
      ),
    };
  }
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/u;
const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));
const DEPTH = 6;

/** A JSON Schema, as zod writes it, as a TypeScript type; what it leaves open is `unknown`. */
export function tsType(schema: JsonSchema | undefined, depth = 0, indent = ''): string {
  if (schema === undefined || depth > DEPTH) return 'unknown';
  if ('const' in schema) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum']))
    return (schema['enum'] as unknown[]).map((v) => JSON.stringify(v)).join(' | ') || 'never';
  const choices = (schema['anyOf'] ?? schema['oneOf']) as unknown[] | undefined;
  if (Array.isArray(choices))
    return choices.map((c) => tsType(c as JsonSchema, depth + 1, indent)).join(' | ') || 'never';
  if (Array.isArray(schema['allOf']))
    return (schema['allOf'] as JsonSchema[]).map((c) => tsType(c, depth + 1, indent)).join(' & ');
  const type = schema['type'];
  if (Array.isArray(type))
    return type.map((t) => tsType({ ...schema, type: t }, depth, indent)).join(' | ');
  switch (type) {
    case 'string':
    case 'boolean':
    case 'null':
      return type;
    case 'number':
    case 'integer':
      return 'number';
    case 'array': {
      if (Array.isArray(schema['prefixItems']))
        return `[${(schema['prefixItems'] as JsonSchema[]).map((s) => tsType(s, depth + 1, indent)).join(', ')}]`;
      const item = tsType(schema['items'] as JsonSchema | undefined, depth + 1, indent);
      return /[ |&]/u.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case 'object': {
      const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
      const required = new Set((schema['required'] ?? []) as string[]);
      const extra = schema['additionalProperties'];
      const inner = `${indent}  `;
      const lines = Object.entries(props).map(([k, p]) => {
        const doc =
          typeof p['description'] === 'string' ? `${inner}/** ${p['description']} */\n` : '';
        return `${doc}${inner}${key(k)}${required.has(k) ? '' : '?'}: ${tsType(p, depth + 1, inner)};`;
      });
      if (isRecord(extra))
        lines.push(`${inner}[key: string]: ${tsType(extra as JsonSchema, depth + 1, inner)};`);
      else if (extra !== false && lines.length === 0) return 'Record<string, unknown>';
      return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

/** The views the API is typed from: each node's, and the plugins the instance offers. */
export interface ApiSources {
  /** The script node. */
  node: GraphNode;
  /** The draft's nodes and edges. */
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** A node's view: its plugin's, or its own for a node whose ports its config declares. */
  viewOf: (node: GraphNode) => PluginView | undefined;
  /** The plugins the instance offers (`GET /available`). */
  available: readonly PluginView[];
}

/** An event type a script hears, with its help and its payload's schema. */
export interface ApiEvent {
  type: string;
  help?: string;
  schema?: JsonSchema;
  /** The input port it comes through, or its own. */
  port: string;
}

/** A member a script uses, from its input's other end. */
export interface ApiMember {
  name: string;
  help?: string;
  input?: JsonSchema;
  output?: JsonSchema;
  /** Its other end does not offer it (or none is known). */
  unknown?: boolean;
}

/** A script node's API, as its panel lists it and its `.d.ts` types it. */
export interface ScriptApi {
  /** Its events inputs, with the types heard through each, and its own types. */
  events: { port: string; namespace: string; from: string[]; types: ApiEvent[]; help?: string }[];
  interfaces: { port: string; from?: string; members: ApiMember[]; help?: string }[];
  outputs: {
    port: string;
    commands: string[];
    spacing: Record<string, number>;
    to?: string;
    help?: string;
  }[];
  own: { type: string; help: string; fields: Record<string, string> }[];
}

/** The nodes bound to a node's input port, by the draft's edges. */
const boundTo = (s: ApiSources, port: string): GraphNode[] =>
  s.edges
    .filter((e) => e.to === `${s.node.id}.${port}`)
    .map((e) => s.nodes.find((n) => n.id === endOf(e.from).node))
    .filter((n): n is GraphNode => n !== undefined);

/** The event types of a namespace a view registers, with their schemas. */
const typesIn = (
  v: PluginView | undefined,
  ns: string
): { type: string; help?: string; schema?: JsonSchema }[] =>
  Object.values(v?.outputs ?? {}).flatMap((o) =>
    o.type === 'events' && o.namespace === ns ? (o.types ?? []) : []
  );

/** A script node's API, from its ports and what its edges bind (or the plugins it names). */
export function scriptApi(s: ApiSources): ScriptApi {
  const ports = portsOf(s.node.config);
  const api: ScriptApi = { events: [], interfaces: [], outputs: [], own: [] };
  for (const [port, p] of Object.entries(ports.inputs)) {
    const bound = boundTo(s, port);
    if (p.type === 'events') {
      const views = bound.length > 0 ? bound.map((n) => s.viewOf(n)) : [...s.available];
      const seen = new Map<string, ApiEvent>();
      for (const v of views)
        for (const t of typesIn(v, p.namespace))
          if (!seen.has(t.type)) seen.set(t.type, { ...t, port });
      api.events.push({
        port,
        namespace: p.namespace,
        from: bound.map((n) => n.id),
        types: [...seen.values()].sort((a, b) => a.type.localeCompare(b.type)),
        ...(p.help === undefined ? {} : { help: p.help }),
      });
      continue;
    }
    const other = bound[0];
    const view =
      other !== undefined ? s.viewOf(other) : s.available.find((v) => v.plugin === p.plugin);
    const offered = new Map<string, MemberView>([
      ...(view?.interface.reads ?? []).map((m): [string, MemberView] => [`state.${m.name}`, m]),
      ...(view?.interface.actions ?? []).map((m): [string, MemberView] => [`actions.${m.name}`, m]),
    ]);
    api.interfaces.push({
      port,
      ...(other === undefined
        ? p.plugin === undefined
          ? {}
          : { from: p.plugin }
        : { from: other.id }),
      members: p.members.map((name) => {
        const m = offered.get(name);
        if (m === undefined) return { name, unknown: true };
        return {
          name,
          ...(m.help === '' ? {} : { help: m.help }),
          ...(m.input === undefined ? {} : { input: m.input }),
          ...(m.output === undefined ? {} : { output: m.output }),
        };
      }),
      ...(p.help === undefined ? {} : { help: p.help }),
    });
  }
  for (const [port, p] of Object.entries(ports.outputs)) {
    const edge = s.edges.find((e) => e.from === `${s.node.id}.${port}`);
    api.outputs.push({
      port,
      commands: p.commands,
      spacing: p.minIntervalS ?? {},
      ...(edge === undefined ? {} : { to: endOf(edge.to).node }),
      ...(p.help === undefined ? {} : { help: p.help }),
    });
  }
  for (const [name, e] of Object.entries(ports.events))
    api.own.push({ type: `${s.node.id}.${name}`, help: e.help, fields: e.fields });
  return api;
}

const doc = (lines: (string | undefined)[], indent = ''): string => {
  const kept = lines.filter((l): l is string => l !== undefined && l !== '');
  if (kept.length === 0) return '';
  if (kept.length === 1) return `${indent}/** ${kept[0]} */\n`;
  return `${indent}/**\n${kept.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
};

/** An event as a handler hears it: the bus's head, and its payload. */
const eventType = (e: { type: string; schema?: JsonSchema }, indent: string): string => {
  const payload = tsType(e.schema, 0, indent);
  const head = `{ type: ${JSON.stringify(e.type)}; t: number; instance: string }`;
  return payload === '{}' || (payload === 'Record<string, unknown>' && e.schema === undefined)
    ? head
    : `${head} & ${payload}`;
};

const FIELD_TS: Record<string, string> = { string: 'string', number: 'number', boolean: 'boolean' };

/** What a member returns: its output's type, or `unknown`, as a promise. */
const memberType = (m: ApiMember, indent: string): string => {
  const input = m.input === undefined ? '' : `input: ${tsType(m.input, 0, indent)}`;
  return `(${input}) => Promise<${m.output === undefined ? 'unknown' : tsType(m.output, 0, indent)}>`;
};

/**
 * A script node's `.d.ts`: the API's globals typed by its ports (an event type or a namespace it
 * hears, the members of each interface input, its outputs, its own events), each with its help.
 */
export function scriptDts(api: ScriptApi, id: string): string {
  const all = api.events.flatMap((p) => p.types);
  const own = api.own.map((e) => ({
    type: e.type,
    help: e.help,
    fields: e.fields,
  }));
  const heard = [
    ...all,
    ...own
      .filter((o) => !all.some((t) => t.type === o.type))
      .map((o) => ({ type: o.type, help: o.help, port: '(its own)', fields: o.fields })),
  ];
  const ownPayload = (fields: Record<string, string>, indent: string): string =>
    Object.keys(fields).length === 0
      ? '{}'
      : `{\n${Object.entries(fields)
          .map(([k, t]) => `${indent}  ${key(k)}: ${FIELD_TS[t] ?? 'unknown'};`)
          .join('\n')}\n${indent}}`;
  const events = heard
    .map((t) => {
      const fields = 'fields' in t ? (t.fields as Record<string, string>) : undefined;
      const type =
        fields === undefined
          ? eventType(t, '  ')
          : `{ type: ${JSON.stringify(t.type)}; t: number; instance: string } & ${ownPayload(fields, '  ')}`;
      return `${doc([t.help, `Heard through ${t.port}.`], '  ')}  ${JSON.stringify(t.type)}: ${type};`;
    })
    .join('\n');
  const namespaces = [
    ...new Set([...api.events.map((p) => p.namespace), ...(api.own.length > 0 ? [id] : [])]),
  ];
  const nsLines = namespaces
    .map((ns) => {
      const types = heard
        .filter((t) => t.type.startsWith(`${ns}.`))
        .map((t) => `ScriptEvents[${JSON.stringify(t.type)}]`);
      return `  ${JSON.stringify(ns)}: ${types.length === 0 ? '{ type: string; t: number; instance: string; [field: string]: unknown }' : types.join(' | ')};`;
    })
    .join('\n');
  const interfaces = api.interfaces
    .map((i) => {
      const part = (p: 'state' | 'actions'): string => {
        const ms = i.members.filter((m) => m.name.startsWith(`${p}.`));
        return ms
          .map((m) => {
            const name = m.name.slice(p.length + 1);
            return `${doc([m.help, m.unknown === true ? `Not offered by ${i.from ?? 'any node bound'}: its types are unknown.` : undefined], '      ')}      ${key(name)}${memberType(m, '      ').replace(' => ', ': ')};`;
          })
          .join('\n');
      };
      return `${doc([i.help, i.from === undefined ? 'Its input is not bound.' : `Bound to ${i.from}.`], '  ')}  ${JSON.stringify(i.port)}: {\n    state: {\n${part('state')}\n    };\n    actions: {\n${part('actions')}\n    };\n  };`;
    })
    .join('\n');
  const outputs = api.outputs.map((o) => JSON.stringify(o.port)).join(' | ') || 'never';
  const ownTypes = api.own
    .map((e) => `${doc([e.help], '  ')}  ${JSON.stringify(e.type)}: ${ownPayload(e.fields, '  ')};`)
    .join('\n');
  const heardKeys = 'keyof ScriptEvents | keyof ScriptNamespaces';
  return `// The script API of node ${id}, typed from its ports (generated).
/** The event types it hears, by type: the bus's head (type, t, instance) and their payloads. */
interface ScriptEvents {
${events}
}
/** The events of each namespace it hears. */
interface ScriptNamespaces {
${nsLines}
}
/** Its interface inputs, by port: the members each uses. */
interface ScriptInterfaces {
${interfaces}
}
/** Its own event types, and their payloads. */
interface ScriptOwnEvents {
${ownTypes}
}
/** Its chat-out outputs. */
type ScriptOutput = ${outputs};
/** When a queued send is dropped before it goes. */
interface ScriptCancel {
  /** Event types or namespaces it hears: one of them, holding \`when\`, drops it. */
  on?: (${heardKeys}) | readonly (${heardKeys})[];
  /** Fields of the event, by dotted path, each equal (a list at a path: holding the value). */
  when?: Readonly<Record<string, unknown>>;
  /** A time (ms) after which it expires. */
  deadline?: number;
  /** Or: how long from now. */
  withinMs?: number;
}
/** What came of a queued send. */
interface QueuedResult {
  text: string;
  outcome: 'sent' | 'dry-run' | 'refused' | 'cancelled' | 'expired';
  reason?: string;
  event?: { type: string; t: number; [field: string]: unknown };
}
/** A queued send: awaited, its outcome. */
interface QueuedSend extends PromiseLike<QueuedResult> {
  readonly id: number;
  readonly result: Promise<QueuedResult>;
  /** 'waiting', or its outcome. */
  status(): 'waiting' | QueuedResult['outcome'];
  /** Drops it if it still waits: whether it did. */
  cancel(): Promise<boolean>;
}
/** Registers a handler of an event type it hears (while the script loads). */
declare function on<T extends keyof ScriptEvents>(type: T, fn: (event: ScriptEvents[T]) => unknown): void;
/** Registers a handler of every event of a namespace it hears (while the script loads). */
declare function on<N extends keyof ScriptNamespaces>(namespace: N, fn: (event: ScriptNamespaces[N]) => unknown): void;
/** The members an interface input uses, each a promise. */
declare function use<P extends keyof ScriptInterfaces>(port: P): ScriptInterfaces[P];
/** A chat-out output's queue. */
declare function outbox(port: ScriptOutput): {
  /** Queues a send, spaced and coalesced; dropped if its cancel holds before it goes. */
  enqueue(chat: string, text: string, options?: { cancel?: ScriptCancel }): QueuedSend;
};
/** Queues a send through a chat-out output: outbox(port).enqueue(chat, text, options). */
declare function enqueue(port: ScriptOutput, chat: string, text: string, options?: { cancel?: ScriptCancel }): QueuedSend;
/** Publishes an event of its own. */
declare function publish<T extends keyof ScriptOwnEvents>(type: T, payload: ScriptOwnEvents[T]): void;
/** Its own documents, kept across restarts. */
declare const store: {
  read<T = unknown>(name: string): T | undefined;
  write(name: string, value: unknown): void;
  remove(name: string): void;
  names(): string[];
};
/** The node's clock (Date reads it too). */
declare const clock: { now(): number };
/** Its log lines, prefixed with its node's id. */
declare const log: {
  (...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};
declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };
`;
}
