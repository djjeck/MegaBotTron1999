// @vitest-environment happy-dom
/**
 * A view's page (docs/bot-os.md D170): the sections of a made-up ledger's view, each read from the
 * node bound to its input, a selector whose choice its sections take, and the nodes it shows, as
 * the core itself describes them (`GET /graph/view`).
 */
import { describeNodes, parseManifest } from '@megabottron1999/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { GraphViewData, ViewSelector } from '#src/ui/api.ts';
import { resolve, viewPathOf } from '#src/ui/App.tsx';
import { rowInput } from '#src/ui/graph/TableRow.tsx';
import { fakeApi } from '#test/fake-api.ts';
import { PORT_TYPES } from '#test/graph-view.ts';
import { optionsOf, ViewPage, withSelected } from './ViewPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const ledger = parseManifest({
  id: 'ledger',
  kinds: ['stats'],
  description: 'a ledger',
  interface: {
    state: {
      players: {
        help: 'Every player',
        output: z.array(z.object({ name: z.string().describe('Name'), gold: z.number() })),
      },
      player: {
        help: 'One player',
        input: z.object({ name: z.string() }),
        output: z.object({ gold: z.number().describe('Gold') }),
      },
    },
    actions: {
      pay: { help: 'Pays a player', input: z.strictObject({ name: z.string(), gold: z.number() }) },
    },
  },
});

const view = parseManifest({
  id: 'ledger-view',
  kinds: ['view'],
  description: 'the ledger',
  inputs: {
    ledger: { type: 'interface', plugin: 'ledger', optional: true },
    other: { type: 'interface', plugin: 'ledger', optional: true },
  },
  view: {
    title: 'Ledger',
    selector: { from: 'ledger', read: 'players', value: 'name', title: 'Player' },
    sections: [
      {
        show: 'table',
        from: 'ledger',
        read: 'players',
        label: 'Players',
        columns: ['name', 'gold'],
        actions: [{ label: 'Pay', action: 'pay', input: { name: '$selector', gold: 5 } }],
      },
      {
        show: 'keyValue',
        from: 'ledger',
        read: 'player',
        label: 'Chosen',
        input: { name: '$selector' },
      },
      { show: 'counter', from: 'other', read: 'players', label: 'Elsewhere' },
    ],
  },
});

const graph: GraphViewData['graph'] = {
  version: 2,
  nodes: [
    { id: 'ledger', plugin: 'ledger' },
    { id: 'home', plugin: 'ledger-view', path: 'gold' },
  ],
  edges: [{ from: 'ledger.interface', to: 'home.ledger', type: 'interface' }],
};
const VIEW = JSON.parse(
  JSON.stringify({
    graph,
    portTypes: PORT_TYPES,
    nodes: describeNodes(
      [
        { id: 'ledger', manifest: ledger },
        { id: 'home', manifest: view },
      ],
      graph
    ),
  })
) as GraphViewData;

const PLAYERS = [
  { name: 'alice', gold: 3 },
  { name: 'bob', gold: 7 },
];

function serve() {
  return fakeApi({
    'GET /graph/view': [200, VIEW],
    'GET /plugins/ledger/state/players': [200, PLAYERS],
    'GET /plugins/ledger/state/player?name=bob': [200, { gold: 7 }],
    'POST /plugins/ledger/actions/pay': [200, { paid: true }],
  });
}

describe('a view’s page (D170)', () => {
  it('reads each section from its bound node, and names the nodes it shows', async () => {
    const api = serve();
    render(<ViewPage loggedOut={() => {}} section="gold" />);
    expect(await screen.findByRole('heading', { name: /Ledger/u })).toBeDefined();
    const table = await screen.findByRole('table', { name: 'Players' });
    expect(within(table).getByText('alice')).toBeDefined();
    const shows = screen.getByLabelText('its nodes');
    expect(within(shows).getByRole('link', { name: 'ledger' }).getAttribute('href')).toBe(
      '../../#/graph/ledger'
    );
    // Its input left unbound says so; a section waiting for the choice asks for one.
    expect(screen.getByText('Its input other is not wired: draw an edge to it.')).toBeDefined();
    expect(screen.getByText('Pick one above.')).toBeDefined();
    // Each read once, whatever shows it: the selector's and the table's are one.
    expect(api.calls.filter((c) => c === 'GET /plugins/ledger/state/players')).toHaveLength(1);
  });

  it('takes the choice into its sections and rows, and keeps it in its address', async () => {
    const api = serve();
    render(<ViewPage loggedOut={() => {}} section="gold" />);
    const choice = (await screen.findByLabelText('Player')) as HTMLSelectElement;
    await waitFor(() => expect(choice.options).toHaveLength(3));
    fireEvent.change(choice, { target: { value: 'bob' } });
    expect(window.location.search).toBe('?s=bob');
    const chosen = await screen.findByRole('region', { name: 'Chosen' });
    await waitFor(() => expect(within(chosen).getByText('7')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Pay alice' }));
    await waitFor(() =>
      expect(api.calls).toContain('POST /plugins/ledger/actions/pay {"name":"bob","gold":5}')
    );
    fireEvent.change(choice, { target: { value: '' } });
    expect(window.location.search).toBe('');
  });

  it('opens with the choice its address keeps', async () => {
    serve();
    window.history.replaceState(null, '', '/v/gold/?s=bob');
    render(<ViewPage loggedOut={() => {}} section="gold" />);
    const chosen = await screen.findByRole('region', { name: 'Chosen' });
    await waitFor(() => expect(within(chosen).getByText('7')).toBeDefined());
  });

  it('says when no view is at its path', async () => {
    serve();
    render(<ViewPage loggedOut={() => {}} section="nowhere" />);
    expect(await screen.findByText('No view is at /v/nowhere/: add a view node, then Apply.'));
  });
});

describe('a view’s helpers (D170)', () => {
  it('finds a view’s path in the address, and a node to open from a route', () => {
    expect(viewPathOf('/v/gold/')).toBe('gold');
    expect(viewPathOf('/proxy/v/gold/')).toBe('gold');
    expect(viewPathOf('/v/gold')).toBeUndefined();
    expect(viewPathOf('/')).toBeUndefined();
    expect(resolve('graph/ledger%20x').section).toBe('node/ledger x');
  });

  it('fills in the choice, or waits for one', () => {
    expect(withSelected({ name: '$selector', n: 1 }, 'bob')).toEqual({ name: 'bob', n: 1 });
    expect(withSelected({ name: '$selector' }, undefined)).toBeUndefined();
    expect(withSelected(undefined, undefined)).toEqual({});
  });

  it('lists a selector’s options from its read, a map’s values too', () => {
    const sel: ViewSelector = { from: 'l', read: 'r', path: 'all', value: 'id', label: 'name' };
    expect(optionsOf(sel, { all: [{ id: 1, name: 'One' }] })).toEqual([
      { value: '1', label: 'One' },
    ]);
    expect(optionsOf({ from: 'l', read: 'r' }, { a: 'x', b: 'y' })).toEqual([
      { value: 'x', label: 'x' },
      { value: 'y', label: 'y' },
    ]);
    expect(optionsOf({ from: 'l', read: 'r' }, null)).toEqual([]);
  });

  it('puts the choice in a row action’s input', () => {
    expect(
      rowInput({ label: 'x', action: 'pay', input: { name: '$selector' } }, {}, 'bob')
    ).toEqual({ name: 'bob' });
  });
});
