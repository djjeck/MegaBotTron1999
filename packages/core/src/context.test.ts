import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { secretsWith } from '#test/secrets.ts';
import { VirtualClock } from './clock.ts';
import { Core, StartError } from './core.ts';
import { DevKit, FakeConnector } from './devkit.ts';
import { type LogEntry, MemoryEventLog } from './event-log.ts';
import { parseManifest } from './manifest.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 12);

/** A game's parser: it registers `dice`, and replays the last hours of its rolls at `ready`. */
function parser(seen: PluginContext[]) {
  return definePlugin({
    manifest: {
      id: 'dice',
      version: '0.1.0',
      kinds: ['parser'],
      description: 'reads the dice',
      games: { registers: ['dice'] },
      events: { 'dice.roll': z.object({ value: z.number() }) },
    },
    create: (ctx) => {
      seen.push(ctx);
      return {};
    },
  });
}

/** A ledger of the dice's rolls: it consumes `dice`. */
function ledger(seen: PluginContext[]) {
  return definePlugin({
    manifest: {
      id: 'ledger',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'counts the rolls',
      inputs: { rolls: { type: 'events', namespace: 'dice' } },
    },
    create: (ctx) => {
      seen.push(ctx);
      return {};
    },
  });
}

const history: LogEntry[] = [
  { type: 'dice.roll', t: T0 - 30 * HOUR, value: 1 },
  { type: 'dice.roll', t: T0 - 2 * HOUR, value: 2 },
  { type: 'dice.reset', t: T0 - HOUR },
  { type: 'secret.thing', t: T0 - HOUR },
  { type: 'ledger.total', t: T0 - HOUR, total: 3 },
];

describe('the context’s event log', () => {
  it('reads the namespaces a plugin registers or consumes, whole or since a time', async () => {
    const seen: PluginContext[] = [];
    const kit = new DevKit({ start: T0, history, plugins: [parser(seen), ledger(seen)] });
    await kit.start();
    const [dice, counter] = seen as [PluginContext, PluginContext];
    // The whole log, of its own namespace: a fresh instance reading it once.
    expect(dice.events.read({ type: 'dice' }).map((r) => r.t)).toEqual([
      T0 - 30 * HOUR,
      T0 - 2 * HOUR,
      T0 - HOUR,
    ]);
    // One type, the last hours: a replay at `ready`.
    expect(dice.events.read({ type: 'dice.roll', since: T0 - 3 * HOUR })).toEqual([
      { type: 'dice.roll', t: T0 - 2 * HOUR, value: 2 },
    ]);
    // Everything it may read: its own and what it consumes, nothing else.
    expect(counter.events.read().map((r) => r.type)).toEqual([
      'dice.roll',
      'dice.roll',
      'dice.reset',
      'ledger.total',
    ]);
    expect(counter.events.read({ until: T0 - 3 * HOUR })).toHaveLength(1);
    expect(() => dice.events.read({ type: 'secret.thing' })).toThrow(
      'dice does not read secret: it reads dice (add an events input of it)'
    );
    expect(() => counter.events.read({ type: 'secret' })).toThrow('ledger does not read secret');
    // What it records is read back.
    kit.clock.advance(1000);
    counter.record('ledger.total', { total: 4 });
    expect(counter.events.read({ type: 'ledger.total', since: T0 })).toEqual([
      { type: 'ledger.total', t: T0 + 1000, instance: 'ledger', total: 4 },
    ]);
    expect(() => counter.record('dice.roll', {})).toThrow(
      'ledger cannot record dice.roll: its namespaces are ledger'
    );
    expect(() => counter.record('ledger', {})).toThrow('ledger cannot record ledger');
    expect(kit.log.records.at(-1)).toEqual({
      type: 'ledger.total',
      t: T0 + 1000,
      instance: 'ledger',
      total: 4,
    });
  });

  it('reads its own instance’s records, and those of the nodes it hears, or all', async () => {
    const seen: PluginContext[] = [];
    const kit = new DevKit({
      start: T0,
      history: [
        { type: 'dice.roll', t: T0 - 3 * HOUR, value: 1 }, // imported: no instance
        { type: 'dice.roll', t: T0 - 2 * HOUR, instance: 'one', value: 2 },
        { type: 'dice.roll', t: T0 - HOUR, instance: 'two', value: 3 },
        { type: 'ledger.total', t: T0 - HOUR, instance: 'books', total: 1 },
        { type: 'ledger.total', t: T0 - HOUR, instance: 'other-books', total: 9 },
      ],
      plugins: [parser(seen), ledger(seen)],
      graph: {
        version: 1,
        nodes: [
          { id: 'd1', plugin: 'dice', instance: 'one' },
          { id: 'd2', plugin: 'dice', instance: 'two' },
          { id: 'books', plugin: 'ledger' },
        ],
        edges: [{ from: 'd1.events', to: 'books.rolls', type: 'events' }],
      },
    });
    await kit.start();
    const [d1, d2, books] = seen as [PluginContext, PluginContext, PluginContext];
    const values = (c: PluginContext, all?: boolean) =>
      c.events.read(all === undefined ? {} : { all }).map((r) => r['value'] ?? r['total']);
    // Its own instance's, and what has no instance; never the other instance's.
    expect(values(d1)).toEqual([1, 2]);
    expect(values(d2)).toEqual([1, 3]);
    expect(values(d1, true)).toEqual([1, 2, 3]);
    // A consumer: the instances its edges bind, as the bus delivers them, and its own records.
    expect(values(books)).toEqual([1, 2, 1]);
    expect(values(books, true)).toEqual([1, 2, 3, 1, 9]);
    // What it writes carries its instance.
    d2.bus.publish('dice.roll', { value: 4 });
    expect(kit.log.records.at(-1)).toMatchObject({ instance: 'two', value: 4 });
    expect(values(d2)).toEqual([1, 3, 4]);
    expect(values(d1)).toEqual([1, 2]);
  });

  it('reads nothing without a log, and the memory log knows its first day', async () => {
    const seen: PluginContext[] = [];
    const core = new Core({ clock: new VirtualClock(T0) });
    core.register(parser(seen));
    await core.start();
    expect(seen[0]?.events.read()).toEqual([]);
    expect(seen[0]?.record('dice.note', { x: 1 })).toBeUndefined();
    expect(new MemoryEventLog().firstDay()).toBeUndefined();
    expect(new MemoryEventLog(history).firstDay()).toBe(Date.UTC(2026, 10, 4));
    await core.stop();
  });
});

describe('the context’s connector services', () => {
  /** A connector of any number of nodes, each with the token its config names. */
  function service(seen: PluginContext[]) {
    return definePlugin({
      manifest: {
        id: 'api',
        version: '0.1.0',
        kinds: ['connector'],
        description: 'an API, one token per node',
        account: 'api:default',
        config: z.object({ token: z.string().optional() }),
        configSecrets: ['token'],
      },
      create: (ctx) => {
        seen.push(ctx);
        return { connector: new FakeConnector({ account: ctx.account ?? 'api:default' }) };
      },
    });
  }

  it('give each node its account, and the secret its config names', async () => {
    const seen: PluginContext[] = [];
    const core = new Core({
      clock: new VirtualClock(T0),
      secrets: secretsWith({ token_a: 'aaaa-1111', token_b: 'bbbb-2222' }),
      graph: {
        version: 1,
        nodes: [
          { id: 'a', plugin: 'api', account: 'api:a', config: { token: 'token_a' } },
          { id: 'b', plugin: 'api', account: 'api:b', config: { token: 'token_b' } },
          { id: 'c', plugin: 'api', account: 'api:c' },
        ],
        edges: [],
      },
    });
    core.register(service(seen));
    await core.start();
    const [a, b, c] = seen as [PluginContext, PluginContext, PluginContext];
    expect([a.account, b.account, c.account]).toEqual(['api:a', 'api:b', 'api:c']);
    expect(a.secrets?.get('token_a')).toBe('aaaa-1111');
    expect(b.secrets?.get('token_b')).toBe('bbbb-2222');
    expect(() => a.secrets?.get('token_b')).toThrow('a does not declare the secret token_b');
    expect(() => c.secrets?.get('token_a')).toThrow('c does not declare the secret token_a');
    expect(core.status().every((s) => s.state === 'running')).toBe(true);
    await core.stop();
  });

  it('refuse a config that names no secret, or one not provided', () => {
    const core = new Core({
      clock: new VirtualClock(T0),
      secrets: secretsWith({}),
      graph: {
        version: 1,
        nodes: [
          { id: 'a', plugin: 'api', account: 'api:a', config: { token: 'Not A Name' } },
          { id: 'b', plugin: 'api', account: 'api:b', config: { token: 'missing' } },
        ],
        edges: [],
      },
    });
    core.register(service([]));
    expect(() => core.load()).toThrow(StartError);
    const without = new Core({
      clock: new VirtualClock(T0),
      graph: {
        version: 1,
        nodes: [{ id: 'a', plugin: 'api', config: { token: 'missing' } }],
        edges: [],
      },
    });
    without.register(service([]));
    expect(() => without.load()).toThrow(
      'plugin a: the secret missing is not provided (no secrets/missing)'
    );
    const check = new Core({ clock: new VirtualClock(T0), secrets: secretsWith({}) });
    check.register(service([]));
    const r = check.check({
      version: 1,
      nodes: [
        { id: 'a', plugin: 'api', account: 'api:a', config: { token: 'Not A Name' } },
        { id: 'b', plugin: 'api', account: 'api:b', config: { token: 'missing' } },
      ],
      edges: [],
    });
    expect(r).toMatchObject({
      ok: false,
      problems: [
        {
          text: 'plugin a: config token: expected the name of a secret',
          node: 'a',
          config: 'token',
        },
        { node: 'b' },
      ],
    });
    expect(() =>
      parseManifest({
        id: 'x',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'x',
        configSecrets: ['token'],
      })
    ).toThrow('only a connector may hold secrets');
  });
});
