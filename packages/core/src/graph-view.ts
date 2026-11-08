/**
 * The graph printed (docs/bot-os-api.md §4.12): the instance's wiring as text and as a Mermaid
 * flowchart, the first, read-only form of the graph's view; what the web UI's graph view draws of
 * each node (`describeNodes`): its ports and the JSON Schemas of its config, settings and
 * interface, made from the zod schemas its manifest declares (P11); and the graph file the instance
 * writes at each start, for the view, the tools and the editor.
 *
 * Nothing in here knows of any game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type Graph, type GraphEdge, nodeInputs } from './graph.ts';
import { type Manifest } from './manifest.ts';
import {
  type DeclaredInput,
  describePort,
  type InputPort,
  type OutputPort,
  PORT_TYPE_INFO,
} from './ports.ts';

/** The graph file, in the data volume. */
export const GRAPH_FILE = 'graph.json';
/** The graph before the last change, kept beside it. */
export const PREVIOUS_GRAPH_FILE = 'graph.previous.json';

const carried = (e: GraphEdge): string =>
  [
    e.reads !== undefined && e.reads.length > 0 ? `reads ${e.reads.join(' ')}` : '',
    e.sends !== undefined && e.sends.length > 0 ? `sends ${e.sends.join(' ')}` : '',
    e.commands === undefined ? '' : `commands ${e.commands.join(' ')}`,
  ]
    .filter((x) => x !== '')
    .join('; ');

/** The graph as text: its nodes (with their plugin and configuration's keys), then its edges. */
export function graphText(graph: Graph): string {
  const lines = ['nodes:'];
  for (const n of graph.nodes) {
    const keys = Object.keys(n.config ?? {});
    lines.push(
      `  ${n.id}${n.plugin === n.id ? '' : ` (${n.plugin})`}` +
        (n.account === undefined ? '' : ` ${n.account}`) +
        (keys.length === 0 ? '' : `: ${keys.join(', ')}`)
    );
  }
  lines.push('edges:');
  for (const e of graph.edges) {
    const what = carried(e);
    lines.push(`  ${e.from} → ${e.to} (${e.type ?? '?'})${what === '' ? '' : `: ${what}`}`);
  }
  return lines.join('\n');
}

/** A Mermaid id: the node's, with dashes made underscores. */
const mermaidId = (id: string): string => id.replaceAll('-', '_');
/** A label, its quotes escaped as Mermaid's entity. */
const label = (text: string): string => `"${text.replaceAll('"', '#quot;')}"`;

/**
 * The graph as a Mermaid flowchart, left to right: a box per node (its id, and its plugin when
 * another's), an arrow per edge from its output to its input, named by the two ports and coloured
 * by its port type (`PORT_TYPE_INFO`).
 */
export function graphMermaid(graph: Graph): string {
  const lines = ['flowchart LR'];
  for (const n of graph.nodes)
    lines.push(
      `  ${mermaidId(n.id)}[${label(n.plugin === n.id ? n.id : `${n.id}<br/><i>${n.plugin}</i>`)}]`
    );
  graph.edges.forEach((e) => {
    const [from = '', out = ''] = e.from.split('.');
    const [to = '', input = ''] = e.to.split('.');
    const what = carried(e);
    const text = `${out} → ${input}${what === '' ? '' : `<br/>${what}`}`;
    lines.push(`  ${mermaidId(from)} -- ${label(text)} --> ${mermaidId(to)}`);
  });
  graph.edges.forEach((e, i) => {
    if (e.type !== undefined)
      lines.push(`  linkStyle ${i} stroke:${PORT_TYPE_INFO[e.type].colour}`);
  });
  return lines.join('\n');
}

/**
 * Writes the graph to `<dir>/graph.json` (atomically: a temporary file, then a rename), keeping
 * the one before as `graph.previous.json` when it changed. True if it changed.
 */
export function writeGraphFile(dir: string, graph: Graph): boolean {
  const file = path.join(dir, GRAPH_FILE);
  const text = `${JSON.stringify(graph, null, 2)}\n`;
  let before: string | undefined;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    before = undefined;
  }
  if (before === text) return false;
  if (before !== undefined) fs.writeFileSync(path.join(dir, PREVIOUS_GRAPH_FILE), before);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

/** A graph file's contents, unchecked: the core checks it against the image at load. */
export function readGraphFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

/** A JSON Schema, as zod writes it: what the UI makes its forms from. */
export type JsonSchema = Record<string, unknown>;

/** A port as the graph view draws it: its type, what it carries, and its words. */
export type PortView = (
  | { type: 'chat'; network?: string }
  | {
      type: 'events';
      /** Its namespace: the manifest's, or as its node's config names it; none while unresolved. */
      namespace?: string;
      /** The key of its node's config that names its namespace, when the manifest says so. */
      config?: string;
    }
  | { type: 'interface'; plugin?: string; members: string[] }
) & {
  /** The port in words (`describePort`). */
  label: string;
  /** An input left unbound fails nothing (`ctx.useOptional`); an output's is false. */
  optional: boolean;
  help?: string;
};

/** A member of a node's declared interface (§2 `interface`), with its schemas. */
export interface MemberView {
  name: string;
  help: string;
  input?: JsonSchema;
  output?: JsonSchema;
  /** A command's: its arguments, and whether it is the owner's alone. */
  args?: string;
  owner?: boolean;
}

/** A plugin as the editor shows it (`GET /available`), and each node of it: what it declares. */
export interface PluginView {
  plugin: string;
  version: string;
  description: string;
  kinds: string[];
  account?: string;
  configSchema?: JsonSchema;
  /** Its settings' schema; their values in force are the controls' (`GET /status`). */
  settingsSchema?: JsonSchema;
  /** Its input ports (drawn on the left) and output ports (on the right), by name. */
  inputs: Record<string, PortView>;
  outputs: Record<string, PortView>;
  interface: { reads: MemberView[]; actions: MemberView[]; commands: MemberView[] };
  /** The Docker secrets it declares, and the keys of its config that name one (§4.9). */
  secrets: string[];
  configSecrets: string[];
  /** The event types it registers (§4.4). */
  events: string[];
}

/** One node of the graph, as the graph view shows it: its plugin's declarations, and its own. */
export interface NodeView extends PluginView {
  id: string;
  /** Its configuration, as the graph gives it (defaults are the schema's). */
  config?: Record<string, unknown>;
}

/** A zod schema as a JSON Schema, for a form: as its input, what zod cannot say left open. */
export const jsonSchema = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;

function inputView(
  p: DeclaredInput | InputPort,
  declared: DeclaredInput = p as DeclaredInput
): PortView {
  const base = {
    label: describePort(p),
    optional: p.optional,
    ...(p.help === undefined ? {} : { help: p.help }),
  };
  if (p.type === 'chat')
    return { type: 'chat', ...(p.network === undefined ? {} : { network: p.network }), ...base };
  if (p.type === 'events') {
    const from = declared.type === 'events' ? declared.namespace : undefined;
    return {
      type: 'events',
      ...(typeof p.namespace === 'string' ? { namespace: p.namespace } : {}),
      ...(from !== undefined && typeof from !== 'string' ? { config: from.config } : {}),
      ...base,
    };
  }
  return {
    type: 'interface',
    ...(p.plugin === undefined ? {} : { plugin: p.plugin }),
    members: [...p.members],
    ...base,
  };
}

const outputView = (p: OutputPort): PortView => ({
  ...structuredClone(p),
  label: describePort(p),
  optional: false,
});

/**
 * A plugin as the editor shows it: its manifest's ports, interface, secrets and event types, and
 * the JSON Schemas of its config and settings, for the forms (P11).
 */
export function describePlugin(m: Manifest): PluginView {
  const i = m.interface;
  return {
    plugin: m.id,
    version: m.version,
    description: m.description,
    kinds: [...m.kinds],
    ...(m.account === undefined ? {} : { account: m.account }),
    ...(m.config === undefined ? {} : { configSchema: jsonSchema(m.config) }),
    ...(m.settings === undefined ? {} : { settingsSchema: jsonSchema(m.settings) }),
    inputs: Object.fromEntries(Object.entries(m.inputs).map(([k, p]) => [k, inputView(p)])),
    outputs: Object.fromEntries(Object.entries(m.outputs).map(([k, p]) => [k, outputView(p)])),
    interface: {
      reads: Object.entries(i.state ?? {}).map(([name, r]) => ({
        name,
        help: r.help,
        output: jsonSchema(r.output),
      })),
      actions: Object.entries(i.actions ?? {}).map(([name, a]) => ({
        name,
        help: a.help,
        input: jsonSchema(a.input),
        ...(a.output === undefined ? {} : { output: jsonSchema(a.output) }),
      })),
      commands: Object.entries(i.commands ?? {}).map(([name, c]) => ({
        name,
        help: c.help,
        ...(c.args === undefined ? {} : { args: c.args }),
        owner: c.owner,
      })),
    },
    secrets: [...m.secrets],
    configSecrets: [...m.configSecrets],
    events: Object.keys(m.events).sort(),
  };
}

/**
 * Each node of the graph as the graph view shows it: its plugin's manifest (`describePlugin`), with
 * the node's own account and configuration, and its input ports as its config resolves them (§2.1):
 * the ones given, or resolved from the graph's node.
 */
export function describeNodes(
  nodes: readonly { id: string; manifest: Manifest; ports?: Record<string, InputPort> }[],
  graph: Graph
): NodeView[] {
  return nodes.map(({ id, manifest: m, ports }) => {
    const node = graph.nodes.find((n) => n.id === id);
    const { account: _, ...plugin } = describePlugin(m);
    const account = node?.account ?? m.account;
    const resolved = ports ?? nodeInputs(m, node?.config).ports;
    return {
      id,
      ...plugin,
      inputs: Object.fromEntries(
        Object.entries(resolved).map(([k, p]) => [k, inputView(p, m.inputs[k] ?? p)])
      ),
      ...(account === undefined ? {} : { account }),
      ...(node?.config === undefined ? {} : { config: node.config }),
    };
  });
}
