/**
 * What a model connector spends (docs/bot-os.md D117), for any connector whose manifest says
 * `model`: each call's cost from a price table per model, a record of it in the event log, and the
 * last 24 hours kept in its store by the hour, by calling node and by model, so that the figure
 * survives a restart without reading the log back. Its `status` read says it; the connector's
 * widget and page show it (D112), and its `Instance.cost` gives the Costs sheet its total (D77).
 */
import {
  type Clock,
  type Spend,
  type Store,
  type Widget,
  type WidgetPage,
} from '@megabottron1999/core';
import { z } from 'zod';

/** An hour, the ledger's grain, and the window it sums. */
export const HOUR_MS = 3_600_000;
export const WINDOW_MS = 24 * HOUR_MS;
/** Its document in the connector's store. */
export const SPEND_DOC = 'spend';
/** The caller of a call from the owner's controls (the panel's actions), which no node id can be. */
export const OWNER_CALLER = '(owner)';

/** One model's prices, in USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  /** Tokens written to the cache for 5 minutes. */
  cacheWrite5m: number;
  /** Tokens written to the cache for an hour. */
  cacheWrite1h: number;
  cacheRead: number;
}

/** A model's prices, and its dearer ones for a prompt over so many tokens, where they differ. */
export interface ModelPrice extends Rates {
  over?: Rates & { promptTokens: number };
}

/**
 * The price table, by model id: kept in the connector's code, not its config, so that a release
 * updates it (D117).
 */
export type Prices = Readonly<Record<string, ModelPrice>>;

/** What a call used, in tokens. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * A model's price: its own, or that of the id it is a dated snapshot of (`<id>-20251001`); none
 * for a model the table has not.
 */
export function priceOf(prices: Prices, model: string): ModelPrice | undefined {
  if (Object.hasOwn(prices, model)) return prices[model];
  const dated = /^(.+)-\d{8}$/u.exec(model)?.[1];
  return dated !== undefined && Object.hasOwn(prices, dated) ? prices[dated] : undefined;
}

/** A call's cost in USD, its cache writes priced for how long they are kept. */
export function costOf(price: ModelPrice, used: CallUsage, cacheTtl: '5m' | '1h' = '5m'): number {
  const prompt = used.inputTokens + used.cacheReadTokens + used.cacheWriteTokens;
  const p = price.over !== undefined && prompt > price.over.promptTokens ? price.over : price;
  const write = cacheTtl === '1h' ? p.cacheWrite1h : p.cacheWrite5m;
  return (
    (used.inputTokens * p.input +
      used.outputTokens * p.output +
      used.cacheReadTokens * p.cacheRead +
      used.cacheWriteTokens * write) /
    1_000_000
  );
}

/** A call, as the connector logs it (`<plugin>.call`) and counts it. */
export interface CallRecord extends CallUsage {
  /** The node that called, or `(owner)` for the owner's controls. */
  node: string;
  model: string;
  ok: boolean;
  error?: string;
  /** Its cost in USD; null for a model with no price, its cost unknown. */
  usd: number | null;
}

/** An hour's calls of one node to one model. */
interface Bucket extends CallUsage {
  hour: number;
  node: string;
  model: string;
  calls: number;
  unpriced: number;
  usd: number;
}

/** A money amount in words: `$0.42`, `$0.0031` below a cent, `$0`. */
export function dollars(usd: number): string {
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** An amount, and the calls whose cost is unknown: `$0.42 + 2 unpriced`. */
const costText = (usd: number, unpriced: number): string =>
  unpriced === 0 ? dollars(usd) : `${dollars(usd)} + ${unpriced} unpriced`;

const counts = {
  calls: z.number().describe('Calls'),
  cost: z.string().describe('Cost'),
  usd: z.number().describe('USD'),
  unpriced: z.number().describe('Calls of no price'),
  inputTokens: z.number().describe('Input'),
  outputTokens: z.number().describe('Output'),
  cacheWriteTokens: z.number().describe('Cache write'),
  cacheReadTokens: z.number().describe('Cache read'),
};

/** The `status` read of a model connector: the last 24 hours. */
export const spendStatus = z.object({
  ...counts,
  since: z.number().describe('Since (ms)'),
  byNode: z.array(z.object({ node: z.string().describe('Node'), ...counts })).describe('By node'),
  byModel: z
    .array(z.object({ model: z.string().describe('Model'), ...counts }))
    .describe('By model'),
});
export type SpendStatus = z.infer<typeof spendStatus>;

/** On its card: `Last 24 h — Cost: $0.42 · Calls: 14`. */
export const SPEND_WIDGET: Widget = {
  show: 'keyValue',
  read: 'status',
  label: 'Last 24 h',
  fields: ['cost', 'calls'],
};

const COLUMNS = [
  'calls',
  'cost',
  'inputTokens',
  'outputTokens',
  'cacheWriteTokens',
  'cacheReadTokens',
];

/** Its page: the last 24 hours in full, by calling node and by model. */
export const SPEND_PAGE: WidgetPage = {
  title: 'Spend',
  sections: [
    { show: 'keyValue', read: 'status', label: 'Last 24 h', fields: ['cost', 'calls', 'unpriced'] },
    { show: 'table', read: 'status', path: 'byNode', columns: ['node', ...COLUMNS] },
    { show: 'table', read: 'status', path: 'byModel', columns: ['model', ...COLUMNS] },
  ],
};

type Row = Omit<z.infer<(typeof spendStatus.shape.byNode)['element']>, 'node'>;

const zero = (): Row => ({
  calls: 0,
  cost: '$0',
  usd: 0,
  unpriced: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
});

function add(row: Row, b: Bucket): void {
  row.calls += b.calls;
  row.usd += b.usd;
  row.unpriced += b.unpriced;
  row.inputTokens += b.inputTokens;
  row.outputTokens += b.outputTokens;
  row.cacheWriteTokens += b.cacheWriteTokens;
  row.cacheReadTokens += b.cacheReadTokens;
  row.cost = costText(row.usd, row.unpriced);
}

/**
 * The last 24 hours of a model connector's calls, by the hour, in its store: each call counted in
 * its hour's bucket of its node and model, the buckets out of the window dropped as it is written.
 * The window is the hours that overlap the last 24: up to 25 hours of calls.
 */
export class SpendLedger {
  private readonly store: Store;
  private readonly clock: Clock;
  private buckets: Bucket[];

  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
    const kept = store.read<{ buckets?: Bucket[] }>(SPEND_DOC)?.buckets;
    this.buckets = Array.isArray(kept) ? kept : [];
  }

  /** The start of the earliest hour in the window, now: the hour 24 hours ago falls in. */
  private since(): number {
    return Math.floor((this.clock.now() - WINDOW_MS) / HOUR_MS) * HOUR_MS;
  }

  private current(): Bucket[] {
    const since = this.since();
    return this.buckets.filter((b) => b.hour >= since);
  }

  /** Counts a call, now, and keeps the window. */
  add(call: CallRecord): void {
    const hour = Math.floor(this.clock.now() / HOUR_MS) * HOUR_MS;
    this.buckets = this.current();
    let b = this.buckets.find(
      (x) => x.hour === hour && x.node === call.node && x.model === call.model
    );
    if (b === undefined) {
      b = {
        hour,
        node: call.node,
        model: call.model,
        calls: 0,
        unpriced: 0,
        usd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      this.buckets.push(b);
    }
    b.calls += 1;
    if (call.usd === null) b.unpriced += 1;
    else b.usd += call.usd;
    b.inputTokens += call.inputTokens;
    b.outputTokens += call.outputTokens;
    b.cacheWriteTokens += call.cacheWriteTokens;
    b.cacheReadTokens += call.cacheReadTokens;
    this.store.write(SPEND_DOC, { buckets: this.buckets });
  }

  /** The window's totals, and by node and by model, the dearest first. */
  status(): SpendStatus {
    const total = zero();
    const nodes = new Map<string, Row>();
    const models = new Map<string, Row>();
    for (const b of this.current()) {
      add(total, b);
      for (const [map, key] of [
        [nodes, b.node],
        [models, b.model],
      ] as const) {
        let row = map.get(key);
        if (row === undefined) map.set(key, (row = zero()));
        add(row, b);
      }
    }
    const order = (a: Row, b: Row): number => b.usd - a.usd || b.calls - a.calls;
    return {
      ...total,
      since: this.since(),
      byNode: [...nodes].map(([node, r]) => ({ node, ...r })).sort(order),
      byModel: [...models].map(([model, r]) => ({ model, ...r })).sort(order),
    };
  }

  /** The window's spend, for the Costs sheet (`Instance.cost`). */
  spend(): Spend {
    const s = this.status();
    return { usd: s.usd, calls: s.calls, unpriced: s.unpriced };
  }
}
