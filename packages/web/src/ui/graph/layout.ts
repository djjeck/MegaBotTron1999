/**
 * Where each node of the graph view starts: in columns, left to right, so that every edge
 * runs from an output on the right of one node to an input on the left of a later one. A node's
 * column is one past the furthest node that feeds it; an edge that would close a loop (only optional
 * inputs can) is left out of the count, the graph's order deciding which. Within a column, nodes keep the graph's order.
 * The cards given as `last` (a connector's out card, where the sends arrive, D60) take a column of
 * their own, past every other, so that a chat's data flows left to right.
 *
 * A graph whose nodes name groups is drawn in swimlanes (`swimlanes`, bot-os.md D69): the same
 * global columns, each group a horizontal band holding its cards in their columns, and the
 * connectors' cards outside every band, their in cards in a column of their own at the left and
 * their out cards in the one at the right. An ungrouped source that feeds the bands alone (a
 * person's `attention`, shared by the players of several lanes, D136) is drawn in that left
 * column too, under the in cards.
 */

/** The gaps between columns and rows, in the drawing's pixels. */
export const COLUMN_GAP = 320;
export const ROW_GAP = 40;
/** A card's width (`.plugin-node` in styles.css). */
export const CARD_WIDTH = 220;
/** A lane's room for its label above its cards, its padding around them, and the gap between two. */
export const LANE_HEAD = 40;
export const LANE_PAD = 20;
export const LANE_GAP = 24;

export interface Placed {
  x: number;
  y: number;
}

/**
 * Each card's column, by id: one past the furthest card that feeds it, and at least its `floor`;
 * an edge that would close a loop is left out, the graph's order deciding which.
 */
function columns(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  floor: (id: string) => number = () => 0
): (id: string) => number {
  const known = new Set(ids);
  const links = edges
    .map((e) => [e.from.split('.')[0] ?? '', e.to.split('.')[0] ?? ''] as const)
    .filter(([from, to]) => from !== to && known.has(from) && known.has(to));
  // The loops broken: walking the edges forward from each node in the graph's order, an edge back
  // to a node still being walked is left out.
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, to] of links) next.get(from)?.push(to);
  const feeds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const walking = new Set<string>();
  const walked = new Set<string>();
  const walk = (id: string): void => {
    walking.add(id);
    for (const to of next.get(id) ?? []) {
      if (walking.has(to)) continue;
      feeds.get(to)?.push(id);
      if (!walked.has(to)) walk(to);
    }
    walking.delete(id);
    walked.add(id);
  };
  for (const id of ids) if (!walked.has(id)) walk(id);
  const column = new Map<string, number>();
  const columnOf = (id: string): number => {
    let c = column.get(id);
    if (c !== undefined) return c;
    c = floor(id);
    for (const f of feeds.get(id) ?? []) c = Math.max(c, columnOf(f) + 1);
    column.set(id, c);
    return c;
  };
  return columnOf;
}

/** Each node's position, by id: `heights` is each node's drawn height (its ports make it taller). */
export function layout(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  heights: (id: string) => number,
  last: ReadonlySet<string> = new Set()
): Map<string, Placed> {
  const columnOf = columns(ids, edges);
  const final = Math.max(-1, ...ids.filter((id) => !last.has(id)).map(columnOf)) + 1;
  const tops: number[] = [];
  const placed = new Map<string, Placed>();
  for (const id of ids) {
    const c = last.has(id) ? final : columnOf(id);
    const y = tops[c] ?? 0;
    placed.set(id, { x: c * COLUMN_GAP, y });
    tops[c] = y + heights(id) + ROW_GAP;
  }
  return placed;
}

/** A swimlane: its group's name (none for the ungrouped nodes'), its box, and its cards. */
export interface Lane {
  name: string | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
  cards: string[];
}

/** A swimlane layout: each card's position (relative to its lane's box, when in one), and lanes. */
export interface LaneLayout {
  placed: Map<string, Placed & { lane?: number }>;
  lanes: Lane[];
}

/**
 * The cards in swimlanes (bot-os.md D69). Columns are global, computed as `layout`'s across the
 * whole graph, so that a stage lines up across lanes, but for the connectors' cards: their in cards
 * (`first`) take column 0 and every other card starts at column 1 at least, their out cards
 * (`last`) the column past every other. Each group (`groupOf`, none for a connector's cards) is a
 * band across the inner columns, in the order of its first card, the ungrouped cards' band (no
 * name) last; within a band, cards keep the graph's order in their columns. The in and out cards
 * are stacked from the top, outside every band. A card in a band is placed relative to the band.
 *
 * An ungrouped card that no edge feeds and whose every edge, one at least, reaches a card in a
 * band (a person's `attention`, D136) is no band's: it is drawn with the in cards, in their column
 * and stacked under them, its consumers in their bands to its right.
 */
export function swimlanes(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  heights: (id: string) => number,
  o: {
    first: ReadonlySet<string>;
    last: ReadonlySet<string>;
    groupOf: (id: string) => string | undefined;
  }
): LaneLayout {
  const links = edges
    .map((e) => [e.from.split('.')[0] ?? '', e.to.split('.')[0] ?? ''] as const)
    .filter(([from, to]) => from !== to);
  const banded = (id: string): boolean =>
    !o.first.has(id) && !o.last.has(id) && o.groupOf(id) !== undefined;
  // The ungrouped sources that feed the bands alone, beside the in cards (D136).
  const aside = new Set(
    ids.filter(
      (id) =>
        !o.first.has(id) &&
        !o.last.has(id) &&
        o.groupOf(id) === undefined &&
        !links.some(([, to]) => to === id) &&
        links.some(([from]) => from === id) &&
        links.every(([from, to]) => from !== id || banded(to))
    )
  );
  const left = new Set([...o.first, ...aside]);
  const outside = (id: string): boolean => left.has(id) || o.last.has(id);
  const inner = ids.filter((id) => !outside(id));
  const floor = left.size > 0 ? 1 : 0;
  const columnOf = columns(ids, edges, (id) => (left.has(id) ? 0 : floor));
  const colOf = (id: string): number => (left.has(id) ? 0 : columnOf(id));
  const innerCols = inner.map(colOf);
  const lo = Math.min(floor, ...innerCols);
  const hi = Math.max(lo, ...innerCols);
  const final = Math.max(hi + 1, left.size > 0 ? 1 : 0);
  const placed = new Map<string, Placed & { lane?: number }>();
  // The connectors' cards, stacked from the top in their columns, the sources aside under the in
  // cards.
  for (const [column, c] of [
    [[...ids.filter((x) => o.first.has(x)), ...ids.filter((x) => aside.has(x))], 0],
    [ids.filter((x) => o.last.has(x)), final],
  ] as const) {
    let y = 0;
    for (const id of column) {
      placed.set(id, { x: c * COLUMN_GAP, y });
      y += heights(id) + ROW_GAP;
    }
  }
  // The bands: each group's, by its first card, then the ungrouped cards'.
  const names: (string | undefined)[] = [];
  for (const id of inner) {
    const g = o.groupOf(id);
    if (g !== undefined && !names.includes(g)) names.push(g);
  }
  if (inner.some((id) => o.groupOf(id) === undefined)) names.push(undefined);
  const x = lo * COLUMN_GAP - LANE_PAD;
  const width = (hi - lo) * COLUMN_GAP + CARD_WIDTH + 2 * LANE_PAD;
  const lanes: Lane[] = [];
  let top = 0;
  for (const name of names) {
    const cards = inner.filter((id) => o.groupOf(id) === name);
    const tops: number[] = [];
    for (const id of cards) {
      const c = colOf(id);
      const y = tops[c] ?? 0;
      placed.set(id, {
        x: c * COLUMN_GAP - x,
        y: LANE_HEAD + y,
        lane: lanes.length,
      });
      tops[c] = y + heights(id) + ROW_GAP;
    }
    const deepest = Math.max(...tops.filter((t) => t !== undefined));
    const height = LANE_HEAD + deepest - ROW_GAP + LANE_PAD;
    lanes.push({ name, x, y: top, width, height, cards });
    top += height + LANE_GAP;
  }
  return { placed, lanes };
}
