import { Stores, VirtualClock } from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { PRICES } from './anthropic.ts';
import {
  type CallRecord,
  costOf,
  dollars,
  HOUR_MS,
  type ModelPrice,
  priceOf,
  SPEND_DOC,
  SpendLedger,
} from './spend.ts';

const PRICE: ModelPrice = {
  input: 4,
  output: 20,
  cacheWrite5m: 5,
  cacheWrite1h: 8,
  cacheRead: 0.2,
};
const NONE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

let stores = 0;
const store = () => new Stores().open(`spend${++stores}`);

const call = (o: Partial<CallRecord>): CallRecord => ({
  node: 'quest',
  model: 'claude-opus-5-5',
  ok: true,
  ...NONE,
  usd: 0.01,
  ...o,
});

describe('prices', () => {
  it('finds a model’s price, or its dated snapshot’s, and none for a model it has not', () => {
    expect(priceOf(PRICES, 'claude-opus-5-5')).toEqual({
      input: 4,
      output: 20,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
    });
    expect(priceOf(PRICES, 'claude-haiku-4-5-20251001')).toBe(PRICES['claude-haiku-4-5']);
    expect(priceOf(PRICES, 'claude-unknown-9')).toBeUndefined();
    expect(priceOf(PRICES, 'claude-unknown-9-20251001')).toBeUndefined();
    expect(priceOf(PRICES, 'toString')).toBeUndefined();
  });

  it('costs each kind of token at its own rate, the cache writes by how long they are kept', () => {
    const used = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 1_000_000,
    };
    // 4 + 2 + 0.4 + 5, or 8 for an hour's writes.
    expect(costOf(PRICE, used)).toBeCloseTo(11.4);
    expect(costOf(PRICE, used, '1h')).toBeCloseTo(14.4);
    expect(costOf(PRICE, NONE)).toBe(0);
  });

  it('costs a long prompt at its dearer prices, where a model has them', () => {
    const haiku = PRICES['claude-haiku-5-5'] as ModelPrice;
    const short = { ...NONE, inputTokens: 100_000, outputTokens: 1_000_000 };
    expect(costOf(haiku, short)).toBeCloseTo(0.01 + 0.5);
    // Its prompt counts its cache reads and writes too.
    const long = { ...short, cacheReadTokens: 1 };
    expect(costOf(haiku, long)).toBeCloseTo(0.05 + 2.5);
  });

  it('says an amount in dollars, below a cent to the hundredth of one', () => {
    expect(dollars(0)).toBe('$0');
    expect(dollars(0.00314)).toBe('$0.0031');
    expect(dollars(12.345)).toBe('$12.35');
  });
});

describe('SpendLedger', () => {
  it('sums the last 24 hours, by node and by model, the dearest first', () => {
    const clock = new VirtualClock(10 * HOUR_MS);
    const ledger = new SpendLedger(store(), clock);
    ledger.add(call({ usd: 0.01, inputTokens: 10, outputTokens: 5 }));
    ledger.add(call({ usd: 0.02, inputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 2 }));
    ledger.add(call({ node: 'helper', model: 'claude-haiku-5-5', usd: 0.5 }));
    ledger.add(call({ node: '(owner)', model: 'claude-new', usd: null, ok: false }));
    const s = ledger.status();
    expect(s).toMatchObject({
      calls: 4,
      unpriced: 1,
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      cost: '$0.53 + 1 unpriced',
      since: -14 * HOUR_MS,
    });
    expect(s.usd).toBeCloseTo(0.53);
    expect(s.byNode.map((r) => [r.node, r.calls, r.cost])).toEqual([
      ['helper', 1, '$0.50'],
      ['quest', 2, '$0.03'],
      ['(owner)', 1, '$0 + 1 unpriced'],
    ]);
    expect(s.byModel.map((r) => [r.model, r.calls])).toEqual([
      ['claude-haiku-5-5', 1],
      ['claude-opus-5-5', 2],
      ['claude-new', 1],
    ]);
    expect(ledger.spend()).toEqual({ usd: s.usd, calls: 4, unpriced: 1 });
  });

  it('keeps the window across a restart, and drops the hours that leave it', () => {
    const clock = new VirtualClock(10 * HOUR_MS + 1000);
    const kept = store();
    new SpendLedger(kept, clock).add(call({ usd: 1 }));
    clock.advanceTo(12 * HOUR_MS);
    new SpendLedger(kept, clock).add(call({ usd: 2 }));
    // A new ledger on the same store, as after a restart, reads it back.
    const again = new SpendLedger(kept, clock);
    expect(again.spend()).toEqual({ usd: 3, calls: 2, unpriced: 0 });
    // Hour 10 is in the window while it overlaps the last 24 hours.
    clock.advanceTo(34 * HOUR_MS + 1);
    expect(again.spend()).toEqual({ usd: 3, calls: 2, unpriced: 0 });
    clock.advanceTo(35 * HOUR_MS);
    expect(again.spend()).toEqual({ usd: 2, calls: 1, unpriced: 0 });
    again.add(call({ usd: 4 }));
    expect(kept.read<{ buckets: unknown[] }>(SPEND_DOC)?.buckets).toHaveLength(2);
    clock.advanceTo(60 * HOUR_MS);
    expect(again.status()).toMatchObject({ calls: 0, cost: '$0', byNode: [], byModel: [] });
  });

  it('starts empty from a store with nothing, or something else, in its document', () => {
    const odd = store();
    odd.write(SPEND_DOC, { buckets: 'none' });
    expect(new SpendLedger(odd, new VirtualClock()).spend()).toEqual({
      usd: 0,
      calls: 0,
      unpriced: 0,
    });
  });
});
