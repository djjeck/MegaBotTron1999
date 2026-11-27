// @vitest-environment happy-dom
/**
 * A view's layout (docs/bot-os.md D170, phase 2), as a made-up shop's dashboard draws it: stat
 * tiles in a grid, tabs in the address, a gallery and a table that open a drawer (`?row=`), a
 * table's search, sort and paging, badges and tags, forms of an action and of settings, and each
 * leaf's states: loading, empty, failed.
 */
import { describeNodes, parseManifest } from '@megabottron1999/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { GraphViewData } from '#src/ui/api.ts';
import { formatted, sortKey, toneOf } from '#src/ui/view/cells.tsx';
import { fakeApi } from '#test/fake-api.ts';
import { PORT_TYPES } from '#test/graph-view.ts';
import { asksOf, tabSlug, ViewPage, withSelected } from './ViewPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const shop = parseManifest({
  id: 'shop',
  kinds: ['stats'],
  description: 'a made-up shop',
  settings: z.object({ rate: z.number().default(1).describe('Rate') }),
  interface: {
    state: {
      summary: { help: 'Counts', output: z.object({ ads: z.number(), queued: z.number() }) },
      ads: {
        help: 'Its ads',
        output: z.array(
          z.object({ id: z.string(), item: z.string(), cover: z.string(), category: z.string() })
        ),
      },
      players: {
        help: 'Its players',
        output: z.array(
          z.object({ name: z.string(), level: z.number(), triggers: z.array(z.string()) })
        ),
      },
      player: {
        help: 'One player',
        input: z.object({ name: z.string() }),
        output: z.object({ drops: z.array(z.string()), pricing: z.object({ rate: z.number() }) }),
      },
      broken: { help: 'Fails', output: z.array(z.string()) },
    },
    actions: {
      advertise: { help: 'Writes an ad', input: z.strictObject({ item: z.string() }) },
      price: {
        help: 'Prices',
        input: z.strictObject({ name: z.string(), rate: z.number().describe('Rate') }),
      },
    },
  },
});

const view = parseManifest({
  id: 'shop-view',
  kinds: ['view'],
  description: 'the shop',
  inputs: { shop: { type: 'interface', plugin: 'shop', optional: true } },
  view: {
    title: 'Shop',
    sections: [
      {
        show: 'grid',
        columns: 2,
        sections: [
          {
            show: 'stat',
            from: 'shop',
            read: 'summary',
            path: 'ads',
            label: 'Ad count',
            format: 'number',
          },
          {
            show: 'stat',
            from: 'shop',
            read: 'summary',
            path: 'queued',
            label: 'Queued',
            tone: 'warning',
          },
        ],
      },
      {
        show: 'tabs',
        tabs: [
          {
            title: 'Catalogue',
            count: { from: 'shop', read: 'ads' },
            sections: [
              {
                show: 'gallery',
                from: 'shop',
                read: 'ads',
                label: 'Ads',
                image: { path: 'cover' },
                caption: 'item',
                badges: [{ path: 'category', format: 'badge', tones: { guru: 'success' } }],
                actions: [{ label: 'Again', action: 'advertise', input: { item: '$row.item' } }],
                detail: { title: 'item', fields: ['category'] },
              },
            ],
          },
          {
            title: 'Players',
            sections: [
              {
                show: 'table',
                from: 'shop',
                read: 'players',
                label: 'Players',
                key: 'name',
                search: true,
                sort: true,
                pageSize: 2,
                columns: [
                  'name',
                  { path: 'level', format: 'number' },
                  { path: 'triggers', format: 'tags' },
                ],
                detail: {
                  title: 'name',
                  sections: [
                    {
                      show: 'list',
                      from: 'shop',
                      read: 'player',
                      label: 'Drops',
                      input: { name: '$row.name' },
                      path: 'drops',
                    },
                    {
                      show: 'form',
                      from: 'shop',
                      label: 'Price',
                      action: 'price',
                      input: { name: '$row.name' },
                      current: { read: 'player', input: { name: '$row.name' }, path: 'pricing' },
                      submit: 'Price',
                    },
                  ],
                },
              },
            ],
          },
          {
            title: 'More',
            sections: [
              { show: 'list', from: 'shop', read: 'broken', label: 'Broken' },
              {
                show: 'list',
                from: 'shop',
                read: 'players',
                label: 'Nobody',
                empty: 'No player yet',
                path: 'nobody',
              },
              { show: 'form', from: 'shop', label: 'Rates', settings: ['rate'] },
            ],
          },
        ],
      },
    ],
  },
});

const graph: GraphViewData['graph'] = {
  version: 2,
  nodes: [
    { id: 'shop', plugin: 'shop' },
    { id: 'home', plugin: 'shop-view', path: 'shop' },
  ],
  edges: [{ from: 'shop.interface', to: 'home.shop', type: 'interface' }],
};
const VIEW = JSON.parse(
  JSON.stringify({
    graph,
    portTypes: PORT_TYPES,
    nodes: describeNodes(
      [
        { id: 'shop', manifest: shop },
        { id: 'home', manifest: view },
      ],
      graph
    ),
  })
) as GraphViewData;

const ADS = [
  { id: 'a1', item: 'Lantern', cover: 'lantern.png', category: 'guru' },
  { id: 'a2', item: 'Rope', cover: 'rope.png', category: 'travel' },
];
const PLAYERS = [
  { name: 'alice', level: 3, triggers: ['dawn'] },
  { name: 'bob', level: 9, triggers: [] },
  { name: 'carol', level: 5, triggers: ['dusk', 'rain'] },
];

function serve() {
  return fakeApi({
    'GET /graph/view': [200, VIEW],
    'GET /plugins/shop/state/summary': [200, { ads: 1200, queued: 4 }],
    'GET /plugins/shop/state/ads': [200, ADS],
    'GET /plugins/shop/state/players': [200, PLAYERS],
    'GET /plugins/shop/state/player?name=bob': [200, { drops: ['a key'], pricing: { rate: 2 } }],
    'GET /plugins/shop/state/broken': [500, { error: 'it broke' }],
    'POST /plugins/shop/actions/advertise': [200, { written: true }],
    'POST /plugins/shop/actions/price': [400, { error: 'too low' }],
    'GET /settings': [200, { 'shop.rate': 1 }],
    'POST /settings': [200, {}],
  });
}

describe('a view’s dashboard (D170, phase 2)', () => {
  it('draws stat tiles, and the open tab’s gallery with its count, badges and actions', async () => {
    const api = serve();
    render(<ViewPage loggedOut={() => {}} section="shop" />);
    const count = await screen.findByRole('region', { name: 'Ad count' });
    await waitFor(() => expect(within(count).getByText('1,200')).toBeDefined());
    expect(
      screen.getByRole('region', { name: 'Queued' }).querySelector('.tone-warning')
    ).not.toBeNull();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Catalogue2', 'Players', 'More']);
    const gallery = await screen.findByRole('list', { name: 'Ads' });
    const lantern = within(gallery).getByRole('listitem', { name: 'Lantern' });
    expect(within(lantern).getByText('guru').className).toBe('badge tone-success');
    expect(within(lantern).getByRole('img', { name: 'Picture of Lantern' })).toBeDefined();
    // The open tab's reads only: the players' are not asked yet.
    expect(api.calls).not.toContain('GET /plugins/shop/state/players');
    fireEvent.click(within(lantern).getByRole('button', { name: 'Again Lantern' }));
    await waitFor(() =>
      expect(api.calls).toContain('POST /plugins/shop/actions/advertise {"item":"Lantern"}')
    );
    // Its drawer, in the address.
    fireEvent.click(within(lantern).getByRole('button', { name: 'open Lantern' }));
    expect(window.location.search).toBe('?row=a1');
    const drawer = screen.getByRole('dialog', { name: 'Lantern' });
    expect(within(drawer).getByText('guru')).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('keeps the tab and the row in the address, the drawer’s sections read with the row', async () => {
    const api = serve();
    window.history.replaceState(null, '', '/v/shop/?tab=players&row=bob');
    render(<ViewPage loggedOut={() => {}} section="shop" />);
    const drawer = await screen.findByRole('dialog', { name: 'bob' });
    const drops = await within(drawer).findByRole('region', { name: 'Drops' });
    await waitFor(() => expect(within(drops).getByText('a key')).toBeDefined());
    // A form preset from a read, its error said under it.
    const form = within(drawer).getByRole('form', { name: 'Price' });
    await waitFor(() =>
      expect((within(form).getByLabelText(/rate/iu) as HTMLInputElement).value).toBe('2')
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Price' }));
    expect(await within(form).findByRole('alert')).toBeDefined();
    expect(api.calls).toContain('POST /plugins/shop/actions/price {"rate":2,"name":"bob"}');
    fireEvent.click(within(drawer).getByRole('button', { name: 'close' }));
    expect(window.location.search).toBe('?tab=players');
  });

  it('searches, sorts and pages a table, its tags as chips', async () => {
    serve();
    window.history.replaceState(null, '', '/v/shop/?tab=players');
    render(<ViewPage loggedOut={() => {}} section="shop" />);
    const table = await screen.findByRole('table', { name: 'Players' });
    const names = () =>
      within(screen.getByRole('table', { name: 'Players' }))
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.querySelector('td')?.textContent);
    expect(names()).toEqual(['alice', 'bob']);
    expect(screen.getByText('1–2 of 3')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(names()).toEqual(['carol']);
    expect(within(table.closest('section') as HTMLElement).getByText('rain').className).toBe('tag');
    fireEvent.click(screen.getByRole('button', { name: /^level/u }));
    fireEvent.click(screen.getByRole('button', { name: /^level/u }));
    expect(names()).toEqual(['bob', 'carol']);
    fireEvent.change(screen.getByLabelText('search Players'), { target: { value: 'CAR' } });
    expect(names()).toEqual(['carol']);
    fireEvent.change(screen.getByLabelText('search Players'), { target: { value: 'zed' } });
    expect(screen.getByText('Nothing matches.')).toBeDefined();
  });

  it('breaks only its own card when a read fails, says when a leaf is empty, and sets settings', async () => {
    const api = serve();
    window.history.replaceState(null, '', '/v/shop/?tab=more');
    render(<ViewPage loggedOut={() => {}} section="shop" />);
    const broken = await screen.findByRole('region', { name: 'Broken' });
    await waitFor(() =>
      expect(within(broken).getByRole('alert').textContent).toContain('shop.broken did not answer')
    );
    expect(await screen.findByText('No player yet')).toBeDefined();
    const rates = screen.getByRole('form', { name: 'Rates' });
    const rate = (await within(rates).findByLabelText(/rate/iu)) as HTMLInputElement;
    await waitFor(() => expect(rate.value).toBe('1'));
    fireEvent.click(within(rates).getByRole('button', { name: 'Save' }));
    expect(await within(rates).findByText('Nothing changed.')).toBeDefined();
    fireEvent.change(rate, { target: { value: '3' } });
    fireEvent.click(within(rates).getByRole('button', { name: 'Save' }));
    expect(await within(rates).findByText('Set rate.')).toBeDefined();
    expect(api.calls).toContain('POST /settings {"key":"shop.rate","value":3}');
  });

  it('shows each leaf loading until its read answers', async () => {
    fakeApi({ 'GET /graph/view': [200, VIEW] });
    vi.stubGlobal('fetch', (url: string) =>
      url.endsWith('/graph/view')
        ? Promise.resolve(new Response(JSON.stringify(VIEW), { status: 200 }))
        : new Promise(() => {})
    );
    render(<ViewPage loggedOut={() => {}} section="shop" />);
    const count = await screen.findByRole('region', { name: 'Ad count' });
    expect(within(count).getByText('Loading…')).toBeDefined();
  });
});

describe('a view’s helpers (D170, phase 2)', () => {
  it('formats a value by its format, and sorts by it', () => {
    expect(formatted(1234.567, 'number', 'coins')).toBe('1,234.57 coins');
    expect(formatted(12, 'percent')).toBe('12%');
    expect(formatted(['a', 'b'], 'tags')).toBe('a, b');
    expect(formatted(undefined, 'text')).toBe('—');
    expect(formatted('x', 'number')).toBe('x');
    expect(formatted(0, 'relative', undefined, 60_000)).toBe('1m 0s ago');
    expect(formatted('nope', 'datetime')).toBe('nope');
    expect(sortKey('2026-01-01T00:00:00Z', 'datetime')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(sortKey('Bob', 'text')).toBe('bob');
    expect(toneOf('x', { '*': 'info' })).toBe('info');
    expect(toneOf('x', undefined)).toBe('neutral');
  });

  it('fills a row’s values in an input, and names a tab by its slug', () => {
    expect(withSelected({ name: '$row.name', all: '$row' }, undefined, { name: 'bob' })).toEqual({
      name: 'bob',
      all: { name: 'bob' },
    });
    expect(tabSlug('Donations & refunds')).toBe('donations-refunds');
    expect(tabSlug('!!')).toBe('tab');
  });

  it('asks only what the page shows now', () => {
    const asks = asksOf(
      view.view?.sections ?? [],
      { bound: { shop: 'shop' }, answers: {}, address: {} },
      undefined
    );
    expect(asks.map((a) => a.read)).toEqual(['summary', 'ads']);
  });
});
