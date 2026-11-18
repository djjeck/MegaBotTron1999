/**
 * The nodes a load holds back (bot-os.md D143): a node whose plugin did not load (its package or
 * module failed to import, or its import never settled) is taken out of the graph the core runs,
 * with every edge that touches it, rather than refusing the whole graph; and so is each node that
 * then needs it: one whose required input it fed, or one whose required chat-out output it took
 * (as `requiredOf` counts them), transitively. The rest of the graph runs.
 *
 * Nothing in here knows of any game.
 */
import { nodeInputs, nodeManifest } from './graph.ts';
import { type Manifest } from './manifest.ts';

/** A node taken out of the graph the core runs. */
export interface Unloaded {
  id: string;
  plugin: string;
  /** Disabled in the graph: it would not run anyway. */
  disabled: boolean;
  /** The node held already that it needs, for one held because of another; none for its own. */
  needs?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The node an edge's end names (`node.port`, or `node`), and its port if it names one. */
function endOf(end: string): { node: string; port?: string } {
  const [node = '', port] = end.split('.');
  return port === undefined ? { node } : { node, port };
}

/**
 * The graph `raw` without the nodes whose plugin `manifests` lacks, nor those that need them, with
 * the nodes held. A graph that does not read as one is given back as it is, for the check to say
 * why.
 */
export function holdUnloaded(
  raw: unknown,
  manifests: ReadonlyMap<string, Manifest>
): { raw: unknown; held: Unloaded[] } {
  if (!isRecord(raw) || !Array.isArray(raw['nodes'])) return { raw, held: [] };
  const nodes = new Map<string, { plugin: string; config?: Record<string, unknown> }>();
  const held = new Map<string, Unloaded>();
  for (const n of raw['nodes'] as unknown[]) {
    if (!isRecord(n) || typeof n['id'] !== 'string' || typeof n['plugin'] !== 'string') continue;
    const config = isRecord(n['config']) ? n['config'] : undefined;
    nodes.set(n['id'], { plugin: n['plugin'], ...(config === undefined ? {} : { config }) });
    if (!manifests.has(n['plugin']))
      held.set(n['id'], { id: n['id'], plugin: n['plugin'], disabled: n['disabled'] === true });
  }
  if (held.size === 0) return { raw, held: [] };
  const edges = (Array.isArray(raw['edges']) ? (raw['edges'] as unknown[]) : []).flatMap((e) =>
    isRecord(e) && typeof e['from'] === 'string' && typeof e['to'] === 'string'
      ? [{ from: endOf(e['from']), to: endOf(e['to']) }]
      : []
  );
  /** Its own manifest, as its config makes it (D74); none for a node held. */
  const manifestOf = (id: string): Manifest | undefined => {
    const n = nodes.get(id);
    const base = n === undefined ? undefined : manifests.get(n.plugin);
    return base === undefined ? undefined : nodeManifest(base, id, n?.config).manifest;
  };
  const hold = (id: string, plugin: string, needs: string): void => {
    held.set(id, { id, plugin, disabled: false, needs });
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, to } of edges) {
      if (held.has(from.node) === held.has(to.node)) continue;
      if (held.has(from.node)) {
        // It fed an input of `to`: a required one leaves `to` without what it needs.
        const n = nodes.get(to.node);
        const m = manifestOf(to.node);
        if (n === undefined || m === undefined) continue;
        if (nodeInputs(m, n.config).ports[to.port ?? '']?.optional === true) continue;
        hold(to.node, n.plugin, from.node);
      } else {
        // It took a chat-out output of `from`: a required one leaves `from` without its connector.
        const n = nodes.get(from.node);
        const m = manifestOf(from.node);
        if (n === undefined || m === undefined) continue;
        const outputs = from.port === undefined ? Object.values(m.outputs) : [m.outputs[from.port]];
        if (!outputs.some((o) => o?.type === 'chat-out' && !o.optional)) continue;
        hold(from.node, n.plugin, to.node);
      }
      changed = true;
    }
  }
  return {
    raw: {
      ...raw,
      nodes: (raw['nodes'] as unknown[]).filter(
        (n) => !isRecord(n) || typeof n['id'] !== 'string' || !held.has(n['id'])
      ),
      ...(Array.isArray(raw['edges'])
        ? {
            edges: (raw['edges'] as unknown[]).filter(
              (e) =>
                !isRecord(e) ||
                typeof e['from'] !== 'string' ||
                typeof e['to'] !== 'string' ||
                (!held.has(endOf(e['from']).node) && !held.has(endOf(e['to']).node))
            ),
          }
        : {}),
    },
    held: [...held.values()],
  };
}
