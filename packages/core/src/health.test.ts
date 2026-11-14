import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { type AccountControl } from './controls.ts';
import { Core } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { health, healthServer, type HealthSource } from './health.ts';

const source = (accounts: AccountControl[], off = false): HealthSource => ({
  off,
  accounts: () => accounts,
});

const connected = (id: string): AccountControl => ({
  id,
  plugin: 'chat',
  account: 'chat:me',
  state: 'running',
  network: 'chat',
  connection: { state: 'connected', phase: 'connected' },
});

describe('health', () => {
  it('is ok with every enabled connector connected, and says each one, no account', () => {
    const h = health(source([connected('a'), connected('b')]), 12);
    expect(h).toEqual({
      ok: true,
      uptimeS: 12,
      on: true,
      connectors: [
        { id: 'a', plugin: 'chat', status: 'connected', counted: true },
        { id: 'b', plugin: 'chat', status: 'connected', counted: true },
      ],
    });
    expect(JSON.stringify(h)).not.toContain('chat:me');
    expect(health(source([]), 0).ok).toBe(true);
  });

  it('is not ok with a connector connecting, closed or failed', () => {
    const connecting: AccountControl = {
      ...connected('b'),
      connection: { state: 'connecting', phase: 'dialing' },
    };
    expect(health(source([connected('a'), connecting]), 1).ok).toBe(false);
    const failed: AccountControl = { id: 'c', plugin: 'chat', state: 'failed', reason: 'no token' };
    const h = health(source([failed]), 1);
    expect(h.ok).toBe(false);
    expect(h.connectors).toEqual([{ id: 'c', plugin: 'chat', status: 'failed', counted: true }]);
  });

  it('leaves out a connector the owner set aside, and says the instance off without counting it', () => {
    const disabled: AccountControl = { id: 'd', plugin: 'chat', state: 'disabled' };
    const stopped: AccountControl = {
      ...connected('s'),
      state: 'stopped',
      connection: { state: 'closed', phase: 'closed' },
    };
    const h = health(source([connected('a'), disabled, stopped], true), 1);
    expect(h.ok).toBe(true);
    expect(h.on).toBe(false);
    expect(h.connectors.map((c) => [c.id, c.status, c.counted])).toEqual([
      ['a', 'connected', true],
      ['d', 'disabled', false],
      ['s', 'closed', false],
    ]);
  });
});

describe('healthServer', () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('answers GET /health from the core: 503 until the connector connects, then 200', async () => {
    const chat = new FakeConnector({ account: 'chat:me' });
    const core = new Core({ clock: new VirtualClock(1000) });
    core.register(fakeConnectorPlugin('chat', chat));
    core.load();
    await core.start();
    server = healthServer(core.controls, () => 7);
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    chat.close();
    const down = await fetch(`${base}/health`);
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('no-store');
    expect(await down.json()).toEqual({
      ok: false,
      uptimeS: 7,
      on: true,
      connectors: [{ id: 'chat', plugin: 'chat', status: 'closed', counted: true }],
    });
    chat.open();
    const up = await fetch(`${base}/health?probe=1`);
    expect(up.status).toBe(200);
    expect(((await up.json()) as { ok: boolean }).ok).toBe(true);
    const head = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${base}/status`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
    await core.stop();
  });

  it('counts on the process uptime by default', async () => {
    server = healthServer(source([]));
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const h = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      uptimeS: number;
    };
    expect(h.uptimeS).toBeGreaterThanOrEqual(0);
  });
});
