// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph, PluginView } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { AVAILABLE, VIEW } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { groupsOf, hashName, isLaneId, LANE_PALETTE, laneColours, laneId, lit } from './lanes.ts';
import {
  CARD_WIDTH,
  COLUMN_GAP,
  LANE_GAP,
  LANE_HEAD,
  LANE_PAD,
  ROW_GAP,
  swimlanes,
} from './layout.ts';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const slow = { timeout: 5000 };

describe('swimlanes', () => {
  it('names each lane by its group, in the order of its first node, the ungrouped one last', () => {
    expect(
      groupsOf([
        { id: 'a', plugin: 'p', group: 'Beta' },
        { id: 'b', plugin: 'p' },
        { id: 'c', plugin: 'p', group: 'Alpha' },
        { id: 'd', plugin: 'p', group: 'Beta' },
      ])
    ).toEqual(['Beta', 'Alpha']);
    expect(laneId('Beta')).toBe('::lane:Beta');
    expect(laneId(undefined)).toBe('::lane');
    expect([laneId('x'), laneId(undefined), 'node', 'x::out'].map(isLaneId)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('colours each lane by its name’s hash, the next free colour when an earlier lane has it', () => {
    expect(hashName('Quest')).toBe(hashName('Quest'));
    expect(hashName('Quest')).not.toBe(hashName('Loot'));
    const n = LANE_PALETTE.length;
    // Two names that hash to the same colour: the second takes the next one.
    const names = Array.from({ length: 200 }, (_, i) => `g${i}`);
    const first = names[0] as string;
    const twin = names.find((x) => x !== first && hashName(x) % n === hashName(first) % n);
    expect(twin).toBeDefined();
    const two = laneColours([first, twin as string]);
    expect(two.get(first)).toBe(LANE_PALETTE[hashName(first) % n]);
    expect(two.get(twin as string)).toBe(LANE_PALETTE[(hashName(first) + 1) % n]);
    // A lane's colour is its own whatever the lanes after it.
    expect(laneColours([first, 'other']).get(first)).toBe(two.get(first));
    // As many lanes as colours: all different; past them, never the colour of the lane above.
    const many = names.slice(0, n + 6);
    const colours = many.map((g) => laneColours(many).get(g));
    expect(new Set(colours.slice(0, n)).size).toBe(n);
    for (let i = 1; i < colours.length; i++) expect(colours[i]).not.toBe(colours[i - 1]);
  });

  it('lights what a hover reaches: a node’s neighbours and lanes, or a lane and its connectors', () => {
    const drawn = [
      { id: '::lane:A' },
      { id: '::lane:B' },
      { id: 'tg', node: 'tg' },
      { id: 'tg::out', node: 'tg' },
      { id: 'a1', node: 'a1', parentId: '::lane:A' },
      { id: 'a2', node: 'a2', parentId: '::lane:A' },
      { id: 'b1', node: 'b1', parentId: '::lane:B' },
    ];
    const edges = [
      { id: 'e1', source: 'tg', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'tg::out' },
      { id: 'e3', source: 'a1', target: 'b1' },
      { id: 'e4', source: 'b1', target: 'tg::out' },
      { id: 'e5', source: 'ghost', target: 'a2' },
    ];
    expect(lit(undefined, drawn, edges)).toBeUndefined();
    const node = lit({ node: 'b1' }, drawn, edges);
    expect([...(node?.nodes ?? [])].sort()).toEqual(
      ['::lane:A', '::lane:B', 'a1', 'b1', 'tg::out'].sort()
    );
    expect([...(node?.edges ?? [])].sort()).toEqual(['e3', 'e4']);
    // A connector hovered: both its cards.
    expect([...(lit({ node: 'tg' }, drawn, edges)?.nodes ?? [])].sort()).toEqual(
      ['::lane:A', '::lane:B', 'a1', 'b1', 'tg', 'tg::out'].sort()
    );
    const lane = lit({ lane: '::lane:A' }, drawn, edges);
    // The lane, its cards and the connectors it touches; not the card of another lane.
    expect([...(lane?.nodes ?? [])].sort()).toEqual(
      ['::lane:A', 'a1', 'a2', 'tg', 'tg::out'].sort()
    );
    expect([...(lane?.edges ?? [])].sort()).toEqual(['e1', 'e2', 'e3', 'e5']);
  });

  it('lays the lanes out: global columns, each group a band, connectors outside at both ends', () => {
    const groups: Record<string, string> = { p: 'Game', a: 'Game', s: 'Stats', x: 'Game' };
    const { placed, lanes } = swimlanes(
      ['tg', 'p', 'a', 's', 'loose', 'x', 'tg::out'],
      [
        { from: 'tg.chat', to: 'p.chat' },
        { from: 'p.events', to: 'a.events' },
        { from: 'p.events', to: 's.events' },
        { from: 'a.chat', to: 'tg::out' },
      ],
      () => 100,
      {
        first: new Set(['tg']),
        last: new Set(['tg::out']),
        groupOf: (id) => groups[id],
      }
    );
    const x0 = COLUMN_GAP - LANE_PAD;
    const width = COLUMN_GAP + CARD_WIDTH + 2 * LANE_PAD;
    const game = LANE_HEAD + 2 * 100 + ROW_GAP + LANE_PAD;
    const stats = LANE_HEAD + 100 + LANE_PAD;
    expect(lanes).toEqual([
      { name: 'Game', x: x0, y: 0, width, height: game, cards: ['p', 'a', 'x'] },
      { name: 'Stats', x: x0, y: game + LANE_GAP, width, height: stats, cards: ['s'] },
      {
        name: undefined,
        x: x0,
        y: game + stats + 2 * LANE_GAP,
        width,
        height: stats,
        cards: ['loose'],
      },
    ]);
    expect(Object.fromEntries(placed)).toEqual({
      // The connector's cards: column 0, and the one past every other.
      tg: { x: 0, y: 0 },
      'tg::out': { x: 3 * COLUMN_GAP, y: 0 },
      // Each card in its global column, relative to its lane; a card fed by nothing at column 1.
      p: { x: LANE_PAD, y: LANE_HEAD, lane: 0 },
      x: { x: LANE_PAD, y: LANE_HEAD + 100 + ROW_GAP, lane: 0 },
      a: { x: LANE_PAD + COLUMN_GAP, y: LANE_HEAD, lane: 0 },
      s: { x: LANE_PAD + COLUMN_GAP, y: LANE_HEAD, lane: 1 },
      loose: { x: LANE_PAD, y: LANE_HEAD, lane: 2 },
    });
    // No connector: the lanes start at column 0.
    const bare = swimlanes(['p'], [], () => 100, {
      first: new Set(),
      last: new Set(),
      groupOf: () => 'Game',
    });
    expect(bare.lanes[0]?.x).toBe(-LANE_PAD);
    expect(bare.placed.get('p')).toEqual({ x: LANE_PAD, y: LANE_HEAD, lane: 0 });
  });

  it('draws an ungrouped source that feeds the lanes alone beside the in cards (D136)', () => {
    const groups: Record<string, string> = {
      'quest-parser': 'Quest',
      'quest-player': 'Quest',
      'dice-parser': 'Dice',
      'dice-player': 'Dice',
      'carol-player': 'Dice',
    };
    const { placed, lanes } = swimlanes(
      [
        'alice',
        'tg',
        'quest-parser',
        'quest-player',
        'dice-parser',
        'dice-player',
        'carol',
        'carol-player',
        'clock',
        'stats',
        'tg::out',
      ],
      [
        { from: 'alice.attention', to: 'quest-player.attention' },
        { from: 'alice.attention', to: 'dice-player.attention' },
        { from: 'tg.chat', to: 'quest-parser.chat' },
        { from: 'tg.chat', to: 'dice-parser.chat' },
        { from: 'quest-parser.interface', to: 'quest-player.parser' },
        { from: 'dice-parser.interface', to: 'dice-player.parser' },
        { from: 'quest-player.chat', to: 'tg::out' },
        { from: 'dice-player.chat', to: 'tg::out' },
        // A source that feeds one lane is beside the in cards too.
        { from: 'carol.attention', to: 'carol-player.attention' },
        // One that feeds an ungrouped card stays in the ungrouped band, with it.
        { from: 'clock.events', to: 'stats.events' },
      ],
      () => 100,
      { first: new Set(['tg']), last: new Set(['tg::out']), groupOf: (id) => groups[id] }
    );
    expect(lanes.map((l) => [l.name, l.cards])).toEqual([
      ['Quest', ['quest-parser', 'quest-player']],
      ['Dice', ['dice-parser', 'dice-player', 'carol-player']],
      [undefined, ['clock', 'stats']],
    ]);
    // The in card first, then the sources, in the graph's order, stacked in column 0.
    expect(placed.get('tg')).toEqual({ x: 0, y: 0 });
    expect(placed.get('alice')).toEqual({ x: 0, y: 100 + ROW_GAP });
    expect(placed.get('carol')).toEqual({ x: 0, y: 2 * (100 + ROW_GAP) });
    // Their players in their lanes, to their right.
    expect(placed.get('quest-player')).toEqual({
      x: LANE_PAD + COLUMN_GAP,
      y: LANE_HEAD,
      lane: 0,
    });
    expect(placed.get('carol-player')?.lane).toBe(1);
    // A grouped person stays in its lane; with no connector, the source takes column 0 alone.
    const own = swimlanes(
      ['bob', 'player'],
      [{ from: 'bob.attention', to: 'player.attention' }],
      () => 100,
      { first: new Set(), last: new Set(), groupOf: () => 'Quest' }
    );
    expect(own.lanes.map((l) => l.cards)).toEqual([['bob', 'player']]);
    const bare = swimlanes(
      ['bob', 'player'],
      [{ from: 'bob.attention', to: 'player.attention' }],
      () => 100,
      { first: new Set(), last: new Set(), groupOf: (id) => (id === 'bob' ? undefined : 'Quest') }
    );
    expect(bare.placed.get('bob')).toEqual({ x: 0, y: 0 });
    expect(bare.lanes).toEqual([
      expect.objectContaining({ name: 'Quest', x: COLUMN_GAP - LANE_PAD, cards: ['player'] }),
    ]);
  });
});

/** The made-up instance's graph with groups: the parser in Game, the connector's group ignored. */
const grouped = (): Graph => ({
  ...VIEW.graph,
  nodes: VIEW.graph.nodes.map((n) =>
    n.id === 'parser' ? { ...n, group: 'Game' } : n.id === 'chat' ? { ...n, group: 'Ignored' } : n
  ),
});

const nodeOf = (label: string): HTMLElement =>
  screen.getByLabelText(label).closest('.react-flow__node') as HTMLElement;

describe('the graph editor’s lanes', () => {
  it('draws each group as a lane holding its cards, the connector outside, and dims on hover', async () => {
    fakeCore({ file: grouped() });
    const { container } = render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    const game = await screen.findByRole('group', { name: 'lane Game' }, slow);
    expect(screen.getByRole('group', { name: 'lane of the ungrouped nodes' })).toBeDefined();
    // The connector's group draws no lane.
    expect(screen.queryByRole('group', { name: 'lane Ignored' })).toBeNull();
    // The parser's card is placed relative to its lane: within it, at the lane's padding.
    const at = (label: string): string => nodeOf(label).style.transform;
    expect(at('node parser')).toBe(
      `translate(${LANE_PAD + COLUMN_GAP - LANE_PAD}px,${LANE_HEAD}px)`
    );
    // The lane's label zooms to it, and resting on it dims what is outside it.
    const label = within(game).getByRole('button', { name: 'Game' });
    fireEvent.click(label);
    fireEvent.mouseEnter(label);
    await waitFor(() => expect(nodeOf('node actor-a').className).toContain('dimmed'));
    expect(nodeOf('node parser').className).not.toContain('dimmed');
    // The connector is not dimmed only when the lane touches it: the parser does not.
    expect(nodeOf('node chat · in').className).toContain('dimmed');
    // The edges the lane's cards are at stay lit, their rhombi too.
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-id="parser.events → actor-a.game-events"]')
          ?.classList.contains('dimmed')
      ).toBe(false)
    );
    expect(
      screen.getByRole('button', { name: 'edge chat.chat → actor-a.chat' }).className
    ).toContain('dimmed');
    fireEvent.mouseLeave(label);
    await waitFor(() => expect(nodeOf('node actor-a').className).not.toContain('dimmed'));
    // The keyboard's focus on the label dims as the pointer does.
    fireEvent.focus(label);
    await waitFor(() => expect(nodeOf('node actor-a').className).toContain('dimmed'));
    fireEvent.blur(label);
    await waitFor(() => expect(nodeOf('node actor-a').className).not.toContain('dimmed'));
    // A node hovered: its neighbours lit, the rest dimmed.
    fireEvent.mouseEnter(nodeOf('node chat · out'));
    await waitFor(() => expect(nodeOf('node parser').className).toContain('dimmed'));
    expect(nodeOf('node actor-a').className).not.toContain('dimmed');
    fireEvent.mouseLeave(nodeOf('node chat · out'));
    await waitFor(() => expect(nodeOf('node parser').className).not.toContain('dimmed'));
  });

  it('sets a node’s group from its panel: a new one, one of the draft’s, or none', async () => {
    const core = fakeCore({ file: grouped() });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    const details = await screen.findByLabelText('details of actor-a');
    const group = within(details).getByLabelText('group') as HTMLSelectElement;
    expect(group.value).toBe('');
    expect([...group.options].map((o) => o.textContent)).toEqual([
      'none',
      'Ignored',
      'Game',
      'new group…',
    ]);
    // A new group, named and set (trimmed); Set waits for a name.
    fireEvent.change(group, { target: { value: group.options[3]?.value } });
    const name = within(details).getByLabelText('new group');
    const set = within(details).getByRole('button', { name: 'Set' }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.change(name, { target: { value: '  Players ' } });
    fireEvent.keyDown(name, { key: 'a' });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes.find((n) => n.id === 'actor-a')?.group).toBe('Players')
    );
    expect(await screen.findByRole('group', { name: 'lane Players' }, slow)).toBeDefined();
    expect(screen.getByText('Changes not applied')).toBeDefined();
    // Moved into the draft's other group, then the new group's Set button, then none.
    fireEvent.change(group, { target: { value: 'Game' } });
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes.find((n) => n.id === 'actor-a')?.group).toBe('Game')
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: 'lane Players' })).toBeNull());
    fireEvent.change(group, { target: { value: group.options[group.options.length - 1]?.value } });
    fireEvent.change(within(details).getByLabelText('new group'), { target: { value: 'Solo' } });
    fireEvent.click(within(details).getByRole('button', { name: 'Set' }));
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes.find((n) => n.id === 'actor-a')?.group).toBe('Solo')
    );
    fireEvent.change(group, { target: { value: '' } });
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes.find((n) => n.id === 'actor-a')).not.toHaveProperty('group')
    );
    // Back to the saved graph: nothing to apply.
    expect(screen.queryByText('Changes not applied')).toBeNull();
    // A connector's panel says its group is ignored by the drawing.
    fireEvent.click(screen.getByLabelText('node chat · in'));
    const chat = await screen.findByLabelText('details of chat');
    expect((within(chat).getByLabelText('group') as HTMLSelectElement).value).toBe('Ignored');
    expect(within(chat).getByText(/A connector is drawn outside the lanes/u)).toBeDefined();
  });

  it('keeps a node whose gated chat-in edge is removed, and its sender whose chat-out edge is', async () => {
    // A person (D138): its listen chat-in there only while its switch is on (`when`), its chats
    // the config key `listen` (`configChats`), and its output feeding the lane's actor alone.
    const person: PluginView = {
      plugin: 'person',
      version: '0.1.0',
      description: 'a simulated person',
      kinds: ['actor'],
      inputs: { listen: { type: 'chat-in', label: 'chat-in', optional: false, when: 'follows' } },
      outputs: {
        events: { type: 'events', namespace: 'game', label: 'events of game', optional: false },
      },
      interface: { reads: [], actions: [], commands: [] },
      secrets: [],
      configSecrets: [],
      events: [],
      configChats: [{ key: 'listen', input: 'listen' }],
    };
    const graph: Graph = {
      ...grouped(),
      nodes: [
        ...grouped().nodes.map((n) => (n.id === 'actor-a' ? { ...n, group: 'Game' } : n)),
        { id: 'alice', plugin: 'person', config: { follows: true, listen: ['#a'] } },
      ],
      edges: [
        ...grouped().edges.filter((e) => e.to !== 'actor-a.game-events'),
        { from: 'alice.events', to: 'actor-a.game-events', type: 'events' },
        { from: 'chat.chat', to: 'alice.listen', type: 'chat-in', reads: ['#a'] },
      ],
    };
    const core = fakeCore({
      file: graph,
      available: [...AVAILABLE, { ...person, id: 'person', module: 'game' }],
      routes: {
        'GET /graph/view': [
          200,
          { ...VIEW, graph, nodes: [...VIEW.nodes, { ...person, id: 'alice' }] },
        ],
      },
    });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node alice', {}, slow);
    // Read by its edge, it is in the ungrouped lane.
    expect(screen.getByRole('group', { name: 'lane of the ungrouped nodes' })).toBeDefined();
    const remove = async (edge: string): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: `edge ${edge}` }));
      const panel = await screen.findByLabelText(`details of edge ${edge}`);
      fireEvent.click(within(panel).getByRole('button', { name: 'Remove edge' }));
      await waitFor(() =>
        expect(core.checked.at(-1)?.edges.map((e) => `${e.from} → ${e.to}`)).not.toContain(edge)
      );
    };
    await remove('chat.chat → alice.listen');
    // The node stays, its config too (the switch on and its chats, for the check to say what
    // they lack), now beside the in cards (D136), the ungrouped lane gone with its only card.
    expect(core.checked.at(-1)?.nodes.find((n) => n.id === 'alice')).toEqual({
      id: 'alice',
      plugin: 'person',
      config: { follows: true, listen: ['#a'] },
    });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'lane of the ungrouped nodes' })).toBeNull()
    );
    expect(nodeOf('node alice').style.transform).toMatch(/^translate\(0px,/u);
    // A chat-out edge removed takes no node either.
    await remove('actor-a.chat → chat.chat');
    expect(core.checked.at(-1)?.nodes.map((n) => n.id)).toEqual([
      'chat',
      'parser',
      'actor-a',
      'alice',
    ]);
    expect(screen.getByLabelText('node actor-a')).toBeDefined();
    expect(screen.getByLabelText('node alice')).toBeDefined();
  }, 15000);

  it('draws a graph without groups as before, with no lane', async () => {
    fakeCore();
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node actor-a', {}, slow);
    expect(screen.queryByRole('group', { name: /^lane/u })).toBeNull();
  });
});
