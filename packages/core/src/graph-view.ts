/**
 * The graph printed (docs/bot-os-api.md §4.12): the instance's wiring as text (and two printouts'
 * line diff) and as a Mermaid flowchart, the first, read-only form of the graph's view; what the web UI's graph view draws of
 * each node (`describeNodes`): its ports and the JSON Schemas of its config, settings and
 * interface, made from the zod schemas its manifest declares (P11); and the graph file's write.
 *
 * Nothing in here knows of any game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type Graph, type GraphEdge, nodeInputs } from './graph.ts';
import { type Manifest } from './manifest.ts';
import {
  describePort,
  type InputPort,
  type ManifestInputPort,
  type OutputPort,
  PORT_TYPE_INFO,
} from './ports.ts';

/** The graph file, in the data volume. */
export const GRAPH_FILE = 'graph.json';
/**
 * The graph before the last change, as releases before the history kept it beside the file: read
 * once, at the first start with a history, into it (`graph-history.ts`), then removed.
 */
export const PREVIOUS_GRAPH_FILE = 'graph.previous.json';

/** JSON with its object keys sorted, on one line: two values that mean the same print the same. */
export const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    typeof x === 'object' && x !== null && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]])
        )
      : x
  ) ?? 'null';

const carried = (e: GraphEdge): string =>
  [
    e.reads === '*' ? 'reads any chat' : '',
    Array.isArray(e.reads) && e.reads.length > 0 ? `reads ${e.reads.join(' ')}` : '',
    e.senders === undefined ? '' : `from ${e.senders.join(' ')}`,
    e.sends !== undefined && e.sends.length > 0 ? `sends ${e.sends.join(' ')}` : '',
    e.commands === undefined ? '' : `commands ${e.commands.join(' ')}`,
  ]
    .filter((x) => x !== '')
    .join('; ');

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The graph as text, for reading and for a line diff (`lineDiff`): so that a changed value is a
 * changed line, each node is a line (its id, its plugin, its instance when not its id, its mode and
 * its account), then a line per key of its config and of its settings, the value as compact JSON
 * with its keys sorted; then each edge is a line, with what it carries. Nodes are sorted by id and
 * edges by their ends, so that the same graph always prints the same.
 */
export function graphText(graph: Graph): string {
  const lines = ['nodes:'];
  for (const n of [...graph.nodes].sort((a, b) => byText(a.id, b.id))) {
    const about = [
      n.instance === undefined || n.instance === n.id ? '' : `instance ${n.instance}`,
      n.mode === undefined ? '' : `mode ${n.mode}`,
      n.account === undefined ? '' : `account ${n.account}`,
    ].filter((x) => x !== '');
    lines.push(`  ${n.id} (${n.plugin})${about.map((x) => `, ${x}`).join('')}`);
    for (const [part, values] of [
      ['config', n.config],
      ['settings', n.settings],
    ] as const)
      for (const key of Object.keys(values ?? {}).sort(byText))
        lines.push(`    ${part}.${key}: ${stableJson(values?.[key])}`);
  }
  lines.push('edges:');
  const edges = graph.edges.map((e) => {
    const what = carried(e);
    return `  ${e.from} → ${e.to} (${e.type ?? '?'})${what === '' ? '' : `: ${what}`}`;
  });
  lines.push(...edges.sort(byText));
  return lines.join('\n');
}

/** One line of a line diff: kept (` `), only in the first text (`-`), or only in the second (`+`). */
export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

/** Past this many cells (lines × lines), `lineDiff` gives up on the shortest diff. */
const DIFF_CELLS = 4_000_000;

/**
 * The lines of `before` and `after` (two printouts, `graphText`) as a diff: their longest common
 * subsequence kept, and what each has besides, a line removed before one added at the same place.
 * Two texts too long for it (`DIFF_CELLS`) give every line removed, then every one added.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > DIFF_CELLS)
    return [
      ...a.map((text) => ({ op: '-' as const, text })),
      ...b.map((text) => ({ op: '+' as const, text })),
    ];
  // The length of the longest common subsequence of each pair of suffixes.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  const at = (i: number, j: number): number => lcs[i * w + j] as number;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) out.push({ op: '-', text: a[i++] as string });
    else out.push({ op: '+', text: b[j++] as string });
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] as string });
  while (j < b.length) out.push({ op: '+', text: b[j++] as string });
  return out;
}

/** A Mermaid id: the node's, with dashes made underscores. */
const mermaidId = (id: string): string => id.replaceAll('-', '_');
/** A label, its quotes escaped as Mermaid's entity. */
const label = (text: string): string => `"${text.replaceAll('"', '#quot;')}"`;

/**
 * The graph as a Mermaid flowchart, left to right: a box per node (its id, and its plugin when
 * another's), an arrow per edge from its output to its input, named by the two ports and coloured
 * by its port type (`PORT_TYPE_INFO`). A connector that chat-out edges send through has a second
 * box, `<id> · out`, so that the sends flow left to right too (bot-os.md D60).
 */
export function graphMermaid(graph: Graph): string {
  const lines = ['flowchart LR'];
  for (const n of graph.nodes)
    lines.push(
      `  ${mermaidId(n.id)}[${label(n.plugin === n.id ? n.id : `${n.id}<br/><i>${n.plugin}</i>`)}]`
    );
  const outs = [
    ...new Set(
      graph.edges.flatMap((e) => (e.type === 'chat-out' ? [e.to.split('.')[0] ?? ''] : []))
    ),
  ];
  for (const id of outs) lines.push(`  ${mermaidId(id)}_out[${label(`${id} · out`)}]`);
  graph.edges.forEach((e) => {
    const [from = '', out = ''] = e.from.split('.');
    const [to = '', input = ''] = e.to.split('.');
    const what = carried(e);
    const text = `${out} → ${input}${what === '' ? '' : `<br/>${what}`}`;
    const target = `${mermaidId(to)}${e.type === 'chat-out' ? '_out' : ''}`;
    lines.push(`  ${mermaidId(from)} -- ${label(text)} --> ${target}`);
  });
  graph.edges.forEach((e, i) => {
    if (e.type !== undefined)
      lines.push(`  linkStyle ${i} stroke:${PORT_TYPE_INFO[e.type].colour}`);
  });
  return lines.join('\n');
}

/**
 * Writes the graph to `<dir>/graph.json` (atomically: a temporary file, then a rename). True if it
 * changed. The versions before it are the history's (`GraphFile`, `graph-history.ts`).
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
  | {
      type: 'chat-in' | 'chat-out';
      network?: string;
      /** A chat-in's: the key of its node's config that, set, gives the node this port. */
      when?: string;
    }
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
  /**
   * An input left unbound fails nothing (`ctx.useOptional`), nor does a chat-out output; another
   * output's is false.
   */
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
  p: ManifestInputPort | InputPort,
  declared: ManifestInputPort = p as ManifestInputPort
): PortView {
  const base = {
    label: describePort(p),
    optional: p.optional,
    ...(p.help === undefined ? {} : { help: p.help }),
  };
  if (p.type === 'chat-in' || p.type === 'chat-out')
    return {
      type: p.type,
      ...(p.network === undefined ? {} : { network: p.network }),
      ...(p.type === 'chat-in' && p.when !== undefined ? { when: p.when.config } : {}),
      ...base,
    };
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

function outputView(p: OutputPort): PortView {
  if (p.type !== 'chat-out')
    return { ...structuredClone(p), label: describePort(p), optional: false };
  return {
    type: 'chat-out',
    ...(p.network === undefined ? {} : { network: p.network }),
    label: describePort(p),
    optional: p.optional,
    ...(p.help === undefined ? {} : { help: p.help }),
  };
}

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
