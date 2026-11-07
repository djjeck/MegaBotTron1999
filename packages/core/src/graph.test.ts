import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultGraph,
  type Graph,
  GraphError,
  type GraphInput,
  loadOrder,
  requiredOf,
  resolveGraph,
} from './graph.ts';
import { type Manifest, type ManifestInput, parseManifest } from './manifest.ts';
import { describePort, type InputPort, mismatch, PORT_TYPE_INFO, PORT_TYPES } from './ports.ts';

const m = (id: string, more: Partial<ManifestInput> = {}): Manifest =>
  parseManifest({ id, version: '0.1.0', kinds: ['stats'], description: id, ...more });

/** A connector, a parser on it, an actor on both, and a reader of the parser's events. */
const image = (): Map<string, Manifest> =>
  new Map(
    [
      m('irc', { kinds: ['connector'], account: 'irc:me' }),
      m('game', {
        kinds: ['parser'],
        games: { registers: ['game'] },
        interface: { state: { score: { help: 'the score', output: z.number() } } },
        inputs: { channel: { type: 'chat', network: 'irc', bind: { node: 'irc', reads: ['#a'] } } },
      }),
      m('actor', {
        kinds: ['actor'],
        inputs: {
          game: { type: 'interface', plugin: 'game', members: ['state.score'] },
          channel: { type: 'chat', network: 'irc' },
          notices: { type: 'events', namespace: 'game' },
          map: { type: 'interface', plugin: 'game', optional: true },
        },
      }),
    ].map((x) => [x.id, x])
  );

const problems = (raw: unknown, plugins = image()): string[] => {
  try {
    resolveGraph(raw, plugins);
  } catch (e) {
    if (e instanceof GraphError) return e.problems;
    throw e;
  }
  return [];
};

const graph = (more: Partial<GraphInput> = {}): GraphInput => ({
  version: 1,
  nodes: [
    { id: 'irc', plugin: 'irc' },
    { id: 'game', plugin: 'game' },
    { id: 'actor', plugin: 'actor', config: { x: 1 } },
  ],
  edges: [
    { from: 'irc', to: 'game.channel', reads: ['#a'] },
    { from: 'game', to: 'actor.game' },
    { from: 'irc.chat', to: 'actor.channel', reads: ['#a'], sends: ['#a'], commands: ['!go'] },
    { from: 'game.events', to: 'actor.notices', type: 'events' },
  ],
  ...more,
});

describe('port types', () => {
  it('have a stable id, a description, a shape and a colour for the UI', () => {
    for (const t of PORT_TYPES) {
      expect(PORT_TYPE_INFO[t].id).toBe(t);
      expect(PORT_TYPE_INFO[t].description.length).toBeGreaterThan(10);
    }
    expect(describePort({ type: 'chat', optional: false })).toBe('chat of any network');
    expect(describePort({ type: 'events', namespace: 'x' })).toBe('events of x');
  });

  it('match an input to an output of its type, network, namespace and plugin', () => {
    const chat = { type: 'chat', network: 'irc', optional: false } as const;
    expect(mismatch(chat, { type: 'chat', network: 'irc' })).toBeUndefined();
    expect(mismatch(chat, { type: 'chat', network: 'telegram' })).toBe(
      'chat of telegram cannot bind chat of irc'
    );
    expect(mismatch({ ...chat, network: undefined }, { type: 'chat', network: 'x' })).toBe(
      undefined
    );
    const events = { type: 'events', namespace: 'a', optional: false } as const;
    expect(mismatch(events, { type: 'events', namespace: 'b' })).toBe(
      'events of b cannot bind events of a'
    );
    expect(mismatch(events, { type: 'chat', network: 'a' })).toBe(
      'chat of a cannot bind events of a'
    );
    const iface: InputPort = {
      type: 'interface',
      plugin: 'p',
      members: ['state.x'],
      optional: false,
    };
    expect(mismatch(iface, { type: 'interface', plugin: 'p', members: ['state.x'] })).toBe(
      undefined
    );
    expect(mismatch(iface, { type: 'interface', plugin: 'p', members: [] })).toBe(
      'p does not declare state.x'
    );
    expect(mismatch(iface, { type: 'events', namespace: 'p' })).toBe(
      'events of p cannot bind interface of p'
    );
  });
});

describe('the graph', () => {
  it('is checked, every edge written out with its ports and type', () => {
    const { graph: g, nodes } = resolveGraph(graph(), image());
    expect(g.edges).toEqual([
      { from: 'irc.chat', to: 'game.channel', type: 'chat', reads: ['#a'], sends: [] },
      { from: 'game.interface', to: 'actor.game', type: 'interface' },
      {
        from: 'irc.chat',
        to: 'actor.channel',
        type: 'chat',
        reads: ['#a'],
        sends: ['#a'],
        commands: ['!go'],
      },
      { from: 'game.events', to: 'actor.notices', type: 'events' },
    ]);
    const actor = nodes.find((n) => n.id === 'actor');
    expect(actor?.config).toEqual({ x: 1 });
    expect(actor?.inputs.get('map')).toEqual([]);
    expect(requiredOf(actor as never)).toEqual(['game', 'irc']);
    expect(nodes.find((n) => n.id === 'irc')?.account).toBe('irc:me');
  });

  it('is made from the manifests by default, as the programmatic wiring binds them', () => {
    const manifests = [...image().values()];
    const g: Graph = defaultGraph(manifests, { actor: { x: 1 } });
    expect(g.nodes).toEqual([
      { id: 'irc', plugin: 'irc' },
      { id: 'game', plugin: 'game' },
      { id: 'actor', plugin: 'actor', config: { x: 1 } },
    ]);
    // The actor's chat names no node to bind by default: unbound, and so refused.
    expect(g.edges.map((e) => `${e.from} → ${e.to}`)).toEqual([
      'irc.chat → game.channel',
      'game.interface → actor.game',
      'game.events → actor.notices',
      'game.interface → actor.map',
    ]);
    expect(problems(g)).toEqual(['node actor: input port channel (chat of irc) is not bound']);
  });

  it('names the node and the port of every problem', () => {
    expect(problems({ version: 2, nodes: [] })).toEqual([
      'graph: version: Invalid input: expected 1',
    ]);
    expect(
      problems(
        graph({
          nodes: [
            { id: 'irc', plugin: 'irc' },
            { id: 'irc', plugin: 'irc' },
            { id: 'game', plugin: 'game' },
            { id: 'ghost', plugin: 'nowhere' },
            { id: 'actor', plugin: 'actor' },
            { id: 'irc2', plugin: 'irc' },
          ],
          edges: [
            { from: 'irc', to: 'game.channel' },
            { from: 'irc', to: 'game.channel' },
            { from: 'game.events', to: 'actor.channel' },
            { from: 'game', to: 'game.channel' },
            { from: 'nobody', to: 'actor.game' },
            { from: 'game', to: 'actor.nothing' },
            { from: 'game.nothing', to: 'actor.game' },
            { from: 'irc', to: 'actor.game' },
            { from: 'game', to: 'actor.notices', type: 'chat' },
            { from: 'game', to: 'actor.map', sends: ['#a'] },
            { from: 'game.events', to: 'actor.notices' },
            { from: 'game.events', to: 'actor.notices' },
          ],
        })
      )
    ).toEqual([
      'node irc: in the graph twice',
      'node ghost: its plugin nowhere is not in the image',
      "node irc2: the account irc:me is irc's",
      'node game: input port channel is bound twice',
      'node actor: input port channel: events of game cannot bind chat of irc (edge game.events → actor.channel)',
      'edge game → game.channel: a node cannot feed itself',
      'edge nobody → actor.game: no node nobody',
      'node actor: no input port nothing',
      'node game: no output port nothing',
      'edge irc → actor.game: no output of irc fits interface of game; name it',
      'edge game → actor.notices: its type is events, not chat',
      'edge game → actor.map: only a chat carries reads, sends and commands',
      'edge game.events → actor.notices: twice in the graph',
      'node actor: input port game (interface of game) is not bound',
    ]);
  });

  it('gives a connector instance its own account, of its plugin’s network', () => {
    const two = graph({
      nodes: [
        { id: 'irc', plugin: 'irc' },
        { id: 'irc-b', plugin: 'irc', account: 'irc:other' },
        { id: 'game', plugin: 'game' },
        { id: 'actor', plugin: 'actor' },
      ],
    });
    const { nodes } = resolveGraph(two, image());
    expect(nodes.map((n) => n.account)).toEqual(['irc:me', 'irc:other', undefined, undefined]);
    expect(
      problems(
        graph({
          nodes: [
            { id: 'irc', plugin: 'irc', account: 'telegram:me' },
            { id: 'game', plugin: 'game', account: 'irc:x' },
            { id: 'actor', plugin: 'actor' },
          ],
        })
      )
    ).toEqual([
      "node irc: its account telegram:me is not of irc:me's network",
      'node game: only a connector has an account',
      'node game: input port channel: chat of telegram cannot bind chat of irc (edge irc → game.channel)',
      'node actor: input port channel: chat of telegram cannot bind chat of irc (edge irc.chat → actor.channel)',
    ]);
  });

  it('orders the nodes by their required edges, and names a cycle', () => {
    const { nodes } = resolveGraph(
      graph({
        nodes: [
          { id: 'actor', plugin: 'actor' },
          { id: 'game', plugin: 'game' },
          { id: 'irc', plugin: 'irc' },
        ],
      }),
      image()
    );
    expect(loadOrder(nodes).map((n) => n.id)).toEqual(['irc', 'game', 'actor']);
    const loop = new Map(
      [
        m('a', { inputs: { b: { type: 'interface', plugin: 'b' } } }),
        m('b', { inputs: { a: { type: 'interface', plugin: 'a' } } }),
      ].map((x) => [x.id, x])
    );
    const looped = resolveGraph(defaultGraph([...loop.values()]), loop).nodes;
    expect(() => loadOrder(looped)).toThrow('a cycle of required edges: a → b → a');
    // An optional edge imposes no order: two plugins may use each other so.
    const optional = new Map(
      [
        m('a', { inputs: { b: { type: 'interface', plugin: 'b', optional: true } } }),
        m('b', { inputs: { a: { type: 'interface', plugin: 'a' } } }),
      ].map((x) => [x.id, x])
    );
    const ok = resolveGraph(defaultGraph([...optional.values()]), optional).nodes;
    expect(loadOrder(ok).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('binds an events input to every other node registering its namespace, or those named', () => {
    const plugins = new Map(
      [
        m('p', { games: { registers: ['g'] } }),
        m('q', { games: { registers: ['g'] } }),
        m('r', { inputs: { all: { type: 'events', namespace: 'g' } } }),
        m('s', { inputs: { one: { type: 'events', namespace: 'g', bind: { nodes: ['q'] } } } }),
      ].map((x) => [x.id, x])
    );
    const g = defaultGraph([...plugins.values()]);
    expect(g.edges.map((e) => `${e.from} → ${e.to}`)).toEqual([
      'p.events → r.all',
      'q.events → r.all',
      'q.events → s.one',
    ]);
    expect(
      resolveGraph(g, plugins)
        .nodes.find((n) => n.id === 'r')
        ?.inputs.get('all')
    ).toEqual([
      { node: 'p', port: 'events', type: 'events' },
      { node: 'q', port: 'events', type: 'events' },
    ]);
  });
});
