import {
  controlHandler,
  Core,
  CORE_STORE,
  FakeConnector,
  fakeConnectorPlugin,
  Stores,
} from '@megabottron1999/core';
import { VirtualClock } from '@megabottron1999/core/clock.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth.ts';
import { DIST, passwordRefusal, startWebUi, WEB_SECRET, webHandler } from './web-server.ts';

const PASSWORD = 'a long enough password';

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

/** A built app of two files. */
function dist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>UI</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'app-1234.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'assets', 'blob'), 'x');
  return dir;
}

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A client that keeps the session cookie, as a browser on the UI's page does. */
function browser(base: string) {
  let cookie = '';
  const call = async (route: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const res = await fetch(`${base}${route}`, {
      ...rest,
      ...(json === undefined
        ? {}
        : { method: 'POST', body: typeof json === 'string' ? json : JSON.stringify(json) }),
      headers: {
        ...(json === undefined ? {} : { 'content-type': 'application/json', origin: base }),
        ...(cookie === '' ? {} : { cookie }),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
    const set = res.headers.get('set-cookie');
    if (set !== null) cookie = set.split(';')[0] ?? '';
    return res;
  };
  return { call, cookie: () => cookie };
}

describe('webHandler', () => {
  it('serves the control API only behind the login, with the session in a strict cookie', async () => {
    const seen: string[] = [];
    const base = await serve(
      webHandler({
        password: PASSWORD,
        dist: dist(),
        api: (req, res) => {
          seen.push(`${req.method} ${req.url}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        },
      })
    );
    const b = browser(base);
    const first = (await (await b.call('/api/session')).json()) as { boot: string };
    expect(first).toEqual({ authenticated: false, boot: expect.stringMatching(/^[0-9a-f]{16}$/u) });
    const refused = await b.call('/api/status');
    expect(refused.status).toBe(401);
    expect(refused.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await b.call('/api/login', { json: { password: 'nope' } })).status).toBe(401);
    expect((await b.call('/api/login', { json: 'not json' })).status).toBe(401);
    expect((await b.call('/api/login', { json: { password: 1 } })).status).toBe(401);
    expect(seen).toEqual([]);

    const ok = await b.call('/api/login', { json: { password: PASSWORD } });
    expect(ok.status).toBe(200);
    const set = ok.headers.get('set-cookie') ?? '';
    expect(set).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=[\\w-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000$`,
        'u'
      )
    );
    expect(await (await b.call('/api/session')).json()).toEqual({
      authenticated: true,
      boot: first.boot,
    });
    expect(await (await b.call('/api/status')).json()).toEqual({ ok: true });
    await b.call('/api/plugins/a%20b/mode', { json: { mode: 'live' } });
    await b.call('/api/events?limit=5');
    await b.call('/api');
    expect(seen).toEqual([
      'GET /status',
      'POST /plugins/a%20b/mode',
      'GET /events?limit=5',
      'GET /',
    ]);

    const out = await b.call('/api/logout', { json: {} });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await b.call('/api/status')).status).toBe(401);
  });

  it('keeps the login across a restart, ends it at its logout, and at a new password', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'web-data-'));
    const store = () => new Stores(data).open(CORE_STORE);
    const api: http.RequestListener = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    const first = await serve(
      webHandler({ password: PASSWORD, dist: dist(), api, store: store() })
    );
    const b = browser(first);
    await b.call('/api/login', { json: { password: PASSWORD } });
    const before = (await (await b.call('/api/session')).json()) as { boot: string };
    // The next process, on the same data volume: logged in still, another boot.
    const second = await serve(
      webHandler({ password: PASSWORD, dist: dist(), api, store: store() })
    );
    const again = browser(second);
    const cookie = b.cookie();
    const res = await fetch(`${second}/api/status`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const now = (await (await fetch(`${second}/api/session`, { headers: { cookie } })).json()) as {
      authenticated: boolean;
      boot: string;
    };
    expect(now.authenticated).toBe(true);
    expect(now.boot).not.toBe(before.boot);
    // A second login, then one logout: the other session stays.
    await again.call('/api/login', { json: { password: PASSWORD } });
    await again.call('/api/logout', { json: {} });
    expect((await fetch(`${second}/api/status`, { headers: { cookie } })).status).toBe(200);
    // A new password ends every session.
    const third = await serve(
      webHandler({ password: 'another long password', dist: dist(), api, store: store() })
    );
    expect((await fetch(`${third}/api/status`, { headers: { cookie } })).status).toBe(401);
  });

  it('refuses a POST or a PUT from another origin, or not JSON', async () => {
    const base = await serve(webHandler({ password: PASSWORD, dist: dist(), api: () => {} }));
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/login`, {
        method: 'POST',
        body: JSON.stringify({ password: PASSWORD }),
        headers,
      });
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect(
      (await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status
    ).toBe(403);
    expect(
      (await post({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status
    ).toBe(403);
    expect(
      (await post({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' })).status
    ).toBe(200);
    expect((await post({ 'content-type': 'application/json' })).status).toBe(200);
    // A PUT (the graph's file) is held to the same.
    const put = await fetch(`${base}/api/graph/file`, {
      method: 'PUT',
      body: '{}',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    });
    expect(put.status).toBe(403);
  });

  it('marks the cookie Secure behind HTTPS', async () => {
    const base = await serve(webHandler({ password: PASSWORD, dist: dist(), api: () => {} }));
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    });
    expect(res.headers.get('set-cookie')).toMatch(/; Secure$/u);
  });

  it('limits failed logins, and lets the owner in once the window passed', async () => {
    let now = 0;
    const base = await serve(
      webHandler({
        password: PASSWORD,
        dist: dist(),
        api: () => {},
        now: () => now,
        maxFailures: 2,
        windowMs: 60_000,
        sessionMs: 1000,
      })
    );
    const b = browser(base);
    for (let i = 0; i < 2; i++)
      expect((await b.call('/api/login', { json: { password: 'x' } })).status).toBe(401);
    const limited = await b.call('/api/login', { json: { password: PASSWORD } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ retryAfterS: 60 });
    now = 60_000;
    const ok = await b.call('/api/login', { json: { password: PASSWORD } });
    expect(ok.headers.get('set-cookie')).toContain('Max-Age=1');
    now += 1000;
    expect(await (await b.call('/api/session')).json()).toMatchObject({ authenticated: false });
  });

  it('refuses a login body too large', async () => {
    const base = await serve(webHandler({ password: PASSWORD, dist: dist(), api: () => {} }));
    const res = await browser(base).call('/api/login', {
      json: { password: 'x'.repeat(5000) },
    });
    expect(res.status).toBe(401);
  });

  it('serves the built app, index.html for any other path, assets cached', async () => {
    const base = await serve(webHandler({ password: PASSWORD, dist: dist(), api: () => {} }));
    const index = await fetch(`${base}/`);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('<title>UI</title>');
    const js = await fetch(`${base}/assets/app-1234.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/blob`)).headers.get('content-type')).toBe(
      'application/octet-stream'
    );
    expect(await (await fetch(`${base}/plugins`)).text()).toContain('<title>UI</title>');
    expect(await (await fetch(`${base}/assets`)).text()).toContain('<title>UI</title>');
    expect(await (await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).text()).toContain(
      '<title>UI</title>'
    );
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('says when the app is not built', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'web-empty-'));
    const base = await serve(webHandler({ password: PASSWORD, dist: empty, api: () => {} }));
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build');
  });

  it('carries the core’s control API, its routes unchanged', async () => {
    const core = new Core({ clock: new VirtualClock(0) });
    core.register(fakeConnectorPlugin('chat', new FakeConnector({ account: 'chat:me' })));
    await core.start();
    const base = await serve(
      webHandler({
        password: PASSWORD,
        dist: dist(),
        api: controlHandler({ controls: core.controls, settings: core.settings }),
      })
    );
    const b = browser(base);
    await b.call('/api/login', { json: { password: PASSWORD } });
    expect(await (await b.call('/api/accounts')).json()).toMatchObject([
      { id: 'chat', account: 'chat:me' },
    ]);
    expect(await (await b.call('/api/off', { json: {} })).json()).toEqual({
      off: true,
      result: 'off',
    });
    await core.stop();
  });
});

describe('startWebUi', () => {
  const secrets = (password?: string) => ({
    read: (name: string) => (name === WEB_SECRET ? password : undefined),
  });

  it('serves nothing without the password, or with one too short (fail closed)', () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(startWebUi({ secrets: secrets(), api: () => {}, port: 0, print })).toBeUndefined();
    expect(
      startWebUi({ secrets: secrets('short'), api: () => {}, port: 0, print })
    ).toBeUndefined();
    expect(lines).toEqual([
      'web UI: off (no web_ui_password secret)',
      'web UI: off (the web_ui_password secret is shorter than 12 characters)',
    ]);
    expect(passwordRefusal('')).toBe('no web_ui_password secret');
    expect(passwordRefusal(PASSWORD)).toBeUndefined();
  });

  it('listens with the password', async () => {
    const lines: string[] = [];
    const server = startWebUi({
      secrets: secrets(PASSWORD),
      api: () => {},
      port: 0,
      host: '127.0.0.1',
      dist: dist(),
      store: new Stores(fs.mkdtempSync(path.join(os.tmpdir(), 'web-data-'))).open(CORE_STORE),
      now: () => 0,
      print: (l) => lines.push(l),
    });
    expect(server).toBeDefined();
    if (server === undefined) return;
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as { port: number };
    expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(401);
    expect(lines).toEqual(['web UI: on port 0']);
    expect(DIST).toMatch(/packages[/\\]web[/\\]dist$/u);
  });
});
