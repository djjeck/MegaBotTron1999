/**
 * The canvas's nodes and edges kept as they were when nothing they draw changed: a draft changed
 * by a keystroke in a node's panel (a config field, a script's port) remakes them all, and React
 * Flow draws again each one it is handed anew. Each one made again that draws as before is the
 * one it had, and the list itself is kept when none changed, so that typing in the panel leaves
 * the canvas alone. Pure, tested apart from React.
 */

/** What an item draws: the keys it is given, as JSON (a function, as a lane's hover, is left out). */
const drawn = (item: object, keys: readonly string[]): string =>
  JSON.stringify(keys.map((k) => (item as Record<string, unknown>)[k]));

/**
 * `next`, each item the one of `before` with its id when it draws the same (`keys`, compared as
 * JSON), and `before` itself when every one does, in the same order.
 */
export function keepSame<T extends { id: string }>(
  before: readonly T[],
  next: readonly T[],
  keys: readonly (keyof T & string)[]
): T[] {
  const was = new Map(before.map((b) => [b.id, b]));
  let changed = before.length !== next.length;
  const out = next.map((n, i) => {
    const b = was.get(n.id);
    if (b !== undefined && drawn(b, keys) === drawn(n, keys)) {
      if (before[i] !== b) changed = true;
      return b;
    }
    changed = true;
    return n;
  });
  return changed ? out : (before as T[]);
}
