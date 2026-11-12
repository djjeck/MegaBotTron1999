/**
 * Where each node of the graph view starts: in columns, left to right, so that every edge
 * runs from an output on the right of one node to an input on the left of a later one. A node's
 * column is one past the furthest node that feeds it; an edge that would close a loop (only optional
 * inputs can) is left out of the count, the graph's order deciding which. Within a column, nodes keep the graph's order.
 * The cards given as `last` (a connector's out card, where the sends arrive, D60) take a column of
 * their own, past every other, so that a chat's data flows left to right.
 */

/** The gaps between columns and rows, in the drawing's pixels. */
export const COLUMN_GAP = 320;
export const ROW_GAP = 40;

export interface Placed {
  x: number;
  y: number;
}

/** Each node's position, by id: `heights` is each node's drawn height (its ports make it taller). */
export function layout(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  heights: (id: string) => number,
  last: ReadonlySet<string> = new Set()
): Map<string, Placed> {
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
    c = 0;
    for (const f of feeds.get(id) ?? []) c = Math.max(c, columnOf(f) + 1);
    column.set(id, c);
    return c;
  };
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
