// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoginState } from '#src/ui/api.ts';
import { ConnectorLogin, QrCode } from './ConnectorLogin.tsx';

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
