/**
 * An events input whose namespace is its edge's (docs/bot-os.md D156, #75): `namespace: { edge:
 * true }`. The port always exists; its one edge, from any events output, gives it that output's
 * namespace (a node that registers its own id, as a collection: the node bound); its plugin
 * subscribes relative to it and learns the namespace from the bus; with no edge it hears nothing.
 * Made up: `shelf` nodes, each announcing `<its id>.changed`, and a `postcard` that watches one.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusHandle } from './bus.ts';
import { DevKit } from './devkit.ts';
import { defaultGraph, type GraphInput, resolveGraph } from './graph.ts';
import { describeInputs } from './graph-view.ts';
import { type Manifest, type ManifestInput, parseManifest } from './manifest.ts';
import { definePlugin, type Plugin, type PluginContext } from './plugin.ts';
import { describePort, mismatch, resolveInputs } from './ports.ts';

const changed = z.object({ id: z.string() });

/** A node that announces its own changes, in its own id's namespace (as a collection, D155). */
function shelf(got: Record<string, BusHandle>): Plugin {
  return definePlugin({
    manifest: {
      id: 'shelf',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'Things on a shelf',
      node: (_config, id) => ({
        id: 'shelf',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'Things on a shelf',
        games: { registers: [id] },
        events: { [`${id}.changed`]: changed },
      }),
    },
    create: (ctx) => {
      got[ctx.id] = ctx.bus;
      return {};
    },
  });
}

const POSTCARD: ManifestInput = {
  id: 'postcard',
  version: '0.1.0',
  kinds: ['stats'],
  description: 'Remakes its cards when its cast changes',
  inputs: {
    'cast-events': {
      type: 'events',
      namespace: { edge: true },
      optional: true,
      help: 'The changes of the collection its cards are made from',
    },
  },
};

/** The postcard: it hears `changed` of whatever its edge binds, and says whose. */
function postcard(heard: string[], bound: (string | undefined)[], held: PluginContext[] = []) {
  return definePlugin({
    manifest: POSTCARD,
    create: (ctx) => {
      held.push(ctx);
      bound.push(ctx.bus.namespace('cast-events'));
      ctx.bus.subscribeTo('cast-events', 'changed', (e) =>
        heard.push(`${e.type} ${String(e['id'])}`)
      );
      ctx.bus.subscribeTo('cast-events', '*', (e) => heard.push(`* ${e.type}`));
      return {};
    },
  });
}

const graph = (edges: GraphInput['edges']): GraphInput => ({
  version: 2,
  nodes: [
    { id: 'hosts', plugin: 'shelf' },
    { id: 'props', plugin: 'shelf' },
    { id: 'postcard', plugin: 'postcard' },
  ],
  edges,
});

async function start(edges: GraphInput['edges']) {
  const got: Record<string, BusHandle> = {};
  const heard: string[] = [];
  const bound: (string | undefined)[] = [];
  const held: PluginContext[] = [];
  const kit = new DevKit({
    plugins: [shelf(got), postcard(heard, bound, held)],
    graph: graph(edges),
  });
  await kit.start();
  const read = (type: string) => (held[0] as PluginContext).events.read({ type });
  return { kit, got, heard, bound, read };
}

const manifests = (): Map<string, Manifest> =>
  new Map(
    [shelf({}), postcard([], [])].map((p) => {
      const m = parseManifest(p.manifest);
      return [m.id, m];
    })
  );

describe('an events input from its edge (D156)', () => {
  it('hears the node its edge comes from, relative to it, and knows its id', async () => {
    const { got, heard, bound, kit, read } = await start([
      { from: 'hosts.events', to: 'postcard.cast-events' },
    ]);
    expect(bound).toEqual(['hosts']);
    got['hosts']?.publish('hosts.changed', { id: 'r1' });
    // Another node's, of another namespace, is not heard.
    got['props']?.publish('props.changed', { id: 'r9' });
    expect(heard).toEqual(['hosts.changed r1', '* hosts.changed']);
    // Its history is the bound node's too.
    expect(read('hosts.changed').map((e) => e['id'])).toEqual(['r1']);
    await kit.stop();
  });

  it('hears nothing with no edge, and its port is there all the same', async () => {
    const { got, heard, bound, kit, read } = await start([]);
    expect(bound).toEqual([undefined]);
    got['hosts']?.publish('hosts.changed', { id: 'r1' });
    expect(heard).toEqual([]);
    expect(() => read('hosts.changed')).toThrow('postcard does not read hosts');
    await kit.stop();
  });

  it('refuses a port that is not one of its events inputs', () => {
    const kit = new DevKit({ plugins: [postcard([], [])] });
    const bus = kit.core['bus'].handle(
      'postcard',
      parseManifest(POSTCARD),
      new Map(),
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      'postcard',
      { 'cast-events': '' }
    );
    expect(() => bus.namespace('cast')).toThrow(
      'postcard has no events input cast: its are cast-events'
    );
    expect(() =>
      kit.core['bus'].handle('x', parseManifest(POSTCARD), new Map(), {} as never).namespace('a')
    ).toThrow('x has no events input a');
    // Unbound: a stop that does nothing.
    expect(() => bus.subscribeTo('cast-events', 'changed', () => {})()).not.toThrow();
  });

  it('is bound by the check to one edge from any events output, and drawn as such', () => {
    const plugins = manifests();
    const { nodes } = resolveGraph(
      graph([{ from: 'hosts.events', to: 'postcard.cast-events' }]),
      plugins
    );
    const card = nodes.find((n) => n.id === 'postcard');
    expect(card?.ports['cast-events']).toMatchObject({
      type: 'events',
      namespace: 'hosts',
      edge: true,
    });
    // With no edge, the port is there, its namespace unknown.
    const free = resolveGraph(graph([]), plugins).nodes.find((n) => n.id === 'postcard');
    expect(free?.ports['cast-events']).toMatchObject({ namespace: '', edge: true });
    expect(describePort(free?.ports['cast-events'] as never)).toBe(
      'events of the node its edge comes from'
    );
    expect(describePort(card?.ports['cast-events'] as never)).toBe('events of hosts');
    expect(describePort(plugins.get('postcard')?.inputs['cast-events'] as never)).toBe(
      'events of the node its edge comes from'
    );
    // The editor draws it so, with nothing to configure.
    const m = plugins.get('postcard') as Manifest;
    expect(describeInputs(m, resolveInputs(m.inputs, undefined).ports)['cast-events']).toEqual({
      type: 'events',
      edge: true,
      label: 'events of the node its edge comes from',
      optional: true,
      help: 'The changes of the collection its cards are made from',
    });
    expect(
      mismatch(free?.ports['cast-events'] as never, { type: 'events', namespace: 'anything' })
    ).toBeUndefined();
  });

  it('refuses a second edge, an output of another type, and none when required', () => {
    const plugins = manifests();
    expect(() =>
      resolveGraph(
        graph([
          { from: 'hosts.events', to: 'postcard.cast-events' },
          { from: 'props.events', to: 'postcard.cast-events' },
        ]),
        plugins
      )
    ).toThrow(
      'node postcard: input port cast-events takes one edge: its namespace is the node its edge comes from (edge props.events → postcard.cast-events)'
    );
    expect(() =>
      resolveGraph(graph([{ from: 'hosts.interface', to: 'postcard.cast-events' }]), plugins)
    ).toThrow('interface of shelf cannot bind events of the node its edge comes from');
    const required = parseManifest({
      ...POSTCARD,
      inputs: { 'cast-events': { type: 'events', namespace: { edge: true } } },
    });
    expect(() => resolveGraph(graph([]), new Map([...plugins, ['postcard', required]]))).toThrow(
      'node postcard: input port cast-events (events of the node its edge comes from) is not bound'
    );
    expect(() =>
      parseManifest({
        ...POSTCARD,
        inputs: { 'cast-events': { type: 'events', namespace: { edge: false } } },
      })
    ).toThrow('bad manifest');
  });

  it('is bound by the programmatic wiring only where its manifest says', () => {
    const watcher = parseManifest({
      ...POSTCARD,
      inputs: {
        'cast-events': { type: 'events', namespace: { edge: true }, bind: { nodes: ['dice'] } },
        free: { type: 'events', namespace: { edge: true }, optional: true },
      },
    });
    const dice = parseManifest({
      id: 'dice',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'Rolls',
      games: { registers: ['dice'] },
      events: { 'dice.roll': changed },
    });
    expect(defaultGraph([dice, watcher]).edges).toEqual([
      { from: 'dice.events', to: 'postcard.cast-events', type: 'events' },
    ]);
  });
});
