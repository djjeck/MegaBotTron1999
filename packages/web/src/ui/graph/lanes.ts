/**
 * The editor's swimlanes (docs/bot-os.md D69), apart from React: each group of the draft drawn as
 * a lane, its React Flow id, its colour, and what a hover leaves lit. Pure functions, tested on
 * their own; `layout.ts` places the lanes, `LaneNode.tsx` draws one.
 */
import type { GraphNode } from '#src/ui/api.ts';

/** A lane's id in the drawing: `::lane:<group>`, `::lane` for the ungrouped nodes' (a node's id has no colon). */
export const LANE_ID = '::lane';
export const laneId = (group: string | undefined): string =>
  group === undefined ? LANE_ID : `${LANE_ID}:${group}`;
export const isLaneId = (id: string): boolean => id === LANE_ID || id.startsWith(`${LANE_ID}:`);

/** The groups of a draft's nodes, each once, in the order of the first node of each. */
export function groupsOf(nodes: readonly GraphNode[]): string[] {
  return [...new Set(nodes.flatMap((n) => (n.group === undefined ? [] : [n.group])))];
}

/**
 * The lanes' colours, as `r g b` for CSS's `rgb()`, each drawn translucent (a tint, a border, the
 * minimap's fill) so that it reads on the light theme's background and on the dark one's: mid
 * tones of distinct hues, none of them the grey of the ungrouped nodes' lane.
 */
export const LANE_PALETTE: readonly string[] = [
  '59 130 246', // blue
  '34 197 94', // green
  '245 158 11', // amber
  '236 72 153', // pink
  '139 92 246', // violet
  '6 182 212', // cyan
  '249 115 22', // orange
  '132 204 22', // lime
];
/** The ungrouped nodes' lane: a neutral grey. */
export const UNGROUPED_COLOUR = '120 113 108';

/** A string's 32-bit FNV-1a hash: stable across runs, browsers and releases. */
export function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Each group's colour: the palette's entry its name hashes to; when a lane before it (in the
 * lanes' order) has that entry already, the next free one, so that no two lanes share one while
 * the palette lasts; past it, the next entry that is not the lane above's.
 */
export function laneColours(groups: readonly string[]): Map<string, string> {
  const n = LANE_PALETTE.length;
  const taken = new Set<number>();
  const out = new Map<string, string>();
  let above: number | undefined;
  for (const g of groups) {
    const want = hashName(g) % n;
    let i = want;
    if (taken.size < n) while (taken.has(i)) i = (i + 1) % n;
    else if (i === above) i = (i + 1) % n;
    taken.add(i);
    above = i;
    out.set(g, LANE_PALETTE[i] as string);
  }
  return out;
}

/** What the pointer rests on: a node (any of its cards), or a lane's label. */
export type Hover = { node: string } | { lane: string } | undefined;

/** A card or a lane as the hover sees it: its id, its node (none for a lane), its lane. */
export interface Drawn {
  id: string;
  node?: string | undefined;
  parentId?: string | undefined;
}

/**
 * What a hover leaves lit, every other card, lane and edge dimmed; undefined: nothing is dimmed.
 * A node: its cards, its edges, the cards at their other ends, and their lanes. A lane's label:
 * the lane, its cards, their edges, and the cards outside every lane (the connectors') those edges
 * reach.
 */
export function lit(
  hover: Hover,
  drawn: readonly Drawn[],
  edges: readonly { id: string; source: string; target: string }[]
): { nodes: Set<string>; edges: Set<string> } | undefined {
  if (hover === undefined) return undefined;
  const byId = new Map(drawn.map((d) => [d.id, d]));
  const own = new Set(
    drawn
      .filter((d) => ('node' in hover ? d.node === hover.node : d.parentId === hover.lane))
      .map((d) => d.id)
  );
  const nodes = new Set(own);
  if ('lane' in hover) nodes.add(hover.lane);
  const litEdges = new Set<string>();
  for (const e of edges) {
    if (!own.has(e.source) && !own.has(e.target)) continue;
    litEdges.add(e.id);
    for (const end of [e.source, e.target]) {
      const d = byId.get(end);
      if (d === undefined || nodes.has(end)) continue;
      if ('node' in hover || d.parentId === undefined) nodes.add(end);
    }
  }
  if ('node' in hover)
    for (const id of [...nodes]) {
      const parent = byId.get(id)?.parentId;
      if (parent !== undefined) nodes.add(parent);
    }
  return { nodes, edges: litEdges };
}
