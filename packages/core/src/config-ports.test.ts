/**
 * Events inputs whose namespace comes from their node's config (docs/bot-os-api.md §2.1): resolved
 * per node by the graph's check, the bus, the event log's reader and the graph view.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusEvent } from './bus.ts';
import { DevKit } from './devkit.ts';
import { type LogEntry } from './event-log.ts';
import { defaultGraph, GraphError, type GraphInput, nodeInputs, resolveGraph } from './graph.ts';
import { describeNodes, describePlugin } from './graph-view.ts';
import { type Manifest, type ManifestInput, parseManifest } from './manifest.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import { describePort, namespaceOf, resolveInputs } from './ports.ts';

const m = (id: string, more: Partial<ManifestInput> = {}): Manifest =>
  parseManifest({ id, version: '0.1.0', kinds: ['stats'], description: id, ...more });

/** A listener that learns from its config what it hears: `on`, an event type or a namespace. */
const listener = (optional = false): ManifestInput => ({
  id: 'listener',
  version: '0.1.0',
  kinds: ['stats'],
  description: 'hears what its config says',
  config: z.object({ on: z.string().optional(), unused: z.number().optional() }),
  inputs: { heard: { type: 'events', namespace: { config: 'on' }, optional } },
});

const image = (optional = false): Map<string, Manifest> =>
  new Map(
    [
      m('dice', { games: { registers: ['dice'] } }),
      m('cards', { games: { registers: ['cards'] } }),
      parseManifest(listener(optional)),
    ].map((x) => [x.id, x])
  );

const problems = (raw: GraphInput, plugins = image()): string[] => {
  try {
    resolveGraph(raw, plugins);
    return [];
  } catch (e) {
    if (e instanceof GraphError) return e.problems;
    throw e;
  }
};

const graph = (config: Record<string, unknown> | undefined, from = 'dice.events'): GraphInput => ({
  version: 2,
  nodes: [
    { id: 'dice', plugin: 'dice' },
    { id: 'cards', plugin: 'cards' },
    { id: 'ears', plugin: 'listener', ...(config === undefined ? {} : { config }) },
  ],
  edges: [{ from, to: 'ears.heard', type: 'events' }],
});

describe('an events input whose namespace its node’s config names', () => {
  it('reads the namespace of a value: a namespace, or an event type’s', () => {
    expect(namespaceOf('dice')).toBe('dice');
    expect(namespaceOf('dice.roll')).toBe('dice');
    expect(namespaceOf('Dice.roll')).toBeUndefined();
    expect(namespaceOf(3)).toBeUndefined();
    expect(describePort({ type: 'events', namespace: { config: 'on' }, optional: false })).toBe(
      'events of config on'
    );
  });

  it('is resolved per node, from the config, or is a problem naming its port', () => {
    const { inputs } = parseManifest(listener());
    expect(resolveInputs(inputs, { on: 'dice.roll' })).toEqual({
      ports: { heard: { type: 'events', namespace: 'dice', optional: false } },
      problems: [],
    });
    expect(resolveInputs(inputs, {}).problems).toEqual([
      'input port heard: its namespace comes from config on, which is not set',
    ]);
    expect(resolveInputs(inputs, { on: 'Not One' }).problems).toEqual([
      'input port heard: its namespace comes from config on, and "Not One" names no event type or namespace',
    ]);
    // Optional, and not set: the node has no such port.
    expect(resolveInputs(parseManifest(listener(true)).inputs, undefined)).toEqual({
      ports: {},
      problems: [],
    });
  });

  it('must name a key of the plugin’s config', () => {
    expect(() => parseManifest({ ...listener(), config: z.object({ other: z.string() }) })).toThrow(
      'inputs.heard.namespace: its config has no key on'
    );
    const { config: _, ...bare } = listener();
    expect(() => parseManifest(bare)).toThrow('its config has no key on');
  });

  it('binds an output of the namespace its config names, and no other', () => {
    const { nodes } = resolveGraph(graph({ on: 'dice.roll' }), image());
    expect(nodes.find((n) => n.id === 'ears')?.inputs.get('heard')).toEqual([
      { node: 'dice', port: 'events', type: 'events' },
    ]);
    expect(problems(graph({ on: 'cards' }))).toEqual([
      'node ears: input port heard: events of dice cannot bind events of cards (edge dice.events → ears.heard)',
    ]);
    expect(resolveGraph(graph({ on: 'cards' }, 'cards'), image()).graph.edges).toEqual([
      { from: 'cards.events', to: 'ears.heard', type: 'events' },
    ]);
  });

  it('refuses a node whose config leaves a required one unresolved, naming the node', () => {
    expect(problems({ ...graph(undefined), edges: [] })).toEqual([
      'node ears: input port heard: its namespace comes from config on, which is not set',
    ]);
    expect(problems({ ...graph({ on: '?' }), edges: [] })).toEqual([
      'node ears: input port heard: its namespace comes from config on, and "?" names no event type or namespace',
    ]);
  });

  it('leaves an optional one out of a node whose config does not set it', () => {
    expect(problems({ ...graph({}), edges: [] }, image(true))).toEqual([]);
    expect(problems(graph({}), image(true))).toEqual([
      'node ears: no input port heard: its namespace comes from config on, which is not set',
    ]);
  });

  it('is resolved from the config as its schema makes it, defaults included', () => {
    const defaulted = parseManifest({
      ...listener(),
      config: z.object({ on: z.string().default('cards.draw') }),
    });
    expect(nodeInputs(defaulted, undefined).ports['heard']).toMatchObject({ namespace: 'cards' });
    // A config the schema refuses: as written.
    expect(nodeInputs(defaulted, { on: 5 }).problems).toHaveLength(1);
    expect(
      nodeInputs(parseManifest({ ...listener(), config: z.strictObject({ on: z.string() }) }), {
        on: 'dice',
        bad: 1,
      }).ports['heard']
    ).toMatchObject({ namespace: 'dice' });
  });

  it('is bound by the default graph to the nodes registering the namespace its config names', () => {
    const plugins = [...image().values()];
    expect(defaultGraph(plugins, { listener: { on: 'cards.draw' } }).edges).toEqual([
      { from: 'cards.events', to: 'listener.heard', type: 'events' },
    ]);
    expect(defaultGraph(plugins).edges).toEqual([]);
  });

  it('is drawn with its key, and resolved on each node', () => {
    const manifest = parseManifest(listener());
    expect(describePlugin(manifest).inputs['heard']).toEqual({
      type: 'events',
      config: 'on',
      label: 'events of config on',
      optional: false,
    });
    const { graph: g, nodes } = resolveGraph(graph({ on: 'dice.roll' }), image());
    const view = (ns: typeof nodes) => describeNodes(ns, g).find((n) => n.id === 'ears')?.inputs;
    const resolved = {
      heard: {
        type: 'events',
        namespace: 'dice',
        config: 'on',
        label: 'events of dice',
        optional: false,
      },
    };
    expect(view(nodes)).toEqual(resolved);
    // Without the host's ports: from the graph's node.
    expect(view(nodes.map(({ id, manifest: mf }) => ({ id, manifest: mf }) as never))).toEqual(
      resolved
    );
  });
});

describe('a plugin with such an input', () => {
  const T0 = Date.UTC(2026, 10, 5, 12);
  const roll = z.object({ value: z.number() });

  it('hears, and reads back, the namespace its config names', async () => {
    let dice: PluginContext | undefined;
    let ears: PluginContext | undefined;
    const history: LogEntry[] = [{ type: 'dice.roll', t: T0 - 1000, value: 1 }];
    const kit = new DevKit({
      start: T0,
      history,
      config: { listener: { on: 'dice.roll' } },
      plugins: [
        definePlugin({
          manifest: {
            id: 'dice',
            version: '0.1.0',
            kinds: ['parser'],
            description: 'rolls',
            games: { registers: ['dice'] },
            events: { 'dice.roll': roll },
          },
          create: (ctx) => {
            dice = ctx;
            return {};
          },
        }),
        definePlugin({
          manifest: listener(),
          create: (ctx) => {
            ears = ctx;
            return {};
          },
        }),
      ],
    });
    await kit.start();
    const heard: BusEvent[] = [];
    ears?.bus.subscribe('dice.roll', (e) => heard.push(e));
    dice?.bus.publish('dice.roll', { value: 6 });
    expect(heard.map((e) => e['value'])).toEqual([6]);
    expect(ears?.events.read({ type: 'dice.roll' }).map((r) => r['value'])).toEqual([1, 6]);
    expect(() => ears?.bus.subscribe('cards', () => {})).toThrow('listener does not consume cards');
    expect(() => ears?.events.read({ type: 'cards' })).toThrow('listener does not read cards');
  });
});
