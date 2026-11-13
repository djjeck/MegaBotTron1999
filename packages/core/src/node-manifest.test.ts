/**
 * A node whose ports its config declares (bot-os.md D74): a plugin's `manifest.node` makes each
 * node's own manifest from its config and its id, checked as any manifest; its ports, kinds and
 * event types are the node's in the check, on the bus, in the queue and in the editor's views.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DevKit, FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { GraphError, type GraphInput, nodeManifest, resolveGraph } from './graph.ts';
import { type GraphFile, graphFileControls } from './graph-file.ts';
import { type Manifest, type ManifestInput, parseManifest } from './manifest.ts';
import { definePlugin, type Instance, type Plugin, type PluginContext } from './plugin.ts';

/** A made-up plugin whose node's config declares its ports: a tiny script node. */
const declaring = (create: (ctx: PluginContext) => Instance = () => ({})): Plugin => {
  const base: ManifestInput = {
    id: 'declared',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'Ports from its config',
    config: z.object({
      hears: z.string().optional(),
      sends: z.array(z.string()).optional(),
      spacing: z.number().optional(),
      broken: z.boolean().default(false),
    }),
  };
  return definePlugin({
    manifest: {
      ...base,
      node: (config, id) => {
        const c = config as {
          hears?: string;
          sends?: string[];
          spacing?: number;
          broken?: boolean;
        };
        if (c.broken === true) return { ...base, id: 'other' };
        return {
          ...base,
          kinds: c.sends === undefined ? ['stats'] : ['actor'],
          games: { registers: [id] },
          events: { [`${id}.done`]: z.object({ n: z.number() }).describe('Done') },
          inputs: c.hears === undefined ? {} : { heard: { type: 'events', namespace: c.hears } },
          outputs:
            c.sends === undefined
              ? {}
              : {
                  chat: {
                    type: 'chat-out',
                    commands: c.sends,
                    ...(c.spacing === undefined
                      ? {}
                      : { minIntervalS: { [c.sends[0] as string]: c.spacing } }),
                  },
                },
        };
      },
    },
    create,
  });
};

const game = definePlugin({
  manifest: {
    id: 'game',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'A game',
    games: { registers: ['game'] },
    events: { 'game.turn': z.object({ n: z.number() }) },
  },
  create: () => ({}),
});

const manifests = (...plugins: Plugin[]): Map<string, Manifest> =>
  new Map(plugins.map((p) => [p.manifest.id, parseManifest(p.manifest)]));

const problemsOf = (raw: GraphInput, plugins: Map<string, Manifest>): string[] => {
  try {
    resolveGraph(raw, plugins);
    return [];
  } catch (e) {
    if (e instanceof GraphError) return e.problems;
    throw e;
  }
};

describe('a node’s own manifest', () => {
  it('is its plugin’s for a plugin that declares none', () => {
    const base = parseManifest(game.manifest);
    expect(nodeManifest(base, 'g', {}).manifest).toBe(base);
  });

  it('gives each node the ports, kinds and events its config declares', () => {
    const { nodes } = resolveGraph(
      {
        version: 2,
        nodes: [
          { id: 'game', plugin: 'game' },
          { id: 'watch', plugin: 'declared', config: { hears: 'game' } },
          { id: 'idle', plugin: 'declared' },
        ],
        edges: [{ from: 'game.events', to: 'watch.heard' }],
      },
      manifests(game, declaring())
    );
    const watch = nodes.find((n) => n.id === 'watch');
    expect(Object.keys(watch?.ports ?? {})).toEqual(['heard']);
    expect(watch?.manifest.games.registers).toEqual(['watch']);
    expect(Object.keys(watch?.manifest.events ?? {})).toEqual(['watch.done']);
    expect(Object.keys(nodes.find((n) => n.id === 'idle')?.ports ?? {})).toEqual([]);
  });

  it('is refused as the node’s problem, its plugin’s standing in', () => {
    const plugins = manifests(game, declaring());
    expect(
      problemsOf(
        { version: 2, nodes: [{ id: 'x', plugin: 'declared', config: { broken: true } }] },
        plugins
      )
    ).toEqual(['node x: its manifest is of other, not declared']);
    const bad = nodeManifest(parseManifest(declaring().manifest), 'x', {
      hears: 'Not A Namespace',
    });
    expect(bad.problem).toMatch(/^node x: bad manifest: inputs\.heard/u);
    expect(bad.manifest.inputs).toEqual({});
  });

  it('is made from the config as written when its schema refuses it, which the load reports', () => {
    const base = parseManifest(declaring().manifest);
    const { manifest, problem } = nodeManifest(base, 'x', { hears: 'game', spacing: 'soon' });
    expect(problem).toBeUndefined();
    expect(Object.keys(manifest.inputs)).toEqual(['heard']);
  });
});

describe('a chat-out output that declares its commands', () => {
  const graph = (commands?: string[]): GraphInput => ({
    version: 2,
    nodes: [
      { id: 'tg', plugin: 'tg' },
      { id: 'look', plugin: 'declared', config: { sends: ['/look', '/inv'] } },
    ],
    edges: [
      {
        from: 'look.chat',
        to: 'tg.chat',
        sends: ['@QuestBot'],
        ...(commands === undefined ? {} : { commands }),
      },
    ],
  });
  const tg = fakeConnectorPlugin('tg', new FakeConnector({ account: 'telegram:alice' }));

  it('lets its edge allow those, or fewer', () => {
    expect(problemsOf(graph(['/look']), manifests(tg, declaring()))).toEqual([]);
  });

  it('refuses an edge that allows another, or any text', () => {
    expect(problemsOf(graph(['/look', '/buy']), manifests(tg, declaring()))).toEqual([
      'node look: output port chat sends only /look, /inv: its edge allows /buy too (edge look.chat → tg.chat)',
    ]);
    expect(problemsOf(graph(), manifests(tg, declaring()))).toEqual([
      'node look: output port chat sends only /look, /inv: its edge allows any text, name its commands (edge look.chat → tg.chat)',
    ]);
  });

  it('spaces its queued sends as it declares, under its edge’s own spacing', async () => {
    const connector = new FakeConnector({ account: 'telegram:alice' });
    let ctx: PluginContext | undefined;
    const kit = new DevKit({
      plugins: [
        fakeConnectorPlugin('tg', connector),
        declaring((c) => {
          ctx = c;
          return {};
        }),
      ],
      graph: {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'tg' },
          { id: 'look', plugin: 'declared', config: { sends: ['/look'], spacing: 60 } },
        ],
        edges: [{ from: 'look.chat', to: 'tg.chat', sends: ['@QuestBot'], commands: ['/look'] }],
      },
    });
    await kit.start();
    connector.open();
    const out = (ctx as PluginContext).outbox('chat');
    void out.enqueue('@QuestBot', '/look sword');
    void out.enqueue('@QuestBot', '/look shield');
    await kit.runUntil(1000);
    expect(connector.sent.map((s) => s.text)).toEqual(['/look sword']);
    await kit.runUntil(61_000);
    expect(connector.sent.map((s) => s.text)).toEqual(['/look sword', '/look shield']);
    await kit.stop();
  });
});

describe('the bus, for nodes of one plugin that register their own namespaces', () => {
  it('lets each publish its own events alone', async () => {
    const contexts = new Map<string, PluginContext>();
    const kit = new DevKit({
      plugins: [
        declaring((c) => {
          contexts.set(c.id, c);
          return {};
        }),
      ],
      graph: {
        version: 2,
        nodes: [
          { id: 'one', plugin: 'declared' },
          { id: 'two', plugin: 'declared' },
        ],
      },
    });
    await kit.start();
    const one = contexts.get('one') as PluginContext;
    one.bus.publish('one.done', { n: 1 });
    expect(() => one.bus.publish('two.done', { n: 2 })).toThrow(
      'one cannot publish two.done: declared registers it'
    );
    expect(kit.log.records.filter((e) => e.type === 'one.done')).toHaveLength(1);
    await kit.stop();
  });
});

describe('the editor’s views of such nodes', () => {
  it('draws each node as its config declares it, whether or not the graph checks', async () => {
    const kit = new DevKit({ plugins: [game, declaring()], graph: { version: 2, nodes: [] } });
    await kit.start();
    const raw = {
      version: 2,
      nodes: [
        { id: 'game', plugin: 'game' },
        { id: 'look', plugin: 'declared', config: { hears: 'game', sends: ['/look'] } },
        { id: 'bad', plugin: 'declared', config: { broken: true } },
        { id: 'gone', plugin: 'nowhere' },
        'not a node',
      ],
      edges: [],
    };
    const views = kit.core.nodeViews(raw);
    expect(Object.keys(views)).toEqual(['look']);
    expect(views['look']?.inputs['heard']?.label).toBe('events of game');
    expect(views['look']?.outputs['chat']).toMatchObject({ type: 'chat-out', commands: ['/look'] });
    expect(views['look']?.outputs['events']).toMatchObject({
      type: 'events',
      types: [{ type: 'look.done', help: 'Done', schema: { type: 'object' } }],
    });
    expect(kit.core.nodeViews('not a graph')).toEqual({});
    const file = { read: () => ({ exists: false }) } as unknown as GraphFile;
    const checked = graphFileControls(file, kit.core).check(raw) as { views: object };
    expect(Object.keys(checked.views)).toEqual(['look']);
    await kit.stop();
  });
});
