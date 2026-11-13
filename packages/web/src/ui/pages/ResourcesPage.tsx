/**
 * The nodes by what they cost (docs/bot-os.md D77), to find the top offenders, a script or a
 * module's plugin alike: each node's time in its handlers (where the core hands it events,
 * messages and timers), a script's worker's CPU and heap and its handlers' calls, since the start,
 * from `GET /status`. A table sorted by its cost, most first, by any column with a click; the top
 * three marked, each with its share of the whole.
 */
import { useState } from 'react';
import type { NodeCost, PluginControl } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

/** A node's row: its cost, the CPU of its worker or its handlers' time, and the rest. */
export interface CostRow {
  id: string;
  plugin: string;
  state: string;
  runs: string;
  /** What it is ranked by, in ms: a worker's CPU, or its handlers' time. */
  costMs: number;
  calls: number;
  avgMs: number;
  maxMs: number;
  heapMb?: number;
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
      costMs: worker ? (own.cpuMs ?? 0) : c.dispatch.ms,
      calls,
      avgMs: calls === 0 ? 0 : ms / calls,
      maxMs: own?.maxMs ?? c.dispatch.maxMs,
      ...(own?.heapBytes === undefined ? {} : { heapMb: own.heapBytes / 2 ** 20 }),
    };
  });
}

type Key = Exclude<keyof CostRow, 'state'>;
const COLUMNS: { key: Key; title: string; help: string }[] = [
  { key: 'id', title: 'Node', help: 'The node, and its plugin' },
  { key: 'runs', title: 'Runs', help: 'In a worker thread of its own (a script), or in process' },
  {
    key: 'costMs',
    title: 'Cost',
    help: 'A worker’s CPU time; otherwise the time in its handlers, as the core hands it events, messages and timers',
  },
  { key: 'calls', title: 'Calls', help: 'Its handlers’ calls' },
  { key: 'avgMs', title: 'Avg', help: 'A call’s time, on average' },
  { key: 'maxMs', title: 'Max', help: 'The longest call' },
  { key: 'heapMb', title: 'Heap', help: 'A worker’s heap in use' },
];

const ms = (v: number): string =>
  v === 0
    ? '0'
    : v < 1
      ? `${v.toFixed(2)} ms`
      : v < 1000
        ? `${v.toFixed(1)} ms`
        : `${(v / 1000).toFixed(2)} s`;

export function ResourcesPage({ loggedOut }: PageProps) {
  const status = useLoad(() => api<{ plugins: PluginControl[] }>('/status'), loggedOut);
  const [sort, setSort] = useState<{ key: Key; down: boolean }>({ key: 'costMs', down: true });
  if (status.data === undefined) return <p className="muted">{status.error ?? 'Loading…'}</p>;
  const rows = costRows(status.data.plugins);
  if (rows.length === 0) return <p className="muted">No node runs.</p>;
  const total = rows.reduce((t, r) => t + r.costMs, 0);
  const top = new Set(
    [...rows]
      .filter((r) => r.costMs > 0)
      .sort((a, b) => b.costMs - a.costMs)
      .slice(0, 3)
      .map((r) => r.id)
  );
  rows.sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    const order =
      typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? ''))
        : (x ?? -1) - (y ?? -1);
    return sort.down ? -order : order;
  });
  return (
    <div className="resources">
      <p className="muted small">
        Since the start. A script’s cost is its worker’s CPU time; any other node’s, the time its
        handlers take as the core hands it events, messages and timers. The top three are marked.
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
              const share = total === 0 ? 0 : r.costMs / total;
              return (
                <tr key={r.id} className={top.has(r.id) ? 'top-cost' : undefined}>
                  <td>
                    {top.has(r.id) ? (
                      <span className="badge failed" title="among the top three">
                        top
                      </span>
                    ) : null}{' '}
                    <code>{r.id}</code> <span className="muted small">{r.plugin}</span>
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
                    {total === 0 ? null : (
                      <span className="muted small"> {Math.round(share * 100)}%</span>
                    )}
                  </td>
                  <td>{r.calls}</td>
                  <td>{ms(r.avgMs)}</td>
                  <td>{ms(r.maxMs)}</td>
                  <td>{r.heapMb === undefined ? '' : `${r.heapMb.toFixed(1)} MB`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
