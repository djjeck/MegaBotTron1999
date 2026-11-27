// @vitest-environment happy-dom
// A node's widget on its card and its page (D112): drawn from its plugin's declaration and its
// read's output alone.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemberView,
  NodeView,
  PluginControl,
  Status,
  Widget,
  WidgetPage,
} from '#src/ui/api.ts';
import { App, resolve } from '#src/ui/App.tsx';
import { NodePage } from '#src/ui/pages/NodePage.tsx';
import { fakeApi } from '#test/fake-api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { AVAILABLE, status, VIEW } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { nodeHeight, WIDGET_ROW } from './PluginNode.tsx';
import { WidgetLine, WidgetSection } from './Widget.tsx';
import { countOf, relative, timeOf, widgetLine, words } from './widget-text.ts';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restore();
});

const loggedOut = vi.fn();
const slow = { timeout: 5000 };

/** A made-up ledger's read: its schema's descriptions are the labels. */
const READS: MemberView[] = [
  {
    name: 'status',
    help: 'how it is',
    output: {
      type: 'object',
      properties: {
        gold: { type: 'number', description: 'Gold' },
        cap: { type: 'number' },
        who: { type: 'string' },
        next: { type: 'number', description: 'Next turn' },
        silver: { anyOf: [{ type: 'number', description: 'Silver' }, { type: 'null' }] },
        bank: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'In the bank' },
        bag: {
          type: 'array',
          items: {
            type: 'object',
            properties: { item: { type: 'string', description: 'Item' }, n: { type: 'number' } },
          },
        },
      },
    },
  },
];

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const OUT = {
  gold: 40,
  cap: 100,
  who: 'alice',
  next: NOW + 12 * 60_000 + 5_000,
  bag: [
    { item: 'rope', n: 1 },
    { item: 'lamp', n: 2 },
    { item: 'map', n: 1 },
    { item: 'key', n: 3 },
  ],
};

const line = (w: Widget, out: unknown = OUT): string => widgetLine(w, READS, out, NOW);

describe('a widget’s line on its card', () => {
  it('says each kind in a line, labelled by the section or its read’s schema', () => {
    expect(line({ show: 'keyValue', read: 'status', fields: ['gold', 'who'] })).toBe(
      'Gold: 40 · who: alice'
    );
    expect(
      line({
        show: 'keyValue',
        read: 'status',
        label: 'Ledger',
        fields: [{ path: 'who', label: 'Who' }],
      })
    ).toBe('Ledger — Who: alice');
    expect(line({ show: 'keyValue', read: 'status', path: 'gold' })).toBe('Gold: 40');
    expect(line({ show: 'keyValue', read: 'status' }, { a: 1 })).toBe('a: 1');
    expect(line({ show: 'counter', read: 'status', path: 'bag', label: 'Items' })).toBe('4 Items');
    expect(line({ show: 'counter', read: 'status', path: 'gold' })).toBe('40 Gold');
    expect(line({ show: 'counter', read: 'status' }, 7)).toBe('7');
    expect(line({ show: 'list', read: 'status', path: 'bag', item: 'item' })).toBe(
      'bag: rope, lamp, map +1'
    );
    expect(line({ show: 'list', read: 'status', path: 'bag', item: 'item' }, { bag: [] })).toBe(
      'bag: none'
    );
    expect(line({ show: 'table', read: 'status', path: 'bag', columns: ['item'] })).toBe('4 bag');
    expect(line({ show: 'table', read: 'status', columns: ['x'] }, [{ x: 1 }])).toBe('1 row');
    expect(line({ show: 'progress', read: 'status', path: 'gold', of: 'cap' })).toBe(
      'Gold: 40/100'
    );
    expect(line({ show: 'until', read: 'status', path: 'next' })).toBe('Next turn: in 12m 5s');
    expect(line({ show: 'until', read: 'status', path: 'next' }, {})).toBe('Next turn: —');
    // A word in place of a time, as it is (an attention that plans none, D138).
    expect(
      line({ show: 'until', read: 'status', path: 'next' }, { next: 'follows your play' })
    ).toBe('Next turn: follows your play');
    expect(
      line(
        { show: 'until', read: 'status', path: 'next' },
        { next: new Date(NOW - 3_600_000).toISOString() }
      )
    ).toBe('Next turn: 1h 0m ago');
    expect(relative(NOW, NOW)).toBe('in 0s');
    // A nullable value's label is its schema's, inside the null or around it.
    expect(
      line(
        { show: 'keyValue', read: 'status', fields: ['silver', 'bank', 'gold.x'] },
        { silver: 2, bank: true }
      )
    ).toBe('Silver: 2 · In the bank: true · x: —');
    expect(countOf('many')).toBeUndefined();
    expect(timeOf({})).toBeUndefined();
    expect(timeOf('not a date')).toBeUndefined();
    expect(words(null)).toBe('—');
  });

  it('draws a bar for an amount out of its total, and moves a time as the clock does', () => {
    vi.useFakeTimers({ now: NOW });
    const { rerender } = render(
      <WidgetLine
        widget={{ show: 'progress', read: 'status', path: 'gold', of: 'cap' }}
        reads={READS}
        value={OUT}
      />
    );
    const bar = screen.getByRole('progressbar', { name: 'Gold' }) as HTMLProgressElement;
    expect([bar.value, bar.max]).toEqual([40, 100]);
    rerender(
      <WidgetLine
        widget={{ show: 'until', read: 'status', path: 'next' }}
        reads={READS}
        value={OUT}
      />
    );
    expect(screen.getByLabelText('its widget').textContent).toBe('Next turn: in 12m 5s');
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByLabelText('its widget').textContent).toBe('Next turn: in 12m 0s');
  });

  it('makes its node’s card a line taller', () => {
    const view = VIEW.nodes.find((n) => n.id === 'actor-a') as NodeView;
    expect(nodeHeight({ ...view, widget: { show: 'counter', read: 'status' } })).toBe(
      nodeHeight(view) + WIDGET_ROW
    );
  });
});

describe('a section of a node’s page', () => {
  const section = (w: Widget, value: unknown = OUT, error?: string) =>
    render(<WidgetSection widget={w} reads={READS} value={value} error={error} />);

  it('draws each kind in full', () => {
    section({ show: 'keyValue', read: 'status', label: 'Ledger', fields: ['gold', 'who'] });
    const kv = screen.getByRole('region', { name: 'Ledger' });
    expect([...kv.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Gold', 'who']);
    expect([...kv.querySelectorAll('dd')].map((d) => d.textContent)).toEqual(['40', 'alice']);
    cleanup();
    section({ show: 'keyValue', read: 'status', path: 'who' });
    expect(screen.getByRole('region', { name: 'who' }).textContent).toBe('whoalice');
    cleanup();
    section({ show: 'counter', read: 'status', path: 'bag', label: 'Items' });
    expect(screen.getByRole('region', { name: 'Items' }).textContent).toBe('Items4');
    cleanup();
    section({ show: 'list', read: 'status', path: 'bag', item: 'item', max: 2 });
    const list = screen.getByRole('region', { name: 'bag' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((i) => i.textContent)
    ).toEqual(['rope', 'lamp']);
    expect(within(list).getByText('and 2 more')).toBeDefined();
    cleanup();
    section({ show: 'list', read: 'status', path: 'bag' }, { bag: [] });
    expect(screen.getByText('Nothing yet')).toBeDefined();
    cleanup();
    section({
      show: 'table',
      read: 'status',
      path: 'bag',
      columns: ['item', { path: 'n', label: 'How many' }],
    });
    const table = screen.getByRole('table', { name: 'bag' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
    ).toEqual(['Item', 'How many']);
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    cleanup();
    section({ show: 'table', read: 'status', path: 'bag', columns: ['item'] }, { bag: {} });
    expect(screen.getByText('Nothing yet')).toBeDefined();
    cleanup();
    section({ show: 'progress', read: 'status', path: 'gold', of: 50 });
    expect(screen.getByRole('progressbar', { name: 'Gold' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Gold' }).textContent).toContain('40 / 50');
    cleanup();
    vi.useFakeTimers({ now: NOW });
    section({ show: 'until', read: 'status', path: 'next' });
    expect(screen.getByRole('region', { name: 'Next turn' }).textContent).toBe(
      'Next turnin 12m 5s (2026-11-16 12:12 UTC)'
    );
    cleanup();
    section({ show: 'until', read: 'status', path: 'who' });
    expect(screen.getByRole('region', { name: 'who' }).textContent).toBe('whoalice');
  });

  it('says a value missing with a dash, and why its read did not answer', () => {
    section({ show: 'counter', read: 'status', path: 'gold' }, {});
    expect(screen.getByRole('region', { name: 'Gold' }).textContent).toBe('GoldNothing yet');
    cleanup();
    section({ show: 'counter', read: 'status', path: 'gold' }, undefined, 'ledger is not running');
    expect(screen.getByText('ledger is not running').className).toBe('error');
  });
});

/** The actor's view, declaring a widget and a page, and the live status giving the widget's value. */
const WIDGET: Widget = { show: 'counter', read: 'status', path: 'count', label: 'Counted' };
const PAGE: WidgetPage = {
  title: 'Counts',
  sections: [
    { show: 'counter', read: 'status', path: 'count', label: 'Counted' },
    { show: 'keyValue', read: 'status', label: 'All' },
    { show: 'table', read: 'day', input: { day: 2 }, columns: ['what'] },
  ],
};
const declares = <T extends { plugin: string }>(v: T): T =>
  v.plugin === 'actor' ? { ...v, widget: WIDGET, page: PAGE } : v;
const VIEWED = { ...VIEW, nodes: VIEW.nodes.map(declares) };
const live = (actor: Partial<PluginControl> = {}): Status => ({
  ...status(),
  plugins: status().plugins.map((p) =>
    p.id === 'actor-a'
      ? { ...p, reads: ['status', 'day'], status: { count: 3 }, widget: { count: 3 }, ...actor }
      : p
  ),
});

describe('a node’s widget in the editor', () => {
  it('is drawn on its card while it runs, and its panel opens its page', async () => {
    fakeCore({
      available: AVAILABLE.map(declares),
      routes: { 'GET /graph/view': [200, VIEWED], 'GET /status': [200, live()] },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    const card = await screen.findByLabelText('node actor-a', {}, slow);
    await waitFor(() =>
      expect(within(card).getByLabelText('its widget').textContent).toBe('3 Counted')
    );
    fireEvent.click(card);
    const details = await screen.findByLabelText('details of actor-a');
    expect(
      within(details).getByRole('link', { name: 'Open its page: Counts' }).getAttribute('href')
    ).toBe('#/node/actor-a');
  });

  it('is not drawn, nor its page offered, while its node does not run', async () => {
    fakeCore({
      available: AVAILABLE.map(declares),
      routes: {
        'GET /graph/view': [200, VIEWED],
        'GET /status': [200, live({ state: 'inactive' })],
      },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    const card = await screen.findByLabelText('node actor-a', {}, slow);
    await waitFor(() => expect(within(card).getByText('inactive')).toBeDefined());
    expect(within(card).queryByLabelText('its widget')).toBeNull();
    fireEvent.click(card);
    const details = await screen.findByLabelText('details of actor-a');
    expect(within(details).queryByRole('link', { name: /Open its page/u })).toBeNull();
  });
});

describe('a node’s page', () => {
  it('is reached at #/node/<id>, in no menu', () => {
    expect(resolve('node/turn-a')).toMatchObject({ page: { route: 'node' }, section: 'turn-a' });
    expect(resolve('node/a%2Fb').section).toBe('a/b');
    // `node` alone names no node: the home page.
    expect(resolve('node').page.route).toBe('graph');
  });

  it('draws its sections from its reads, each asked once, and again every few seconds', async () => {
    let count = 3;
    const api = fakeApi({
      'GET /graph/view': [200, VIEWED],
      'GET /plugins/actor-a/state/status': () => [200, { count: count++ }],
      'GET /plugins/actor-a/state/day?day=2': [500, { error: 'no ledger' }],
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<NodePage loggedOut={loggedOut} section="actor-a" />);
    expect(await screen.findByRole('heading', { name: 'Counts actor-a' })).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Counted' }).textContent).toBe('Counted3')
    );
    expect(screen.getByRole('region', { name: 'All' }).textContent).toBe('Allcount3');
    expect(screen.getByRole('region', { name: 'day' }).textContent).toBe('dayno ledger');
    expect(api.calls.filter((c) => c === 'GET /plugins/actor-a/state/status')).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Counted' }).textContent).toBe('Counted4')
    );
    expect(screen.getByRole('link', { name: '← Graph' }).getAttribute('href')).toBe('#/graph');
  });

  it('says so for a node that does not run or declares no page', async () => {
    fakeApi({ 'GET /graph/view': [200, VIEW] });
    render(<NodePage loggedOut={loggedOut} section="actor-a" />);
    expect(await screen.findByText('actor-a declares no page.')).toBeDefined();
    cleanup();
    render(<NodePage loggedOut={loggedOut} section="gone" />);
    expect(await screen.findByText('No node gone runs: apply the graph first.')).toBeDefined();
  });

  it('opens from the address bar, logged in', async () => {
    fakeApi({
      'GET /session': [200, { authenticated: true }],
      'GET /instance': [500, {}],
      'GET /graph/view': [200, VIEWED],
      'GET /plugins/actor-a/state/status': [200, { count: 1 }],
      'GET /plugins/actor-a/state/day?day=2': [200, [{ what: 'rope' }]],
    });
    window.location.hash = '#/node/actor-a';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Node page', level: 1 })).toBeDefined();
    expect(await screen.findByRole('table', { name: 'day' })).toBeDefined();
    window.location.hash = '';
  });
});
