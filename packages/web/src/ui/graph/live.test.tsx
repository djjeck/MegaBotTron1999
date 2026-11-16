// @vitest-environment happy-dom
// What the Admin page showed, now in the editor (D111): the instance's switches on the map's bar,
// each account on its connector, and each node's cost, status, settings in force, reads and actions
// in its panel; the costs' table in a side sheet.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginControl, Status } from '#src/ui/api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { status } from '#test/graph-view.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { GraphPage } from './GraphPage.tsx';
import { query } from './NodeControls.tsx';
import { AccountFold } from './NodeDetails.tsx';

let restore: () => void;
beforeEach(() => {
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

const loggedOut = vi.fn();
const slow = { timeout: 5000 };

/** The status, the actor offering a status, reads and actions, and each node what it cost. */
const live = (off = false, actor: Partial<PluginControl> = {}): Status => ({
  ...status(false, off),
  plugins: status(false, off).plugins.map((p) =>
    p.id === 'actor-a'
      ? {
          ...p,
          reads: ['status'],
          actions: ['bump', 'stay'],
          status: { count: 0 },
          cost: { dispatch: { calls: 4, ms: 30, maxMs: 12 } },
          ...actor,
        }
      : { ...p, cost: { dispatch: { calls: 1, ms: 10, maxMs: 10 } } }
  ),
});

const ACCOUNTS = [
  {
    id: 'chat',
    plugin: 'chat',
    account: 'chat:me',
    state: 'running',
    network: 'chat',
    self: 'ExampleBot',
    as: '@ExampleBot',
    connection: { state: 'closed', phase: 'closed', detail: 'refused' },
  },
];

describe('the instance’s switches, on the map’s bar', () => {
  it('turns the instance off once confirmed, and on, and kills every plugin once confirmed', async () => {
    let off = false;
    const { api } = fakeCore({
      routes: {
        'GET /status': () => [200, live(off)],
        'POST /off': () => {
          off = true;
          return [200, { off: true, result: 'off' }];
        },
        'POST /on': () => {
          off = false;
          return [200, { off: false, result: 'actor back' }];
        },
        'POST /kill': [200, { result: 'Killed: actor stopped' }],
      },
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    const bar = await screen.findByRole('group', { name: 'the instance' }, slow);
    expect(within(bar).getByText('instance on')).toBeDefined();
    fireEvent.click(within(bar).getByRole('button', { name: 'Turn off' }));
    expect(api.calls).not.toContain('POST /off {}');
    confirm.mockReturnValue(true);
    fireEvent.click(within(bar).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('instance off', {}, slow)).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('off');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('actor back'));
    expect(await screen.findByText('instance on')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Kill all' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Killed: actor stopped')
    );
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm).toHaveBeenLastCalledWith("Kill: run every plugin's safety stop?");
  });

  it('says why a switch is refused', async () => {
    fakeCore({ routes: { 'GET /status': [200, live(true)], 'POST /on': [500, undefined] } });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }, slow));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('on: HTTP 500'));
  });
});

describe('a connector’s account, on its cards and in its panel', () => {
  it('shows its connection on its cards, and as whom it runs in its panel', async () => {
    fakeCore({ routes: { 'GET /accounts': [200, ACCOUNTS] } });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    const card = await screen.findByLabelText('node chat · in', {}, slow);
    const badge = await within(card).findByText('closed', {}, slow);
    expect(badge.getAttribute('title')).toBe('its connection: closed: refused');
    // Whom it is logged in as, from its login (D120): what the owner recognises.
    expect(within(card).getByTitle('logged in as @ExampleBot').textContent).toBe(' @ExampleBot');
    expect(within(screen.getByLabelText('node actor-a')).queryByText('closed')).toBeNull();
    fireEvent.click(card);
    const details = await screen.findByLabelText('details of chat');
    const account = (await within(details).findByText('Connection')).nextElementSibling;
    expect(account?.textContent).toBe('as @ExampleBot closed closed: refused');
  });

  it('says when a running connector is not connecting', async () => {
    fakeCore({
      routes: { 'GET /accounts': [200, [{ id: 'chat', plugin: 'chat', state: 'failed' }]] },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node chat · in', {}, slow));
    const details = await screen.findByLabelText('details of chat');
    expect(await within(details).findByText('not connected')).toBeDefined();
  });
});

describe('a node’s panel, while it runs', () => {
  it('shows its cost, its status, and its settings in force, each set at once', async () => {
    const { api } = fakeCore({
      routes: {
        'GET /status': [200, live()],
        'POST /settings': (b) =>
          (b as { key: string }).key === 'level' ? [200, {}] : [400, { error: 'no such setting' }],
      },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    const details = await screen.findByLabelText('details of actor-a');
    // What it costs, among the others: all three are the top three here.
    const cost = (await within(details).findByText('Cost')).nextElementSibling as HTMLElement;
    expect(cost.textContent).toContain('30.0 ms in its handlers (60% of all)');
    expect(within(details).getByLabelText('its status').textContent).toBe('{\n  "count": 0\n}');
    // Its status shown, no button reads it again; its reads are still listed.
    expect(within(details).queryByRole('button', { name: 'Read status' })).toBeNull();
    expect(within(details).getByText('how it is')).toBeDefined();

    const inForce = within(details).getByRole('group', { name: 'settings in force' });
    const level = within(inForce).getByLabelText('level');
    expect((level as HTMLInputElement).value).toBe('2');
    fireEvent.change(level, { target: { value: '5' } });
    fireEvent.click(within(inForce).getByRole('button', { name: 'Set level' }));
    expect(await within(inForce).findByText('level set')).toBeDefined();
    expect(api.calls).toContain('POST /settings {"key":"level","value":5}');
    const loud = within(inForce).getByLabelText('actor-a.loud');
    fireEvent.change(loud, { target: { value: 'plain words' } });
    fireEvent.submit(loud);
    expect(await within(inForce).findByText('actor-a.loud: no such setting')).toBeDefined();
    expect(api.calls).toContain('POST /settings {"key":"actor-a.loud","value":"plain words"}');
  });

  it('calls its reads and its actions, with their input from their forms', async () => {
    const { api } = fakeCore({
      routes: {
        // Its status not given (its read failed): its button reads it.
        'GET /status': [200, live(false, { status: undefined })],
        'GET /plugins/actor-a/state/status': [200, { count: 3 }],
        'POST /plugins/actor-a/actions/bump': (b) =>
          (b as { by?: number }).by === undefined ? [400, { error: 'by: required' }] : [200, 4],
        'POST /plugins/actor-a/actions/stay': [200, null],
      },
    });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    const details = await screen.findByLabelText('details of actor-a');
    fireEvent.click(await within(details).findByRole('button', { name: 'Read status' }));
    await waitFor(() =>
      expect(within(details).getByLabelText('status answer').textContent).toContain('"count": 3')
    );
    const bump = within(details).getByRole('button', { name: 'Run bump' });
    fireEvent.click(bump);
    const answer = await within(details).findByLabelText('bump answer');
    await waitFor(() => expect(answer.textContent).toBe('by: required'));
    expect(answer.className).toContain('error');
    const by = within(within(details).getByRole('group', { name: 'bump input' })).getByLabelText(
      /by/u
    );
    fireEvent.change(by, { target: { value: '1' } });
    fireEvent.blur(by);
    fireEvent.click(bump);
    await waitFor(() =>
      expect(within(details).getByLabelText('bump answer').textContent).toBe('4')
    );
    expect(api.calls).toContain('POST /plugins/actor-a/actions/bump {"by":1}');
    // An action of no input is run with none.
    fireEvent.click(within(details).getByRole('button', { name: 'Run stay' }));
    await waitFor(() =>
      expect(within(details).getByLabelText('stay answer').textContent).toBe('null')
    );
    expect(api.calls).toContain('POST /plugins/actor-a/actions/stay {}');
  });

  it('offers no call and no status while it does not run', async () => {
    fakeCore({ routes: { 'GET /status': [200, live(false, { state: 'inactive' })] } });
    render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    fireEvent.click(await screen.findByLabelText('node actor-a', {}, slow));
    const details = await screen.findByLabelText('details of actor-a');
    await waitFor(() => expect(within(details).getByText('inactive')).toBeDefined(), slow);
    expect(within(details).queryByRole('button', { name: 'Read status' })).toBeNull();
    expect(within(details).queryByLabelText('its status')).toBeNull();
    // Its settings in force are still set: they are its instance's.
    expect(within(details).getByRole('group', { name: 'settings in force' })).toBeDefined();
  });
});

describe('the costs’ side sheet', () => {
  it('opens from its tab, or a route, and selects a node by its name', async () => {
    fakeCore({ routes: { 'GET /status': [200, live()] } });
    const { rerender } = render(<GraphPage loggedOut={loggedOut} checkAfterMs={0} />);
    await screen.findByLabelText('node actor-a', {}, slow);
    const tab = screen.getByRole('button', { name: 'Costs' });
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(tab);
    const sheet = await screen.findByRole('complementary', { name: 'what each node costs' });
    const table = await within(sheet).findByRole('table', { name: 'nodes by cost' }, slow);
    fireEvent.click(within(table).getByRole('button', { name: 'actor-a' }));
    expect(screen.queryByRole('complementary', { name: 'what each node costs' })).toBeNull();
    expect(await screen.findByLabelText('details of actor-a')).toBeDefined();
    await waitFor(() =>
      expect(screen.getByLabelText('node actor-a').className).toContain('selected')
    );
    // A route that names the sheet opens it.
    rerender(<GraphPage loggedOut={loggedOut} checkAfterMs={0} section="costs" />);
    expect(
      await screen.findByRole('complementary', { name: 'what each node costs' })
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Costs' }));
    expect(screen.queryByRole('complementary', { name: 'what each node costs' })).toBeNull();
  });
});

describe('a read’s input', () => {
  it('goes as the query’s fields, a string as it is and anything else as JSON', () => {
    expect(query({})).toBe('');
    expect(query({ who: 'alice', n: 2 })).toBe('?who=alice&n=2');
  });
});

describe('a connector’s account, under Advanced (D119)', () => {
  it('is its node’s id without its network, or the one its graph names, which can go', () => {
    const clear = vi.fn();
    const { rerender } = render(
      <AccountFold
        account="telegram-bot:quest"
        network="telegram-bot"
        named={undefined}
        clear={clear}
      />
    );
    expect(screen.getByLabelText('account').textContent).toBe('quest');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <AccountFold
        account="telegram-bot:old"
        network="telegram-bot"
        named="telegram-bot:old"
        clear={clear}
      />
    );
    expect(screen.getByText('(named in its graph on telegram-bot)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Use its node’s id' }));
    expect(clear).toHaveBeenCalled();
    rerender(<AccountFold account="odd:x" network={undefined} named="odd:x" clear={clear} />);
    expect(screen.getByLabelText('account').textContent).toBe('odd:x');
    expect(screen.getByText('(named in its graph)')).toBeDefined();
    rerender(
      <AccountFold account={undefined} network={undefined} named={undefined} clear={clear} />
    );
    expect(screen.queryByLabelText('account')).toBeNull();
  });
});
