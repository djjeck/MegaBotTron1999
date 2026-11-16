import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { secretsWith } from '#test/secrets.ts';
import { VirtualClock } from './clock.ts';
import { controlServer } from './control-server.ts';
import { Core } from './core.ts';
import { type LogEntry } from './event-log.ts';
import { type Login, loginAnswer, LoginNeeded, type LoginState, NEEDS_LOGIN } from './login.ts';
import { parseManifest } from './manifest.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const TOKEN = 'a-token-of-the-store-xyz';

/**
 * A connector that logs in (D116, D118): its token from its store, else it needs a login; `token`
 * checks one (`good` passes) and keeps it.
 */
function loginConnector(grab: (ctx: PluginContext) => void = () => {}) {
  return definePlugin({
    manifest: {
      id: 'tg',
      version: '0.1.0',
      kinds: ['connector'],
      description: 'logs in',
      account: 'tg:me',
      login: true,
    },
    create: (ctx) => {
      grab(ctx);
      const kept = ctx.store.read<{ token: string }>('login')?.token;
      if (kept !== undefined) ctx.secrets?.remember(kept);
      let state: LoginState =
        kept !== undefined
          ? { status: 'done', source: 'store', actions: [{ name: 'logout', label: 'Log out' }] }
          : {
              status: 'needed',
              step: { title: 'Token', fields: [{ name: 'token', label: 'Token', secret: true }] },
              actions: [{ name: 'token', label: 'Check', submit: true }],
            };
      const login: Login = {
        state: () => state,
        act: (action, values) => {
          if (action === 'boom') return Promise.reject(new Error(`no ${TOKEN}`));
          if (action !== 'token') return Promise.reject(new Error(`no action ${action}`));
          const token = values['token'] ?? '';
          ctx.secrets?.remember(token);
          if (!token.startsWith('good')) state = { ...state, error: `refused ${token}` };
          else {
            ctx.store.write('login', { token });
            state = { status: 'done', source: 'store', as: '@Me', restart: true, actions: [] };
          }
          return Promise.resolve(state);
        },
      };
      return { connector: new LoginNeeded(ctx.account ?? 'tg:me', 'tg'), login };
    },
  });
}

const plain = definePlugin({
  manifest: { id: 'plain', version: '0.1.0', kinds: ['stats'], description: 'nothing' },
  create: () => ({}),
});

let server: http.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(core: Core) {
  server = controlServer({ controls: core.controls, settings: core.settings });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return async (p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...(body === undefined
        ? {}
        : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return [res.status, await res.json()] as const;
  };
}

describe('a connector that logs in from its node (D116)', () => {
  it('runs without credentials, needing a login', async () => {
    let ctx: PluginContext | undefined;
    const core = new Core({ clock: new VirtualClock(1), secrets: secretsWith({}) });
    core.register(loginConnector((c) => (ctx = c)));
    await core.start();
    expect(core.state('tg')?.state).toBe('running');
    expect(core.connector('tg')?.status()).toEqual({
      state: 'closed',
      phase: NEEDS_LOGIN,
      detail: 'log in from its node',
    });
    expect(ctx?.secrets?.has('other')).toBe(false);
    await core.stop();
  });

  it('logs in through the control API, recorded without what was typed, redacted', async () => {
    const records: LogEntry[] = [];
    const core = new Core({
      clock: new VirtualClock(1),
      secrets: secretsWith({}),
      record: (r) => records.push(r),
    });
    core.register(loginConnector(), plain);
    await core.start();
    const call = await serve(core);
    expect(await call('/plugins/tg/login')).toMatchObject([200, { status: 'needed' }]);
    // A refused answer is where it stands, its error redacted of what was typed.
    expect(
      await call('/plugins/tg/login', { action: 'token', values: { token: 'bad-token-123' } })
    ).toMatchObject([200, { status: 'needed', error: 'refused [redacted]' }]);
    expect(
      await call('/plugins/tg/login', { action: 'token', values: { token: 'good-token-456' } })
    ).toEqual([200, { status: 'done', source: 'store', as: '@Me', restart: true, actions: [] }]);
    // Whom it is logged in as, on its account too (D120).
    expect(core.controls.accounts().find((x) => x.id === 'tg')?.as).toBe('@Me');
    // An action it does not offer: 409, redacted too.
    expect(await call('/plugins/tg/login', { action: 'boom' })).toEqual([
      409,
      { error: 'no a-token-of-the-store-xyz' },
    ]);
    expect(await call('/plugins/tg/login', { values: {} })).toEqual([
      400,
      { error: 'action: expected a name' },
    ]);
    expect(await call('/plugins/plain/login')).toEqual([404, { error: 'plain offers no login' }]);
    expect(await call('/plugins/nobody/login')).toEqual([404, { error: 'nobody offers no login' }]);
    const logins = records.filter((r) => r.type === 'core.login');
    expect(logins.map(({ t: _, ...r }) => r)).toEqual([
      {
        type: 'core.login',
        node: 'tg',
        action: 'token',
        status: 'needed',
        error: 'refused [redacted]',
      },
      { type: 'core.login', node: 'tg', action: 'token', status: 'done', as: '@Me' },
    ]);
    expect(JSON.stringify(records)).not.toContain('good-token-456');
    await core.stop();
    // Not running: 409.
    expect(await call('/plugins/tg/login')).toEqual([409, { error: 'tg is not running' }]);
    expect(await call('/plugins/tg/login', { action: 'token' })).toEqual([
      409,
      { error: 'tg is not running' },
    ]);
  });

  it('requires the secrets it declares, as any connector: a login is no fallback for them', () => {
    const core = new Core({ clock: new VirtualClock(1), secrets: secretsWith({}) });
    core.register(
      definePlugin({
        manifest: {
          id: 'tg',
          version: '0.1.0',
          kinds: ['connector'],
          description: 'logs in, with a key',
          account: 'tg:me',
          secrets: ['tg_key'],
          login: true,
        },
        create: () => ({ connector: new LoginNeeded('tg:me', 'tg') }),
      })
    );
    expect(() => core.load()).toThrow('the secret tg_key is not provided');
  });

  it('reports a login whose state throws, redacted', async () => {
    const core = new Core({ clock: new VirtualClock(1) });
    core.register(
      definePlugin({
        manifest: {
          id: 'tg',
          version: '0.1.0',
          kinds: ['connector'],
          description: 'broken',
          account: 'tg:me',
          login: true,
        },
        create: () => ({
          connector: new LoginNeeded('tg:me', 'tg'),
          login: {
            state: () => {
              throw new Error('lost');
            },
            act: () => Promise.reject(new Error('lost')),
          },
        }),
      })
    );
    await core.start();
    expect(core.controls.login('tg')).toEqual({ error: 'lost' });
    expect(core.controls.accounts()[0]).not.toHaveProperty('as');
    expect(await core.controls.loginAct('tg', 'x', {})).toEqual({ error: 'lost' });
    await core.stop();
  });

  it('refuses a login on a plugin that is not a connector', () => {
    expect(() =>
      parseManifest({
        id: 'x',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'x',
        login: true,
      })
    ).toThrow('only a connector logs in');
  });
});

describe('LoginNeeded', () => {
  it('sends nothing and lists nothing', async () => {
    const c = new LoginNeeded('tg:me', 'tg');
    expect(c.send()).toBe(false);
    await expect(c.deliver()).rejects.toThrow('tg:me needs a login');
    await expect(c.surfaces()).rejects.toThrow('it needs a login');
  });
});

describe('loginAnswer', () => {
  it('reads an action and its values, each a string', () => {
    expect(loginAnswer({ action: 'code', values: { code: '12345' } })).toEqual({
      action: 'code',
      values: { code: '12345' },
    });
    expect(loginAnswer({ action: 'qr' })).toEqual({ action: 'qr', values: {} });
    expect(loginAnswer(null)).toEqual({ error: 'expected {"action", "values"}' });
    expect(loginAnswer({ action: 'x', values: [] })).toEqual({
      error: 'values: expected an object of strings',
    });
    expect(loginAnswer({ action: 'x', values: { n: 1 } })).toEqual({
      error: 'values.n: expected a string',
    });
  });
});
