/**
 * A view's layout vocabulary (docs/bot-os.md D170, phase 2): tabs, grids, cards, stat tiles, a
 * gallery, a form, a table's search, sort, paging and drawer, formats and badges; each checked in
 * the manifest as it is written, and against the node bound to its input in the graph.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GraphError, resolveGraph } from './graph.ts';
import { type Manifest, type ManifestInput, parseManifest } from './manifest.ts';
import {
  layoutIssues,
  tabSlug,
  viewCounts,
  viewLeaves,
  type ViewSection,
  viewSectionSchema,
} from './widgets.ts';

/** A made-up shop's ads: items with pictures, players, donations, and what changes them. */
const shop = parseManifest({
  id: 'shop',
  kinds: ['stats'],
  description: 'a made-up shop',
  settings: z.object({ rate: z.number().default(1), minCoins: z.number().default(10) }),
  interface: {
    state: {
      summary: {
        help: 'Its counts',
        output: z.object({ ads: z.number(), queued: z.number(), since: z.string() }),
      },
      ads: {
        help: 'Its ads',
        output: z.array(
          z.object({
            id: z.string(),
            item: z.string(),
            pictures: z.array(z.string()),
            cover: z.string(),
            category: z.string(),
            seller: z.string(),
          })
        ),
      },
      players: {
        help: 'Its players',
        output: z.array(
          z.object({
            name: z.string(),
            level: z.number(),
            triggers: z.array(z.string()),
            seen: z.number(),
          })
        ),
      },
      player: {
        help: 'One player',
        input: z.object({ name: z.string() }),
        output: z.object({ drops: z.array(z.string()), pricing: z.object({ rate: z.number() }) }),
      },
      donations: {
        help: 'Its donations',
        output: z.array(
          z.object({
            at: z.number(),
            counted: z.boolean(),
            amount: z.number(),
            player: z.string(),
          })
        ),
      },
    },
    actions: {
      advertise: {
        help: 'Writes an ad',
        input: z.strictObject({ item: z.string(), again: z.boolean().optional() }),
      },
      price: { help: 'Prices', input: z.strictObject({ name: z.string(), rate: z.number() }) },
    },
  },
});

const view = (sections: unknown[], more: Partial<ManifestInput> = {}): ManifestInput => ({
  id: 'shop-view',
  kinds: ['view'],
  description: 'the shop',
  inputs: { shop: { type: 'interface', plugin: 'shop', optional: true } },
  view: { title: 'Shop', sections: sections as never },
  ...more,
});

/** Why the graph of a shop and its view is refused; nothing when it stands. */
function refused(sections: unknown[]): string[] {
  const v = parseManifest(view(sections));
  try {
    resolveGraph(
      {
        version: 2,
        nodes: [
          { id: 'shop', plugin: 'shop' },
          { id: 'home', plugin: 'shop-view' },
        ],
        edges: [{ from: 'shop.interface', to: 'home.shop' }],
      },
      new Map<string, Manifest>([
        ['shop', shop],
        ['shop-view', v],
      ])
    );
    return [];
  } catch (e) {
    if (e instanceof GraphError) return e.problems;
    throw e;
  }
}

/** A full dashboard: stats, tabs of a gallery, a table with a drawer, and a settings form. */
const DASHBOARD = [
  {
    show: 'grid',
    columns: 3,
    sections: [
      { show: 'stat', from: 'shop', read: 'summary', path: 'ads', label: 'Ads', format: 'number' },
      { show: 'stat', from: 'shop', read: 'summary', path: 'queued', tone: 'warning' },
      { show: 'stat', from: 'shop', read: 'summary', path: 'since', format: 'relative' },
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
            image: { path: 'pictures', carousel: true },
            caption: 'item',
            search: ['item', 'seller'],
            badges: [
              { path: 'category', format: 'badge', tones: { guru: 'success', '*': 'neutral' } },
            ],
            actions: [
              { label: 'Again', action: 'advertise', input: { item: '$row.item', again: true } },
            ],
            detail: { title: 'item', fields: ['seller', { path: 'cover', format: 'image' }] },
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
            key: 'name',
            search: true,
            sort: true,
            defaultSort: { path: 'level', direction: 'desc' },
            pageSize: 25,
            empty: 'No player yet',
            columns: [
              'name',
              { path: 'level', format: 'number' },
              { path: 'triggers', format: 'tags' },
              { path: 'seen', format: 'relative' },
            ],
            detail: {
              title: 'name',
              sections: [
                {
                  show: 'list',
                  from: 'shop',
                  read: 'player',
                  input: { name: '$row.name' },
                  path: 'drops',
                },
                {
                  show: 'form',
                  from: 'shop',
                  action: 'price',
                  input: { name: '$row.name' },
                  current: { read: 'player', input: { name: '$row.name' }, path: 'pricing' },
                },
              ],
            },
          },
        ],
      },
      {
        title: 'Pricing',
        sections: [
          {
            show: 'card',
            title: 'Rates',
            sections: [{ show: 'form', from: 'shop', settings: ['rate', 'minCoins'] }],
          },
        ],
      },
    ],
  },
];

describe('a view’s layout (D170, phase 2)', () => {
  it('takes tabs, grids, cards, stats, a gallery, a drawer and forms, and runs against its node', () => {
    const m = parseManifest(view(DASHBOARD));
    expect(m.inputs['shop']).toMatchObject({
      members: [
        'state.summary',
        'state.ads',
        'actions.advertise',
        'state.players',
        'state.player',
        'actions.price',
      ],
    });
    const leaves = viewLeaves(m.view ?? { sections: [] });
    expect(leaves.map((l) => [l.leaf.show, l.tab ?? '-', l.drawerOf?.show ?? '-'])).toEqual([
      ['stat', '-', '-'],
      ['stat', '-', '-'],
      ['stat', '-', '-'],
      ['gallery', 'catalogue', '-'],
      ['table', 'players', '-'],
      ['list', 'players', 'table'],
      ['form', 'players', 'table'],
      ['form', 'pricing', '-'],
    ]);
    expect(viewCounts(m.view ?? { sections: [] }).map((c) => c.path.join('.'))).toEqual([
      'sections.1.tabs.0.count',
    ]);
    expect(refused(DASHBOARD)).toEqual([]);
  });

  it('names the kinds a section may be when its show is none of them', () => {
    const r = viewSectionSchema.safeParse({ show: 'map', from: 'shop', read: 'ads' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      'expected show to be one of: keyValue, counter, list, table, progress, until, stat, gallery, chart, timeseries, form, tabs, grid, card'
    );
  });

  it('formats a column with format, phase 1’s show and from read as format and source', () => {
    const parse = (column: unknown) =>
      (
        viewSectionSchema.parse({
          show: 'table',
          from: 'shop',
          read: 'ads',
          columns: [column],
        }) as {
          columns: unknown[];
        }
      ).columns[0];
    expect(parse({ path: 'cover', show: 'image', from: 'media' })).toEqual({
      path: 'cover',
      format: 'image',
      source: 'media',
    });
    expect(parse({ path: 'cover', format: 'image' })).toEqual({
      path: 'cover',
      format: 'image',
      source: 'files',
    });
    const bad = (column: unknown) =>
      viewSectionSchema
        .safeParse({ show: 'table', from: 'shop', read: 'ads', columns: [column] })
        .error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(bad({ path: 'x', show: 'image', format: 'image' })).toEqual([
      'columns.0.show: say format alone',
    ]);
    expect(bad({ path: 'x', tones: { a: 'success' } })).toEqual([
      'columns.0.tones: only a badge has tones',
    ]);
    expect(bad({ path: 'x', format: 'text', unit: 'g' })).toEqual([
      'columns.0.unit: only a number has a unit',
    ]);
    expect(bad({ path: 'x', source: 'files' })).toEqual([
      'columns.0.source: only a picture (format image or carousel) has a source',
    ]);
    expect(bad({ path: 'x', format: 'loud' })).toEqual([
      'columns.0.format: expected a format: text, number, percent, datetime, relative, badge, tags, image, carousel',
    ]);
    expect(bad({ path: 'x', format: 'badge', tones: { a: 'red' } })).toEqual([
      'columns.0.tones.a: expected a tone: neutral, info, success, warning, danger',
    ]);
  });

  it('refuses a form that names neither an action nor settings, or both, or gives settings an input', () => {
    const bad = (form: object) =>
      viewSectionSchema
        .safeParse({ show: 'form', from: 'shop', ...form })
        .error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(bad({})).toEqual([
      'action: a form runs an action (action) or sets settings (settings): name one',
    ]);
    expect(bad({ action: 'price', settings: ['rate'] })).toHaveLength(1);
    expect(bad({ settings: ['rate'], fields: ['rate'] })).toEqual([
      'fields: a settings form takes no fields',
    ]);
  });

  it('keeps one level of tabs, each its own address, and one drawer a tab', () => {
    const tabs = (...titles: string[]): ViewSection => ({
      show: 'tabs',
      tabs: titles.map((title) => ({ title, sections: [] })),
    });
    const table = (key: string) => ({
      show: 'table' as const,
      from: 'shop',
      read: 'players',
      columns: ['name'],
      key,
      detail: { title: 'name' },
    });
    expect(tabSlug('Donations & refunds')).toBe('donations-refunds');
    expect(tabSlug('Café')).toBe('cafe');
    expect(tabSlug('!!')).toBe('tab');
    expect(
      layoutIssues({
        sections: [
          tabs('Players', 'players!'),
          { show: 'tabs', tabs: [{ title: 'Outer', sections: [tabs('Inner')] }] },
          table('name') as ViewSection,
          { show: 'card', sections: [table('name') as ViewSection] },
        ],
      })
    ).toEqual([
      {
        path: ['sections', 0, 'tabs', 1, 'title'],
        message: "its address is tab 0's too (?tab=players): give it another title",
      },
      {
        path: ['sections', 1, 'tabs', 0, 'sections', 0],
        message: 'tabs within tabs: a view has one level of tabs',
      },
      {
        path: ['sections', 3, 'sections', 0, 'detail'],
        message: 'a second drawer outside the tabs (the first: sections.2): ?row= opens one leaf’s',
      },
    ]);
    expect(() => parseManifest(view([tabs('A', 'a')]))).toThrow(
      "view.sections.0.tabs.1.title: its address is tab 0's too (?tab=a)"
    );
  });

  it('refuses in the graph what its bound node does not answer, by its path in the manifest', () => {
    expect(
      refused([
        { show: 'stat', from: 'shop', read: 'summary', path: 'since', format: 'number' },
        { show: 'stat', from: 'shop', read: 'summary', path: 'ads', of: 'nothing' },
        { show: 'stat', from: 'shop', read: 'summary', path: 'ads', format: 'tags' },
        { show: 'gallery', from: 'shop', read: 'ads', image: { path: 'cover', carousel: true } },
        {
          show: 'tabs',
          tabs: [
            {
              title: 'Players',
              count: { from: 'shop', read: 'summary', path: 'since' },
              sections: [
                {
                  show: 'table',
                  from: 'shop',
                  read: 'players',
                  columns: [
                    { path: 'name', format: 'number' },
                    { path: 'level', format: 'tags' },
                  ],
                  search: ['nick'],
                  defaultSort: { path: 'rank' },
                  detail: {
                    title: 'nick',
                    fields: ['level', 'gone'],
                    actions: [{ label: 'Price', action: 'price', input: { name: '$row.nick' } }],
                    sections: [
                      {
                        show: 'list',
                        from: 'shop',
                        read: 'player',
                        input: { name: '$row.nick' },
                        path: 'drops',
                      },
                      {
                        show: 'form',
                        from: 'shop',
                        action: 'price',
                        fields: ['cost'],
                        current: { read: 'summary', path: 'ads' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        { show: 'form', from: 'shop', settings: ['rate', 'speed'] },
        { show: 'form', from: 'shop', action: 'price', input: { name: '$row.name' } },
      ]).map((p) => p.replace(' (from shop, bound to shop)', ''))
    ).toEqual([
      'node home: view sections.0.path: since is not a number',
      'node home: view sections.1.of: the read summary has no nothing',
      'node home: view sections.2.format: a stat shows one value: format tags is a column’s',
      'node home: view sections.3.image: cover is not a list of pictures',
      'node home: view sections.4.tabs.0.sections.0.columns.0: name is not a number',
      'node home: view sections.4.tabs.0.sections.0.columns.1: level is not a list of texts',
      'node home: view sections.4.tabs.0.sections.0.defaultSort.path: the read players has no rank',
      'node home: view sections.4.tabs.0.sections.0.search.0: the read players has no nick',
      'node home: view sections.4.tabs.0.sections.0.key: its rows have no id: a drawer needs a key that tells its rows apart (key)',
      'node home: view sections.4.tabs.0.sections.0.detail.title: the read players has no nick',
      'node home: view sections.4.tabs.0.sections.0.detail.fields.1: the read players has no gone',
      'node home: view sections.4.tabs.0.sections.0.detail.actions.0.input.name: its rows have no nick',
      'node home: view sections.4.tabs.0.sections.0.detail.sections.0.input.name: its row has no nick',
      'node home: view sections.4.tabs.0.sections.0.detail.sections.1.fields.0: the action price takes no cost',
      'node home: view sections.4.tabs.0.sections.0.detail.sections.1.current.path: ads is not an object of the form’s fields',
      'node home: view sections.5.settings.1: speed is not among its settings',
      'node home: view sections.6.input.name: only a form in a drawer has a row ($row)',
      'node home: view sections.4.tabs.0.count.path: since is not a number, a list or a map',
    ]);
    // An action the node has not is refused by the edge itself: the view's input needs it.
    expect(refused([{ show: 'form', from: 'shop', action: 'gone' }])).toEqual([
      'node home: input port shop: shop does not declare actions.gone (edge shop.interface → home.shop)',
    ]);
  });
});

describe('a view’s charts (D174)', () => {
  const donations = {
    show: 'timeseries',
    from: 'shop',
    read: 'donations',
    label: 'Donations per day',
    x: 'at',
    interval: 'day',
    timeZone: 'Europe/Rome',
    mark: 'bar',
    stack: true,
    series: 'counted',
    seriesLabels: { true: 'Counted', false: 'Not counted' },
    y: { label: 'Donations' },
    value: { path: 'amount', label: 'Value', unit: '₭' },
  };

  it('takes a chart and a time series that its node answers', () => {
    expect(refused([donations])).toEqual([]);
    expect(
      refused([
        {
          show: 'chart',
          from: 'shop',
          read: 'donations',
          x: 'player',
          y: ['amount', { path: 'amount', reduce: 'max', label: 'Largest' }],
        },
        { show: 'chart', from: 'shop', read: 'players', x: 'level', mark: 'dot' },
      ])
    ).toEqual([]);
  });

  it('refuses a chart its rows cannot draw, naming where', () => {
    const problems = refused([
      { ...donations, x: 'counted' },
      { show: 'chart', from: 'shop', read: 'donations', x: 'when', y: 'player', series: 'kind' },
      { show: 'chart', from: 'shop', read: 'summary', x: 'ads' },
      { show: 'chart', from: 'shop', read: 'donations', x: 'at', value: { path: 'nope' } },
    ]).join('\n');
    expect(problems).toContain('counted is not a time');
    expect(problems).toContain('has no when');
    expect(problems).toContain('player is not a number');
    expect(problems).toContain('has no kind');
    expect(problems).toContain('is not a list or a map');
    expect(problems).toContain('has no nope');
  });

  it('refuses a chart said wrong, as it is written', () => {
    const wrong = (extra: Record<string, unknown>): string => {
      const r = viewSectionSchema.safeParse({ ...donations, ...extra });
      return r.success ? '' : r.error.issues.map((i) => i.message).join('; ');
    };
    expect(wrong({ y: ['amount', 'amount'] })).toContain('not both');
    expect(wrong({ series: undefined })).toContain('only a chart split by series');
    expect(wrong({ mark: 'line' })).toContain('only bars and areas stack');
    expect(wrong({ timeZone: 'Mars/Base' })).toContain('expected a time zone');
    expect(wrong({ y: { reduce: 'count' } })).toBe('');
    expect(wrong({ y: { reduce: 'sum' } })).toContain('a measure with no path counts its rows');
    expect(
      viewSectionSchema.safeParse({
        show: 'chart',
        from: 'shop',
        read: 'a',
        x: 'b',
        y: { reduce: 'max' },
      }).success
    ).toBe(false);
    expect(wrong({ interval: 'year' })).toContain('expected an interval');
  });
});

describe('the views cookbook (docs/views.md)', () => {
  it('has a shop and a whole dashboard that the checks take as they are written', () => {
    const doc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/views.md'),
      'utf8'
    );
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/gu)].map((m) => m[1] ?? '');
    const object = (text: string): Record<string, unknown> =>
      // A block of `key: value,` lines: an object's body, made of plain values and zod.
      new Function('z', `return {${text}}`)(z) as Record<string, unknown>;
    const iface = object(blocks[0] ?? '');
    const whole = object(blocks.at(-1) ?? '');
    const cookShop = parseManifest({
      id: 'shop',
      kinds: ['stats'],
      description: 'the shop',
      ...iface,
    });
    const cookView = parseManifest({
      id: 'shop-view',
      kinds: ['view'],
      description: 'the dashboard',
      inputs: { shop: { type: 'interface', plugin: 'shop', optional: true } },
      view: whole['view'] as never,
    });
    expect(() =>
      resolveGraph(
        {
          version: 2,
          nodes: [
            { id: 'shop', plugin: 'shop' },
            { id: 'home', plugin: 'shop-view' },
          ],
          edges: [{ from: 'shop.interface', to: 'home.shop' }],
        },
        new Map<string, Manifest>([
          ['shop', cookShop],
          ['shop-view', cookView],
        ])
      )
    ).not.toThrow();
  });
});
