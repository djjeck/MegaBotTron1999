import { describe, expect, it } from 'vitest';
import type { Graph, PluginView, PortView } from '#src/ui/api.ts';
import { AVAILABLE, VIEW } from '#test/graph-view.ts';
import { cardsOf, cardTitle, isSplit, nodesOfCards, targetCard } from './cards.ts';
import {
  addNode,
  asGraph,
  bindProblem,
  connect,
  dropOn,
  edgeKey,
  edgeOf,
  edgesOfPort,
  EMPTY_GRAPH,
  endOf,
  fixedChats,
  freeId,
  freeName,
  idProblem,
  inputsOf,
  instanceOf,
  movePort,
  ownerOf,
  placeProblems,
  portChanged,
  removeEdge,
  removeNode,
  removePort,
  sameGraph,
  servedNote,
  servesText,
  syncEdgeChats,
  updateEdge,
  updateNode,
  viewOf,
  wireRequired,
} from './draft.ts';

const plugins = new Map(AVAILABLE.map((p) => [p.id, p]));

describe('the draft', () => {
  it('starts as the saved file’s graph, keeping only nodes and edges', () => {
    expect(asGraph(undefined)).toEqual(EMPTY_GRAPH);
    expect(asGraph([])).toEqual(EMPTY_GRAPH);
    expect(asGraph({ nodes: 'x' })).toEqual(EMPTY_GRAPH);
    expect(
      asGraph({
        version: 2,
        nodes: [{ id: 'a', plugin: 'p' }, { id: 1 }, null],
        edges: [{ from: 'a.x', to: 'b.y' }, { from: 'a' }],
      })
    ).toEqual({
      version: 2,
      nodes: [{ id: 'a', plugin: 'p' }],
      edges: [{ from: 'a.x', to: 'b.y' }],
    });
    expect(sameGraph({ a: 1, b: [{ c: 1, d: 2 }] }, { b: [{ d: 2, c: 1 }], a: 1 })).toBe(true);
    expect(sameGraph(VIEW.graph, EMPTY_GRAPH)).toBe(false);
  });

  it('names a new node freely, and says why an id cannot be used', () => {
    expect(freeId('chat', new Set())).toBe('chat');
    expect(freeId('chat', new Set(['chat', 'chat-2']))).toBe('chat-3');
    expect(idProblem('Chat', new Set())).toBe('lower-case words and dashes, such as dice-roller');
    expect(idProblem('core', new Set())).toBe('`core` is the core’s own');
    expect(idProblem('chat', new Set(['chat']))).toBe('a node chat is in the graph already');
    expect(idProblem('chat-2', new Set(['chat']))).toBeUndefined();
  });

  it('adds, changes and removes nodes, an instance named only when it is not the id', () => {
    let g = addNode(EMPTY_GRAPH, { id: 'a', plugin: 'chat', instance: 'a' });
    g = addNode(g, { id: 'b', plugin: 'actor', instance: 'old-b' });
    expect(g.nodes).toEqual([
      { id: 'a', plugin: 'chat' },
      { id: 'b', plugin: 'actor', instance: 'old-b' },
    ]);
    expect(g.nodes.map(instanceOf)).toEqual(['a', 'old-b']);
    g = updateNode(g, 'a', { config: { host: 'h' }, account: 'chat:x' });
    g = updateNode(g, 'a', { account: '', settings: {}, disabled: true });
    g = updateNode(g, 'a', { disabled: undefined });
    expect(g.nodes[0]).toEqual({ id: 'a', plugin: 'chat', config: { host: 'h' } });
    g = connect(g, { from: 'a.chat', to: 'b.chat', type: 'chat-out' });
    g = connect(g, { from: 'a.chat', to: 'b.chat', type: 'chat-out', reads: ['#a'] });
    g = connect(g, { from: 'b.interface', to: 'c.x' });
    expect(g.edges).toHaveLength(2);
    expect(removeNode(g, 'a')).toEqual({
      version: 2,
      nodes: [{ id: 'b', plugin: 'actor', instance: 'old-b' }],
      edges: [{ from: 'b.interface', to: 'c.x' }],
    });
  });

  it('changes an edge’s chats and commands, and removes it', () => {
    let g = connect(EMPTY_GRAPH, {
      from: 'a.chat',
      to: 'b.chat',
      type: 'chat-out',
      commands: ['/x'],
    });
    g = connect(g, { from: 'c', to: 'b.other' });
    const key = edgeKey({ from: 'a.chat', to: 'b.chat' });
    expect(key).toBe('a.chat → b.chat');
    g = updateEdge(g, key, { reads: ['#a'], sends: [], commands: [] });
    expect(g.edges[0]).toEqual({
      from: 'a.chat',
      to: 'b.chat',
      type: 'chat-out',
      reads: ['#a'],
      sends: [],
    });
    g = updateEdge(g, key, { reads: undefined, commands: ['/play'] });
    expect(g.edges[0]).toEqual({
      from: 'a.chat',
      to: 'b.chat',
      type: 'chat-out',
      sends: [],
      commands: ['/play'],
    });
    expect(removeEdge(g, key).edges).toEqual([{ from: 'c', to: 'b.other' }]);
    expect(endOf('c')).toEqual({ node: 'c', port: undefined });
    expect(endOf('a.chat')).toEqual({ node: 'a', port: 'chat' });
  });

  it('moves the edges bound to a port renamed, an input’s or an output’s, and no other', () => {
    const g: Graph = {
      version: 2,
      nodes: [],
      edges: [
        { from: 'parser.events', to: 'look.heard', type: 'events' },
        { from: 'look.heard', to: 'other.in' },
        { from: 'look.chat', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
        { from: 'parser.events', to: 'lookout.heard' },
      ],
    };
    expect(movePort(g, 'look', { side: 'in', from: 'heard', to: 'game' }).edges).toEqual([
      { from: 'parser.events', to: 'look.game', type: 'events' },
      { from: 'look.heard', to: 'other.in' },
      { from: 'look.chat', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
      { from: 'parser.events', to: 'lookout.heard' },
    ]);
    expect(movePort(g, 'look', { side: 'out', from: 'chat', to: 'say' }).edges).toEqual([
      { from: 'parser.events', to: 'look.heard', type: 'events' },
      { from: 'look.heard', to: 'other.in' },
      { from: 'look.say', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
      { from: 'parser.events', to: 'lookout.heard' },
    ]);
  });

  it('removes the edges bound to a port removed, an input’s or an output’s, and no other (D84)', () => {
    const g: Graph = {
      version: 2,
      nodes: [],
      edges: [
        { from: 'parser.events', to: 'look.heard', type: 'events' },
        { from: 'other.events', to: 'look.heard', type: 'events' },
        { from: 'look.heard', to: 'other.in' },
        { from: 'look.chat', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
        { from: 'parser.events', to: 'lookout.heard' },
      ],
    };
    expect(portChanged(g, 'look', { side: 'in', removed: 'heard' }).edges).toEqual([
      { from: 'look.heard', to: 'other.in' },
      { from: 'look.chat', to: 'chat.chat', type: 'chat-out', commands: ['/look'] },
      { from: 'parser.events', to: 'lookout.heard' },
    ]);
    expect(removePort(g, 'look', { side: 'out', removed: 'chat' }).edges).toHaveLength(4);
    expect(portChanged(g, 'look', { side: 'out', from: 'chat', to: 'say' }).edges[3]?.from).toBe(
      'look.say'
    );
    expect(edgesOfPort(g.edges, 'look', 'in', 'heard').map((e) => e.from)).toEqual([
      'parser.events',
      'other.events',
    ]);
  });

  it('makes an edge from an output dragged to an input, of the output’s type', () => {
    const g = VIEW.graph;
    expect(
      edgeOf(
        { source: 'chat', sourceHandle: 'chat', target: 'actor-a', targetHandle: 'chat' },
        plugins,
        g
      )
    ).toEqual({
      from: 'chat.chat',
      to: 'actor-a.chat',
      type: 'chat-in',
    });
    // Dragged to a connector's out card: an edge to its node, a dry run until said (D64).
    expect(
      edgeOf(
        { source: 'actor-a', sourceHandle: 'chat', target: 'chat::out', targetHandle: 'chat' },
        plugins,
        g
      )
    ).toEqual({ from: 'actor-a.chat', to: 'chat.chat', type: 'chat-out', dryRun: true });
    expect(
      edgeOf(
        { source: 'gone', sourceHandle: null, target: 'actor-a', targetHandle: null },
        plugins,
        g
      )
    ).toEqual({
      from: 'gone',
      to: 'actor-a.',
    });
  });

  it('starts an edge from an output that declares its commands with them (D74)', () => {
    const g: Graph = {
      version: 2,
      nodes: [...VIEW.graph.nodes, { id: 'look', plugin: 'script' }],
      edges: [],
    };
    const look: PluginView = {
      plugin: 'script',
      version: '0.1.0',
      description: 'A script',
      kinds: ['actor'],
      inputs: {},
      outputs: {
        chat: {
          type: 'chat-out',
          commands: ['/look'],
          label: 'chat-out of any network',
          optional: false,
        },
      },
      interface: { reads: [], actions: [], commands: [] },
      secrets: [],
      configSecrets: [],
      events: [],
    };
    expect(
      edgeOf(
        { source: 'look', sourceHandle: 'chat', target: 'chat::out', targetHandle: 'chat' },
        plugins,
        g,
        { look }
      )
    ).toEqual({
      from: 'look.chat',
      to: 'chat.chat',
      type: 'chat-out',
      commands: ['/look'],
      dryRun: true,
    });
  });

  describe('the chats a config names, on its edges (D97)', () => {
    const port = (type: 'chat-in' | 'chat-out', more = {}) => ({
      type,
      label: `${type} of any network`,
      optional: false,
      ...more,
    });
    const view = (plugin: string, more: Partial<PluginView>): PluginView => ({
      plugin,
      version: '0.1.0',
      description: plugin,
      kinds: [],
      inputs: {},
      outputs: {},
      interface: { reads: [], actions: [], commands: [] },
      secrets: [],
      configSecrets: [],
      events: [],
      ...more,
    });
    const views = new Map<string, PluginView>([
      ['bot', view('bot', { kinds: ['connector'], configChats: [{ key: 'owner', owner: true }] })],
      [
        'reactor',
        view('reactor', {
          inputs: { chat: port('chat-in') },
          outputs: { chat: port('chat-out') },
          configChats: [
            { key: 'chat', output: 'chat', template: true },
            { key: 'in', input: 'chat' },
          ],
        }),
      ],
      [
        'teller',
        view('teller', { outputs: { chat: port('chat-out', { owner: true, many: true }) } }),
      ],
    ]);
    const g: Graph = {
      version: 2,
      nodes: [
        { id: 'bot', plugin: 'bot', config: { owner: 1000000002 } },
        { id: 'look', plugin: 'reactor', config: { chat: '@QuestBot', in: ['#lobby'] } },
        { id: 'teller', plugin: 'teller' },
      ],
      edges: [],
    };

    it('reads a config key’s chats: a chat, a number, a list; never a template', () => {
      expect(fixedChats('@QuestBot', {})).toEqual(['@QuestBot']);
      expect(fixedChats(5, {})).toEqual(['5']);
      expect(fixedChats(['a', 2, null], {})).toEqual(['a', '2']);
      expect(fixedChats('{chat}', { template: true })).toEqual([]);
      expect(fixedChats('', {})).toEqual([]);
      expect(ownerOf(g.nodes[0], views.get('bot'))).toEqual(['1000000002']);
      expect(ownerOf(g.nodes[1], views.get('reactor'))).toEqual([]);
    });

    it('starts a new edge with the chats its node’s config picked, or the owner’s', () => {
      expect(
        edgeOf(
          { source: 'look', sourceHandle: 'chat', target: 'bot::out', targetHandle: 'chat' },
          views,
          g
        )
      ).toEqual({
        from: 'look.chat',
        to: 'bot.chat',
        type: 'chat-out',
        sends: ['@QuestBot'],
        dryRun: true,
      });
      expect(
        edgeOf(
          { source: 'bot', sourceHandle: 'chat', target: 'look', targetHandle: 'chat' },
          new Map([...views, ['bot', view('bot', { outputs: { chat: port('chat-in') } })]]),
          g
        )
      ).toMatchObject({ type: 'chat-in', reads: ['#lobby'] });
      expect(
        edgeOf(
          { source: 'teller', sourceHandle: 'chat', target: 'bot::out', targetHandle: 'chat' },
          views,
          g
        )
      ).toMatchObject({ sends: ['1000000002'] });
      // A template names no chat ahead.
      const templated = {
        ...g,
        nodes: g.nodes.map((n) => (n.id === 'look' ? { ...n, config: { chat: '{chat}' } } : n)),
      };
      expect(
        edgeOf(
          { source: 'look', sourceHandle: 'chat', target: 'bot::out', targetHandle: 'chat' },
          views,
          templated
        )
      ).not.toHaveProperty('sends');
    });

    it('adds a chat picked to its edge, replaces it when the pick changes, and keeps the rest', () => {
      const wired: Graph = {
        ...g,
        edges: [
          { from: 'look.chat', to: 'bot.chat', type: 'chat-out', sends: ['@QuestBot', '#extra'] },
          { from: 'bot.chat', to: 'look.chat', type: 'chat-in', reads: ['#lobby'] },
        ],
      };
      const specs = views.get('reactor')?.configChats ?? [];
      const before = { chat: '@QuestBot', in: ['#lobby'] };
      const after = syncEdgeChats(wired, 'look', specs, before, {
        chat: '@OtherBot',
        in: ['#lobby'],
      });
      expect(after.edges[0]?.sends).toEqual(['#extra', '@OtherBot']);
      expect(after.edges[1]).toBe(wired.edges[1]);
      // A template in its place takes the chat off; nothing changed, the graph as it was.
      expect(
        syncEdgeChats(wired, 'look', specs, before, { chat: '{chat}', in: ['#lobby'] }).edges[0]
          ?.sends
      ).toEqual(['#extra']);
      expect(syncEdgeChats(wired, 'look', specs, before, before)).toBe(wired);
      // Its input's: onto the reads, unless it reads every chat.
      expect(
        syncEdgeChats(wired, 'look', specs, before, { ...before, in: ['#side'] }).edges[1]?.reads
      ).toEqual(['#side']);
      const every = {
        ...wired,
        edges: [wired.edges[0], { ...wired.edges[1], reads: '*' }],
      } as Graph;
      expect(
        syncEdgeChats(every, 'look', specs, before, { ...before, in: ['#side'] }).edges[1]?.reads
      ).toBe('*');
      // Picked where its edge names it already, by any case: named once.
      expect(
        syncEdgeChats(
          wired,
          'look',
          specs,
          { in: ['#lobby'] },
          { chat: '@questbot', in: ['#lobby'] }
        ).edges[0]?.sends
      ).toEqual(['@QuestBot', '#extra']);
      // People it recognises (D100) go on no edge, nor keep a chat on one.
      const people = [...specs, { key: 'deny', output: 'chat', sender: true as const }];
      expect(
        syncEdgeChats(wired, 'look', people, before, { ...before, deny: ['66'] }).edges[0]?.sends
      ).toEqual(['@QuestBot', '#extra']);
      expect(
        syncEdgeChats(wired, 'look', people, before, {
          chat: '@OtherBot',
          in: ['#lobby'],
          deny: ['@QuestBot'],
        }).edges[0]?.sends
      ).toEqual(['#extra', '@OtherBot']);
    });
  });

  it('places each problem where the editor shows it', () => {
    const placed = placeProblems([
      { text: 'edge bad', edge: { from: 'a.x', to: 'b.y' }, node: 'b' },
      { text: 'config bad', node: 'a', config: 'host' },
      { text: 'config worse', node: 'a', config: 'host' },
      { text: 'setting bad', node: 'a', setting: 'loud' },
      { text: 'port bad', node: 'b', port: 'y' },
      { text: 'node bad', node: 'b' },
      { text: 'anywhere' },
    ]);
    expect(placed.edges.get('a.x → b.y')).toEqual(['edge bad']);
    expect(placed.config.get('a')).toEqual({ host: ['config bad', 'config worse'] });
    expect(placed.settings.get('a')).toEqual({ loud: ['setting bad'] });
    expect(placed.ports.get('b.y')).toEqual(['port bad']);
    expect(placed.nodes.get('b')).toEqual(['node bad']);
    expect(placed.other).toEqual(['anywhere']);
  });

  it('draws a node from its plugin, or says its plugin is not offered', () => {
    const chat = viewOf(
      { id: 'c', plugin: 'chat', account: 'chat:other', config: { host: 'h' } },
      plugins.get('chat')
    );
    expect(chat).toMatchObject({
      id: 'c',
      plugin: 'chat',
      account: 'chat:other',
      config: { host: 'h' },
    });
    // No account named: its node's id on its plugin's network (D119).
    expect(viewOf({ id: 'c', plugin: 'chat' }, plugins.get('chat')).account).toBe('chat:c');
    const gone = viewOf({ id: 'g', plugin: 'gone' }, undefined);
    expect(gone).toMatchObject({
      id: 'g',
      description: 'the plugin gone is not offered by this instance',
    });
    expect(gone).not.toHaveProperty('account');
  });

  it('draws a node’s inputs as the check resolved them, once it has (#6)', () => {
    const plugin = {
      ...(plugins.get('chat') as PluginView),
      inputs: {
        heard: { type: 'events', config: 'on', label: 'events of config on', optional: false },
      },
    } as PluginView;
    const node = { id: 'ears', plugin: 'chat' };
    // Not seen by the check yet: from its config as written, which names no namespace.
    expect(viewOf(node, plugin).inputs['heard']).not.toHaveProperty('namespace');
    // The check's: its schema's default resolved.
    const resolved = {
      heard: {
        type: 'events',
        namespace: 'dice',
        config: 'on',
        label: 'events of dice',
        optional: false,
      },
    } as const;
    expect(viewOf(node, plugin, resolved).inputs).toEqual(resolved);
  });

  it('resolves an events input whose namespace a node’s config names, as the core does', () => {
    const ports = {
      heard: { type: 'events', config: 'on', label: 'events of config on', optional: false },
      maybe: { type: 'events', config: 'also', label: 'events of config also', optional: true },
      chat: { type: 'chat-in', label: 'chat-in of any network', optional: false },
      matched: { type: 'chat-in', when: 'match', label: 'chat-in of any network', optional: false },
    } as const;
    expect(inputsOf(ports, { on: 'dice.roll', also: 'cards' })).toEqual({
      heard: { ...ports.heard, namespace: 'dice', label: 'events of dice' },
      maybe: { ...ports.maybe, namespace: 'cards', label: 'events of cards' },
      chat: ports.chat,
    });
    // Unresolved: a required one stays, for the check to refuse; an optional one is not there.
    expect(inputsOf(ports, { on: 'Bad' })).toEqual({ heard: ports.heard, chat: ports.chat });
    expect(inputsOf(ports, undefined)).toEqual({ heard: ports.heard, chat: ports.chat });
    // A chat-in there only with its config key (the reactor's match).
    expect(inputsOf(ports, { match: 'x' })).toEqual({
      heard: ports.heard,
      chat: ports.chat,
      matched: ports.matched,
    });
    // An events input there only with its config key (the reactor's on), required once there.
    const reactor = {
      events: {
        type: 'events',
        config: 'on',
        when: 'on',
        label: 'events of config on',
        optional: false,
      },
    } as const;
    expect(inputsOf(reactor, { match: 'x' })).toEqual({});
    expect(inputsOf(reactor, { on: 'dice.roll' })).toEqual({
      events: { ...reactor.events, namespace: 'dice', label: 'events of dice' },
    });
  });
});

describe('the cards', () => {
  const views = new Map(VIEW.nodes.map((v) => [v.id, v]));
  const chat = views.get('chat') as (typeof VIEW.nodes)[number];

  it('draw a connector as an in card and an out card, and any other node as one', () => {
    expect(isSplit(chat)).toBe(true);
    const [inCard, outCard] = cardsOf(chat);
    expect(inCard).toMatchObject({ id: 'chat', node: 'chat', side: 'in' });
    expect(Object.keys(inCard?.view.inputs ?? {})).toEqual([]);
    expect(Object.keys(inCard?.view.outputs ?? {})).toEqual(['chat']);
    expect(outCard).toMatchObject({ id: 'chat::out', node: 'chat', side: 'out' });
    expect(Object.keys(outCard?.view.inputs ?? {})).toEqual(['chat']);
    expect(outCard?.view.outputs).toEqual({});
    const actor = views.get('actor-a') as (typeof VIEW.nodes)[number];
    expect(cardsOf(actor)).toEqual([
      { id: 'actor-a', node: 'actor-a', side: undefined, view: actor },
    ]);
    expect(cardTitle('chat', 'out')).toBe('chat · out');
    expect(cardTitle('actor-a', undefined)).toBe('actor-a');
    expect(nodesOfCards(['chat::out', 'actor-a', 'chat'])).toEqual(['chat', 'actor-a']);
  });

  it('end a chat-out edge on the out card, and every other on the node’s card', () => {
    expect(targetCard({ from: 'actor-a.chat', to: 'chat.chat', type: 'chat-out' }, views)).toBe(
      'chat::out'
    );
    expect(targetCard({ from: 'actor-a.chat', to: 'chat', type: 'chat-out' }, views)).toBe(
      'chat::out'
    );
    expect(targetCard({ from: 'chat.chat', to: 'actor-a.chat', type: 'chat-in' }, views)).toBe(
      'actor-a'
    );
    expect(targetCard({ from: 'x', to: 'chat.other' }, views)).toBe('chat');
    expect(targetCard({ from: 'x', to: 'gone.y' }, views)).toBe('gone');
  });
});

describe('an edge dropped on a node whose inputs its config declares (D80)', () => {
  const grows: PluginView = {
    plugin: 'grows',
    version: '0.1.0',
    description: 'inputs from its config',
    kinds: ['actor'],
    inputs: {},
    outputs: {
      chat: { type: 'chat-out', label: 'chat-out', optional: false },
      events: { type: 'events', namespace: 'watch', label: 'events of watch', optional: false },
    },
    interface: { reads: [], actions: [], commands: [] },
    secrets: [],
    configSecrets: [],
    events: [],
    configInputs: { key: 'inputs', types: ['events', 'interface'] },
  };
  const all = new Map([...plugins, ['grows', grows]]);
  const g: Graph = {
    version: 2,
    nodes: [
      { id: 'parser', plugin: 'parser' },
      { id: 'chat', plugin: 'chat' },
      {
        id: 'watch',
        plugin: 'grows',
        config: { code: 'x', inputs: { game: { type: 'interface' } } },
      },
    ],
    edges: [],
  };
  /** A drop that binds (or adds) an input; undefined for one that asks which. */
  const drop = (...a: Parameters<typeof dropOn>) => {
    const r = dropOn(...a);
    return r !== undefined && 'graph' in r ? r : undefined;
  };
  const inputs = (r: ReturnType<typeof drop>) =>
    r?.graph.nodes.find((n) => n.id === 'watch')?.config?.['inputs'];

  it('adds an events input of the output’s namespace, named after it, and binds the edge', () => {
    const r = drop(g, { node: 'parser', port: 'events' }, 'watch', all);
    // `game` is taken (by an interface input): the next free name.
    expect(r?.port).toBe('game-2');
    expect(r?.added).toBe(true);
    expect(inputs(r)).toEqual({
      game: { type: 'interface' },
      'game-2': { type: 'events', namespace: 'game' },
    });
    expect(r?.graph.nodes.find((n) => n.id === 'watch')?.config?.['code']).toBe('x');
    expect(r?.graph.edges).toEqual([{ from: 'parser.events', to: 'watch.game-2', type: 'events' }]);
    // Dropped again: the input it has takes it.
    const again = drop(r?.graph as Graph, { node: 'parser', port: 'events' }, 'watch', all);
    expect(again).toMatchObject({ port: 'game-2', added: false });
    expect(inputs(again)).toEqual(inputs(r));
  });

  it('adds an interface input of the output’s plugin with no member, for the owner to pick', () => {
    const r = drop(g, { node: 'parser', port: 'interface' }, 'watch', all);
    expect(r?.port).toBe('parser');
    expect((inputs(r) as Record<string, unknown>)['parser']).toEqual({
      type: 'interface',
      plugin: 'parser',
      members: [],
    });
    expect(r?.graph.edges).toEqual([
      { from: 'parser.interface', to: 'watch.parser', type: 'interface' },
    ]);
    // Bound, it takes no second edge: another input is added.
    const second = drop(r?.graph as Graph, { node: 'parser', port: 'interface' }, 'watch', all);
    expect(second).toMatchObject({ port: 'parser-2', added: true });
    // A node with no config yet starts one.
    const bare: Graph = { ...g, nodes: [...g.nodes.slice(0, 2), { id: 'watch', plugin: 'grows' }] };
    expect(inputs(drop(bare, { node: 'parser', port: 'interface' }, 'watch', all))).toEqual({
      parser: { type: 'interface', plugin: 'parser', members: [] },
    });
  });

  it('takes nothing it does not declare, nor its own outputs, nor a node that declares none', () => {
    // A chat-in output: no input of its type is declared in its config.
    expect(drop(g, { node: 'chat', port: 'chat' }, 'watch', all)).toBeUndefined();
    expect(drop(g, { node: 'watch', port: 'events' }, 'watch', all)).toBeUndefined();
    expect(drop(g, { node: 'parser', port: 'events' }, 'chat', all)).toBeUndefined();
    expect(drop(g, { node: 'parser', port: 'nope' }, 'watch', all)).toBeUndefined();
    expect(drop(g, { node: 'parser', port: 'events' }, 'gone', all)).toBeUndefined();
    const eventsOnly = new Map([
      ...all,
      ['grows', { ...grows, configInputs: { key: 'inputs', types: ['events' as const] } }],
    ]);
    expect(drop(g, { node: 'parser', port: 'interface' }, 'watch', eventsOnly)).toBeUndefined();
    // An events output whose namespace is not known yet.
    const unknown = new Map([
      ...all,
      [
        'parser',
        {
          ...(plugins.get('parser') as PluginView),
          outputs: { events: { type: 'events', label: 'events', optional: false } },
        } as PluginView,
      ],
    ]);
    expect(drop(g, { node: 'parser', port: 'events' }, 'watch', unknown)).toBeUndefined();
    // A node whose ports its config declares is read from the check's views.
    const views = { parser: { ...grows, plugin: 'parser' } };
    expect(drop(g, { node: 'parser', port: 'events' }, 'watch', all, views)?.port).toBe('watch');
  });

  it('binds to the one input of several that is free, and asks which when none or more are (D84)', () => {
    const two = (inputs: Record<string, unknown>, edges: Graph['edges'] = []): Graph => ({
      ...g,
      nodes: [...g.nodes.slice(0, 2), { id: 'watch', plugin: 'grows', config: { inputs } }],
      edges,
    });
    const events = {
      a: { type: 'events', namespace: 'game' },
      b: { type: 'events', namespace: 'game' },
    };
    // Two events inputs of the namespace, both free: which one is the owner's to say.
    expect(dropOn(two(events), { node: 'parser', port: 'events' }, 'watch', all)).toEqual({
      choose: ['a', 'b'],
    });
    // One of them bound already (from another node): the free one takes it.
    const one = two(events, [{ from: 'other.events', to: 'watch.a' }]);
    expect(drop(one, { node: 'parser', port: 'events' }, 'watch', all)).toMatchObject({
      port: 'b',
      added: false,
    });
    // Bound to this very output already: dropped again, it changes nothing.
    const twice = two(events, [{ from: 'parser.events', to: 'watch.b' }]);
    expect(drop(twice, { node: 'parser', port: 'events' }, 'watch', all)).toMatchObject({
      port: 'b',
      added: false,
    });
    // Both bound: asked again.
    expect(
      dropOn(
        two(events, [
          { from: 'other.events', to: 'watch.a' },
          { from: 'more.events', to: 'watch.b' },
        ]),
        { node: 'parser', port: 'events' },
        'watch',
        all
      )
    ).toEqual({ choose: ['a', 'b'] });
    // Two interface inputs of the plugin, both free: asked; one bound, the other takes it.
    const ifaces = {
      reads: { type: 'interface', plugin: 'parser', members: ['state.board'] },
      acts: { type: 'interface', plugin: 'parser', members: ['actions.reset'] },
    };
    expect(dropOn(two(ifaces), { node: 'parser', port: 'interface' }, 'watch', all)).toEqual({
      choose: ['reads', 'acts'],
    });
    const bound = two(ifaces, [{ from: 'parser.interface', to: 'watch.reads' }]);
    expect(drop(bound, { node: 'parser', port: 'interface' }, 'watch', all)?.graph.edges).toEqual([
      { from: 'parser.interface', to: 'watch.reads' },
      { from: 'parser.interface', to: 'watch.acts', type: 'interface' },
    ]);
  });

  it('names a port free in the node', () => {
    expect(freeName('chat', ['chat', 'chat-2'])).toBe('chat-3');
  });
});

describe('an edge dragged (#4)', () => {
  const port = (p: Record<string, unknown>): PortView =>
    ({ optional: false, label: `${String(p['type'])} port`, ...p }) as PortView;

  it('binds ports of one type that agree, and says why others do not', () => {
    const chatIn = port({ type: 'chat-in', network: 'irc', label: 'chat-in of irc' });
    expect(bindProblem(chatIn, port({ type: 'chat-in' }))).toBeUndefined();
    expect(bindProblem(chatIn, port({ type: 'chat-in', network: 'telegram' }))).toBe(
      'chat-in of irc cannot bind chat-in port'
    );
    expect(bindProblem(chatIn, port({ type: 'events', namespace: 'dice' }))).toBe(
      'chat-in of irc cannot bind events port'
    );
    const out = port({ type: 'chat-out' });
    expect(bindProblem(out, port({ type: 'chat-out', network: 'irc' }))).toBeUndefined();
    const dice = port({ type: 'events', namespace: 'dice' });
    expect(bindProblem(dice, port({ type: 'events', namespace: 'dice' }))).toBeUndefined();
    expect(bindProblem(dice, port({ type: 'events', namespace: 'cards' }))).toBe(
      'events port cannot bind events port'
    );
    // Not resolved yet: the check says.
    expect(bindProblem(dice, port({ type: 'events', config: 'on' }))).toBeUndefined();
    const face = port({ type: 'interface', plugin: 'dice', members: ['state.get'] });
    expect(
      bindProblem(face, port({ type: 'interface', plugin: 'dice', members: ['state.get'] }))
    ).toBeUndefined();
    expect(bindProblem(face, port({ type: 'interface', members: ['actions.roll'] }))).toBe(
      'dice does not declare actions.roll'
    );
    expect(
      bindProblem(
        port({ type: 'interface', members: [] }),
        port({ type: 'interface', members: ['x'] })
      )
    ).toBe('interface port does not declare x');
    expect(bindProblem(face, port({ type: 'interface', plugin: 'cards', members: [] }))).toBe(
      'interface port cannot bind interface port'
    );
  });

  it('binds a connector’s commands output to a plugin’s commands input alone (D109)', () => {
    const served = port({ type: 'commands', network: 'telegram', label: 'commands of telegram' });
    expect(bindProblem(served, port({ type: 'commands', commands: ['map'] }))).toBeUndefined();
    expect(bindProblem(port({ type: 'chat-in' }), port({ type: 'commands' }))).toBe(
      'chat-in port cannot bind commands port'
    );
    expect(bindProblem(served, port({ type: 'chat-in' }))).toBe(
      'commands of telegram cannot bind chat-in port'
    );
  });
});

describe('a node added, wired (D135)', () => {
  const port = (p: Record<string, unknown>): PortView =>
    ({ optional: false, label: `${String(p['type'])} port`, ...p }) as PortView;
  const view = (
    plugin: string,
    inputs: Record<string, PortView>,
    outputs: Record<string, PortView>
  ): PluginView => ({
    plugin,
    version: '0.1.0',
    description: plugin,
    kinds: [],
    inputs,
    outputs,
    interface: { reads: [], actions: [], commands: [] },
    secrets: [],
    configSecrets: [],
    events: [],
  });
  const face = (plugin: string, members: string[]): PortView =>
    port({ type: 'interface', plugin, members });
  const all = new Map(
    [
      view(
        'telegram-user',
        { chat: port({ type: 'chat-out', network: 'telegram', optional: true }) },
        {
          chat: port({ type: 'chat-in', network: 'telegram' }),
          interface: face('telegram-user', []),
        }
      ),
      view(
        'irc',
        { chat: port({ type: 'chat-out', network: 'irc', optional: true }) },
        { chat: port({ type: 'chat-in', network: 'irc' }), interface: face('irc', []) }
      ),
      view(
        'attention',
        {},
        { attention: port({ type: 'attention' }), interface: face('attention', ['state.status']) }
      ),
      view(
        'turn-parser',
        {},
        {
          events: port({ type: 'events', namespace: 'game' }),
          interface: face('turn-parser', ['state.ready', 'actions.sent']),
        }
      ),
      view(
        'player',
        {
          parser: port({ type: 'interface', members: ['state.ready', 'actions.sent'] }),
          attention: port({ type: 'attention' }),
          moods: port({ type: 'attention', optional: true }),
        },
        {
          chat: port({ type: 'chat-out', network: 'telegram' }),
          interface: face('player', ['state.status']),
        }
      ),
      view('reactor', { on: port({ type: 'events', config: 'on' }) }, {}),
    ].map((v) => [v.plugin, v])
  );
  const portsOf = (n: { plugin: string }) => all.get(n.plugin);
  const graph = (...nodes: [string, string][]): Graph => ({
    version: 2,
    nodes: nodes.map(([id, plugin]) => ({ id, plugin })),
    edges: [],
  });
  const added = (g: Graph, id: string, plugin: string) =>
    wireRequired(addNode(g, { id, plugin, disabled: true }), id, portsOf, all);

  it('binds each required port the one port of the draft serves, a chat-out edge a dry run', () => {
    const g = graph(['me', 'telegram-user'], ['bob', 'attention'], ['game', 'turn-parser']);
    const { graph: out, wired } = added(g, 'player', 'player');
    expect(wired).toEqual([
      { from: 'game.interface', to: 'player.parser', type: 'interface' },
      { from: 'bob.attention', to: 'player.attention', type: 'attention' },
      // Its chat unnamed, for the owner to pick; sent nowhere until the owner says so.
      { from: 'player.chat', to: 'me.chat', type: 'chat-out', dryRun: true },
    ]);
    expect(out.edges).toEqual(wired);
    expect(out.nodes.at(-1)).toEqual({ id: 'player', plugin: 'player', disabled: true });
  });

  it('leaves a port unwired when no port, or several, serve it', () => {
    // Two people, two Telegram accounts: the owner says which; no IRC connector serves its chat.
    const two = graph(
      ['me', 'telegram-user'],
      ['bot', 'telegram-user'],
      ['bob', 'attention'],
      ['carol', 'attention'],
      ['game', 'turn-parser']
    );
    expect(added(two, 'player', 'player').wired).toEqual([
      { from: 'game.interface', to: 'player.parser', type: 'interface' },
    ]);
    expect(added(graph(['irc', 'irc']), 'player', 'player').wired).toEqual([]);
    // An events input whose namespace is not known yet is the check's to say, never guessed.
    expect(added(graph(['game', 'turn-parser']), 'reactor', 'reactor').wired).toEqual([]);
    // A node nothing is known of is added as it is.
    const unknown = added(graph(['bob', 'attention']), 'ghost', 'ghost');
    expect(unknown.wired).toEqual([]);
    expect(unknown.graph.edges).toEqual([]);
    expect(wireRequired(EMPTY_GRAPH, 'none', portsOf, all)).toEqual({
      graph: EMPTY_GRAPH,
      wired: [],
    });
  });

  it('keeps a port bound already as it is', () => {
    const g: Graph = {
      ...graph(['me', 'telegram-user'], ['bob', 'attention'], ['player', 'player']),
      edges: [
        { from: 'bob.attention', to: 'player.attention', type: 'attention' },
        { from: 'player.chat', to: 'me.chat', type: 'chat-out', sends: ['@QuestBot'] },
      ],
    };
    expect(wireRequired(g, 'player', portsOf, all)).toEqual({ graph: g, wired: [] });
  });
});

describe('a commands edge (D109)', () => {
  it('starts a dry run in the connector’s owner’s chat', () => {
    const bot: PluginView = {
      plugin: 'bot',
      version: '0.1.0',
      description: 'a bot',
      kinds: ['connector'],
      inputs: {},
      outputs: { commands: { type: 'commands', label: 'commands of telegram', optional: false } },
      interface: { reads: [], actions: [], commands: [] },
      secrets: [],
      configSecrets: [],
      events: [],
      configChats: [{ key: 'owner', kinds: ['private'], owner: true }],
    };
    const g: Graph = {
      version: 2,
      nodes: [
        { id: 'bot', plugin: 'bot', config: { owner: 1000000002 } },
        { id: 'map', plugin: 'map' },
      ],
      edges: [],
    };
    expect(
      edgeOf(
        { source: 'bot', sourceHandle: 'commands', target: 'map', targetHandle: 'commands' },
        new Map([['bot', bot]]),
        g
      )
    ).toEqual({
      from: 'bot.commands',
      to: 'map.commands',
      type: 'commands',
      chats: ['1000000002'],
      dryRun: true,
    });
  });

  it('says what it serves, where and to whom, in words, and where a plugin is served', () => {
    const e = { from: 'bot.commands', to: 'map.commands', type: 'commands' as const };
    expect(servesText({ ...e, chats: ['#a'] })).toBe('answers every command in 1 chat, to anyone');
    expect(
      servesText({
        ...e,
        serves: ['map', 'ban'],
        chats: ['#a', '#b'],
        privateChats: true,
        senders: ['owner', '@alice'],
        dryRun: true,
      })
    ).toBe(
      'answers /map, /ban in 2 chats and every private chat, to the owner and 1 other; a dry run'
    );
    expect(servesText({ ...e, serves: [], senders: [] })).toBe(
      'answers no command in no chat, to no one'
    );
    expect(servedNote('map', [])).toBe('no edge serves its commands: no chat asks it anything');
    expect(servedNote('map', [{ ...e, privateChats: true }])).toBe(
      'bot answers every command in every private chat, to anyone'
    );
  });

  it('changes what it serves, where, and its dry run', () => {
    const e = { from: 'bot.commands', to: 'map.commands', type: 'commands' as const };
    const g: Graph = { version: 2, nodes: [], edges: [{ ...e, chats: [], dryRun: true }] };
    const key = edgeKey(e);
    expect(
      updateEdge(g, key, { serves: ['map'], chats: ['#a'], privateChats: true, dryRun: undefined })
        .edges
    ).toEqual([{ ...e, serves: ['map'], chats: ['#a'], privateChats: true }]);
  });
});
