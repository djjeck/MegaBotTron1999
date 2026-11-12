// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { AVAILABLE, status } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { groupPlugins } from './Palette.tsx';

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
const EMPTY: Graph = { version: 1, nodes: [], edges: [] };

describe('the graph editor', () => {
  it('builds a graph from nothing: a connector added, saved, and applied by a restart', async () => {
    const core = fakeCore({ file: undefined, status: { off: false, plugins: [] } });
    core.running = EMPTY;
    const loggedOut = vi.fn();
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    // The first step: the connectors first.
    const first = await screen.findByRole('region', { name: 'first step' }, slow);
    expect(within(first).getByRole('heading', { name: 'Add your first node' })).toBeDefined();
    expect(
      within(first)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['chata chat network', 'Every plugin']);
    fireEvent.click(within(first).getByRole('button', { name: /^chat/u }));
    const add = await screen.findByLabelText('add chat');
    expect((within(add).getByLabelText('node id') as HTMLInputElement).value).toBe('chat');
    expect((within(add).getByLabelText('fresh instance') as HTMLInputElement).value).toBe('chat');
    fireEvent.change(within(add).getByLabelText('node id'), { target: { value: 'irc-main' } });
    expect((within(add).getByLabelText('fresh instance') as HTMLInputElement).value).toBe(
      'irc-main'
    );
    fireEvent.click(within(add).getByRole('button', { name: 'Add irc-main' }));
    expect(await screen.findByLabelText('node irc-main', {}, slow)).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain(
      'irc-main added on the instance irc-main'
    );
    expect(screen.queryByRole('region', { name: 'first step' })).toBeNull();
    // Reviewed: the diff the core gives, then saved and applied.
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const review = await screen.findByLabelText('review changes');
    await waitFor(() => expect(within(review).getByText('irc-main')).toBeDefined());
    expect(within(review).getByRole('heading', { name: 'Nodes added' })).toBeDefined();
    fireEvent.click(within(review).getByRole('button', { name: 'Save' }));
    expect(
      await within(review).findByText(/Saved: it runs once the instance restarts/u)
    ).toBeDefined();
    expect(core.file).toEqual({
      version: 1,
      nodes: [{ id: 'irc-main', plugin: 'chat' }],
      edges: [],
    });
    expect(core.api.calls).toContain(
      'PUT /graph/file {"version":1,"nodes":[{"id":"irc-main","plugin":"chat"}],"edges":[]}'
    );
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    fireEvent.click(within(review).getByRole('button', { name: 'Apply (restart)' }));
    expect(await screen.findByRole('dialog', { name: 'restarting' })).toBeDefined();
    // The session outlives the restart: back to the page, logged in still.
    expect(
      await screen.findByText(
        'The instance restarted: it runs the saved graph and the modules installed.',
        {},
        slow
      )
    ).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'restarting' })).toBeNull();
    expect(loggedOut).not.toHaveBeenCalled();
    expect(core.restarted).toBe(true);
  });

  it('adds a node on an instance kept, or imported from an older directory, and says what it cannot', async () => {
    const core = fakeCore({
      instances: [
        { id: 'actor-a', plugin: 'actor', created: 1, referenced: 2, node: 'actor-a', used: true },
        {
          id: 'old-actor',
          plugin: 'actor',
          created: 1,
          referenced: Date.UTC(2026, 9, 1),
          used: false,
        },
        { id: 'tally', plugin: 'other', created: 1, used: false },
      ],
      legacy: {
        dir: '/legacy',
        stores: [
          {
            id: 'actor',
            documents: ['state'],
            version: 2,
            timers: ['turn'],
            settings: true,
            mode: 'live',
          },
          { id: 'misc', documents: [], version: 0, timers: [], settings: false },
        ],
        events: { days: 0 },
      },
    });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node actor-a', {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }));
    const palette = await screen.findByLabelText('plugins');
    expect(
      within(palette)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
    ).toEqual(['The image', 'Module game']);
    fireEvent.click(within(palette).getByRole('button', { name: /^actor/u }));
    const add = await screen.findByLabelText('add actor');
    expect((within(add).getByLabelText('node id') as HTMLInputElement).value).toBe('actor');
    // A fresh instance cannot take a name kept already.
    fireEvent.change(within(add).getByLabelText('fresh instance'), { target: { value: 'tally' } });
    expect(within(add).getByText(/an instance tally is kept already \(of other\)/u)).toBeDefined();
    fireEvent.change(within(add).getByLabelText('fresh instance'), {
      target: { value: 'actor-a' },
    });
    expect(within(add).getByText('another node runs on the instance actor-a')).toBeDefined();
    fireEvent.change(within(add).getByLabelText('node id'), { target: { value: 'Bad' } });
    expect(
      within(add).getByText('node id: lower-case words and dashes, such as dice-roller')
    ).toBeDefined();
    fireEvent.change(within(add).getByLabelText('node id'), { target: { value: 'actor-b' } });
    // One kept: the one in use by another node of the draft is offered but cannot be chosen.
    fireEvent.click(within(add).getByRole('radio', { name: /One kept of actor/u }));
    const kept = within(add).getByLabelText('existing instance') as HTMLSelectElement;
    expect(kept.value).toBe('old-actor');
    expect([...kept.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ['', false],
      ['actor-a: used by actor-a, last referenced 1970-01-01 00:00', true],
      ['old-actor: unused, last referenced 2026-10-01 00:00', false],
    ]);
    fireEvent.click(within(add).getByRole('button', { name: 'Add actor-b' }));
    await screen.findByLabelText('node actor-b', {}, slow);
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes.at(-1)).toEqual({
        id: 'actor-b',
        plugin: 'actor',
        instance: 'old-actor',
      })
    );
    // Imported: the stores of its plugin's id, or all of them.
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }));
    fireEvent.click(
      within(await screen.findByLabelText('plugins')).getByRole('button', { name: /^actor/u })
    );
    const again = await screen.findByLabelText('add actor');
    fireEvent.click(within(again).getByRole('radio', { name: /Imported/u }));
    const store = (await within(again).findByLabelText('store')) as HTMLSelectElement;
    expect([...store.options].map((o) => o.value)).toEqual(['actor']);
    expect(store.options[0]?.textContent).toBe(
      'actor: 1 documents, version 2, timers turn, was live'
    );
    fireEvent.click(within(again).getByRole('checkbox'));
    fireEvent.change(within(again).getByLabelText('store'), { target: { value: 'misc' } });
    expect((within(again).getByLabelText('imported instance') as HTMLInputElement).value).toBe(
      'misc'
    );
    fireEvent.change(within(again).getByLabelText('imported instance'), {
      target: { value: 'actor-old' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Add actor' }));
    await screen.findByLabelText('node actor', {}, slow);
    expect(core.api.calls).toContain(
      'POST /instances/import {"from":"misc","instance":"actor-old","plugin":"actor"}'
    );
    // An import the core refuses says why; cancelled, back to the plugins.
    core.api.routes['POST /instances/import'] = [
      409,
      { error: 'the instance actor-old exists already' },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }));
    fireEvent.click(
      within(await screen.findByLabelText('plugins')).getByRole('button', { name: /^actor/u })
    );
    const third = await screen.findByLabelText('add actor');
    fireEvent.click(within(third).getByRole('radio', { name: /Imported/u }));
    await within(third).findByLabelText('store');
    fireEvent.click(within(third).getByRole('button', { name: 'Add actor-2' }));
    expect(await within(third).findByRole('alert')).toHaveProperty(
      'textContent',
      'the instance actor-old exists already'
    );
    fireEvent.click(within(third).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByLabelText('plugins')).toBeDefined();
    fireEvent.click(
      within(screen.getByLabelText('plugins')).getByRole('button', { name: 'close' })
    );
    expect(screen.queryByLabelText('plugins')).toBeNull();
  });

  it('says when no older directory is mounted, or a plugin has no instance kept', async () => {
    fakeCore({ routes: { 'GET /legacy': [500, { error: 'the disk is gone' }] } });
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node actor-a', {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }));
    fireEvent.click(
      within(await screen.findByLabelText('plugins')).getByRole('button', { name: /^parser/u })
    );
    const add = await screen.findByLabelText('add parser');
    expect(
      (within(add).getByRole('radio', { name: /One kept of parser/u }) as HTMLInputElement).disabled
    ).toBe(true);
    fireEvent.click(within(add).getByRole('radio', { name: /Imported/u }));
    expect(await within(add).findByText('the disk is gone')).toBeDefined();
    expect(within(add).getByText('no store to import')).toBeDefined();
    cleanup();
    fakeCore();
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    await screen.findByLabelText('node actor-a', {}, slow);
    fireEvent.click(screen.getByRole('button', { name: 'Add a node' }));
    fireEvent.click(
      within(await screen.findByLabelText('plugins')).getByRole('button', { name: /^parser/u })
    );
    const other = await screen.findByLabelText('add parser');
    fireEvent.click(within(other).getByRole('radio', { name: /Imported/u }));
    expect(
      await within(other).findByText('No older data directory is mounted (LEGACY_DIR).')
    ).toBeDefined();
  });

  it('marks what the check refuses where it is, and edits a node and an edge', async () => {
    const core = fakeCore({
      refuse: (g) => [
        ...(g.edges.some((e) => e.to === 'actor-a.chat' && (e.reads ?? []).includes('#a'))
          ? [
              {
                text: 'node actor-a: reads #a, which is not its chat',
                edge: { from: 'chat.chat', to: 'actor-a.chat' },
              },
            ]
          : []),
        { text: 'plugin chat: config host: too short', node: 'chat', config: 'host' },
        {
          text: 'node actor-a: input port parser (interface of parser) is not bound',
          node: 'actor-a',
          port: 'parser',
        },
        { text: 'node parser: something', node: 'parser' },
        { text: 'graph: version: expected 1' },
      ],
    });
    vi.stubGlobal('confirm', () => true);
    const { container } = render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    const actor = await screen.findByLabelText('node actor-a', {}, slow);
    // On the port, the node, the edge, the field; the rest in a list.
    await waitFor(() =>
      expect(within(actor).getByTestId('port in parser').className).toContain('refused')
    );
    expect(within(actor).getByTestId('port in parser').getAttribute('title')).toContain(
      '✗ node actor-a: input port parser (interface of parser) is not bound'
    );
    expect(screen.getByLabelText('node parser').className).toContain('refused');
    expect(screen.getByText('5 problems')).toBeDefined();
    expect(
      within(screen.getByLabelText('other problems')).getByText('graph: version: expected 1')
    ).toBeDefined();
    await waitFor(() =>
      expect(container.querySelector('.react-flow__edge.refused')).not.toBeNull()
    );
    fireEvent.click(screen.getByLabelText('node chat'));
    const chat = await screen.findByLabelText('details of chat');
    expect(within(chat).getByText('plugin chat: config host: too short')).toBeDefined();
    // Its config, a secret among the names provided, and its account.
    fireEvent.change(within(chat).getByLabelText('token'), { target: { value: 'token_b' } });
    fireEvent.change(within(chat).getByLabelText('account'), { target: { value: 'chat:alice' } });
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[0]).toEqual({
        id: 'chat',
        plugin: 'chat',
        config: { host: 'example.test', token: 'token_b' },
        account: 'chat:alice',
      })
    );
    // A node's mode and settings.
    fireEvent.click(screen.getByLabelText('node actor-a'));
    const details = await screen.findByLabelText('details of actor-a');
    expect(
      within(details).getByText(
        'node actor-a: input port parser (interface of parser) is not bound'
      )
    ).toBeDefined();
    fireEvent.change(within(details).getByLabelText('mode'), { target: { value: 'live' } });
    fireEvent.click(within(details).getByLabelText('loud'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.nodes[2]).toMatchObject({
        mode: 'live',
        settings: { loud: true },
      })
    );
    fireEvent.change(within(details).getByLabelText('mode'), { target: { value: '' } });
    await waitFor(() => expect(core.checked.at(-1)?.nodes[2]).not.toHaveProperty('mode'));
    // An edge selected: what it carries.
    const edge = container.querySelector('[data-id="chat.chat → actor-a.chat"]') as Element;
    fireEvent.click(edge);
    const panel = await screen.findByLabelText('details of edge chat.chat → actor-a.chat');
    expect((within(panel).getByLabelText('reads') as HTMLTextAreaElement).value).toBe('#a');
    expect(within(panel).getByText('node actor-a: reads #a, which is not its chat')).toBeDefined();
    fireEvent.change(within(panel).getByLabelText('reads'), { target: { value: '#b\n#c, #d' } });
    fireEvent.blur(within(panel).getByLabelText('reads'));
    fireEvent.change(within(panel).getByLabelText('commands'), { target: { value: '/play' } });
    fireEvent.blur(within(panel).getByLabelText('commands'));
    await waitFor(() =>
      expect(core.checked.at(-1)?.edges[0]).toEqual({
        from: 'chat.chat',
        to: 'actor-a.chat',
        type: 'chat',
        reads: ['#b', '#c', '#d'],
        sends: ['#a'],
        commands: ['/play'],
      })
    );
    await waitFor(() => expect(container.querySelector('.react-flow__edge.refused')).toBeNull());
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove edge' }));
    await waitFor(() => expect(core.checked.at(-1)?.edges).toHaveLength(2));
    // An edge that carries nothing to set.
    fireEvent.click(
      container.querySelector('[data-id="parser.interface → actor-a.parser"]') as Element
    );
    const iface = await screen.findByLabelText('details of edge parser.interface → actor-a.parser');
    expect(
      within(iface).getByText('It carries nothing to set: the binding is the permission.')
    ).toBeDefined();
  });

  it('removes a node, keeping its instance; discards, refuses a save, and rolls back', async () => {
    const core = fakeCore({
      refuse: (g) => (g.nodes.length === 1 ? [{ text: 'node chat: alone', node: 'chat' }] : []),
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    const details = await screen.findByLabelText('details of actor-a');
    fireEvent.click(within(details).getByRole('button', { name: 'Remove actor-a' }));
    expect(confirm).toHaveBeenCalledWith(
      'Remove actor-a? Its instance actor-a is kept, with its state, and deleted after 7 days if no node uses it.'
    );
    expect(screen.getByLabelText('node actor-a')).toBeDefined();
    confirm.mockReturnValue(true);
    fireEvent.click(within(details).getByRole('button', { name: 'Remove actor-a' }));
    await waitFor(() => expect(screen.queryByLabelText('node actor-a')).toBeNull());
    await waitFor(() => expect(core.checked.at(-1)?.edges).toEqual([]));
    // Discarded: the saved graph back.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByLabelText('node actor-a', {}, slow)).toBeDefined();
    // A save the core refuses is not offered; one it takes is, and a rollback swaps it back.
    fireEvent.click(screen.getByLabelText('node parser'));
    fireEvent.click(
      within(await screen.findByLabelText('details of parser')).getByRole('button', {
        name: 'Remove parser',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const review = await screen.findByLabelText('review changes');
    await waitFor(() =>
      expect(within(review).getByText('Nodes removed (their instances kept)')).toBeDefined()
    );
    expect(
      (within(review).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled
    ).toBe(false);
    fireEvent.click(within(review).getByRole('button', { name: 'Save' }));
    expect(await within(review).findByText(/Saved: it runs once/u)).toBeDefined();
    await waitFor(() => expect(screen.getByText('Saved, not running yet')).toBeDefined());
    fireEvent.click(within(review).getByRole('button', { name: 'close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    expect(
      await screen.findByText('Rolled back to the previous saved graph: apply it with a restart.')
    ).toBeDefined();
    expect(await screen.findByLabelText('node parser', {}, slow)).toBeDefined();
    expect(core.file?.nodes).toHaveLength(3);
    // No previous: the core says so.
    core.api.routes['POST /graph/rollback'] = [
      409,
      { error: 'there is no graph.previous.json to roll back to' },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    expect(
      await screen.findByText('rollback: there is no graph.previous.json to roll back to')
    ).toBeDefined();
    // Refused on save: the check said it, the save says it too.
    fireEvent.click(screen.getByLabelText('node parser'));
    fireEvent.click(
      within(await screen.findByLabelText('details of parser')).getByRole('button', {
        name: 'Remove parser',
      })
    );
    fireEvent.click(screen.getByLabelText('node actor-a'));
    fireEvent.click(
      within(await screen.findByLabelText('details of actor-a')).getByRole('button', {
        name: 'Remove actor-a',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const refused = await screen.findByLabelText('review changes');
    await waitFor(() => expect(within(refused).getByText('node chat: alone')).toBeDefined());
    expect(
      (within(refused).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('says what a save, a check and a restart refuse, and when the instance does not come back', async () => {
    const core = fakeCore({ routes: { 'POST /graph/check': [500, { error: 'check broke' }] } });
    vi.stubGlobal('confirm', () => true);
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    expect(await screen.findByText('check: check broke', {}, slow)).toBeDefined();
    // The saved graph differs from what runs: apply it.
    core.running = { version: 1, nodes: [], edges: [] };
    cleanup();
    core.api.routes['POST /graph/check'] = [
      200,
      {
        ok: true,
        problems: [],
        diff: {
          nodes: { added: [], removed: [], changed: [] },
          edges: { added: [], removed: [], changed: [] },
        },
      },
    ];
    core.api.routes['POST /restart'] = [500, { error: 'no restart here' }];
    render(<GraphPage loggedOut={vi.fn()} checkAfterMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (restart)' }, slow));
    expect(await screen.findByText('restart: no restart here')).toBeDefined();
    cleanup();
    // A restart the UI waits through: down, then never back.
    let calls = 0;
    core.api.routes['POST /restart'] = [200, { restarting: true }];
    core.api.routes['GET /session'] = () => {
      calls++;
      return calls === 1 ? [200, { authenticated: true }] : [502, {}];
    };
    const { Restart } = await import('#src/ui/Restart.tsx');
    render(
      <Restart done={vi.fn()} loggedOut={vi.fn()} failed={vi.fn()} everyMs={5} giveUpMs={200} />
    );
    expect(
      await screen.findByText('Starting again: waiting for the instance to answer…')
    ).toBeDefined();
    expect(await screen.findByText(/The instance has not come back/u, {}, slow)).toBeDefined();
  });

  it('groups the plugins: the image first, then each module, connectors first', () => {
    const groups = groupPlugins([
      ...AVAILABLE,
      { ...(AVAILABLE[1] as (typeof AVAILABLE)[number]), id: 'aaa', module: 'aaa' },
      { ...(AVAILABLE[0] as (typeof AVAILABLE)[number]), id: 'zz', module: 'game' },
    ]);
    expect(groups.map(([g, ps]) => [g, ps.map((p) => p.id)])).toEqual([
      ['The image', ['chat']],
      ['Module aaa', ['aaa']],
      ['Module game', ['zz', 'actor', 'parser']],
    ]);
    expect(status().plugins).toHaveLength(3);
  });
});
