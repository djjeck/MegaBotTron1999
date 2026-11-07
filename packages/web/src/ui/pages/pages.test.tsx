// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '#test/fake-api.ts';
import { AccountsPage } from './AccountsPage.tsx';
import { DriftPage } from './DriftPage.tsx';
import { EventsPage } from './EventsPage.tsx';
import { InstancePage } from './InstancePage.tsx';
import { PluginsPage } from './PluginsPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loggedOut = vi.fn();

const HEALTH = {
  off: false,
  uptimeS: 42,
  node: 'v24.0.0',
  memoryMb: { rss: 80, heap: 30 },
  plugins: { running: 2 },
  accounts: {},
};

describe('InstancePage', () => {
  it('shows the health, and turns the instance off and on, and kills it once confirmed', async () => {
    let off = false;
    const api = fakeApi({
      'GET /instance': () => [200, { ...HEALTH, off }],
      'POST /off': () => {
        off = true;
        return [200, { off: true, result: 'off' }];
      },
      'POST /on': () => {
        off = false;
        return [200, { off: false, result: 'actor back' }];
      },
      'POST /kill': [200, { result: 'Killed: actor stopped' }],
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<InstancePage loggedOut={loggedOut} />);
    expect(await screen.findByText('42s')).toBeDefined();
    expect(screen.getByText('2 running')).toBeDefined();
    expect(screen.getByText('none')).toBeDefined();
    expect(screen.getByText('80 MB (30 MB heap)')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(api.calls).not.toContain('POST /off {}');
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'off');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveProperty('textContent', 'actor back')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveProperty('textContent', 'Killed: actor stopped')
    );
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('says why when the instance cannot be read or a switch is refused', async () => {
    fakeApi({ 'GET /instance': [500, { error: 'broken' }] });
    render(<InstancePage loggedOut={loggedOut} />);
    expect(await screen.findByText('broken')).toBeDefined();
    cleanup();
    fakeApi({ 'GET /instance': [200, { ...HEALTH, off: true }], 'POST /on': [500, undefined] });
    render(<InstancePage loggedOut={loggedOut} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'HTTP 500');
  });
});

describe('AccountsPage', () => {
  it('lists each account with its connection, and says when none runs', async () => {
    fakeApi({
      'GET /accounts': [
        200,
        [
          {
            id: 'irc',
            plugin: 'irc',
            account: 'irc:me',
            state: 'running',
            network: 'irc',
            self: 'me_',
            connection: { state: 'connected', phase: 'joined' },
          },
          {
            id: 'second',
            plugin: 'irc',
            state: 'running',
            connection: { state: 'closed', phase: 'closed', detail: 'refused' },
          },
          { id: 'key', plugin: 'key', state: 'failed', reason: 'no secret' },
        ],
      ],
    });
    render(<AccountsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('irc:me')).toBeDefined();
    expect(screen.getByText('me_')).toBeDefined();
    expect(screen.getByText('second (irc)')).toBeDefined();
    expect(screen.getByText(/closed: refused/u)).toBeDefined();
    expect(screen.getByText(/no secret/u)).toBeDefined();
    cleanup();
    fakeApi({ 'GET /accounts': [200, []] });
    render(<AccountsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('No connector runs.')).toBeDefined();
    cleanup();
    fakeApi({});
    render(<AccountsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('not found')).toBeDefined();
  });
});

const ACTOR = {
  id: 'actor-a',
  plugin: 'actor',
  description: 'acts',
  kinds: ['actor'],
  state: 'running',
  mode: 'read-only',
  settings: { level: 1, name: 'x' },
  reads: ['status'],
  actions: ['bump'],
  status: { count: 0 },
};
const PARSER = {
  id: 'parser',
  plugin: 'parser',
  description: 'reads',
  kinds: ['parser'],
  state: 'paused',
  reason: 'drift',
  settings: {},
  reads: [],
  actions: [],
};

describe('PluginsPage', () => {
  it('lists the plugins with their state and mode, and changes a mode', async () => {
    let mode = 'read-only';
    const api = fakeApi({
      'GET /status': () => [200, { off: false, plugins: [{ ...ACTOR, mode }, PARSER] }],
      'POST /plugins/actor-a/mode': (b) => {
        mode = (b as { mode: string }).mode;
        return [200, { mode }];
      },
      'POST /plugins/parser/resume': [409, { error: 'the bot is off' }],
    });
    render(<PluginsPage loggedOut={loggedOut} />);
    const select = await screen.findByLabelText('actor-a mode');
    expect(screen.getByText('(actor)')).toBeDefined();
    expect(screen.getByText('sends nothing')).toBeDefined();
    expect(screen.getByText('drift')).toBeDefined();
    fireEvent.change(select, { target: { value: 'live' } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('live'));
    expect(api.calls).toContain('POST /plugins/actor-a/mode {"mode":"live"}');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/the bot is off/u)).toBeDefined();
  });

  it('opens a plugin: its status, settings, reads and actions', async () => {
    const api = fakeApi({
      'GET /status': [200, { off: false, plugins: [ACTOR] }],
      'POST /settings': (b) =>
        (b as { key: string }).key === 'level' ? [200, {}] : [400, { error: 'no such setting' }],
      'GET /plugins/actor-a/state/status': [200, { count: 3 }],
      'POST /plugins/actor-a/actions/bump': (b) =>
        (b as { by?: number }).by === undefined ? [400, { error: 'by: required' }] : [200, 4],
    });
    render(<PluginsPage loggedOut={loggedOut} />);
    fireEvent.click(await screen.findByRole('button', { name: 'actor-a' }));
    expect(screen.getByText('acts')).toBeDefined();

    const level = screen.getByLabelText('level');
    fireEvent.change(level, { target: { value: '5' } });
    fireEvent.submit(level);
    expect(await screen.findByText('level set')).toBeDefined();
    expect(api.calls).toContain('POST /settings {"key":"level","value":5}');
    const name = screen.getByLabelText('name');
    expect((name as HTMLInputElement).value).toBe('x');
    fireEvent.change(name, { target: { value: 'plain words' } });
    fireEvent.submit(name);
    expect(await screen.findByText('no such setting')).toBeDefined();
    expect(api.calls).toContain('POST /settings {"key":"name","value":"plain words"}');

    fireEvent.click(screen.getByRole('button', { name: 'status' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('"count": 3'));

    const input = screen.getByLabelText('bump input');
    fireEvent.submit(input);
    expect(await screen.findByText('bump: by: required')).toBeDefined();
    fireEvent.change(input, { target: { value: 'not json' } });
    fireEvent.submit(input);
    expect(await screen.findByText('bump: the input is not JSON')).toBeDefined();
    fireEvent.change(input, { target: { value: '{"by": 1}' } });
    fireEvent.submit(input);
    expect(await screen.findByText('bump: 4')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'actor-a' }));
    expect(screen.queryByText('acts')).toBeNull();
  });

  it('says a read refused', async () => {
    fakeApi({ 'GET /status': [200, { off: false, plugins: [{ ...ACTOR, status: undefined }] }] });
    render(<PluginsPage loggedOut={loggedOut} />);
    fireEvent.click(await screen.findByRole('button', { name: 'actor-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'status' }));
    expect(await screen.findByText('status: not found')).toBeDefined();
  });

  it('turns the instance on, the modes locked while off', async () => {
    let off = true;
    fakeApi({
      'GET /status': () => [200, { off, plugins: [ACTOR] }],
      'POST /on': () => {
        off = false;
        return [200, { off: false, result: 'on' }];
      },
    });
    render(<PluginsPage loggedOut={loggedOut} />);
    expect((await screen.findByLabelText('actor-a mode')).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/modes change only while on/u)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await screen.findByRole('button', { name: 'Turn off' });
    expect(screen.getByLabelText('actor-a mode').hasAttribute('disabled')).toBe(false);
  });

  it('says why the plugins cannot be read', async () => {
    fakeApi({ 'GET /status': [500, { error: 'broken' }] });
    render(<PluginsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('broken')).toBeDefined();
  });
});

describe('DriftPage', () => {
  it('shows each parser’s counts and the latest reports', async () => {
    fakeApi({
      'GET /drift': [
        200,
        [
          { parser: 'p', read: 10, unread: 2, recent: 1, tripped: false },
          { parser: 'q', read: 0, unread: 6, recent: 6, tripped: true },
        ],
      ],
      'GET /events?type=core.drift&limit=50&hours=168': [
        200,
        [
          {
            type: 'core.drift',
            t: 2000,
            plugin: 'q',
            event: 'pause',
            reason: '6 unread',
            paused: ['a'],
          },
          {
            type: 'core.drift',
            t: 1000,
            plugin: 'q',
            event: 'pause',
            reason: '6 unread',
            paused: [],
          },
          { type: 'core.drift', t: 500, plugin: 'p', event: 'unread', text: 'what is this' },
          { type: 'core.drift', t: 100 },
        ],
      ],
    });
    render(<DriftPage loggedOut={loggedOut} />);
    expect(await screen.findByText('tripped')).toBeDefined();
    expect(await screen.findByText('what is this')).toBeDefined();
    expect(screen.getByText('; paused a')).toBeDefined();
    expect(screen.getAllByText(': 6 unread')).toHaveLength(2);
  });

  it('says when there is nothing, or why not', async () => {
    fakeApi({
      'GET /drift': [200, []],
      'GET /events?type=core.drift&limit=50&hours=168': [200, []],
    });
    render(<DriftPage loggedOut={loggedOut} />);
    expect(await screen.findByText('No parser has reported since the start.')).toBeDefined();
    expect(await screen.findByText('None.')).toBeDefined();
    cleanup();
    fakeApi({});
    render(<DriftPage loggedOut={loggedOut} />);
    await waitFor(() => expect(screen.getAllByText('not found')).toHaveLength(2));
  });
});

describe('EventsPage', () => {
  it('shows the latest records, filtered by type and count', async () => {
    const api = fakeApi({
      'GET /events?limit=100&type=': [
        200,
        [
          { type: 'core.power', t: 2000, off: true },
          { type: 'game.tick', t: 1000 },
        ],
      ],
      'GET /events?limit=100&type=core.': [200, [{ type: 'core.power', t: 2000, off: true }]],
      'GET /events?limit=500&type=core.': [200, []],
    });
    render(<EventsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('{"off":true}')).toBeDefined();
    expect(screen.getByText('game.tick')).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText('core.'), { target: { value: ' core. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(screen.queryByText('game.tick')).toBeNull());
    expect(screen.getByText('core.power')).toBeDefined();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '500' } });
    expect(await screen.findByText('No record in the last 24 hours.')).toBeDefined();
    expect(api.calls.at(-1)).toBe('GET /events?limit=500&type=core.');
    cleanup();
    fakeApi({});
    render(<EventsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('not found')).toBeDefined();
    expect(within(document.body).queryByText('core.power')).toBeNull();
  });
});
