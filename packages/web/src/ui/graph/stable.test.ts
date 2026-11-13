import { describe, expect, it } from 'vitest';
import { keepSame } from './stable.ts';

describe('the canvas kept as drawn', () => {
  const a = { id: 'a', data: { n: 1 }, measured: { width: 10 } };
  const b = { id: 'b', data: { n: 2 } };

  it('keeps the list itself when every item draws as before', () => {
    const before = [a, b];
    const next = [
      { id: 'a', data: { n: 1 } },
      { id: 'b', data: { n: 2 } },
    ];
    expect(keepSame<{ id: string; data: object }>(before, next, ['data'])).toBe(before);
  });

  it('keeps each item that draws as before, and takes each one changed, added or moved', () => {
    const before = [a, b];
    const changed = { id: 'b', data: { n: 3 } };
    const out = keepSame<{ id: string; data: object }>(before, [a, changed], ['data']);
    expect(out).not.toBe(before);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(changed);
    const c = { id: 'c', data: {} };
    expect(keepSame<{ id: string; data: object }>(before, [a, b, c], ['data'])).toEqual([a, b, c]);
    const swapped = keepSame<{ id: string; data: object }>(before, [b, a], ['data']);
    expect(swapped).not.toBe(before);
    expect(swapped[0]).toBe(b);
    // A function, as a lane's hover, is not compared.
    const f = { id: 'a', data: { n: 1, hover: () => {} } };
    expect(
      keepSame<{ id: string; data: object }>([f], [{ ...f, data: { n: 1 } }], ['data'])[0]
    ).toBe(f);
  });
});
