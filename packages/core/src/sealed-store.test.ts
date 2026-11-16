import { describe, expect, it } from 'vitest';
import { secretsWith } from '#test/secrets.ts';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { LoginNeeded } from './login.ts';
import { definePlugin } from './plugin.ts';
import { SealedStore } from './sealed-store.ts';
import { isSealed, REDACTED, Sealer, SealError } from './secrets.ts';
import { Stores } from './store.ts';

const KEY = 'a-key-made-up-for-the-tests-only';

describe('the sealer (D123)', () => {
  it('seals any JSON under bot_os_key, the same value the same way, and opens it', () => {
    const secrets = secretsWith({ bot_os_key: KEY });
    const sealer = new Sealer(secrets);
    expect(sealer.available).toBe(true);
    const sealed = sealer.seal({ token: '123:secret-token-value' }, 'tg/login');
    expect(isSealed(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('secret-token-value');
    expect(sealer.seal({ token: '123:secret-token-value' }, 'tg/login')).toEqual(sealed);
    expect(sealer.seal({ token: '123:secret-token-value' }, 'other/login')).not.toEqual(sealed);
    expect(sealer.open(sealed, 'tg/login')).toEqual({ token: '123:secret-token-value' });
    // Its strings are remembered: redacted from then on.
    expect(secrets.redact('a 123:secret-token-value')).toBe(`a ${REDACTED}`);
    // Moved elsewhere, or tampered with: it does not open.
    expect(() => sealer.open(sealed, 'other/login')).toThrow(SealError);
    expect(() => sealer.open({ ...sealed, data: 'AAAA' }, 'tg/login')).toThrow(
      'it does not open with this bot_os_key'
    );
    // Another key does not open it; no key, neither.
    expect(() =>
      new Sealer(secretsWith({ bot_os_key: `${KEY}-2` })).open(sealed, 'tg/login')
    ).toThrow('the key changed since it was sealed');
    const none = new Sealer(secretsWith({}));
    expect(none.available).toBe(false);
    expect(() => none.open(sealed, 'tg/login')).toThrow('there is no bot_os_key secret to open it');
    expect(() => none.seal('x', 'tg/login')).toThrow('nothing is sealed without its key');
    expect(isSealed({ $sealed: 1, iv: 'x' })).toBe(false);
    expect(isSealed(null)).toBe(false);
  });
});

describe('a connector’s sealed store (D123)', () => {
  const warned: string[] = [];
  /** The view on `base`, with `key` as bot_os_key, or none (null). */
  const view = (base = new Stores().open('tg'), key: string | null = KEY) =>
    new SealedStore({
      base,
      sealer: new Sealer(secretsWith(key === null ? {} : { bot_os_key: key })),
      scope: 'tg',
      warn: (l) => warned.push(l),
    });

  it('writes sealed with the key, in clear without, and seals a clear one as it reads it', () => {
    const base = new Stores().open('tg');
    const clear = view(base, null);
    clear.write('login', { token: 'clear-token-1' });
    expect(base.read('login')).toEqual({ token: 'clear-token-1' });
    expect(clear.state()).toEqual({ sealed: false });
    const sealed = view(base);
    expect(sealed.read('login')).toEqual({ token: 'clear-token-1' });
    expect(isSealed(base.read('login'))).toBe(true);
    expect(sealed.state()).toEqual({ sealed: true });
    sealed.write('login', { token: 'next-token-2' });
    expect(JSON.stringify(base.read('login'))).not.toContain('next-token-2');
    expect(sealed.read('login')).toEqual({ token: 'next-token-2' });
    expect(sealed.names()).toEqual(['login']);
    sealed.remove('login');
    expect(sealed.read('login')).toBeUndefined();
  });

  it('reads one that does not open as none, and says why, until it is written again', () => {
    const base = new Stores().open('tg');
    view(base).write('login', { token: 'kept-token-3' });
    for (const other of [view(base, `${KEY}-2`), view(base, null)]) {
      expect(other.read('login')).toBeUndefined();
      expect(other.state().unreadable).toMatch(/bot_os_key/u);
    }
    expect(warned.at(-1)).toMatch(/^its kept login does not open: /u);
    const again = view(base, `${KEY}-2`);
    again.read('login');
    again.write('login', { token: 'new-token-4' });
    expect(again.state()).toEqual({ sealed: true });
    expect(again.read('login')).toEqual({ token: 'new-token-4' });
    const gone = view(base, null);
    gone.read('login');
    gone.remove('login');
    expect(gone.state()).toEqual({ sealed: false });
  });

  it('gives a connector its store sealed, and its login says where its credentials sit', async () => {
    const run = async (key: Record<string, string>, docs?: Record<string, unknown>) => {
      const core = new Core({ clock: new VirtualClock(1), secrets: secretsWith(key) });
      core.register(
        definePlugin({
          manifest: {
            id: 'tg',
            version: '0.1.0',
            kinds: ['connector'],
            description: 'logs in',
            account: 'tg:me',
            login: true,
          },
          create: (ctx) => {
            const store = ctx.secrets?.store ?? ctx.store;
            if (docs !== undefined) ctx.store.write('login', docs);
            const kept = store.read<{ token: string }>('login');
            return {
              connector: new LoginNeeded('tg:me', 'tg'),
              login: {
                state: () =>
                  kept === undefined
                    ? { status: 'needed', actions: [] }
                    : { status: 'done', source: 'store', actions: [] },
                act: (_a, values) => {
                  store.write('login', { token: values['token'] ?? '' });
                  return Promise.resolve({ status: 'done', source: 'store', actions: [] });
                },
              },
            };
          },
        })
      );
      await core.start();
      return core;
    };
    const sealed = await run({ bot_os_key: KEY });
    expect(await sealed.controls.loginAct('tg', 'token', { token: 'pasted-token-5' })).toEqual({
      value: { status: 'done', source: 'store', atRest: 'sealed', actions: [] },
    });
    await sealed.stop();
    const clear = await run({}, { token: 'clear-token-6' });
    expect(clear.controls.login('tg')).toEqual({
      value: { status: 'done', source: 'store', atRest: 'clear', actions: [] },
    });
    await clear.stop();
    const lost = await run(
      {},
      new Sealer(secretsWith({ bot_os_key: KEY })).seal({ token: 't' }, 'tg/login') as never
    );
    expect(lost.controls.login('tg')).toMatchObject({
      value: {
        status: 'needed',
        error: expect.stringMatching(/^its kept login does not open: /u) as unknown,
      },
    });
    await lost.stop();
  });
});
