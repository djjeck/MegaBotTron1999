// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoginState, NodeView } from '#src/ui/api.ts';
import { ConnectorLogin, QrCode } from './ConnectorLogin.tsx';
import { NodeDetails } from './NodeDetails.tsx';
import { SensitiveField } from './SensitiveField.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN_STEP: LoginState = {
  status: 'needed',
  step: {
    title: 'The bot’s token',
    text: 'Ask @BotFather.',
    link: { href: 'https://t.me/BotFather', label: '@BotFather' },
    fields: [{ name: 'token', label: 'Token', secret: true }],
  },
  actions: [{ name: 'token', label: 'Check and save', submit: true, primary: true }],
};

/** The login API, its answers in turn; each request kept. */
function stubLogin(answers: (LoginState | { status: number; error: string })[]) {
  const sent: { url: string; body?: unknown }[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      sent.push({
        url,
        ...(init?.body === undefined ? {} : { body: JSON.parse(init.body as string) as unknown }),
      });
      const a = answers[Math.min(i++, answers.length - 1)];
      const status =
        a !== undefined && 'error' in a && typeof a.status === 'number' ? a.status : 200;
      return Promise.resolve(new Response(JSON.stringify(a), { status }));
    })
  );
  return sent;
}

describe('a connector’s login in its panel (D116)', () => {
  it('sends the token typed unseen, then says whom it is and offers the restart', async () => {
    const sent = stubLogin([
      TOKEN_STEP,
      {
        status: 'done',
        source: 'store',
        as: '@ExampleBot',
        restart: true,
        note: 'Restart to connect with it.',
        actions: [],
      },
    ]);
    const restart = vi.fn();
    render(<ConnectorLogin node="tg bot" restart={restart} />);
    const field = await screen.findByLabelText('Token');
    expect(field.getAttribute('type')).toBe('password');
    expect(screen.getByRole('link', { name: '@BotFather' }).getAttribute('href')).toBe(
      'https://t.me/BotFather'
    );
    expect(screen.getByText('needs login')).toBeTruthy();
    fireEvent.change(field, { target: { value: '123:abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    await screen.findByText(/as @ExampleBot/u);
    expect(sent[1]).toEqual({
      url: 'api/plugins/tg%20bot/login',
      body: { action: 'token', values: { token: '123:abc' } },
    });
    expect(screen.getByText('(kept in its store)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(restart).toHaveBeenCalled();
  });

  it('draws a QR code, asks again while pending, and cancels', async () => {
    const qr: LoginState = {
      status: 'pending',
      step: { title: 'Scan the QR code', qr: 'tg://login?token=abc', fields: [] },
      actions: [{ name: 'cancel', label: 'Cancel' }],
    };
    const sent = stubLogin([
      qr,
      qr,
      { status: 'needed', error: 'the login timed out: start it again', actions: [] },
    ]);
    render(<ConnectorLogin node="me" pollMs={10} />);
    expect(await screen.findByRole('img', { name: 'QR code to scan' })).toBeTruthy();
    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'the login timed out: start it again'
    );
  });

  it('asks before an action that says to, and shows a refusal', async () => {
    const sent = stubLogin([
      {
        status: 'done',
        source: 'store',
        note: 'Kept.',
        actions: [{ name: 'logout', label: 'Log out', confirm: 'Sure?' }],
      },
      { status: 409, error: 'the login does not offer logout now' },
    ]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<ConnectorLogin node="me" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(confirm).toHaveBeenCalledWith('Sure?');
    expect(sent).toHaveLength(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'the login does not offer logout now'
    );
    expect(screen.getByText('(kept in its store)')).toBeTruthy();
  });

  it('says where its credentials sit at rest: sealed, or in clear with a warning (D123)', async () => {
    stubLogin([{ status: 'done', source: 'store', atRest: 'clear', actions: [] }]);
    const { unmount } = render(<ConnectorLogin node="me" />);
    expect((await screen.findByRole('note')).textContent).toContain('kept in clear');
    unmount();
    stubLogin([{ status: 'done', source: 'store', atRest: 'sealed', actions: [] }]);
    render(<ConnectorLogin node="me" />);
    expect(await screen.findByText('(kept in its store, sealed)')).toBeDefined();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('says why its login cannot be read', async () => {
    stubLogin([{ status: 409, error: 'me is not running' }]);
    render(<ConnectorLogin node="me" />);
    expect(await screen.findByText('me is not running')).toBeTruthy();
  });

  it('draws a link as a QR code', () => {
    const { container } = render(<QrCode text="tg://login?token=abc" size={100} />);
    const path = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(path.length).toBeGreaterThan(100);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('100');
  });
});

describe('a Telegram-like connector’s panel, as a first setup sees it (D122)', () => {
  const view: NodeView = {
    id: 'quest-bot',
    plugin: 'telegram-bot',
    version: '0.1.0',
    description: 'A bot',
    kinds: ['connector'],
    account: 'telegram-bot:quest-bot',
    network: 'telegram-bot',
    login: true,
    configSchema: {
      type: 'object',
      properties: {
        homeLabel: { type: 'string', default: 'Home', description: 'The back button’s label' },
        unansweredAt: { type: 'integer', default: 10, description: 'How many' },
        liveGraceS: { type: 'number', default: 120, description: 'How old' },
      },
    },
    inputs: {},
    outputs: {},
    interface: { reads: [], actions: [], commands: [] },
    secrets: [],
    configSecrets: [],
    events: [],
  };
  const panel = (connection?: { state: 'closed'; phase: string }, stopped = false) =>
    render(
      <NodeDetails
        node={{ id: 'quest-bot', plugin: 'telegram-bot' }}
        view={view}
        {...(connection === undefined
          ? {}
          : {
              live: {
                id: 'quest-bot',
                plugin: 'telegram-bot',
                description: 'A bot',
                kinds: ['connector'],
                ...(stopped
                  ? {
                      state: 'stopped' as const,
                      stop: { reason: 'killed by the owner', time: '', source: 'owner' as const },
                    }
                  : { state: 'running' as const }),
                settings: {},
                reads: [],
                actions: [],
              },
              account: {
                id: 'quest-bot',
                plugin: 'telegram-bot',
                state: stopped ? 'stopped' : 'running',
                connection,
              },
            })}
        problems={[]}
        configErrors={{}}
        settingErrors={{}}
        secretNames={[]}
        groups={[]}
        change={() => {}}
        remove={() => {}}
        kill={() => {}}
        cleared={false}
        clearStop={() => {}}
      />
    );

  it('says to apply, then to log in first; folds the connector’s tuning; asks no account', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    panel();
    expect(screen.getByText(/It logs in from here once it runs/u)).toBeDefined();
    expect(screen.getByRole('note').textContent).toContain('Log in first');
    const tuning = screen.getByRole('group', { name: 'config tuning' });
    expect(tuning.textContent).toContain('unansweredAt');
    expect(tuning.textContent).toContain('liveGraceS');
    expect(tuning.textContent).not.toContain('homeLabel');
    expect(screen.queryByRole('textbox', { name: 'account' })).toBeNull();
    expect(screen.getByLabelText('account').textContent).toBe('quest-bot');
    cleanup();
    panel({ state: 'closed', phase: 'needs login' });
    expect(screen.getByRole('note').textContent).toContain('Log in first');
    cleanup();
    panel({ state: 'closed', phase: 'closed' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows a stopped connector’s Login, a stop not hiding it (D125)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'needed',
              step: { title: 'The bot’s token', fields: [{ name: 'token', label: 'Token' }] },
              actions: [{ name: 'token', label: 'Check and save', submit: true }],
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        )
      )
    );
    panel({ state: 'closed', phase: 'closed' }, true);
    expect(await screen.findByText('The bot’s token')).toBeDefined();
    expect(screen.queryByText(/It logs in from here/u)).toBeNull();
  });
});

describe('a sensitive config field (D124)', () => {
  it('says whether it is set, never shows it, and replaces or clears it', () => {
    const set = vi.fn();
    const { rerender } = render(
      <SensitiveField name="token" value={{ $sensitive: 'set' }} set={set} />
    );
    expect(screen.getByLabelText('token state').textContent).toBe('set');
    expect(screen.queryByLabelText('token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const input = screen.getByLabelText('token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'typed-anew' } });
    expect(set).toHaveBeenLastCalledWith('typed-anew');
    rerender(<SensitiveField name="token" value="typed-anew" set={set} />);
    expect(screen.getByLabelText('token state').textContent).toBe('set anew, saved with Apply');
    fireEvent.change(screen.getByLabelText('token'), { target: { value: '' } });
    expect(set).toHaveBeenLastCalledWith(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(set).toHaveBeenLastCalledWith(undefined);
    rerender(<SensitiveField name="token" value={undefined} set={set} />);
    expect(screen.getByLabelText('token state').textContent).toBe('not set');
    expect(screen.getByRole('button', { name: 'Set' })).toBeDefined();
  });

  it('is drawn in a node’s config for each key its plugin marks', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    const change = vi.fn();
    render(
      <NodeDetails
        node={{ id: 'k', plugin: 'keeper', config: { token: { $sensitive: 'set' } } }}
        view={{
          id: 'k',
          plugin: 'keeper',
          version: '0.1.0',
          description: 'keeps a token',
          kinds: ['stats'],
          configSchema: { type: 'object', properties: { token: { type: 'string' } } },
          configSensitive: ['token'],
          inputs: {},
          outputs: {},
          interface: { reads: [], actions: [], commands: [] },
          secrets: [],
          configSecrets: [],
          events: [],
        }}
        problems={[]}
        configErrors={{}}
        settingErrors={{}}
        secretNames={[]}
        groups={[]}
        change={change}
        remove={() => {}}
        kill={() => {}}
        cleared={false}
        clearStop={() => {}}
      />
    );
    expect(screen.getByLabelText('token state').textContent).toBe('set');
    expect(document.body.textContent).not.toContain('$sensitive');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(change).toHaveBeenCalledWith({ config: {} });
  });
});
