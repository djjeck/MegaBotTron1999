/**
 * What each node costs (docs/bot-os.md D77, D111), to find the top offenders, a script or a
 * module's plugin alike: each node's time in its handlers (where the core hands it events,
 * messages and timers), a script's worker's CPU and heap and its handlers' calls, since the start,
 * from `GET /status`, which the editor reads already. Each node's own in its panel (`CostLine`),
 * with its share of the whole and whether it is among the top three; all of them in the editor's
 * **Costs** side sheet (`CostTable`), a table sorted by its cost, most first, by any column with a
 * click, the top three marked, each node's name selecting it. A model connector's money over the
 * last 24 hours is beside its time (`own.spend`, D117): what it spent, and its calls. The reads
 * served of it to a page, a view or a panel (`reads`, D172) are in its cost, the core's main
 * thread's time either way, and in a column of their own: how many, their time, their bytes.
 */
import { useState } from 'react';
import type { NodeCost, PluginControl, Spend } from '#src/ui/api.ts';

/** A node's row: its cost, the CPU of its worker or its handlers' time, and the rest. */
export interface CostRow {
  id: string;
  plugin: string;
  state: string;
  runs: string;
  /** What it is ranked by, in ms: a worker's CPU, or its handlers' time; and its reads' (D172). */
  costMs: number;
  calls: number;
  avgMs: number;
  maxMs: number;
  heapMb?: number;
  /** The reads served of it (D172): how many, their time, their answers' bytes. */
  reads: number;
  readMs: number;
  readBytes: number;
  /** A model connector's money over the last 24 hours (D117). */
  spend?: Spend;
}

/** Each node's row, from its cost as `GET /status` gives it. */
export function costRows(plugins: readonly PluginControl[]): CostRow[] {
  return plugins.map((p) => {
    const c: NodeCost = p.cost ?? { dispatch: { calls: 0, ms: 0, maxMs: 0 } };
    const own = c.own;
    const worker = own?.runs === 'worker';
    const calls = own?.calls ?? c.dispatch.calls;
    const ms = own?.ms ?? c.dispatch.ms;
    return {
      id: p.id,
      plugin: p.plugin,
      state: p.state,
      runs: worker ? 'worker' : 'in process',
      costMs: (worker ? (own.cpuMs ?? 0) : c.dispatch.ms) + (c.reads?.ms ?? 0),
      calls,
      avgMs: calls === 0 ? 0 : ms / calls,
      maxMs: own?.maxMs ?? c.dispatch.maxMs,
      ...(own?.heapBytes === undefined ? {} : { heapMb: own.heapBytes / 2 ** 20 }),
      reads: c.reads?.calls ?? 0,
      readMs: c.reads?.ms ?? 0,
      readBytes: c.reads?.bytes ?? 0,
      ...(own?.spend === undefined ? {} : { spend: own.spend }),
    };
  });
}

/** A node's cost among the others': its row, its share of the whole, and whether it is in the top three. */
export interface Ranked {
  row: CostRow;
  share: number;
  top: boolean;
}

/** Each node's row, its share of the whole and whether it is among the top three, by id. */
export function ranking(plugins: readonly PluginControl[]): Map<string, Ranked> {
  const rows = costRows(plugins);
  const total = rows.reduce((t, r) => t + r.costMs, 0);
  const top = new Set(
    [...rows]
      .filter((r) => r.costMs > 0)
      .sort((a, b) => b.costMs - a.costMs)
      .slice(0, 3)
      .map((r) => r.id)
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { row, share: total === 0 ? 0 : row.costMs / total, top: top.has(row.id) },
    ])
  );
}

/** A node's cost, in a line of its panel: what it is ranked by, its share, and its calls. */
export function CostLine({ cost }: { cost: Ranked }) {
  const { row, share, top } = cost;
  return (
    <>
      {top ? (
        <span className="badge failed" title="among the top three">
          top
        </span>
      ) : null}{' '}
      {ms(row.costMs)} {row.runs === 'worker' ? 'of its worker’s CPU' : 'in its handlers'}
      {share === 0 ? null : <span className="muted"> ({Math.round(share * 100)}% of all)</span>}
      <span className="muted small">
        {' '}
        · {row.calls} call{row.calls === 1 ? '' : 's'}, {ms(row.avgMs)} on average, at most{' '}
        {ms(row.maxMs)}
        {row.heapMb === undefined ? '' : ` · ${row.heapMb.toFixed(1)} MB heap`}
        {row.reads === 0 ? '' : ` · ${readsText(row)}`}; since the start
      </span>
      {row.spend === undefined ? null : (
        <>
          <br />
          <span className="badge model">$</span> {spent(row.spend)} over the last 24 hours
        </>
      )}
    </>
  );
}

/** A node's reads served, in words: `120 reads, 340 ms, 1.2 MB` (D172). */
export function readsText(r: Pick<CostRow, 'reads' | 'readMs' | 'readBytes'>): string {
  return `${r.reads} read${r.reads === 1 ? '' : 's'}, ${ms(r.readMs)}, ${bytes(r.readBytes)}`;
}

/** A size in words: `512 B`, `3.4 kB`, `1.2 MB`. */
export const bytes = (v: number): string =>
  v < 1000 ? `${v} B` : v < 1e6 ? `${(v / 1000).toFixed(1)} kB` : `${(v / 1e6).toFixed(1)} MB`;

/** A model's money in words: `$0.42, 14 calls`, and the calls of no price, whose cost is unknown. */
export function spent(s: Spend): string {
  const usd = s.usd === 0 ? '$0' : s.usd < 0.01 ? `$${s.usd.toFixed(4)}` : `$${s.usd.toFixed(2)}`;
  const calls = `${s.calls} call${s.calls === 1 ? '' : 's'}`;
  return `${usd}, ${calls}${s.unpriced === 0 ? '' : ` (${s.unpriced} of no price, cost unknown)`}`;
}

type Key = Exclude<keyof CostRow, 'state'>;
const COLUMNS: { key: Key; title: string; help: string }[] = [
  { key: 'id', title: 'Node', help: 'The node, and its plugin' },
  { key: 'runs', title: 'Runs', help: 'In a worker thread of its own (a script), or in process' },
  {
    key: 'costMs',
    title: 'Cost',
    help: 'A script’s CPU time running its own code, in its worker; otherwise the time in its handlers, as the core hands it events, messages and timers; and the time of the reads served of it',
  },
  {
    key: 'readMs',
    title: 'Reads',
    help: 'The reads served of it to a page, a view or a panel: how many, their time, their answers’ size',
  },
  { key: 'calls', title: 'Calls', help: 'Its handlers’ calls' },
  { key: 'avgMs', title: 'Avg', help: 'A call’s time, on average' },
  { key: 'maxMs', title: 'Max', help: 'The longest call' },
  { key: 'heapMb', title: 'Heap', help: 'A worker’s heap in use' },
  { key: 'spend', title: 'Spent', help: 'A model’s money over the last 24 hours, and its calls' },
];

export const ms = (v: number): string =>
  v === 0
    ? '0'
    : v < 1
      ? `${v.toFixed(2)} ms`
      : v < 1000
        ? `${v.toFixed(1)} ms`
        : `${(v / 1000).toFixed(2)} s`;

/** The nodes by cost, most first, sortable by any column; a node's name selects it. */
export function CostTable(props: {
  plugins: readonly PluginControl[];
  select: (id: string) => void;
}) {
  const [sort, setSort] = useState<{ key: Key; down: boolean }>({ key: 'costMs', down: true });
  const ranked = ranking(props.plugins);
  const rows = [...ranked.values()].map((r) => r.row);
  if (rows.length === 0) return <p className="muted">No node runs.</p>;
  rows.sort((a, b) => {
    const x = sort.key === 'spend' ? a.spend?.usd : a[sort.key];
    const y = sort.key === 'spend' ? b.spend?.usd : b[sort.key];
    const order =
      typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? ''))
        : (x ?? -1) - (y ?? -1);
    return sort.down ? -order : order;
  });
  return (
    <div className="resources">
      <p className="muted small">
        Since the start. A script’s cost is the CPU its worker spent running its code; any other
        node’s, the time its handlers take as the core hands it events, messages and timers; each
        adds the time of the reads served of it to pages and views. The top three are marked.
      </p>
      <div className="table-scroll">
        <table aria-label="nodes by cost">
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.help}
                    aria-sort={on ? (sort.down ? 'descending' : 'ascending') : 'none'}
                  >
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        setSort({
                          key: c.key,
                          down: on ? !sort.down : c.key !== 'id' && c.key !== 'runs',
                        })
                      }
                    >
                      {c.title}
                      {on ? (sort.down ? ' ▾' : ' ▴') : ''}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const { share, top } = ranked.get(r.id) as Ranked;
              return (
                <tr key={r.id} className={top ? 'top-cost' : undefined}>
                  <td>
                    {top ? (
                      <span className="badge failed" title="among the top three">
                        top
                      </span>
                    ) : null}{' '}
                    <button
                      type="button"
                      className="link"
                      title={`Select ${r.id}`}
                      onClick={() => props.select(r.id)}
                    >
                      <code>{r.id}</code>
                    </button>{' '}
                    <span className="muted small">{r.plugin}</span>
                    {r.state === 'running' ? null : (
                      <span className="muted small"> ({r.state})</span>
                    )}
                  </td>
                  <td>{r.runs}</td>
                  <td>
                    <span className="cost-bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(share * 100)}%` }} />
                    </span>{' '}
                    {ms(r.costMs)}
                    {share === 0 ? null : (
                      <span className="muted small"> {Math.round(share * 100)}%</span>
                    )}
                  </td>
                  <td>{r.reads === 0 ? '' : readsText(r)}</td>
                  <td>{r.calls}</td>
                  <td>{ms(r.avgMs)}</td>
                  <td>{ms(r.maxMs)}</td>
                  <td>{r.heapMb === undefined ? '' : `${r.heapMb.toFixed(1)} MB`}</td>
                  <td>{r.spend === undefined ? '' : spent(r.spend)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
