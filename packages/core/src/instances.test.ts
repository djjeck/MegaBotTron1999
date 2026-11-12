import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusEvent } from './bus.ts';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { type GraphInput, withInstances } from './graph.ts';
import { parseManifest } from './manifest.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import { describePort, type InputPort, mismatch } from './ports.ts';

/** A parser that publishes `game.score` with its instance's id, and offers its id. */
const game = definePlugin({
  manifest: {
    id: 'game',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'a game',
    games: { registers: ['game'] },
    events: { 'game.score': z.object({ by: z.string() }) },
    config: z.object({ level: z.number().default(1) }),
    settings: z.object({ loud: z.boolean().default(false) }),
    interface: { state: { who: { help: 'its id', output: z.string() } } },
  },
  create: (ctx) => ({
    interface: {
      state: {
        who: () =>
          `${ctx.id} at ${String(ctx.config['level'])}${ctx.store.read('kept') === undefined ? '' : ', kept'}`,
      },
    },
    start: () => {
      ctx.store.write('seen', { id: ctx.id });
    },
    // Once every plugin has started, it scores once.
    ready: () => ctx.bus.publish('game.score', { by: ctx.id }),
  }),
});

/** An actor on one game and one chat, which hears the game's scores. */
function actor(heard: string[], contexts: PluginContext[]) {
  return definePlugin({
    manifest: {
      id: 'actor',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'an actor',
      inputs: {
        game: { type: 'interface', plugin: 'game', members: ['state.who'] },
        chat: { type: 'chat', network: 'tg' },
        scores: { type: 'events', namespace: 'game' },
        helper: { type: 'interface', plugin: 'helper', optional: true },
      },
    },
    create: (ctx) => {
      contexts.push(ctx);
      ctx.bus.subscribe('game', (e: BusEvent) => heard.push(`${ctx.id} heard ${String(e['by'])}`));
      return {};
    },
  });
}

const helper = definePlugin({
  manifest: { id: 'helper', version: '0.1.0', kinds: ['stats'], description: 'helps' },
  create: () => ({ start: () => {} }),
});

/** Two games, two actors each on its own game and its own private chat, on one connector. */
const twoBots = (): GraphInput => ({
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg' },
    { id: 'game-a', plugin: 'game', config: { level: 2 } },
    { id: 'game-b', plugin: 'game' },
    { id: 'actor-a', plugin: 'actor' },
    { id: 'actor-b', plugin: 'actor' },
  ],
  edges: [
    { from: 'game-a', to: 'actor-a.game' },
    { from: 'game-a', to: 'actor-a.scores' },
    { from: 'tg', to: 'actor-a.chat', reads: ['@a_bot'] },
    { from: 'actor-a.chat', to: 'tg.chat', sends: ['@a_bot'], commands: ['/a'] },
    { from: 'game-b', to: 'actor-b.game' },
    { from: 'game-b', to: 'actor-b.scores' },
    { from: 'tg', to: 'actor-b.chat', reads: ['@b_bot'] },
    { from: 'actor-b.chat', to: 'tg.chat', sends: ['@b_bot'], commands: ['/b'] },
  ],
});

function setup(graph: GraphInput = twoBots(), extra: Record<string, unknown> = {}) {
  const clock = new VirtualClock(1000);
  const tg = new FakeConnector({ account: 'tg:me' });
  const heard: string[] = [];
  const contexts: PluginContext[] = [];
  const core = new Core({ clock, graph, ...extra });
  core.register(fakeConnectorPlugin('tg', tg), game, actor(heard, contexts), helper);
  return { clock, tg, heard, contexts, core };
}

describe('plugin instances', () => {
  it('run one plugin more than once, each with its own id, configuration, store, settings and mode', async () => {
    const { core, contexts } = setup(twoBots(), {
      documents: { 'game-b': { kept: { x: 1 } } },
    });
    await core.start();
    expect(core.status().map((s) => `${s.id} ${s.state}`)).toEqual([
      'tg running',
      'game-a running',
      'game-b running',
      'actor-a running',
      'actor-b running',
    ]);
    // A plugin of the image that the graph does not name does not run.
    expect(core.state('helper')).toBeUndefined();
    const [a, b] = contexts;
    expect([a?.id, b?.id]).toEqual(['actor-a', 'actor-b']);
    expect(a?.use<{ state: { who(): string } }>('game').state.who()).toBe('game-a at 2');
    expect(b?.use<{ state: { who(): string } }>('game').state.who()).toBe('game-b at 1, kept');
    expect(core.settings.set('game-a.loud', true)).toBeUndefined();
    expect(core.settings.of('game-a')?.kept()).toEqual({ loud: true });
    expect(core.settings.of('game-b')?.kept()).toEqual({});
    core.modes.set('actor-a', 'live');
    expect(core.controls.status().plugins.map((p) => [p.id, p.plugin, p.mode])).toEqual([
      ['tg', 'tg', undefined],
      ['game-a', 'game', undefined],
      ['game-b', 'game', undefined],
      ['actor-a', 'actor', 'live'],
      ['actor-b', 'actor', 'read-only'],
    ]);
    expect(core.nodes().map((n) => `${n.id}:${n.manifest.id}`)).toContain('game-b:game');
    expect(core.graph()?.edges).toHaveLength(8);
  });

  it('hear only the events of the instances their edges bind', async () => {
    const { core, heard, contexts } = setup();
    await core.start();
    expect(() => contexts[0]?.bus.subscribe('helper', () => {})).toThrow(
      'actor-a does not consume helper'
    );
    expect(heard).toEqual(['actor-a heard game-a', 'actor-b heard game-b']);
  });

  it('send only where their edges send, with the commands their edges allow', async () => {
    const { core, tg, contexts } = setup();
    core.load();
    core.modes.set('actor-a', 'live');
    core.modes.set('actor-b', 'live');
    await core.start();
    tg.open();
    const [a, b] = contexts as [PluginContext, PluginContext];
    expect(a.outbox('chat').send('@a_bot', '/a')).toMatchObject({ outcome: 'sent' });
    expect(a.outbox('chat').send('@b_bot', '/b')).toMatchObject({
      outcome: 'refused',
      reason: 'actor-a does not send to @b_bot',
    });
    expect(b.outbox('tg:me').send('@b_bot', '/a')).toMatchObject({
      outcome: 'refused',
      reason: "/a is not among actor-b's commands",
    });
    // By the connector's id too; and nowhere else.
    expect(b.connector('tg').account).toBe('tg:me');
    expect(() => b.connector('elsewhere')).toThrow('actor-b has no reach on elsewhere');
    expect(() => b.outbox('irc:me')).toThrow('actor-b has no reach on the account irc:me');
    expect(tg.sent).toEqual([{ chat: '@a_bot', text: '/a' }]);
  });

  it('use an optional input only while it is bound and running, and fail nothing for it', async () => {
    const unbound = setup();
    await unbound.core.start();
    expect(unbound.contexts[0]?.useOptional('helper')).toBeUndefined();
    expect(() => unbound.contexts[0]?.use('helper')).toThrow('helper is not running');
    expect(() => unbound.contexts[0]?.useOptional('nothing')).toThrow(
      'actor-a does not use nothing: add an interface input of it'
    );
    const g = twoBots();
    g.nodes.push({ id: 'helper', plugin: 'helper' });
    g.edges?.push({ from: 'helper', to: 'actor-a.helper' });
    const bound = setup(g);
    await bound.core.start();
    expect(bound.contexts[0]?.useOptional('helper')).toEqual({ state: {}, actions: {} });
    await bound.core.stop();
    expect(bound.contexts[0]?.useOptional('helper')).toBeUndefined();
  });

  it('refuse two instances whose commands share a name, naming them', async () => {
    const asker = definePlugin({
      manifest: {
        id: 'asker',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'asks',
        interface: { commands: { ask: { help: 'asks' } } },
      },
      create: () => ({ commands: { ask: { run: () => Promise.resolve() } } }),
    });
    const core = new Core({
      clock: new VirtualClock(),
      graph: {
        version: 2,
        nodes: [
          { id: 'one', plugin: 'asker' },
          { id: 'two', plugin: 'asker' },
        ],
      },
    });
    core.register(asker);
    await expect(core.start()).rejects.toThrow(
      "plugin two: the command ask of its ask is one's ask already"
    );
  });

  it('bind an interface by contract: each instance to its own plugin that declares the members', async () => {
    /** A parser of its own bot, offering the contract's read. */
    const parserOf = (id: string) =>
      definePlugin({
        manifest: {
          id,
          version: '0.1.0',
          kinds: ['parser'],
          description: id,
          interface: { state: { rest: { help: 'its rest', output: z.string() } } },
        },
        create: () => ({ interface: { state: { rest: () => `${id} rests` } } }),
      });
    const used: string[] = [];
    const turns = definePlugin({
      manifest: {
        id: 'turns',
        version: '0.1.0',
        kinds: ['actor'],
        description: 'turns',
        inputs: { parser: { type: 'interface', members: ['state.rest'] } },
      },
      create: (ctx) => ({
        start: () => {
          used.push(`${ctx.id}: ${ctx.use<{ state: { rest(): string } }>('parser').state.rest()}`);
        },
      }),
    });
    const base: GraphInput = {
      version: 2,
      nodes: [
        { id: 'lore', plugin: 'lore' },
        { id: 'epic', plugin: 'epic' },
        { id: 'turns', plugin: 'turns' },
      ],
      edges: [],
    };
    const core = new Core({
      clock: new VirtualClock(),
      graph: (defaults) => {
        expect(defaults.nodes.map((n) => n.id)).toEqual(['lore', 'epic', 'turns']);
        return withInstances(base, 'turns', [
          { id: 'lore-turns', edges: [{ from: 'lore', to: 'lore-turns.parser' }] },
          {
            id: 'epic-turns',
            config: { x: 1 },
            edges: [{ from: 'epic', to: 'epic-turns.parser' }],
          },
        ]);
      },
    });
    core.register(parserOf('lore'), parserOf('epic'), turns);
    await core.start();
    expect(used).toEqual(['lore-turns: lore rests', 'epic-turns: epic rests']);
    expect(core.graph()?.nodes.map((n) => `${n.id}:${n.plugin}`)).toEqual([
      'lore:lore',
      'epic:epic',
      'lore-turns:turns',
      'epic-turns:turns',
    ]);
    expect(core.graph()?.edges.map((e) => `${e.from} → ${e.to}`)).toEqual([
      'lore.interface → lore-turns.parser',
      'epic.interface → epic-turns.parser',
    ]);
    // The default node of a contract has no default edge, so left as it is it fails, naming it.
    const unbound = new Core({ clock: new VirtualClock() });
    unbound.register(parserOf('lore'), turns);
    await expect(unbound.start()).rejects.toThrow(
      'node turns: input port parser (interface with state.rest) is not bound'
    );
  });
});

describe('contracts', () => {
  it('fit any interface that declares their members, and say what one lacks', () => {
    const contract: InputPort = { type: 'interface', members: ['state.rest'], optional: false };
    expect(describePort(contract)).toBe('interface with state.rest');
    expect(mismatch(contract, { type: 'interface', plugin: 'x', members: ['state.rest'] })).toBe(
      undefined
    );
    expect(mismatch(contract, { type: 'interface', plugin: 'x', members: [] })).toBe(
      'x does not declare state.rest'
    );
    expect(() =>
      parseManifest({
        id: 'turns',
        version: '0.1.0',
        kinds: ['actor'],
        description: 'turns',
        inputs: { parser: { type: 'interface' } },
      })
    ).toThrow('an interface input names its plugin, or the members it uses');
  });

  it('leave withInstances a graph without the plugin when it lists none', () => {
    expect(
      withInstances(
        {
          version: 2,
          nodes: [
            { id: 'a', plugin: 'a' },
            { id: 'turns', plugin: 'turns' },
          ],
          edges: [{ from: 'a', to: 'turns.parser' }],
        },
        'turns',
        []
      )
    ).toEqual({ version: 2, nodes: [{ id: 'a', plugin: 'a' }], edges: [] });
  });
});
