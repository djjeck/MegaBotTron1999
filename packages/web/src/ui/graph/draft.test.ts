import { describe, expect, it } from 'vitest';
import { AVAILABLE, VIEW } from '#test/graph-view.ts';
import {
  addNode,
  asGraph,
  connect,
  edgeKey,
  edgeOf,
  EMPTY_GRAPH,
  endOf,
  freeId,
  idProblem,
  instanceOf,
  placeProblems,
  removeEdge,
  removeNode,
  sameGraph,
  updateEdge,
  updateNode,
  viewOf,
} from './draft.ts';

const plugins = new Map(AVAILABLE.map((p) => [p.id, p]));

describe('the draft', () => {
  it('starts as the saved file’s graph, keeping only nodes and edges', () => {
    expect(asGraph(undefined)).toEqual(EMPTY_GRAPH);
    expect(asGraph([])).toEqual(EMPTY_GRAPH);
    expect(asGraph({ nodes: 'x' })).toEqual(EMPTY_GRAPH);
    expect(
      asGraph({
        version: 1,
        nodes: [{ id: 'a', plugin: 'p' }, { id: 1 }, null],
        edges: [{ from: 'a.x', to: 'b.y' }, { from: 'a' }],
      })
    ).toEqual({
      version: 1,
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
    g = updateNode(g, 'a', { account: '', settings: {}, mode: undefined });
    expect(g.nodes[0]).toEqual({ id: 'a', plugin: 'chat', config: { host: 'h' } });
    g = connect(g, { from: 'a.chat', to: 'b.chat', type: 'chat' });
    g = connect(g, { from: 'a.chat', to: 'b.chat', type: 'chat', reads: ['#a'] });
    g = connect(g, { from: 'b.interface', to: 'c.x' });
    expect(g.edges).toHaveLength(2);
    expect(removeNode(g, 'a')).toEqual({
      version: 1,
      nodes: [{ id: 'b', plugin: 'actor', instance: 'old-b' }],
      edges: [{ from: 'b.interface', to: 'c.x' }],
    });
  });

  it('changes an edge’s chats and commands, and removes it', () => {
    let g = connect(EMPTY_GRAPH, { from: 'a.chat', to: 'b.chat', type: 'chat', commands: ['/x'] });
    g = connect(g, { from: 'c', to: 'b.other' });
    const key = edgeKey({ from: 'a.chat', to: 'b.chat' });
    expect(key).toBe('a.chat → b.chat');
    g = updateEdge(g, key, { reads: ['#a'], sends: [], commands: [] });
    expect(g.edges[0]).toEqual({
      from: 'a.chat',
      to: 'b.chat',
      type: 'chat',
      reads: ['#a'],
      sends: [],
    });
    g = updateEdge(g, key, { reads: undefined, commands: ['/play'] });
    expect(g.edges[0]).toEqual({
      from: 'a.chat',
      to: 'b.chat',
      type: 'chat',
      sends: [],
      commands: ['/play'],
    });
    expect(removeEdge(g, key).edges).toEqual([{ from: 'c', to: 'b.other' }]);
    expect(endOf('c')).toEqual({ node: 'c', port: undefined });
    expect(endOf('a.chat')).toEqual({ node: 'a', port: 'chat' });
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
      type: 'chat',
    });
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
    expect(viewOf({ id: 'c', plugin: 'chat' }, plugins.get('chat')).account).toBe('chat:me');
    const gone = viewOf({ id: 'g', plugin: 'gone' }, undefined);
    expect(gone).toMatchObject({
      id: 'g',
      description: 'the plugin gone is not offered by this instance',
    });
    expect(gone).not.toHaveProperty('account');
  });
});
