import { Stores, VirtualClock } from '@megabottron1999/core';
import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { BOT_LOGIN_DOC, BotLogin, type BotLoginOptions, CHECK_MS } from './bot-login.ts';

const TOKEN = '123456:AAnotarealtokenatallxyz';
let stores = 0;

function setUp(o: Partial<BotLoginOptions> = {}) {
  const store = o.store ?? new Stores().open(`b${++stores}`);
  const clock = new VirtualClock(1000);
  const remembered: string[] = [];
  const logged: string[] = [];
  const checked: string[] = [];
  const login = new BotLogin({
    store,
    clock,
    source: undefined,
    secrets: false,
    self: () => undefined,
    check: (t) => (checked.push(t), Promise.resolve({ username: 'ExampleBot' })),
    remember: (v) => remembered.push(v),
    log: (l) => logged.push(l),
    ...o,
  });
  return { login, store, clock, remembered, logged, checked };
}

describe('a telegram-bot login (D116)', () => {
  it('asks for the token, checks it with Telegram, and keeps it', async () => {
    const { login, store, remembered, logged, checked } = setUp();
    const first = login.state();
    expect(first).toMatchObject({ status: 'needed', step: { title: 'The bot’s token' } });
    expect(first.step?.link?.href).toBe('https://t.me/BotFather');
    expect(first.step?.fields[0]).toMatchObject({ name: 'token', secret: true });
    expect(await login.act('token', { token: 'nonsense' })).toMatchObject({
      status: 'needed',
      error: 'not a bot token: @BotFather gives one as 123456789:AA…',
    });
    expect(checked).toEqual([]);
    expect(await login.act('token', { token: ` ${TOKEN} ` })).toEqual({
      status: 'done',
      source: 'store',
      restart: true,
      as: '@ExampleBot',
      note: 'Restart to connect with it.',
      actions: [
        { name: 'replace', label: 'Use another token' },
        expect.objectContaining({ name: 'logout', label: 'Forget the token' }) as unknown,
      ],
    });
    expect(store.read(BOT_LOGIN_DOC)).toEqual({ token: TOKEN });
    expect(remembered).toEqual(['nonsense', TOKEN]);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('says why Telegram refused a token, or did not answer', async () => {
    const { login, clock } = setUp({
      check: (t) =>
        t.endsWith('x')
          ? Promise.reject(
              new GrammyError(
                'Call to getMe failed!',
                { ok: false, error_code: 401, description: 'Unauthorized' },
                'getMe',
                {}
              )
            )
          : new Promise(() => {}),
    });
    expect(await login.act('token', { token: `${TOKEN}x` })).toMatchObject({
      error: 'Telegram refused it: Unauthorized',
    });
    const pending = login.act('token', { token: TOKEN });
    clock.advance(CHECK_MS);
    expect(await pending).toMatchObject({
      status: 'needed',
      error: 'Telegram refused it: no answer from Telegram',
    });
    const { login: odd } = setUp({ check: () => Promise.reject('odd' as unknown as Error) });
    expect((await odd.act('token', { token: TOKEN })).error).toBe('Telegram refused it: odd');
  });

  it('forgets a token of its store, its Docker secret then the fallback', async () => {
    const store = new Stores().open('kept');
    store.write(BOT_LOGIN_DOC, { token: TOKEN });
    const { login, remembered } = setUp({
      store,
      source: 'store',
      secrets: true,
      self: () => 'ExampleBot',
    });
    expect(remembered).toEqual([TOKEN]);
    expect(login.state()).toMatchObject({ status: 'done', source: 'store', as: '@ExampleBot' });
    await expect(login.act('token', { token: TOKEN })).rejects.toThrow(
      'the login does not ask for a token now'
    );
    expect(await login.act('logout', {})).toMatchObject({
      status: 'done',
      source: 'secrets',
      restart: true,
      note: expect.stringContaining('uses the telegram_bot_token Docker secret again') as unknown,
    });
    expect(store.read(BOT_LOGIN_DOC)).toBeUndefined();
    await expect(login.act('logout', {})).rejects.toThrow('does not offer logout now');
    await expect(login.act('other', {})).rejects.toThrow('does not offer other now');
  });

  it('needs a login once forgotten without a secret; takes a token over its secret', async () => {
    const store = new Stores().open('alone');
    store.write(BOT_LOGIN_DOC, { token: TOKEN });
    const { login } = setUp({ store, source: 'store' });
    expect((await login.act('logout', {})).status).toBe('needed');
    const { login: secret } = setUp({
      source: 'secrets',
      secrets: true,
      self: () => '@ExampleBot',
    });
    expect(secret.state()).toMatchObject({
      status: 'done',
      source: 'secrets',
      as: '@ExampleBot',
      note: expect.stringContaining('is the telegram_bot_token Docker secret') as unknown,
      actions: [{ name: 'replace', label: 'Paste a token' }],
    });
    expect((await secret.act('replace', {})).actions.map((a) => a.name)).toEqual([
      'token',
      'cancel',
    ]);
    expect((await secret.act('cancel', {})).status).toBe('done');
    await secret.act('replace', {});
    expect(await secret.act('token', { token: TOKEN })).toMatchObject({
      status: 'done',
      source: 'store',
    });
  });
});
