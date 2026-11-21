import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { describePlugin } from './graph-view.ts';
import { parseManifest } from './manifest.ts';
import { definePlugin } from './plugin.ts';
import { type DeclaredRead, schemaAt, type Widget } from './widgets.ts';

/** A made-up ledger's reads: its status, its rows, and one that takes an input. */
const reads = {
  status: {
    help: 'how it is',
    output: z.object({
      gold: z.number().describe('Gold'),
      cap: z.number(),
      next: z.number().optional(),
      name: z.string(),
      bag: z.array(z.object({ item: z.string(), n: z.number() })),
      byName: z.record(z.string(), z.object({ n: z.number() })),
      loose: z.unknown(),
    }),
  },
  day: {
    help: 'a day’s rows',
    input: z.object({ day: z.number().int() }),
    output: z.array(z.object({ what: z.string(), n: z.number() })),
  },
};

const base = {
  id: 'ledger',
  version: '0.1.0',
  kinds: ['stats' as const],
  description: 'keeps a ledger',
  interface: { state: reads },
};

/** The problems the manifest's check names, as `path: message`. */
function refused(more: Record<string, unknown>): string {
  try {
    parseManifest({ ...base, ...more });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('a widget and a page in the manifest', () => {
  it('takes sections of every kind, made from its reads', () => {
    const page = {
      title: 'Ledger',
      sections: [
        { show: 'keyValue', read: 'status', fields: ['gold', { path: 'name', label: 'Who' }] },
        { show: 'counter', read: 'status', path: 'bag', label: 'Items' },
        { show: 'counter', read: 'status', path: 'byName' },
        { show: 'list', read: 'status', path: 'bag', item: 'item', max: 5 },
        { show: 'table', read: 'status', path: 'byName', columns: ['n'] },
        { show: 'table', read: 'day', input: { day: 3 }, columns: ['what', 'n'] },
        { show: 'progress', read: 'status', path: 'gold', of: 'cap' },
        { show: 'progress', read: 'status', path: 'gold', of: 100 },
        { show: 'until', read: 'status', path: 'next' },
        // A value its schema says nothing of: any path within it stands.
        { show: 'keyValue', read: 'status', path: 'loose.deep.er' },
      ],
    };
    const widget = { show: 'until', read: 'status', path: 'next', label: 'Next' };
    const m = parseManifest({ ...base, widget, page });
    expect(m.widget).toEqual(widget);
    expect(m.page).toEqual(page);
    // The editor is told both (GET /available, and each node's view).
    expect(describePlugin(m)).toMatchObject({ widget, page });
  });

  it('refuses a read it does not declare, a bad input and a path its output has not', () => {
    expect(refused({ widget: { show: 'counter', read: 'nope' } })).toContain(
      'widget.read: nope is not among its reads (interface.state)'
    );
    expect(
      refused({ widget: { show: 'counter', read: 'status', path: 'bag', input: {} } })
    ).toContain('widget.input: the read status takes no input');
    expect(refused({ widget: { show: 'table', read: 'day', columns: ['n'] } })).toContain(
      'widget.input: day:'
    );
    expect(refused({ widget: { show: 'counter', read: 'status', path: 'silver' } })).toContain(
      'widget.path: the read status has no silver'
    );
    expect(refused({ widget: { show: 'counter', read: 'status', path: 'a b' } })).toContain(
      'widget.path: expected a dotted path'
    );
    expect(refused({ widget: { show: 'pie', read: 'status' } })).toContain('widget.show');
    expect(
      refused({ page: { title: 'L', sections: [{ show: 'list', read: 'status', path: 'gold' }] } })
    ).toContain('page.sections.0.path: gold is not a list or a map');
    expect(refused({ page: { title: 'L', sections: [] } })).toContain('page.sections');
  });

  it('refuses a value of a kind its section cannot show, and fields its items have not', () => {
    const one = (w: Record<string, unknown>) => refused({ widget: { read: 'status', ...w } });
    expect(one({ show: 'counter', path: 'name' })).toContain(
      'widget.path: name is not a number, a list or a map'
    );
    expect(one({ show: 'progress', path: 'name', of: 3 })).toContain('name is not a number');
    expect(one({ show: 'progress', path: 'gold', of: 'name' })).toContain(
      'widget.of: name is not a number'
    );
    expect(one({ show: 'progress', path: 'gold', of: 'max' })).toContain(
      'widget.of: the read status has no max'
    );
    expect(one({ show: 'until', path: 'bag' })).toContain('bag is not a time');
    expect(one({ show: 'table', path: 'bag', columns: ['item', 'weight'] })).toContain(
      'widget.columns.1: bag has no weight'
    );
    expect(one({ show: 'list', path: 'bag', item: 'kind' })).toContain(
      'widget.item.0: bag has no kind'
    );
    expect(one({ show: 'keyValue', fields: ['gold', 'silver'] })).toContain(
      'widget.fields.1: the read status has no silver'
    );
    expect(one({ show: 'table', columns: ['x'] })).toContain(
      'widget.path: the read status is not a list or a map'
    );
  });
});

describe('schemaAt', () => {
  it('walks properties, records and list items, and stops at an open schema', () => {
    const s = z.toJSONSchema(reads.status.output) as Record<string, unknown>;
    expect(schemaAt(s, 'gold')).toMatchObject({ type: 'number' });
    expect(schemaAt(s, 'bag.0.item')).toMatchObject({ type: 'string' });
    expect(schemaAt(s, 'byName.anyone.n')).toMatchObject({ type: 'number' });
    expect(schemaAt(s, 'loose.x')).toBe('open');
    expect(schemaAt(s, 'bag.x')).toBeUndefined();
    expect(schemaAt(s, 'gold.x')).toBeUndefined();
    expect(schemaAt({}, undefined)).toBe('open');
  });
});

describe('a widget’s value in the controls’ status', () => {
  /** Two nodes of a plugin whose widget shows a read, each with a value of its own. */
  async function running(
    widget: Widget,
    extra: Record<string, DeclaredRead & { help: string }> = {}
  ) {
    const ledger = definePlugin({
      manifest: {
        ...base,
        widget,
        interface: {
          state: {
            ...reads,
            ...extra,
          },
        },
      },
      create: (ctx) => ({
        interface: {
          state: {
            status: () => ({
              gold: ctx.id === 'a' ? 1 : 2,
              cap: 9,
              name: ctx.id,
              bag: [],
              byName: {},
            }),
            day: (input: { day: number }) => [{ what: `day ${input.day}`, n: 1 }],
            failing: () => {
              throw new Error('no ledger');
            },
          },
        },
      }),
    });
    const core = new Core({
      clock: new VirtualClock(0),
      print: () => {},
      graph: {
        version: 2,
        nodes: [
          { id: 'a', plugin: 'ledger' },
          { id: 'b', plugin: 'ledger' },
        ],
        edges: [],
      },
    });
    core.register(ledger);
    await core.start();
    return core.controls.status().plugins;
  }

  it('is its node’s: each node’s read answers for it', async () => {
    const plugins = await running({ show: 'counter', read: 'status', path: 'gold' });
    expect(plugins.map((p) => [p.id, (p.widget as { gold: number }).gold])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    // Its status, read once, is the widget's too.
    expect(plugins[0]?.widget).toBe(plugins[0]?.status);
  });

  it('reads another read with its input, and is left out when the read fails', async () => {
    const day = await running({ show: 'table', read: 'day', input: { day: 4 }, columns: ['what'] });
    expect(day[0]?.widget).toEqual([{ what: 'day 4', n: 1 }]);
    const failing = await running(
      { show: 'counter', read: 'failing' },
      { failing: { help: 'fails', output: z.number() } }
    );
    expect(failing[0]).not.toHaveProperty('widget');
  });
});

/** A made-up postcard's cards, each a place, a prompt, a picture and a host; its hosts to pick. */
const cards = {
  id: 'postcard',
  version: '0.1.0',
  kinds: ['actor' as const],
  description: 'Paints a card per place',
  interface: {
    state: {
      cards: {
        help: 'Its cards',
        output: z.array(
          z.object({
            place: z.string(),
            prompt: z.string(),
            picture: z.string().optional(),
            face: z.unknown().optional(),
            host: z.string().optional(),
          })
        ),
      },
      hosts: {
        help: 'Who may host a card',
        output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })) }),
      },
    },
    actions: {
      repaint: {
        help: 'Paints a card again',
        input: z.strictObject({ place: z.string(), what: z.enum(['ad', 'scene']) }),
      },
      rehost: {
        help: 'Gives a card another host',
        input: z.strictObject({
          place: z.string(),
          host: z
            .string()
            .meta({ options: { read: 'hosts', path: 'hosts', value: 'id', label: 'name' } }),
        }),
      },
    },
  },
};

const table = (more: Record<string, unknown>) => ({
  page: {
    title: 'Cards',
    sections: [
      {
        show: 'table',
        read: 'cards',
        columns: ['place', 'prompt', { path: 'picture', label: 'Picture', show: 'image' }],
        ...more,
      },
    ],
  },
});

function cardsRefused(more: Record<string, unknown>): string {
  try {
    parseManifest({ ...cards, ...more });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('a table’s pictures and row actions (D157)', () => {
  it('takes a picture column, from the files by default, and row actions built from the row', () => {
    const m = parseManifest({
      ...cards,
      ...table({
        actions: [
          {
            label: 'Re-roll',
            action: 'repaint',
            input: { place: '$row.place', what: 'ad' },
            confirm: 'Re-roll this picture?',
          },
          {
            label: 'Rehost',
            action: 'rehost',
            input: { place: '$row.place' },
            current: { host: '$row.host' },
          },
        ],
      }),
    });
    const section = m.page?.sections[0] as Widget & { show: 'table' };
    expect(section.columns[2]).toEqual({
      path: 'picture',
      label: 'Picture',
      show: 'image',
      from: 'files',
    });
    expect(section.actions?.map((a) => a.label)).toEqual(['Re-roll', 'Rehost']);
    // A media column, too.
    expect(cardsRefused(table({ columns: [{ path: 'face', show: 'image', from: 'media' }] }))).toBe(
      ''
    );
    // The options travel to the editor with the action's input schema.
    const rehost = describePlugin(m).interface.actions.find((a) => a.name === 'rehost');
    expect(
      (rehost?.input?.['properties'] as Record<string, Record<string, unknown>>)['host']?.[
        'options'
      ]
    ).toEqual({ read: 'hosts', path: 'hosts', value: 'id', label: 'name' });
  });

  it('refuses an action not declared, a key or a constant its input refuses, a row path the rows have not', () => {
    const why = (actions: unknown[]) => cardsRefused(table({ actions }));
    expect(why([{ label: 'Go', action: 'fly' }])).toContain(
      'page.sections.0.actions.0.action: fly is not among its actions (interface.actions)'
    );
    expect(why([{ label: 'Go', action: 'repaint', input: { colour: 'red' } }])).toContain(
      'page.sections.0.actions.0.input.colour: the action repaint takes no colour'
    );
    expect(why([{ label: 'Go', action: 'repaint', input: { what: 'poster' } }])).toContain(
      'page.sections.0.actions.0.input.what: the action repaint refuses "poster"'
    );
    expect(why([{ label: 'Go', action: 'repaint', input: { place: '$row.town' } }])).toContain(
      'page.sections.0.actions.0.input.place: its rows have no town'
    );
    expect(why([{ label: 'Go', action: 'repaint', input: { place: '$rows' } }])).toContain(
      'expected $row.<path>, as $row.place'
    );
    expect(
      why([{ label: 'Go', action: 'rehost', input: { host: 'x' }, current: { host: '$row.host' } }])
    ).toContain(
      'page.sections.0.actions.0.current.host: host is given by input: the owner picks none'
    );
    expect(why([{ label: 'Go', action: 'rehost', current: { host: '$row.who' } }])).toContain(
      'its rows have no who'
    );
    expect(why([{ label: 'Go', action: 'rehost', current: { host: 'host' } }])).toContain(
      'expected $row.<path>'
    );
    // A row of its own, whole: `$row`.
    expect(why([{ label: 'Go', action: 'repaint', input: { place: '$row' } }])).toBe('');
    // A picture column's path is checked as any column's.
    expect(cardsRefused(table({ columns: [{ path: 'photo', show: 'image' }] }))).toContain(
      'page.sections.0.columns.0: the read cards has no photo'
    );
  });

  it('refuses options naming a read it does not declare, or a path its output has not', () => {
    const withOptions = (options: unknown) =>
      cardsRefused({
        interface: {
          ...cards.interface,
          actions: {
            rehost: { help: 'h', input: z.object({ host: z.string().meta({ options }) }) },
          },
        },
      });
    expect(withOptions({ read: 'people' })).toContain(
      'interface.actions.rehost.input.host.options: people is not among its reads (interface.state)'
    );
    expect(withOptions({ read: 'hosts', path: 'guests' })).toContain(
      'the read hosts has no guests'
    );
    expect(withOptions({ read: 'hosts' })).toContain('the read hosts is not a list or a map');
    expect(withOptions({ list: ['a'] })).toContain('expected { read, path?, value?, label? }');
    expect(withOptions({ read: 'cards', value: 'place' })).toBe('');
  });
});
