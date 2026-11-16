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
