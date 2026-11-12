// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphHistoryView, GraphVersionView } from '#src/ui/api.ts';
import { fakeApi } from '#test/fake-api.ts';
import { GraphHistoryPage, GraphTextPage } from './GraphHistoryPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loggedOut = vi.fn();
const NEWEST = '2026-11-03T10-00-00.000Z';
const GOOD = '2026-11-02T10-00-00.000Z';
const FIRST = '2026-11-01T10-00-00.000Z';
const iso = (id: string): string => id.replace(/T(\d\d)-(\d\d)-/u, 'T$1:$2:');
const when = (id: string): string => new Date(iso(id)).toLocaleString();

const HISTORY: GraphHistoryView = {
  versions: [
    {
      id: NEWEST,
      time: iso(NEWEST),
      source: 'rollback',
      restores: FIRST,
      summary: '− node examine',
      start: { result: 'refused', at: iso(NEWEST), problems: ['node x: bad'] },
    },
    {
      id: GOOD,
      time: iso(GOOD),
      source: 'save',
      summary: '+ node examine; ~ node x: config',
      start: { result: 'ran', at: iso(GOOD) },
    },
    { id: FIRST, time: iso(FIRST), source: 'migrated', summary: '+ node x' },
    { id: 'gone', time: 'not a time', source: 'rollback', restores: 'pruned', summary: 'x' },
  ],
  current: NEWEST,
  lastGood: GOOD,
  keep: { days: 7, latest: 5 },
};

const version = (id: string, more: Partial<GraphVersionView> = {}): GraphVersionView => ({
  ...(HISTORY.versions.find((v) => v.id === id) as GraphVersionView),
  graph: { version: 2, nodes: [], edges: [] },
  current: id === NEWEST,
  diff: {
    nodes: { added: ['examine'], removed: [], changed: [{ id: 'x', fields: ['config'] }] },
    edges: { added: [], removed: [], changed: [{ from: 'a.out', to: 'b.in', fields: ['reads'] }] },
  },
  text: 'nodes:\n  examine (p)\n  x (p)\n    config.k: 2\nedges:',
  currentText: 'nodes:\n  x (p)\n    config.k: 1\nedges:',
  lines: [
    { op: ' ', text: 'nodes:' },
    { op: '+', text: '  examine (p)' },
    { op: ' ', text: '  x (p)' },
    { op: '-', text: '    config.k: 1' },
    { op: '+', text: '    config.k: 2' },
    { op: ' ', text: 'edges:' },
  ],
  ...more,
});

describe('the graph history', () => {
  it('lists the versions newest first, with their start and the last good one marked', async () => {
    fakeApi({ 'GET /graph/history': [200, HISTORY] });
    render(<GraphHistoryPage loggedOut={loggedOut} />);
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      `${when(NEWEST)}currentrollback to ${when(FIRST)}: − node examinerefusedOpen`,
      `${when(GOOD)}last good+ node examine; ~ node x: configranOpen`,
      `${when(FIRST)}from before the history: + node xnever startedOpen`,
      'not a timerollback to pruned: xnever startedOpen',
    ]);
    expect(within(rows[0] as HTMLElement).getByText('refused').title).toBe('node x: bad');
  });

  it('opens a version: its changes, its line diff, and its rollback, confirmed, then a restart', async () => {
    let restarted = false;
    const api = fakeApi({
      'GET /graph/history': [200, HISTORY],
      [`GET /graph/history/${GOOD}`]: [200, version(GOOD)],
      [`GET /graph/history/${NEWEST}`]: [
        200,
        version(NEWEST, { problems: [{ text: 'node x: bad' }] }),
      ],
      [`POST /graph/history/${GOOD}/rollback`]: [200, { rolledBack: true }],
      'POST /restart': () => {
        restarted = true;
        return [200, { restarting: true }];
      },
      'GET /session': () => [200, { authenticated: true, boot: restarted ? 'b2' : 'b1' }],
    });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.resolve() } });
    const done = vi.fn();
    render(<GraphHistoryPage loggedOut={loggedOut} restarted={done} />);
    // The current one: refused now, and no rollback to it.
    fireEvent.click(
      await screen.findByRole('button', { name: `Open the version of ${when(NEWEST)}` })
    );
    let opened = await screen.findByRole('region', { name: `version of ${when(NEWEST)}` });
    expect(within(opened).getByRole('alert').textContent).toContain('node x: bad');
    expect(
      (within(opened).getByRole('button', { name: 'Roll back to this' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(within(opened).getByText('It is the current graph.')).toBeDefined();
    // Another: what rolling back would change, in two tabs.
    fireEvent.click(screen.getByRole('button', { name: `Open the version of ${when(GOOD)}` }));
    opened = await screen.findByRole('region', { name: `version of ${when(GOOD)}` });
    const tabs = within(opened).getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Changes', 'true'],
      ['As text', 'false'],
    ]);
    const panel = within(opened).getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'Nodes added' })).toBeDefined();
    expect(within(panel).getByText('x: config')).toBeDefined();
    expect(within(panel).getByText('a.out → b.in: reads')).toBeDefined();
    fireEvent.click(tabs[1] as HTMLElement);
    const diff = within(opened).getByLabelText('line diff');
    expect([...diff.querySelectorAll('.line')].map((l) => [l.className, l.textContent])).toEqual([
      ['line kept', '  nodes:\n'],
      ['line added', '+   examine (p)\n'],
      ['line kept', '    x (p)\n'],
      ['line removed', '−     config.k: 1\n'],
      ['line added', '+     config.k: 2\n'],
      ['line kept', '  edges:\n'],
    ]);
    expect(within(opened).getByLabelText('this version as text').textContent).toBe(
      version(GOOD).text
    );
    // Rolled back once confirmed, the diff repeated; then the instance restarts.
    fireEvent.click(within(opened).getByRole('button', { name: 'Roll back to this' }));
    let confirm = await screen.findByRole('dialog', { name: 'roll back' });
    expect(within(confirm).getByText('a.out → b.in: reads')).toBeDefined();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'roll back' })).toBeNull();
    expect(api.calls).not.toContain(`POST /graph/history/${GOOD}/rollback {}`);
    fireEvent.click(within(opened).getByRole('button', { name: 'Roll back to this' }));
    confirm = await screen.findByRole('dialog', { name: 'roll back' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Roll back and restart' }));
    expect(await screen.findByRole('dialog', { name: 'restarting' })).toBeDefined();
    expect(api.calls).toContain(`POST /graph/history/${GOOD}/rollback {}`);
    await waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('says why a version does not open, a rollback is refused, or a restart fails', async () => {
    fakeApi({
      'GET /graph/history': [200, HISTORY],
      [`GET /graph/history/${GOOD}`]: [
        200,
        version(GOOD, {
          diff: {
            nodes: { added: [], removed: [], changed: [] },
            edges: { added: [], removed: [], changed: [] },
          },
          lines: [{ op: ' ', text: 'nodes:' }],
        }),
      ],
      [`POST /graph/history/${GOOD}/rollback`]: [409, { error: 'it is the current graph already' }],
    });
    render(<GraphHistoryPage loggedOut={loggedOut} />);
    fireEvent.click(
      await screen.findByRole('button', { name: `Open the version of ${when(FIRST)}` })
    );
    expect(await screen.findByText(`${FIRST}: not found`)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: `Open the version of ${when(GOOD)}` }));
    const opened = await screen.findByRole('region', { name: `version of ${when(GOOD)}` });
    expect(
      within(opened).getByText('This version is the same as the current graph.')
    ).toBeDefined();
    fireEvent.click(within(opened).getByRole('tab', { name: 'As text' }));
    expect(within(opened).getByText('The two print the same.')).toBeDefined();
    fireEvent.click(within(opened).getByRole('button', { name: 'Roll back to this' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'roll back' })).getByRole('button', {
        name: 'Roll back and restart',
      })
    );
    expect(
      await screen.findByText('Not rolled back: it is the current graph already')
    ).toBeDefined();
    // Closed, and opened again then closed by its button.
    fireEvent.click(within(opened).getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('region', { name: `version of ${when(GOOD)}` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Open the version of ${when(GOOD)}` }));
    await screen.findByRole('region', { name: `version of ${when(GOOD)}` });
    fireEvent.click(screen.getByRole('button', { name: `Open the version of ${when(GOOD)}` }));
    expect(screen.queryByRole('region', { name: `version of ${when(GOOD)}` })).toBeNull();
  });

  it('restarts without the app, and says when the restart is refused', async () => {
    let restarts = 0;
    fakeApi({
      'GET /graph/history': [200, HISTORY],
      [`GET /graph/history/${GOOD}`]: [200, version(GOOD)],
      [`POST /graph/history/${GOOD}/rollback`]: [200, { rolledBack: true }],
      'POST /restart': () =>
        restarts++ === 0 ? [500, { error: 'no' }] : [200, { restarting: true }],
      'GET /session': () => [200, { authenticated: true, boot: restarts > 1 ? 'b2' : 'b1' }],
    });
    render(<GraphHistoryPage loggedOut={loggedOut} />);
    const rollBack = async (open = true): Promise<void> => {
      if (open)
        fireEvent.click(
          await screen.findByRole('button', { name: `Open the version of ${when(GOOD)}` })
        );
      const opened = await screen.findByRole('region', { name: `version of ${when(GOOD)}` });
      fireEvent.click(within(opened).getByRole('button', { name: 'Roll back to this' }));
      fireEvent.click(
        within(await screen.findByRole('dialog', { name: 'roll back' })).getByRole('button', {
          name: 'Roll back and restart',
        })
      );
    };
    await rollBack();
    expect(
      await screen.findByText('Rolled back, but not restarted: no. Apply it from the graph editor.')
    ).toBeDefined();
    // The version stays open, to try again.
    await rollBack(false);
    expect(
      await screen.findByText(/^The instance restarted/u, {}, { timeout: 4000 })
    ).toBeDefined();
  });

  it('says when nothing was applied yet, or the history does not load', async () => {
    fakeApi({ 'GET /graph/history': [200, { versions: [], keep: { days: 7, latest: 5 } }] });
    render(<GraphHistoryPage loggedOut={loggedOut} />);
    expect(await screen.findByText('No graph has been applied yet.')).toBeDefined();
    cleanup();
    fakeApi({ 'GET /graph/history': [500, { error: 'the disk is gone' }] });
    render(<GraphHistoryPage loggedOut={loggedOut} />);
    expect(await screen.findByText('the disk is gone')).toBeDefined();
  });
});

describe('the graph as text', () => {
  it('shows the saved graph printed, or why not', async () => {
    fakeApi({ 'GET /graph/file': [200, { exists: true, differs: false, text: 'nodes:\nedges:' }] });
    render(<GraphTextPage loggedOut={loggedOut} />);
    expect((await screen.findByLabelText('the saved graph as text')).textContent).toBe(
      'nodes:\nedges:'
    );
    cleanup();
    fakeApi({
      'GET /graph/file': [200, { exists: true, differs: true, error: 'graph.json is not JSON' }],
    });
    render(<GraphTextPage loggedOut={loggedOut} />);
    expect(await screen.findByText('graph.json is not JSON')).toBeDefined();
    cleanup();
    fakeApi({ 'GET /graph/file': [500, { error: 'the disk is gone' }] });
    render(<GraphTextPage loggedOut={loggedOut} />);
    expect(await screen.findByText('the disk is gone')).toBeDefined();
  });
});
