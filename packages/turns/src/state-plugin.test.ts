import {
  type BusEvent,
  Core,
  CoreEventLog,
  definePlugin,
  type Plugin,
  type PluginContext,
  VirtualClock,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANNOUNCED_DOC, type Mark, STATE_DOC, statePlugin } from '#src/state-plugin.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-10T12:00:00Z');

/** A made-up game's events: a full inventory, an item gained, gold lost (an amount, or unknown). */
const questEvents = {
  'quest.inventory': z.object({
    items: z.array(z.object({ name: z.string(), count: z.number() })),
    gold: z.number(),
  }),
  'quest.gain': z.object({ name: z.string() }),
  'quest.loss': z.object({ gold: z.number().optional() }),
  'quest.level': z.object({ level: z.number() }),
};

/** The made-up game's parser: publishes what the test says, at the time it says. */
function questParser(
  onStart?: (publish: (type: string, payload: object, t?: number) => void) => void
): Plugin {
  return definePlugin({
    manifest: {
      id: 'quest',
      version: '0.1.0',
      kinds: ['parser'],
      description: 'A made-up game',
      games: { registers: ['quest'] },
      events: questEvents,
      interface: {
        actions: {
          emit: {
            help: 'Publishes an event',
            input: z.object({
              type: z.string(),
              payload: z.record(z.string(), z.unknown()),
              t: z.number().optional(),
            }),
          },
        },
      },
    },
    create: (ctx) => ({
      start() {
        onStart?.((type, payload, t) =>
          ctx.bus.publish(type, payload as Record<string, unknown>, t)
        );
      },
      interface: {
        actions: {
          emit: (i: { type: string; payload: Record<string, unknown>; t?: number }) => {
            ctx.bus.publish(i.type, i.payload, i.t);
          },
        },
      },
    }),
  });
}

const Item = z.object({
  name: z.string().describe('Item'),
  count: z.number().int().describe('Count'),
});
const QuestState = z.object({
  inventory: z
    .object({
      items: z.array(Item).describe('Items'),
      gold: z.number().describe('Gold'),
    })
    .describe('Inventory'),
  profile: z.object({ level: z.number().describe('Level') }).describe('Profile'),
});
type QuestState = z.output<typeof QuestState>;

function questState(more: { reduce?: (s: QuestState, e: BusEvent) => QuestState } = {}): Plugin {
  return statePlugin<QuestState>({
    id: 'quest-state',
    description: "The player's inventory and profile in the made-up game",
    schema: QuestState,
    initial: { inventory: { items: [], gold: 0 }, profile: { level: 1 } },
    consumes: ['quest.inventory', 'quest.gain', 'quest.loss', 'quest.level'],
    reduce:
      more.reduce ??
      ((s, e) => {
        if (e.type === 'quest.inventory')
          return {
            ...s,
            inventory: {
              items: e['items'] as QuestState['inventory']['items'],
              gold: e['gold'] as number,
            },
          };
        if (e.type === 'quest.gain') {
          const name = e['name'] as string;
          const has = s.inventory.items.some((i) => i.name === name);
          const items = has
            ? s.inventory.items.map((i) => (i.name === name ? { ...i, count: i.count + 1 } : i))
            : [...s.inventory.items, { name, count: 1 }];
          return { ...s, inventory: { ...s.inventory, items } };
        }
        if (e.type === 'quest.loss') {
          const gold = e['gold'] as number | undefined;
          return gold === undefined
            ? s
            : { ...s, inventory: { ...s.inventory, gold: s.inventory.gold - gold } };
        }
        return { ...s, profile: { level: e['level'] as number } };
      }),
    freshness: (e, changed) => {
      const marks: Record<string, Mark> = Object.fromEntries(changed.map((c) => [c, 'delta']));
      if (e.type === 'quest.inventory') marks['inventory'] = 'snapshot';
      if (e.type === 'quest.loss' && e['gold'] === undefined) marks['inventory'] = 'uncertain';
      return marks;
    },
    queries: {
      count: {
        help: 'How many of an item the player has',
        input: z.object({ name: z.string() }),
        output: z.number(),
        run: (s, input: { name: string }) =>
          s.inventory.items.find((i) => i.name === input.name)?.count ?? 0,
      },
      richest: {
        help: 'The item held most',
        output: z.string().optional(),
        run: (s) => [...s.inventory.items].sort((a, b) => b.count - a.count)[0]?.name,
      },
    },
  });
}

/** A made-up acting node that reads the state: it requires it (a required interface input). */
function buyer(): Plugin {
  return definePlugin({
    manifest: {
      id: 'buyer',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'Buys what the state says is missing',
      requires: ['quest-state'],
    },
    create: () => ({}),
  });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-plugin-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An instance on the test's data volume and event log, as the image's entry point makes one. */
async function boot(
  o: {
    at?: number;
    plugins?: Plugin[];
    pin?: string[];
    onRecord?: (r: BusEvent) => void;
  } = {}
) {
  const clock = new VirtualClock(o.at ?? T0);
  const log = new CoreEventLog(path.join(dir, 'events'));
  const changed: BusEvent[] = [];
  const core = new Core({
    clock,
    dataDir: path.join(dir, 'data'),
    events: log,
    print: () => undefined,
    record: (r) => {
      if (r.type === 'quest-state.changed') changed.push(r as BusEvent);
      o.onRecord?.(r as BusEvent);
      return log.write(r);
    },
    config: { 'quest-state': { pin: o.pin ?? [] } },
  });
  core.register(...(o.plugins ?? [questParser(), questState()]));
  await core.start();
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    t?: number
  ): Promise<void> => {
    const r = await core.controls.act('quest', 'emit', {
      type,
      payload,
      ...(t === undefined ? {} : { t }),
    });
    expect(r).toEqual({ output: undefined });
    await Promise.resolve();
  };
  const read = (name: string, input?: Record<string, unknown>): unknown => {
    const r = core.controls.read('quest-state', name, input);
    if ('error' in r) throw new Error(r.error);
    return r.value;
  };
  const kept = (): Record<string, unknown> =>
    JSON.parse(
      fs.readFileSync(
        path.join(dir, 'data', 'instances', 'quest-state', `${STATE_DOC}.json`),
        'utf8'
      )
    ) as Record<string, unknown>;
  return { core, clock, log, emit, read, kept, changed };
}

describe('statePlugin', () => {
  it('applies each event with its reducer, keeps its freshness, announces it, and answers', async () => {
    const run = await boot();
    await run.emit('quest.inventory', { items: [{ name: 'rope', count: 2 }], gold: 40 });
    await run.emit('quest.gain', { name: 'lamp' });
    await run.emit('quest.gain', { name: 'rope' });
    await run.emit('quest.loss', {});
    await run.emit('quest.level', { level: 3 });
    expect(run.read('get')).toEqual({
      inventory: {
        items: [
          { name: 'rope', count: 3 },
          { name: 'lamp', count: 1 },
        ],
        gold: 40,
      },
      profile: { level: 3 },
    });
    expect(run.read('get', { path: 'inventory.items.1.name' })).toBe('lamp');
    expect(run.read('count', { name: 'rope' })).toBe(3);
    expect(run.read('richest')).toBe('rope');
    // A full snapshot at T0, then three changes since, one of them uncertain (the loss untold).
    expect(run.read('freshness', { section: 'inventory' })).toEqual({
      snapshot: { t: T0, event: 'quest.inventory' },
      deltas: 3,
      uncertain: 1,
      updated: { t: T0, event: 'quest.loss' },
    });
    expect(run.read('freshness', { section: 'nothing' })).toEqual({ deltas: 0, uncertain: 0 });
    expect(Object.keys(run.read('freshness') as object)).toEqual(['inventory', 'profile']);
    expect(run.changed.map((c) => [c['sections'], c['refreshed']])).toEqual([
      [['inventory'], ['inventory']],
      [['inventory'], ['inventory']],
      [['inventory'], ['inventory']],
      [[], ['inventory']],
      [['profile'], ['profile']],
    ]);
    expect(run.changed[0]?.['event']).toEqual({ type: 'quest.inventory', t: T0 });
    // What a read gives is a copy: changing it changes nothing kept.
    (run.read('get', { path: 'profile' }) as { level: number }).level = 99;
    expect(run.read('get', { path: 'profile.level' })).toBe(3);
    expect(run.kept()).toMatchObject({ updatedAt: T0, batch: 5 });
    await run.core.stop();
  });

  it('resumes from its cursor: what was written after it, across day files, applied once', async () => {
    const first = await boot();
    await first.emit('quest.gain', { name: 'rope' });
    await first.emit('quest.gain', { name: 'rope' });
    await first.core.stop();
    const cursor = first.kept()['cursor'] as Record<string, number>;
    expect(Object.keys(cursor)).toEqual(['2026-11-10']);

    // While it is down: the parser's records go on, to today's file, to an old day's (a missed
    // message, published late with its own time) and to a new day's.
    const log = new CoreEventLog(path.join(dir, 'events'));
    log.write({ type: 'quest.gain', t: T0 + 1000, instance: 'quest', name: 'lamp' });
    log.write({ type: 'quest.gain', t: T0 - DAY, instance: 'quest', name: 'map' });
    log.write({ type: 'quest.gain', t: T0 + DAY, instance: 'quest', name: 'rope' });
    // Not its business: another instance's, another type, a record of the core's.
    log.write({ type: 'quest.gain', t: T0 + 2000, instance: 'other', name: 'nothing' });
    log.write({ type: 'core.plugin', t: T0 + 3000, plugin: 'quest' });

    const second = await boot({ at: T0 + DAY + 60_000 });
    // In the log's order: each day's as written, the days merged by time (the old day's first).
    expect(second.read('get', { path: 'inventory.items' })).toEqual([
      { name: 'rope', count: 3 },
      { name: 'map', count: 1 },
      { name: 'lamp', count: 1 },
    ]);
    // The catch-up announced once, its sections summed.
    expect(second.changed.map((c) => [c['sections'], c['event']])).toEqual([
      [['inventory'], undefined],
    ]);
    // Live again, at once.
    await second.emit('quest.gain', { name: 'map' });
    expect(second.read('count', { name: 'map' })).toBe(2);
    await second.core.stop();

    // Nothing new: nothing applied twice.
    const third = await boot({ at: T0 + DAY + 120_000 });
    expect(third.read('get', { path: 'inventory.items' })).toEqual([
      { name: 'rope', count: 3 },
      { name: 'map', count: 2 },
      { name: 'lamp', count: 1 },
    ]);
    expect(third.changed).toEqual([]);
    await third.core.stop();
  });

  it('applies what a node published before it started from the log, and the rest live', async () => {
    // The parser, before the state in the load order, publishes at its start: the log holds it.
    const run = await boot({
      plugins: [questParser((publish) => publish('quest.gain', { name: 'early' })), questState()],
    });
    await run.emit('quest.gain', { name: 'late' });
    expect(run.read('get', { path: 'inventory.items' })).toEqual([
      { name: 'early', count: 1 },
      { name: 'late', count: 1 },
    ]);
    await run.core.stop();
  });

  it('keeps its state once a delivery is over, so an event published inside one is not passed', async () => {
    // Another subscriber, heard first, answers a gain with a bonus: the bonus reaches the state
    // before the gain does, though the log holds the gain first. The state is kept once both are
    // applied, its cursor past both, and a restart applies neither again.
    const echo = definePlugin({
      manifest: {
        id: 'echo',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'Answers a gain with a bonus',
        games: { registers: ['echo'] },
        events: { 'echo.bonus': z.object({}) },
        inputs: { events: { type: 'events', namespace: 'quest' } },
      },
      create: (ctx) => ({
        start() {
          ctx.bus.subscribe('quest.gain', () => ctx.bus.publish('echo.bonus', {}));
        },
      }),
    });
    const both = (): Plugin =>
      statePlugin<{ items: number; bonus: number }>({
        id: 'quest-state',
        description: 'Gains and bonuses',
        schema: z.object({ items: z.number(), bonus: z.number() }),
        initial: { items: 0, bonus: 0 },
        consumes: ['quest.gain', 'echo.bonus'],
        reduce: (s, e) =>
          e.type === 'echo.bonus' ? { ...s, bonus: s.bonus + 1 } : { ...s, items: s.items + 1 },
      });
    const run = await boot({ plugins: [questParser(), echo, both()] });
    await run.emit('quest.gain', { name: 'rope' });
    expect(run.kept()['state']).toEqual({ items: 1, bonus: 1 });
    expect(run.changed.map((c) => c['sections'])).toEqual([['bonus'], ['items']]);
    await run.core.stop();
    const again = await boot({ plugins: [questParser(), echo, both()] });
    expect(again.read('get')).toEqual({ items: 1, bonus: 1 });
    await again.core.stop();
  });

  it('announces again at its start a change kept and not known announced (a crash between)', async () => {
    const first = await boot();
    await first.emit('quest.level', { level: 4 });
    await first.core.stop();
    // The crash: the state kept with its change, the announcement's note not written.
    fs.writeFileSync(
      path.join(dir, 'data', 'instances', 'quest-state', `${ANNOUNCED_DOC}.json`),
      JSON.stringify({ batch: 0 })
    );
    const second = await boot();
    expect(second.changed.map((c) => c['sections'])).toEqual([['profile']]);
    await second.core.stop();
    const third = await boot();
    expect(third.changed).toEqual([]);
    await third.core.stop();
  });

  it('passes an event its reducer refuses, records why, and never tries it again', async () => {
    const records: BusEvent[] = [];
    const reducer = (s: QuestState, e: BusEvent): QuestState => {
      if (e['name'] === 'bad') throw new Error('no such item');
      if (e['name'] === 'odd') return { ...s, profile: { level: 'x' as unknown as number } };
      return { ...s, profile: { level: s.profile.level + 1 } };
    };
    const run = await boot({
      plugins: [questParser(), questState({ reduce: reducer })],
      onRecord: (r) => {
        if (r.type === 'quest-state.refused') records.push(r);
      },
    });
    await run.emit('quest.gain', { name: 'bad' });
    await run.emit('quest.gain', { name: 'odd' });
    await run.emit('quest.gain', { name: 'fine' });
    expect(run.read('get', { path: 'profile.level' })).toBe(2);
    expect(records.map((r) => r['reason'])).toEqual([
      'no such item',
      expect.stringContaining('a state its schema refuses'),
    ]);
    await run.core.stop();
    const again = await boot({ plugins: [questParser(), questState({ reduce: reducer })] });
    expect(again.read('get', { path: 'profile.level' })).toBe(2);
    await again.core.stop();
  });

  it('offers its view, its schema and its pins, and a line of it for its card', async () => {
    const run = await boot({ pin: ['inventory.items', 'inventory.gold', 'profile.level'] });
    await run.emit('quest.inventory', {
      items: [
        { name: 'rope', count: 2 },
        { name: 'lamp', count: 1 },
      ],
      gold: 40,
    });
    const view = run.core.controls.view('quest-state');
    expect(view).toMatchObject({
      value: {
        state: { inventory: { gold: 40 } },
        pin: ['inventory.items', 'inventory.gold', 'profile.level'],
        updatedAt: T0,
        freshness: { inventory: { deltas: 0 } },
      },
    });
    const schema = (
      view as unknown as { value: { schema: { properties: Record<string, unknown> } } }
    ).value.schema;
    expect(schema.properties['inventory']).toMatchObject({ description: 'Inventory' });
    const plugins = run.core.controls.status().plugins;
    expect(plugins.find((p) => p.id === 'quest-state')?.summary).toBe('2 Items · Gold: 40');
    expect(plugins.find((p) => p.id === 'quest')?.summary).toBeUndefined();
    expect(run.core.controls.view('quest')).toBeUndefined();
    expect(run.core.controls.view('nobody')).toBeUndefined();
    await run.core.stop();
  });

  it('requires its parsers: one stopped takes it down at once, and what requires it', async () => {
    // A parser stopped (a protocol changed, the owner's Stop): a state node still running would be
    // frozen in time while the nodes acting on it go on asking; it and they are inactive at once.
    const run = await boot({ plugins: [questParser(), questState(), buyer()] });
    expect(questState().manifest.inputs?.['events']?.optional).toBeUndefined();
    expect(run.core.stopNode('quest', 'its protocol changed', 'owner')).toBe(true);
    expect(run.core.state('quest-state')).toMatchObject({
      state: 'inactive',
      reason: 'needs quest (stopped)',
    });
    expect(run.core.state('buyer')).toMatchObject({
      state: 'inactive',
      reason: 'needs quest-state (inactive)',
    });
    await run.core.stop();
    // At the next start too, until its stop is cleared; and a graph without its parser is refused.
    const again = await boot({ plugins: [questParser(), questState(), buyer()] });
    expect(again.core.state('quest-state')?.state).toBe('inactive');
    await again.core.stop();
    await expect(boot({ plugins: [questState()] })).rejects.toThrow(
      /input port events \(events of quest\) is not bound/u
    );
  });

  it('on its parser’s drift keeps running, and the actors that require it stop', async () => {
    // Drift stops the actors that require the parser, through the state node too (P5, D65); the
    // state node itself, kind stats, goes on, as any node that does not act.
    let drift: PluginContext['drift'] | undefined;
    const parser = definePlugin({
      ...questParser(),
      manifest: { ...questParser().manifest, drift: { unreadAt: 1, windowMin: 5 } },
      create: (ctx) => ((drift = ctx.drift), {}),
    });
    const run = await boot({ plugins: [parser, questState(), buyer()] });
    drift?.unread({ text: 'a new line' });
    drift?.unread({ text: 'another' });
    expect(run.core.state('buyer')).toMatchObject({ state: 'stopped', stop: { source: 'drift' } });
    expect(run.core.state('quest-state')?.state).toBe('running');
    await run.core.stop();
  });

  it('refuses a pin that names no path of its state', async () => {
    await expect(boot({ pin: ['inventory.nothing'] })).rejects.toThrow(
      /no such path in the state/u
    );
  });

  it('refuses a spec that cannot work, naming why', () => {
    const base = {
      id: 'quest-state',
      description: 'x',
      schema: QuestState,
      initial: { inventory: { items: [], gold: 0 }, profile: { level: 1 } },
      consumes: ['quest.gain'],
      reduce: (s: QuestState) => s,
    };
    expect(() => statePlugin({ ...base, id: 'Bad' })).toThrow(/lower-case/u);
    expect(() => statePlugin({ ...base, consumes: [] })).toThrow(/consumes no event type/u);
    expect(() => statePlugin({ ...base, consumes: ['quest'] })).toThrow(/not an event type/u);
    expect(() => statePlugin({ ...base, consumes: ['quest-state.changed'] })).toThrow(/its own/u);
    expect(() =>
      statePlugin({ ...base, queries: { get: { help: '', output: z.unknown(), run: () => 1 } } })
    ).toThrow(/cannot be named get/u);
    expect(() =>
      statePlugin({
        ...base,
        initial: { inventory: { items: [], gold: 'x' }, profile: { level: 1 } } as never,
      })
    ).toThrow(/initial state does not fit/u);
  });

  it('fails a node whose kept state its schema refuses, and reads its namespaces apart', async () => {
    const run = await boot();
    await run.core.stop();
    const file = path.join(dir, 'data', 'instances', 'quest-state', `${STATE_DOC}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...run.kept(), state: { inventory: 1 } }));
    const again = await boot();
    expect(again.core.state('quest-state')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('a migration is missing'),
    });
    await again.core.stop();
    // Several namespaces: an events input each.
    const two = statePlugin({
      id: 'both',
      description: 'x',
      schema: z.object({ n: z.number() }),
      initial: { n: 0 },
      consumes: ['quest.gain', 'other.gain'],
      reduce: (s) => s,
      migrations: [],
    });
    expect(Object.keys(two.manifest.inputs ?? {})).toEqual(['quest-events', 'other-events']);
  });
});
