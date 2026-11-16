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
    expect(store.read(BOT_LOGIN_DOC)).toEqual({ token: TOKEN, as: '@ExampleBot' });
    expect(remembered).toEqual(['nonsense', TOKEN]);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('says whom it is from what its login kept, before the bot connects (D120)', () => {
    const store = new Stores().open('named');
    store.write(BOT_LOGIN_DOC, { token: TOKEN, as: '@ExampleBot' });
    const { login } = setUp({ store, source: 'store' });
    expect(login.state()).toMatchObject({ status: 'done', as: '@ExampleBot' });
  });

  it('refuses a token of a bot another node holds, naming it, unchecked (D121)', async () => {
    const claimed: (string | undefined)[] = [];
    const { login, checked, store } = setUp({
      taken: (bot) => (bot === '123456' ? 'quest-bot' : undefined),
      claim: (bot) => claimed.push(bot),
    });
    expect(await login.act('token', { token: TOKEN })).toMatchObject({
      status: 'needed',
      error: expect.stringContaining('used by the node quest-bot already') as unknown,
    });
    expect(checked).toEqual([]);
    expect(store.read(BOT_LOGIN_DOC)).toBeUndefined();
    const other = `654321:${TOKEN.slice(7)}`;
    expect((await login.act('token', { token: other })).status).toBe('done');
    expect(await login.act('logout', {})).toMatchObject({ status: 'needed' });
    expect(claimed).toEqual(['654321', undefined]);
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

  it('forgets a token of its store, then needs a login; takes another token in its place', async () => {
    const store = new Stores().open('kept');
    store.write(BOT_LOGIN_DOC, { token: TOKEN });
    const { login, remembered } = setUp({ store, source: 'store', self: () => 'ExampleBot' });
    expect(remembered).toEqual([TOKEN]);
    expect(login.state()).toMatchObject({ status: 'done', source: 'store', as: '@ExampleBot' });
    await expect(login.act('token', { token: TOKEN })).rejects.toThrow(
      'the login does not ask for a token now'
    );
    expect((await login.act('replace', {})).actions.map((a) => a.name)).toEqual([
      'token',
      'cancel',
    ]);
    expect((await login.act('cancel', {})).status).toBe('done');
    expect(await login.act('logout', {})).toMatchObject({ status: 'needed', restart: true });
    expect(store.read(BOT_LOGIN_DOC)).toBeUndefined();
    await expect(login.act('logout', {})).rejects.toThrow('does not offer logout now');
    await expect(login.act('other', {})).rejects.toThrow('does not offer other now');
    await login.act('replace', {});
    expect(await login.act('token', { token: TOKEN })).toMatchObject({
      status: 'done',
      source: 'store',
    });
  });
});
