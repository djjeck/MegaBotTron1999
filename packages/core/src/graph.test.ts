import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultGraph,
  type Graph,
  GraphError,
  type GraphInput,
  loadOrder,
  monitoredChats,
  requiredOf,
  type ResolvedNode,
  resolveGraph,
  upgradeGraph,
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
        inputs: {
          channel: { type: 'chat-in', network: 'irc', bind: { node: 'irc', reads: ['#a'] } },
        },
      }),
      m('actor', {
        kinds: ['actor'],
        inputs: {
          game: { type: 'interface', plugin: 'game', members: ['state.score'] },
          channel: { type: 'chat-in', network: 'irc' },
          notices: { type: 'events', namespace: 'game' },
          map: { type: 'interface', plugin: 'game', optional: true },
        },
        outputs: { channel: { type: 'chat-out', network: 'irc' } },
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
  version: 2,
  nodes: [
    { id: 'irc', plugin: 'irc' },
    { id: 'game', plugin: 'game' },
    { id: 'actor', plugin: 'actor', config: { x: 1 } },
  ],
  edges: [
    { from: 'irc', to: 'game.channel', reads: ['#a'] },
    { from: 'game', to: 'actor.game' },
    { from: 'irc.chat', to: 'actor.channel', reads: ['#a'] },
    { from: 'actor.channel', to: 'irc.chat', sends: ['#a'], commands: ['!go'] },
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
    expect(describePort({ type: 'chat-in', optional: false })).toBe('chat-in of any network');
    expect(describePort({ type: 'chat-out', network: 'irc', optional: false })).toBe(
      'chat-out of irc'
    );
    // In and out, related: the same shape, two colours.
    expect(PORT_TYPE_INFO['chat-in'].shape).toBe(PORT_TYPE_INFO['chat-out'].shape);
    expect(PORT_TYPE_INFO['chat-in'].colour).not.toBe(PORT_TYPE_INFO['chat-out'].colour);
    expect(describePort({ type: 'events', namespace: 'x' })).toBe('events of x');
  });

  it('match an input to an output of its type, network, namespace and plugin', () => {
    const chat = { type: 'chat-in', network: 'irc', optional: false } as const;
    expect(mismatch(chat, { type: 'chat-in', network: 'irc' })).toBeUndefined();
    expect(mismatch(chat, { type: 'chat-in', network: 'telegram' })).toBe(
      'chat-in of telegram cannot bind chat-in of irc'
    );
    expect(mismatch({ type: 'chat-in', optional: false }, { type: 'chat-in', network: 'x' })).toBe(
      undefined
    );
    // A connector's chat-out input takes a sender's output of its network, or of any.
    const into = { type: 'chat-out', network: 'irc', optional: true } as const;
    const out = { type: 'chat-out', optional: false } as const;
    expect(mismatch(into, out)).toBeUndefined();
    expect(mismatch(into, { ...out, network: 'irc' })).toBeUndefined();
    expect(mismatch(into, { ...out, network: 'telegram' })).toBe(
      'chat-out of telegram cannot bind chat-out of irc'
    );
    expect(mismatch(into, { type: 'chat-in', network: 'irc' })).toBe(
      'chat-in of irc cannot bind chat-out of irc'
    );
    const events = { type: 'events', namespace: 'a', optional: false } as const;
    expect(mismatch(events, { type: 'events', namespace: 'b' })).toBe(
      'events of b cannot bind events of a'
    );
    expect(mismatch(events, { type: 'chat-in', network: 'a' })).toBe(
      'chat-in of a cannot bind events of a'
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
      { from: 'irc.chat', to: 'game.channel', type: 'chat-in', reads: ['#a'] },
      { from: 'game.interface', to: 'actor.game', type: 'interface' },
      { from: 'irc.chat', to: 'actor.channel', type: 'chat-in', reads: ['#a'] },
      {
        from: 'actor.channel',
        to: 'irc.chat',
        type: 'chat-out',
        sends: ['#a'],
        commands: ['!go'],
      },
      { from: 'game.events', to: 'actor.notices', type: 'events' },
    ]);
    const actor = nodes.find((n) => n.id === 'actor');
    expect(actor?.config).toEqual({ x: 1 });
    expect(actor?.inputs.get('map')).toEqual([]);
    expect(actor?.outputs.get('channel')).toEqual([
      {
        node: 'irc',
        port: 'chat',
        type: 'chat-out',
        chat: { reads: [], sends: ['#a'], commands: ['!go'] },
      },
    ]);
    expect(requiredOf(actor as never)).toEqual(['game', 'irc']);
    // The connector takes every sender's edge on its one chat-out input.
    expect(nodes.find((n) => n.id === 'irc')?.inputs.get('chat')).toEqual([
      {
        node: 'actor',
        port: 'channel',
        type: 'chat-out',
        chat: { reads: [], sends: ['#a'], commands: ['!go'] },
      },
    ]);
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
    expect(problems(g)).toEqual([
      'node actor: input port channel (chat-in of irc) is not bound',
      'node actor: output port channel (chat-out of irc) is not bound',
    ]);
  });

  it('names the node and the port of every problem', () => {
    expect(problems({ version: 3, nodes: [] })).toEqual([
      'graph: version: Invalid input: expected 2',
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
            { from: 'game', to: 'actor.notices', type: 'chat-in' },
            { from: 'game', to: 'actor.map', sends: ['#a'] },
            { from: 'game', to: 'actor.map', reads: ['#a'] },
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
      'node actor: input port channel: events of game cannot bind chat-in of irc (edge game.events → actor.channel)',
      'edge game → game.channel: a node cannot feed itself',
      'edge nobody → actor.game: no node nobody',
      'node actor: no input port nothing',
      'node game: no output port nothing',
      'edge irc → actor.game: no output of irc fits interface of game; name it',
      'edge game → actor.notices: its type is events, not chat-in',
      'edge game → actor.map: only a chat-out edge carries sends, commands, minIntervalS and dryRun',
      'edge game → actor.map: only a chat-in edge carries reads and senders',
      'edge game.events → actor.notices: twice in the graph',
      'node actor: input port game (interface of game) is not bound',
      'node actor: output port channel (chat-out of irc) is not bound',
    ]);
  });

  it('keeps each node’s group, a name without spaces at its ends, that the run ignores', () => {
    const grouped = graph({
      nodes: [
        { id: 'irc', plugin: 'irc', group: 'Quest Bot' },
        { id: 'game', plugin: 'game', group: 'Quest Bot' },
        { id: 'actor', plugin: 'actor', config: { x: 1 }, group: 'Ünïcode · lane' },
      ],
    });
    const { graph: g, nodes } = resolveGraph(grouped, image());
    expect(g.nodes.map((n) => n.group)).toEqual(['Quest Bot', 'Quest Bot', 'Ünïcode · lane']);
    expect(nodes.map((n) => n.id)).toEqual(['irc', 'game', 'actor']);
    expect(
      problems(
        graph({
          nodes: [
            { id: 'irc', plugin: 'irc', group: '' },
            { id: 'game', plugin: 'game', group: ' Quest' },
            { id: 'actor', plugin: 'actor', config: { x: 1 }, group: 3 as unknown as string },
          ],
        })
      )
    ).toEqual([
      'graph: nodes.0.group: expected a name, without spaces at its ends',
      'graph: nodes.1.group: expected a name, without spaces at its ends',
      'graph: nodes.2.group: Invalid input: expected string, received number',
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
      'node game: input port channel: chat-in of telegram cannot bind chat-in of irc (edge irc → game.channel)',
      'node actor: input port channel: chat-in of telegram cannot bind chat-in of irc (edge irc.chat → actor.channel)',
      'node irc: input port chat: chat-out of irc cannot bind chat-out of telegram (edge actor.channel → irc.chat)',
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

describe('chat-in and chat-out', () => {
  /** A connector; a reader; a sender; one that reads only with a config's `match`. */
  const plugins = new Map(
    [
      m('tg', { kinds: ['connector'], account: 'telegram:alice' }),
      m('reader', { kinds: ['parser'], inputs: { chat: { type: 'chat-in' } } }),
      m('sender', {
        kinds: ['actor'],
        outputs: { chat: { type: 'chat-out', bind: { node: 'tg', sends: ['@QuestBot'] } } },
      }),
      m('both', {
        kinds: ['actor'],
        config: z.object({ match: z.string().optional() }),
        inputs: { chat: { type: 'chat-in', when: { config: 'match' } } },
        outputs: { chat: { type: 'chat-out', optional: true } },
      }),
      // Module API 1: its old chat input is both.
      m('old', { kinds: ['actor'], inputs: { line: { type: 'chat' } } }),
    ].map((x) => [x.id, x])
  );

  it('binds a sender to the connector, the connector taking any number of them', () => {
    const g = defaultGraph([...plugins.values()].filter((p) => p.id !== 'old'));
    expect(g.edges).toEqual([
      {
        from: 'sender.chat',
        to: 'tg.chat',
        type: 'chat-out',
        sends: ['@QuestBot'],
      },
    ]);
    const { nodes } = resolveGraph(
      {
        ...g,
        edges: [
          ...g.edges,
          { from: 'tg', to: 'reader.chat', reads: ['@QuestBot'] },
          { from: 'both.chat', to: 'tg.chat', commands: ['/look'] },
        ],
      },
      plugins
    );
    expect(
      nodes
        .find((n) => n.id === 'tg')
        ?.inputs.get('chat')
        ?.map((b) => b.node)
    ).toEqual(['sender', 'both']);
    // The sender needs the connector first; an optional chat-out imposes no order.
    const sender = nodes.find((n) => n.id === 'sender');
    expect(requiredOf(sender as ResolvedNode)).toEqual(['tg']);
    expect(requiredOf(nodes.find((n) => n.id === 'both') as ResolvedNode)).toEqual([]);
    // Without match, the reactor-like node has no chat-in port; with it, it has.
    expect(Object.keys(nodes.find((n) => n.id === 'both')?.ports ?? {})).toEqual([]);
    const matching = resolveGraph(
      {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'tg' },
          { id: 'both', plugin: 'both', config: { match: 'x' } },
        ],
        edges: [{ from: 'tg', to: 'both.chat' }],
      },
      plugins
    );
    expect(matching.graph.edges).toEqual([
      { from: 'tg.chat', to: 'both.chat', type: 'chat-in', reads: [] },
    ]);
  });

  it('refuses a chat-out bound twice, unbound, or the wrong way round', () => {
    const base = {
      version: 2,
      nodes: [
        { id: 'tg', plugin: 'tg' },
        { id: 'tg-2', plugin: 'tg', account: 'telegram:bob' },
        { id: 'sender', plugin: 'sender' },
        { id: 'reader', plugin: 'reader' },
      ],
    };
    expect(
      problems(
        {
          ...base,
          edges: [
            { from: 'tg', to: 'reader.chat' },
            { from: 'sender.chat', to: 'tg.chat' },
            { from: 'sender.chat', to: 'tg-2.chat' },
            { from: 'sender.chat', to: 'tg.chat' },
            { from: 'tg.chat', to: 'sender.chat' },
            { from: 'reader.chat', to: 'tg.chat' },
          ],
        },
        plugins
      )
    ).toEqual([
      'node sender: output port chat is bound twice',
      'edge sender.chat → tg.chat: twice in the graph',
      'node sender: no input port chat',
      'node reader: no output port chat',
    ]);
    expect(
      problems(
        {
          version: 2,
          nodes: [
            { id: 'reader', plugin: 'reader' },
            { id: 'sender', plugin: 'sender' },
          ],
        },
        plugins
      )
    ).toEqual([
      'node reader: input port chat (chat-in of any network) is not bound',
      'node sender: output port chat (chat-out of any network) is not bound: tg is not in the graph',
    ]);
  });

  it('converts a version 1 graph, each chat edge by the ports of its node', () => {
    // The shape of a graph saved before the split: a connector's chat edges, all empty, to a
    // parser (it reads), a turn-actor (it reads and sends) and a reactor on events (it sends).
    const shell = new Map(
      [
        m('telegram-user', { kinds: ['connector'], account: 'telegram:alice' }),
        m('parser', {
          kinds: ['parser'],
          games: { registers: ['questbot'] },
          interface: { state: { rest: { help: 'its rest', output: z.number() } } },
          inputs: { chat: { type: 'chat-in', network: 'telegram' } },
        }),
        m('turn-actor', {
          kinds: ['actor'],
          inputs: {
            chat: { type: 'chat-in', network: 'telegram' },
            parser: { type: 'interface', members: ['state.rest'] },
          },
          outputs: { chat: { type: 'chat-out', network: 'telegram' } },
        }),
        m('reactor', {
          kinds: ['actor'],
          config: z.object({ on: z.string().optional(), match: z.string().optional() }),
          inputs: {
            chat: { type: 'chat-in', when: { config: 'match' } },
            events: { type: 'events', namespace: { config: 'on' }, optional: true },
          },
          outputs: { chat: { type: 'chat-out' } },
        }),
      ].map((x) => [x.id, x])
    );
    const v1 = {
      version: 1,
      nodes: [
        { id: 'telegram-user', plugin: 'telegram-user' },
        { id: 'questbot', plugin: 'parser' },
        { id: 'questbot-turns', plugin: 'turn-actor' },
        { id: 'look', plugin: 'reactor', config: { on: 'questbot.turn' } },
      ],
      edges: [
        { from: 'telegram-user.chat', to: 'questbot.chat', type: 'chat', reads: [], sends: [] },
        {
          from: 'telegram-user.chat',
          to: 'questbot-turns.chat',
          type: 'chat',
          reads: [],
          sends: [],
        },
        { from: 'telegram-user.chat', to: 'look.chat', type: 'chat', reads: [], sends: [] },
        { from: 'questbot.interface', to: 'questbot-turns.parser', type: 'interface' },
        { from: 'questbot.events', to: 'look.events', type: 'events' },
      ],
    };
    const converted = [
      { from: 'telegram-user.chat', to: 'questbot.chat', type: 'chat-in', reads: [] },
      { from: 'telegram-user.chat', to: 'questbot-turns.chat', type: 'chat-in', reads: [] },
      { from: 'questbot-turns.chat', to: 'telegram-user.chat', type: 'chat-out', sends: [] },
      { from: 'look.chat', to: 'telegram-user.chat', type: 'chat-out', sends: [] },
      { from: 'questbot.interface', to: 'questbot-turns.parser', type: 'interface' },
      { from: 'questbot.events', to: 'look.events', type: 'events' },
    ];
    expect(upgradeGraph(v1, shell)).toEqual({ ...v1, version: 2, edges: converted });
    const { graph: g, nodes } = resolveGraph(v1, shell);
    expect(g).toEqual({ version: 2, nodes: v1.nodes, edges: converted });
    expect(loadOrder(nodes).map((n) => n.id)).toEqual([
      'telegram-user',
      'questbot',
      'questbot-turns',
      'look',
    ]);
    // A version 2 graph, and what is not a graph, are left as they are.
    expect(upgradeGraph(g, shell)).toBe(g);
    expect(upgradeGraph('x', shell)).toBe('x');
  });

  it('converts what it can of an odd version 1 graph, and leaves the check to say the rest', () => {
    const v1 = {
      version: 1,
      nodes: [{ id: 'tg', plugin: 'tg' }, { id: 'old', plugin: 'old' }, { id: 'reader' }, 7],
      edges: [
        // Untyped, it is a chat edge by what it carries, or by its target's port.
        { from: 'tg', to: 'old.line', reads: ['#a'], sends: ['#b'], commands: ['!go'] },
        { from: 'tg', to: 'reader.chat', sends: ['#b'] },
        { from: 'ghost', to: 'nobody.chat', type: 'chat', reads: ['#a'] },
        { from: 'tg', to: 'old.nothing', type: 'chat' },
        { from: 'tg', to: 'old.other' },
        'junk',
      ],
    };
    expect(upgradeGraph(v1, plugins)).toEqual({
      ...v1,
      version: 2,
      edges: [
        { from: 'tg', to: 'old.line', type: 'chat-in', reads: ['#a'] },
        { from: 'old.line', to: 'tg.chat', type: 'chat-out', sends: ['#b'], commands: ['!go'] },
        // Of a node with no plugin known, both halves, nothing lost.
        { from: 'tg', to: 'reader.chat', type: 'chat-in' },
        { from: 'reader.chat', to: 'tg.chat', type: 'chat-out', sends: ['#b'] },
        { from: 'ghost', to: 'nobody.chat', type: 'chat-in', reads: ['#a'] },
        { from: 'nobody.chat', to: 'ghost.chat', type: 'chat-out' },
        // Of a known node with no such port, the input's half, for the check to refuse.
        { from: 'tg', to: 'old.nothing', type: 'chat-in' },
        { from: 'tg', to: 'old.other' },
        'junk',
      ],
    });
    expect(upgradeGraph({ version: 1 }, plugins)).toEqual({ version: 2 });
  });
});

describe('the chats a connector monitors (D89)', () => {
  /** Three connectors that say what they monitor, one that does not, and a reader. */
  const plugins = new Map(
    [
      m('tg', {
        kinds: ['connector'],
        account: 'telegram:alice',
        config: z.object({ chats: z.array(z.string()).optional() }),
        monitors: { config: 'chats' },
      }),
      m('irc', {
        kinds: ['connector'],
        account: 'irc:alice',
        config: z.object({ channel: z.string().default('#lobby') }),
        monitors: { config: 'channel' },
      }),
      m('every', { kinds: ['connector'], account: 'telegram-bot:QuestBot', monitors: 'all' }),
      m('quiet', {
        kinds: ['connector'],
        account: 'telegram:bob',
        config: z.object({ chats: z.array(z.string()).optional() }),
      }),
      m('reader', { kinds: ['parser'], inputs: { chat: { type: 'chat-in' } } }),
    ].map((x) => [x.id, x])
  );
  const reading = (
    connector: string,
    config: Record<string, unknown> | undefined,
    reads: string[] | '*'
  ): GraphInput => ({
    version: 2,
    nodes: [
      { id: 'conn', plugin: connector, ...(config === undefined ? {} : { config }) },
      { id: 'quest', plugin: 'reader' },
    ],
    edges: [{ from: 'conn', to: 'quest.chat', reads }],
  });
  const warnings = (g: GraphInput): string[] => resolveGraph(g, plugins).warnings;

  it('warns of a chat read that its connector’s list does not name, and accepts the graph', () => {
    const g = reading('tg', { chats: ['-1001', '@QuestBot'] }, ['@questbot', '@DiceBot', '-1002']);
    const { graph, warnings: said } = resolveGraph(g, plugins);
    expect(graph.edges).toHaveLength(1);
    expect(said).toEqual([
      'node quest: input port chat reads @DiceBot, which conn does not monitor (its chats: -1001, @QuestBot) (edge conn → quest.chat)',
      'node quest: input port chat reads -1002, which conn does not monitor (its chats: -1001, @QuestBot) (edge conn → quest.chat)',
    ]);
    // An empty list monitors nothing.
    expect(warnings(reading('tg', { chats: [] }, ['@QuestBot']))).toEqual([
      'node quest: input port chat reads @QuestBot, which conn does not monitor (its chats: none) (edge conn → quest.chat)',
    ]);
  });

  it('warns of nothing for every chat: the list unset, `all` declared, or any chat read', () => {
    expect(warnings(reading('tg', undefined, ['@QuestBot']))).toEqual([]);
    expect(warnings(reading('every', undefined, ['@QuestBot']))).toEqual([]);
    expect(warnings(reading('tg', { chats: ['-1001'] }, '*'))).toEqual([]);
  });

  it('reads one chat from a string key, its default included', () => {
    expect(warnings(reading('irc', { channel: '#Lobby' }, ['#lobby']))).toEqual([]);
    expect(warnings(reading('irc', undefined, ['#games']))).toEqual([
      'node quest: input port chat reads #games, which conn does not monitor (its channel: #lobby) (edge conn → quest.chat)',
    ]);
  });

  it('says nothing of a connector that does not declare what it monitors: unknown, not wrong', () => {
    expect(warnings(reading('quiet', { chats: ['-1001'] }, ['@QuestBot']))).toEqual([]);
    expect(monitoredChats(plugins.get('quiet') as Manifest, { chats: [] })).toBeUndefined();
  });

  it('takes the config as written when its schema refuses it, and keeps the warnings of a graph refused', () => {
    expect(
      monitoredChats(plugins.get('tg') as Manifest, { chats: ['-1001', 7] as unknown[] })
    ).toEqual({ key: 'chats', chats: ['-1001'] });
    const g = reading('tg', { chats: ['-1001'] }, ['@QuestBot']);
    try {
      resolveGraph({ ...g, nodes: [...g.nodes, { id: 'lost', plugin: 'gone' }] }, plugins);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).problems).toEqual([
        'node lost: its plugin gone is not in the image',
      ]);
      expect((e as GraphError).warnings).toHaveLength(1);
    }
  });
});
