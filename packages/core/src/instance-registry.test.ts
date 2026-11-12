import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { Core, type CoreOptions } from './core.ts';
import { type GraphInput } from './graph.ts';
import { InstanceRegistry, ORPHAN_MS } from './instance-registry.ts';
import { definePlugin } from './plugin.ts';
import { Stores } from './store.ts';

const DAY = 86_400_000;

/** A counter that keeps its count, a timer and a setting in its instance. */
const counter = definePlugin({
  manifest: {
    id: 'counter',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'counts its starts',
    settings: z.object({ step: z.coerce.number().int().default(1) }),
    interface: { state: { count: { help: 'the count', output: z.number() } } },
  },
  create: (ctx) => {
    const step = (ctx.settings.kept()['step'] as number | undefined) ?? 1;
    return {
      start: () => {
        ctx.store.write('count', (ctx.store.read<number>('count') ?? 0) + step);
        ctx.scheduler.after('later', DAY * 30);
      },
      interface: { state: { count: () => ctx.store.read<number>('count') ?? 0 } },
    };
  },
});
const other = definePlugin({
  manifest: { id: 'other', version: '0.1.0', kinds: ['stats'], description: 'another plugin' },
  create: () => ({}),
});

let dataDir: string;
let clock: VirtualClock;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instances-'));
  clock = new VirtualClock(Date.UTC(2026, 10, 1));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function core(graph: GraphInput, o: Partial<CoreOptions> = {}): { core: Core; lines: string[] } {
  const lines: string[] = [];
  const c = new Core({ clock, dataDir, graph, print: (l) => lines.push(l), ...o });
  c.register(counter, other);
  return { core: c, lines };
}

const read = (file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as unknown;

describe('instances apart from nodes', () => {
  it('file a node’s state under its instance, which another node of its plugin takes up', async () => {
    const first = core({
      version: 2,
      nodes: [{ id: 'a', plugin: 'counter', instance: 'tally', settings: { step: 2 } }],
    }).core;
    await first.start();
    expect(first.controls.read('a', 'count')).toEqual({ value: 2 });
    expect(first.stopNode('a', 'a safety stop', 'safety')).toBe(true);
    await first.stop();
    const dir = path.join(dataDir, 'instances', 'tally');
    expect(fs.readdirSync(dir).sort()).toEqual([
      '_instance.json',
      '_settings.json',
      '_stop.json',
      '_timers.json',
      'count.json',
    ]);
    expect(read('instances/tally/_instance.json')).toEqual({
      plugin: 'counter',
      created: clock.now(),
      referenced: clock.now(),
    });
    expect(read('instances/tally/_stop.json')).toEqual({
      reason: 'a safety stop',
      time: new Date(clock.now()).toISOString(),
      source: 'safety',
    });
    // Another node, on the same instance: its count, its settings, its timer and its stop.
    const second = core({
      version: 2,
      nodes: [{ id: 'b', plugin: 'counter', instance: 'tally' }],
    }).core;
    await second.start();
    expect(second.state('b')).toMatchObject({ state: 'stopped', reason: 'a safety stop' });
    expect(second.clearStop('b')).toBe(true);
    await second.stop();
    const third = core({
      version: 2,
      nodes: [{ id: 'b', plugin: 'counter', instance: 'tally' }],
    }).core;
    await third.start();
    expect(third.controls.read('b', 'count')).toEqual({ value: 4 });
    expect(third.instances()).toEqual([
      {
        id: 'tally',
        plugin: 'counter',
        created: clock.now(),
        referenced: clock.now(),
        node: 'b',
        used: true,
      },
    ]);
    await third.stop();
  });

  it('start a fresh instance in its node’s settings, and a node on its own id', async () => {
    const { core: c } = core({
      version: 2,
      nodes: [{ id: 'c', plugin: 'counter', settings: { step: 5 } }],
    });
    await c.start();
    expect(c.controls.read('c', 'count')).toEqual({ value: 5 });
    expect(fs.existsSync(path.join(dataDir, 'instances', 'c', '_instance.json'))).toBe(true);
    await c.stop();
  });

  it('refuse an instance of another plugin, one instance for two nodes, and bad settings', () => {
    new InstanceRegistry(new Stores(dataDir), () => 0).create('kept', 'other');
    let problems = '';
    try {
      core({ version: 2, nodes: [{ id: 'x', plugin: 'counter', instance: 'kept' }] }).core.load();
    } catch (e) {
      problems = (e as Error).message;
    }
    expect(problems).toBe('node x: its instance kept is of the plugin other, not counter');
    const again = core({
      version: 2,
      nodes: [
        { id: 'b', plugin: 'counter', instance: 'shared' },
        { id: 'c', plugin: 'counter', instance: 'shared' },
      ],
    }).core;
    expect(() => again.load()).toThrow("node c: its instance shared is node b's");
    const bad = core({
      version: 2,
      nodes: [
        { id: 'c', plugin: 'counter', settings: { step: 'x', nope: 1 } },
        { id: 'd', plugin: 'other', settings: { any: 1 } },
      ],
    }).core;
    expect(() => bad.load()).toThrow(
      [
        'plugin c: settings step: Invalid input: expected number, received NaN',
        'plugin c: settings nope: no such setting',
        'plugin d: settings any: no such setting',
      ].join('\n')
    );
    expect(() => new InstanceRegistry(new Stores(dataDir), () => 0).create('kept', 'x')).toThrow(
      'the instance kept exists already'
    );
  });

  it('delete an instance no node has referenced for 7 days, at start and daily', async () => {
    const first = core({ version: 2, nodes: [{ id: 'a', plugin: 'counter', instance: 'old' }] });
    await first.core.start();
    await first.core.stop();
    // A directory without its record is left alone.
    fs.mkdirSync(path.join(dataDir, 'instances', 'by-hand'));
    clock.advance(DAY);
    // The saved graph references `saved`, which no running node does.
    new InstanceRegistry(new Stores(dataDir), () => clock.now()).create('saved', 'counter');
    const records: unknown[] = [];
    const empty = core(
      { version: 2, nodes: [] },
      { referenced: () => new Set(['saved']), record: (r) => records.push(r) }
    );
    await empty.core.start();
    expect(empty.core.instances().map((i) => [i.id, i.used])).toEqual([
      ['by-hand', false],
      ['old', false],
      ['saved', true],
    ]);
    clock.advance(ORPHAN_MS - 2 * DAY);
    expect(fs.existsSync(path.join(dataDir, 'instances', 'old'))).toBe(true);
    clock.advance(DAY);
    expect(fs.existsSync(path.join(dataDir, 'instances', 'old'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'instances', 'saved'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'instances', 'by-hand'))).toBe(true);
    expect(empty.lines).toContain('core: instance old deleted, unused for 7 days');
    expect(records).toContainEqual({
      type: 'core.instance',
      t: clock.now(),
      instance: 'old',
      event: 'deleted',
    });
    await empty.core.stop();
    // Stopped, it sweeps no more; and a saved graph that does not read keeps every instance.
    clock.advance(30 * DAY);
    expect(fs.existsSync(path.join(dataDir, 'instances', 'saved'))).toBe(true);
    const unread = core({ version: 2, nodes: [] }, { referenced: () => undefined }).core;
    await unread.start();
    expect(unread.sweepInstances()).toEqual([]);
    expect(unread.instances().find((i) => i.id === 'saved')?.used).toBe(false);
    await unread.stop();
    const none = core({ version: 2, nodes: [] }).core;
    await none.start();
    expect(fs.existsSync(path.join(dataDir, 'instances', 'saved'))).toBe(false);
    await none.stop();
  });

  it('list and expire instances in memory too', async () => {
    const c = new Core({ clock, graph: { version: 2, nodes: [{ id: 'a', plugin: 'counter' }] } });
    c.register(counter);
    await c.start();
    expect(c.instances().map((i) => i.id)).toEqual(['a']);
    await c.stop();
    const stores = new Stores();
    const registry = new InstanceRegistry(stores, () => clock.now());
    registry.create('x', 'counter');
    stores.internal('y').put('_instance', 'not a record');
    expect(registry.meta('y')).toBeUndefined();
    expect(registry.meta('nobody')).toBeUndefined();
    clock.advance(ORPHAN_MS);
    expect(registry.sweep(new Set())).toEqual(['x']);
    expect(stores.ids()).toEqual(['y']);
    fs.mkdirSync(path.join(dataDir, 'instances', 'z'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'instances', 'z', '_instance.json'), '{half');
    expect(new InstanceRegistry(new Stores(dataDir), () => 0).meta('z')).toBeUndefined();
  });
});
