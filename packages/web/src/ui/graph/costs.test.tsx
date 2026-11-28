// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginControl } from '#src/ui/api.ts';
import type { Ranked } from './Costs.tsx';
import { bytes, CostLine, costRows, CostTable, ranking, readsText } from './Costs.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const node = (id: string, cost?: PluginControl['cost'], state = 'running'): PluginControl => ({
  id,
  plugin: id === 'examine' ? 'script' : id,
  description: id,
  kinds: ['stats'],
  state,
  settings: {},
  reads: [],
  actions: [],
  ...(cost === undefined ? {} : { cost }),
});

const PLUGINS = [
  node('quest', { dispatch: { calls: 100, ms: 12, maxMs: 0.5 } }),
  node('tg', { dispatch: { calls: 40, ms: 0.4, maxMs: 0.05 } }),
  node('examine', {
    dispatch: { calls: 10, ms: 0.1, maxMs: 0.02 },
    own: {
      runs: 'worker',
      calls: 10,
      errors: 0,
      ms: 50,
      maxMs: 9,
      cpuMs: 1500,
      heapBytes: 8 * 2 ** 20,
    },
  }),
  node('quiet', undefined, 'disabled'),
  node('slow', { dispatch: { calls: 1, ms: 2500, maxMs: 2500 } }),
];

describe('the reads served of a node (D172)', () => {
  it('adds their time to its cost, and shows them in a column and its line', () => {
    const plugins = [
      node('shop', {
        dispatch: { calls: 2, ms: 1, maxMs: 1 },
        reads: { calls: 120, ms: 3000, maxMs: 90, bytes: 1_250_000 },
      }),
      node('quest', { dispatch: { calls: 100, ms: 12, maxMs: 0.5 } }),
    ];
    const rows = costRows(plugins);
    expect(rows[0]).toMatchObject({ costMs: 3001, reads: 120, readMs: 3000, readBytes: 1_250_000 });
    expect(readsText({ reads: 1, readMs: 0.5, readBytes: 512 })).toBe('1 read, 0.50 ms, 512 B');
    render(<CostTable plugins={plugins} select={() => {}} />);
    const table = screen.getByRole('table', { name: 'nodes by cost' });
    expect(table.textContent).toContain('120 reads, 3.00 s, 1.3 MB');
    fireEvent.click(within(table).getByRole('button', { name: 'Reads' }));
    expect(within(table).getAllByRole('row')[1]?.querySelector('code')?.textContent).toBe('shop');
    cleanup();
    render(<CostLine cost={ranking(plugins).get('shop') as Ranked} />);
    expect(document.body.textContent).toContain('120 reads, 3.00 s, 1.3 MB');
    expect(bytes(3400)).toBe('3.4 kB');
  });
});

describe('the nodes by cost (D77)', () => {
  it('ranks a worker by its CPU, any other by its handlers’ time', () => {
    const rows = costRows(PLUGINS);
    expect(rows.find((r) => r.id === 'examine')).toEqual({
      id: 'examine',
      plugin: 'script',
      state: 'running',
      runs: 'worker',
      costMs: 1500,
      calls: 10,
      avgMs: 5,
      maxMs: 9,
      heapMb: 8,
      reads: 0,
      readMs: 0,
      readBytes: 0,
    });
    expect(rows.find((r) => r.id === 'quiet')).toMatchObject({ costMs: 0, calls: 0, avgMs: 0 });
  });

  it('lists them most costly first, the top three marked, sorted by any column', () => {
    const select = vi.fn();
    render(<CostTable plugins={PLUGINS} select={select} />);
    const table = screen.getByRole('table', { name: 'nodes by cost' });
    const ids = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.querySelector('code')?.textContent);
    expect(ids()).toEqual(['slow', 'examine', 'quest', 'tg', 'quiet']);
    expect(within(table).getAllByText('top')).toHaveLength(3);
    expect(table.textContent).toContain('2.50 s');
    expect(table.textContent).toContain('8.0 MB');
    fireEvent.click(within(table).getByRole('button', { name: 'Calls' }));
    expect(ids()).toEqual(['quest', 'tg', 'examine', 'slow', 'quiet']);
    fireEvent.click(within(table).getByRole('button', { name: /Calls/u }));
    expect(ids()[0]).toBe('quiet');
    fireEvent.click(within(table).getByRole('button', { name: 'Node' }));
    expect(ids()).toEqual(['examine', 'quest', 'quiet', 'slow', 'tg']);
    fireEvent.click(within(table).getByRole('button', { name: 'Heap' }));
    expect(ids()[0]).toBe('examine');
    // A node's name selects it, on the map.
    fireEvent.click(within(table).getByRole('button', { name: 'quest' }));
    expect(select).toHaveBeenCalledWith('quest');
  });

  it('says a node’s cost in a line: its share, its rank and its calls', () => {
    const ranked = ranking(PLUGINS);
    render(<CostLine cost={ranked.get('examine')!} />);
    expect(screen.getByText('top')).toBeDefined();
    expect(document.body.textContent).toContain('1.50 s of its worker’s CPU');
    expect(document.body.textContent).toContain('(37% of all)');
    expect(document.body.textContent).toContain('10 calls, 5.0 ms on average, at most 9.0 ms');
    expect(document.body.textContent).toContain('8.0 MB heap');
    cleanup();
    render(<CostLine cost={ranked.get('quiet')!} />);
    expect(screen.queryByText('top')).toBeNull();
    expect(document.body.textContent).toContain('0 in its handlers');
    expect(document.body.textContent).not.toContain('% of all');
    cleanup();
    render(<CostLine cost={ranked.get('slow')!} />);
    expect(document.body.textContent).toContain('1 call,');
  });

  it('says so when no node runs, and marks none when none costs', () => {
    render(<CostTable plugins={[]} select={vi.fn()} />);
    expect(screen.getByText('No node runs.')).toBeDefined();
    cleanup();
    render(
      <CostTable
        plugins={[node('a', { dispatch: { calls: 0, ms: 0, maxMs: 0 } })]}
        select={vi.fn()}
      />
    );
    const table = screen.getByRole('table', { name: 'nodes by cost' });
    expect(within(table).queryByText('top')).toBeNull();
  });
});
