/**
 * What a connector has delivered of each chat, kept in its store (docs/bot-os.md D66): so that each
 * message (a chat and its id) reaches the readers at most once, across live delivery, catch-up and
 * restarts, and a gap is fetched again until it is filled.
 *
 * - `last` (`LAST_SEEN_DOC`, by chat): every message of the chat up to that id is accounted for,
 *   delivered or deliberately skipped. It never moves past a gap that is not filled.
 * - Above it, ranges of ids accounted for (`SEEN_ABOVE_DOC`): the messages heard live, or sent,
 *   while a gap below is still unfilled. A range that meets `last` folds into it. At most
 *   `MAX_RANGES` a chat: past them, the lowest gap is given up (skipped, and said so).
 *
 * Message ids grow within a chat but are not consecutive (a deleted message, a service one, or a
 * private chat's ids shared with the account's other chats), so a range is only ever what was
 * seen, or what a fetch found complete.
 */

/** The store's document of the last message id accounted for in each chat, by the chat's key. */
export const LAST_SEEN_DOC = 'last-seen';
/** The store's document of the ids accounted for above it, as ranges, by the chat's key. */
export const SEEN_ABOVE_DOC = 'seen-above';
/** How many ranges above `last` a chat keeps, at most. */
export const MAX_RANGES = 100;

/** A range of message ids, both ends included. */
export type IdRange = [number, number];

/** What the ledger needs of a store (`ctx.store`). */
export interface LedgerStore {
  read<T>(name: string): T | undefined;
  write(name: string, value: unknown): void;
}

export class SeenLedger {
  private readonly lastSeen: Record<string, number>;
  private readonly above: Record<string, IdRange[]>;
  private readonly store: LedgerStore | undefined;
  /** Told of a gap given up for the bound (the chat, and the ids skipped, both ends excluded). */
  private readonly gaveUp: ((key: string, after: number, before: number) => void) | undefined;

  constructor(store?: LedgerStore, gaveUp?: (key: string, after: number, before: number) => void) {
    this.store = store;
    this.gaveUp = gaveUp;
    this.lastSeen = { ...(store?.read<Record<string, number>>(LAST_SEEN_DOC) ?? {}) };
    this.above = structuredClone(store?.read<Record<string, IdRange[]>>(SEEN_ABOVE_DOC) ?? {});
  }

  /** The last id accounted for in a chat, below which nothing is missing; none for a new chat. */
  last(key: string): number | undefined {
    return this.lastSeen[key];
  }

  /** Whether a message is accounted for: delivered, or skipped on purpose. */
  covered(key: string, id: number): boolean {
    const last = this.lastSeen[key];
    if (last !== undefined && id <= last) return true;
    return (this.above[key] ?? []).some(([a, b]) => a <= id && id <= b);
  }

  /** Everything up to `id` accounted for: delivered, or skipped on purpose. */
  advance(key: string, id: number): void {
    const last = this.lastSeen[key];
    if (last !== undefined && id <= last) return;
    this.lastSeen[key] = id;
    this.settle(key);
  }

  /** The ids from `from` to `to` accounted for (heard live since `from`, or one id alone). */
  mark(key: string, from: number, to = from): void {
    if (this.lastSeen[key] === undefined) {
      this.advance(key, to);
      return;
    }
    if (from === to && this.covered(key, from)) return;
    (this.above[key] ??= []).push([from, to]);
    this.settle(key);
  }

  /**
   * What is missing of a chat up to `upTo`: the ranges between `last` and the ranges above it,
   * each `[after, upTo]` (`after` excluded), newest first. None for a chat with no `last`.
   */
  gaps(key: string, upTo: number): IdRange[] {
    const last = this.lastSeen[key];
    if (last === undefined) return [];
    const out: IdRange[] = [];
    let lo = last;
    for (const [a, b] of this.above[key] ?? []) {
      if (a > upTo) break;
      if (a - 1 > lo) out.push([lo, a - 1]);
      lo = Math.max(lo, b);
    }
    if (upTo > lo) out.push([lo, upTo]);
    return out.reverse();
  }

  /** A chat's ranges sorted and merged, those that meet `last` folded in, bounded; then kept. */
  private settle(key: string): void {
    let last = this.lastSeen[key];
    const merged: IdRange[] = [];
    for (const [a, b] of [...(this.above[key] ?? [])].sort((x, y) => x[0] - y[0])) {
      const top = merged.at(-1);
      if (top !== undefined && a <= top[1] + 1) top[1] = Math.max(top[1], b);
      else merged.push([a, b]);
    }
    for (;;) {
      const low = merged[0];
      if (low === undefined || last === undefined) break;
      if (low[0] <= last + 1) {
        last = Math.max(last, low[1]);
        merged.shift();
      } else if (merged.length > MAX_RANGES) {
        this.gaveUp?.(key, last, low[0]);
        last = low[1];
        merged.shift();
      } else break;
    }
    if (last !== undefined) this.lastSeen[key] = last;
    const had = this.above[key] !== undefined;
    if (merged.length > 0) this.above[key] = merged;
    else delete this.above[key];
    this.store?.write(LAST_SEEN_DOC, this.lastSeen);
    if (had || merged.length > 0) this.store?.write(SEEN_ABOVE_DOC, this.above);
  }
}
