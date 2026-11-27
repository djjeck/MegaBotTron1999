import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GraphError, resolveGraph, viewPath } from './graph.ts';
import { describeNodes, graphText } from './graph-view.ts';
import { type Manifest, type ManifestInput, parseManifest } from './manifest.ts';
import { selectorIssues } from './widgets.ts';

/** A made-up game's ledger: its players, each with their gold, and an action that pays one. */
const ledger = parseManifest({
  id: 'ledger',
  kinds: ['stats'],
  description: 'a ledger',
  interface: {
    state: {
      players: {
        help: 'Every player',
        output: z.array(z.object({ name: z.string(), gold: z.number() })),
      },
      player: {
        help: 'One player',
        input: z.object({ name: z.string() }),
        output: z.object({ gold: z.number(), log: z.array(z.object({ what: z.string() })) }),
      },
    },
    actions: {
      pay: { help: 'Pays a player', input: z.object({ name: z.string(), gold: z.number() }) },
    },
  },
});

/** A view of the ledger, as a module ships one. */
const view = (more: Partial<ManifestInput> = {}): ManifestInput => ({
  id: 'ledger-view',
  kinds: ['view'],
  description: 'the ledger, in full',
  inputs: { ledger: { type: 'interface', plugin: 'ledger', optional: true } },
  view: {
    title: 'Ledger',
    selector: { from: 'ledger', read: 'players', value: 'name', label: 'name', title: 'Player' },
    sections: [
      {
        show: 'table',
        from: 'ledger',
        read: 'players',
        columns: ['name', 'gold'],
        actions: [{ label: 'Pay', action: 'pay', input: { name: '$row.name' } }],
      },
      { show: 'list', from: 'ledger', read: 'player', input: { name: '$selector' }, path: 'log' },
    ],
  },
  ...more,
});

const image = (...more: Manifest[]): Map<string, Manifest> =>
  new Map([ledger, parseManifest(view()), ...more].map((p) => [p.id, p]));

const graph = (nodes: object[], edges: object[] = []) => ({ version: 2, nodes, edges });
const bound = [{ from: 'ledger.interface', to: 'ledger-view.ledger' }];

/** Why `raw` is refused, each problem a line; nothing when it stands. */
function refused(raw: unknown, plugins = image()): string[] {
  try {
    resolveGraph(raw, plugins);
    return [];
  } catch (e) {
    if (e instanceof GraphError) return e.problems;
    throw e;
  }
}

describe('a view plugin’s manifest (D170)', () => {
  it('reads the nodes on its interface inputs, the members its sections use added to them', () => {
    const m = parseManifest(view());
    expect(m.view?.title).toBe('Ledger');
    expect(m.inputs['ledger']).toMatchObject({
      type: 'interface',
      plugin: 'ledger',
      members: ['state.players', 'actions.pay', 'state.player'],
    });
  });

  it('refuses a view of another kind, a section from no interface input, a view with a page', () => {
    expect(() => parseManifest(view({ kinds: ['stats'] }))).toThrow(
      'view: only a view declares one'
    );
    expect(() => parseManifest(view({ view: undefined }))).toThrow(
      'view: a view declares its view'
    );
    expect(() =>
      parseManifest(
        view({
          inputs: { ledger: { type: 'events', namespace: 'ledger' } },
        })
      )
    ).toThrow('ledger is not among its interface inputs');
    expect(() =>
      parseManifest(view({ page: { title: 'x', sections: [{ show: 'counter', read: 'x' }] } }))
    ).toThrow('a view is its own page');
  });
});

describe('a view in the graph (D170)', () => {
  it('is served at its path, its id by default, and checks its sections against its bound node', () => {
    const { nodes, graph: g } = resolveGraph(
      graph(
        [
          { id: 'ledger', plugin: 'ledger' },
          { id: 'ledger-view', plugin: 'ledger-view', path: 'gold' },
        ],
        bound
      ),
      image()
    );
    expect(viewPath({ id: 'ledger-view' })).toBe('ledger-view');
    const views = describeNodes(nodes, g);
    expect(views.find((v) => v.id === 'ledger-view')).toMatchObject({
      view: { title: 'Ledger' },
      served: { path: 'gold', bound: { ledger: 'ledger' } },
    });
    expect(views.find((v) => v.id === 'ledger')?.shownIn).toEqual([
      { node: 'ledger-view', path: 'gold' },
    ]);
    expect(graphText(g)).toContain('ledger-view (ledger-view), path gold');
  });

  it('runs with its inputs unbound, and its sections are checked once bound', () => {
    expect(refused(graph([{ id: 'ledger-view', plugin: 'ledger-view' }]))).toEqual([]);
  });

  it('refuses a path on a node that is no view, and two views of one path', () => {
    expect(
      refused(
        graph([
          { id: 'ledger', plugin: 'ledger', path: 'x' },
          { id: 'a', plugin: 'ledger-view', path: 'same' },
          { id: 'b', plugin: 'ledger-view', path: 'same' },
          { id: 'same', plugin: 'ledger-view' },
        ])
      )
    ).toEqual([
      'node ledger: only a view has a path',
      "node b: the path /v/same/ is a's",
      "node same: the path /v/same/ is a's",
    ]);
  });

  it('refuses a section or a selector that its bound node does not answer', () => {
    // A node that offers the members by name, as a contract binds, but other shapes.
    const other = parseManifest({
      id: 'other',
      kinds: ['stats'],
      description: 'another ledger',
      interface: {
        state: {
          players: { help: 'p', output: z.object({ count: z.number() }) },
          player: { help: 'p', input: z.object({ id: z.number() }), output: z.string() },
        },
        actions: { pay: { help: 'p', input: z.strictObject({ id: z.number() }) } },
      },
    });
    const contract = parseManifest(
      view({
        id: 'any-view',
        inputs: { ledger: { type: 'interface', members: ['state.players'], optional: true } },
      })
    );
    const problems = refused(
      graph(
        [
          { id: 'other', plugin: 'other' },
          { id: 'any-view', plugin: 'any-view' },
        ],
        [{ from: 'other.interface', to: 'any-view.ledger' }]
      ),
      image(other, contract)
    );
    expect(problems).toEqual([
      'node any-view: view selector.path: the read players is not a list or a map (from ledger, bound to other)',
      'node any-view: view sections.0.path: the read players is not a list or a map (from ledger, bound to other)',
      'node any-view: view sections.1.input: id: Invalid input: expected number, received undefined (from ledger, bound to other)',
      'node any-view: view sections.1.path: the read player has no log (from ledger, bound to other)',
    ]);
  });

  it('takes the selector’s value in a read’s input and a row’s action, never schema-checked', () => {
    const pays = parseManifest(
      view({
        id: 'pay-view',
        view: {
          title: 'Pay',
          selector: { from: 'ledger', read: 'players', value: 'name' },
          sections: [
            {
              show: 'table',
              from: 'ledger',
              read: 'players',
              columns: ['gold'],
              actions: [
                { label: 'Pay', action: 'pay', input: { name: '$selector', gold: 'lots' } },
              ],
            },
          ],
        },
      })
    );
    expect(
      refused(
        graph(
          [
            { id: 'ledger', plugin: 'ledger' },
            { id: 'pay-view', plugin: 'pay-view' },
          ],
          [{ from: 'ledger.interface', to: 'pay-view.ledger' }]
        ),
        image(pays)
      )
    ).toEqual([
      'node pay-view: view sections.0.actions.0.input.gold: the action pay refuses "lots": Invalid input: expected number, received string (from ledger, bound to ledger)',
    ]);
  });
});

describe('a view’s selector (D170)', () => {
  const reads = ledger.interface.state ?? {};

  it('names a read of its node, a list in it, and its options’ value and label', () => {
    expect(selectorIssues({ from: 'l', read: 'players', value: 'name' }, reads)).toEqual([]);
    expect(selectorIssues({ from: 'l', read: 'gone' }, reads)).toEqual([
      { path: ['read'], message: 'gone is not among its reads (interface.state)' },
    ]);
    expect(selectorIssues({ from: 'l', read: 'players', path: 'x' }, reads)).toEqual([
      { path: ['path'], message: 'the read players has no x' },
    ]);
    expect(
      selectorIssues({ from: 'l', read: 'players', value: 'id', label: 'nick' }, reads)
    ).toEqual([
      { path: ['value'], message: 'its options have no id' },
      { path: ['label'], message: 'its options have no nick' },
    ]);
    expect(selectorIssues({ from: 'l', read: 'player', input: { name: 1 } }, reads)).toEqual([
      { path: ['input'], message: 'name: Invalid input: expected string, received number' },
      { path: ['path'], message: 'the read player is not a list or a map' },
    ]);
  });
});
