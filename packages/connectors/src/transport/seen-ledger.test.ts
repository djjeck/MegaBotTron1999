import { describe, expect, it } from 'vitest';
import { LAST_SEEN_DOC, MAX_RANGES, SEEN_ABOVE_DOC, SeenLedger } from './seen-ledger.ts';

function store(start: [string, unknown][] = []) {
  const docs = new Map<string, unknown>(start);
  const writes: string[] = [];
  return {
    docs,
    writes,
    read: <T>(name: string) => docs.get(name) as T | undefined,
    write: (name: string, value: unknown) => {
      writes.push(name);
      docs.set(name, structuredClone(value));
    },
  };
}

describe('SeenLedger', () => {
  it('starts a new chat where it is first seen, and moves only forward', () => {
    const s = store();
    const l = new SeenLedger(s);
    expect(l.last('g')).toBeUndefined();
    expect(l.gaps('g', 10)).toEqual([]);
    l.mark('g', 7, 9);
    expect(l.last('g')).toBe(9);
    l.advance('g', 4);
    expect(l.last('g')).toBe(9);
    expect(l.covered('g', 9)).toBe(true);
    expect(l.covered('g', 10)).toBe(false);
    expect(s.docs.get(LAST_SEEN_DOC)).toEqual({ g: 9 });
    // Nothing above it: the ranges' document is never written.
    expect(s.writes).not.toContain(SEEN_ABOVE_DOC);
  });

  it('keeps ranges above a gap, merges them, and folds them in once the gap is filled', () => {
    const s = store([[LAST_SEEN_DOC, { g: 10 }]]);
    const l = new SeenLedger(s);
    l.mark('g', 20, 22);
    l.mark('g', 23, 25);
    l.mark('g', 15);
    l.mark('g', 15);
    expect(s.docs.get(SEEN_ABOVE_DOC)).toEqual({
      g: [
        [15, 15],
        [20, 25],
      ],
    });
    expect(l.covered('g', 21)).toBe(true);
    expect(l.covered('g', 16)).toBe(false);
    expect(l.gaps('g', 30)).toEqual([
      [25, 30],
      [15, 19],
      [10, 14],
    ]);
    expect(l.gaps('g', 18)).toEqual([
      [15, 18],
      [10, 14],
    ]);
    l.advance('g', 14);
    expect(l.last('g')).toBe(15);
    l.advance('g', 19);
    expect(l.last('g')).toBe(25);
    expect(s.docs.get(SEEN_ABOVE_DOC)).toEqual({});
    // Kept: a ledger made again from the store has it.
    expect(new SeenLedger(s).last('g')).toBe(25);
  });

  it(`gives up the lowest gap past ${MAX_RANGES} ranges, and says so`, () => {
    const s = store([[LAST_SEEN_DOC, { g: 0 }]]);
    const gaveUp: string[] = [];
    const l = new SeenLedger(s, (key, after, before) => gaveUp.push(`${key} ${after} ${before}`));
    for (let i = 1; i <= MAX_RANGES + 1; i++) l.mark('g', i * 10);
    expect(gaveUp).toEqual(['g 0 10']);
    expect(l.last('g')).toBe(10);
    expect(l.gaps('g', 20)).toEqual([[10, 19]]);
  });

  it('works without a store', () => {
    const l = new SeenLedger();
    l.advance('g', 3);
    l.mark('g', 5);
    expect(l.gaps('g', 5)).toEqual([[3, 4]]);
  });
});
