// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginControl } from '#src/ui/api.ts';
import { fakeApi } from '#test/fake-api.ts';
import { costRows, ResourcesPage } from './ResourcesPage.tsx';

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
    });
    expect(rows.find((r) => r.id === 'quiet')).toMatchObject({ costMs: 0, calls: 0, avgMs: 0 });
  });

  it('lists them most costly first, the top three marked, sorted by any column', async () => {
    fakeApi({ 'GET /status': [200, { off: false, plugins: PLUGINS }] });
    render(<ResourcesPage loggedOut={vi.fn()} />);
    const table = await screen.findByRole('table', { name: 'nodes by cost' });
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
  });

  it('says so when no node runs, or what failed', async () => {
    fakeApi({ 'GET /status': [200, { off: false, plugins: [] }] });
    render(<ResourcesPage loggedOut={vi.fn()} />);
    expect(await screen.findByText('No node runs.')).toBeDefined();
    cleanup();
    fakeApi({
      'GET /status': [
        200,
        { off: false, plugins: [node('a', { dispatch: { calls: 0, ms: 0, maxMs: 0 } })] },
      ],
    });
    render(<ResourcesPage loggedOut={vi.fn()} />);
    const table = await screen.findByRole('table', { name: 'nodes by cost' });
    expect(within(table).queryByText('top')).toBeNull();
  });
});
