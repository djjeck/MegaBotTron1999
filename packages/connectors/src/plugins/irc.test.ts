import {
  type BusEvent,
  type ConnectorStatus,
  Core,
  type Inbound,
  type Plugin,
  VirtualClock,
} from '@megabottron1999/core';
import { secretsWith } from '@megabottron1999/core/test/secrets.ts';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type IrcClientOptions } from '#src/transport/irc-client.ts';
import { type ChannelLine, type TransportEvents, transportOver } from '#src/transport/transport.ts';
import { IRC_CONFIG, IRC_OPTIONS, IRC_SECRETS } from '#test/irc.ts';
import { healthServer, IrcConnector, ircPlugin } from './irc.ts';

/** An IRC connector on a fake client: what it was told, and its events to play. */
function fake() {
  const calls: string[] = [];
  let events: TransportEvents | undefined;
  let connected = true;
  const connector = new IrcConnector(IRC_OPTIONS, (e) => {
    events = e;
    return {
      start: () => calls.push('start'),
      say: (text) => {
        calls.push(`say ${text}`);
        return connected;
      },
      stop: () => calls.push('stop'),
    };
  });
  return {
    connector,
    calls,
    events: () => events as TransportEvents,
    disconnect: () => {
      connected = false;
    },
  };
}

const line = (text: string, playback = false): ChannelLine => ({
  nick: 'GameBot',
  text,
  time: 1000,
  playback,
});

describe('IrcConnector', () => {
  it('is one account, connected once however often started', () => {
    const f = fake();
    expect(f.connector.account).toBe('irc:alice');
    expect(f.connector.network).toBe('irc');
    f.connector.start();
    f.connector.start();
    f.connector.stop();
    f.connector.stop();
    f.connector.start();
    expect(f.calls).toEqual(['start', 'stop', 'start']);
  });

  it('hands out the channel’s lines as messages of its account, and its statuses', () => {
    const f = fake();
    const seen: Inbound[] = [];
    const statuses: ConnectorStatus[] = [];
    f.connector.onMessage((m) => seen.push(m));
    const stop = f.connector.onStatus((s) => statuses.push(s));
    expect(f.connector.status()).toEqual({ state: 'closed', phase: 'closed' });
    f.events().status('connecting');
    f.events().status('registered');
    f.events().status('joined');
    f.events().line(line('hello', true));
    stop();
    f.events().status('closed', 'ECONNRESET');
    expect(statuses).toEqual([
      { state: 'connecting', phase: 'connecting' },
      { state: 'connecting', phase: 'registered' },
      { state: 'connected', phase: 'joined' },
    ]);
    expect(f.connector.status()).toEqual({
      state: 'closed',
      phase: 'closed',
      detail: 'ECONNRESET',
    });
    expect(seen).toEqual([
      {
        account: 'irc:alice',
        network: 'irc',
        chat: '#lobby',
        sender: 'GameBot',
        text: 'hello',
        time: 1000,
        playback: true,
      },
    ]);
  });

  it('sends only to its channel, and says when it cannot', () => {
    const f = fake();
    expect(f.connector.send('#LOBBY', '!profile')).toBe(true);
    expect(f.connector.send('#other', '!profile')).toBe(false);
    f.disconnect();
    expect(f.connector.send('#lobby', '!house')).toBe(false);
    expect(f.calls).toEqual(['say !profile', 'say !house']);
  });

  it('makes a real IRC client by default, which does not connect until started', () => {
    expect(new IrcConnector(IRC_OPTIONS).status().state).toBe('closed');
  });
});

describe('the irc plugin in the core', () => {
  it('makes its connector from its configuration, started and stopped with the core', async () => {
    const calls: string[] = [];
    const given: IrcClientOptions[] = [];
    let got: unknown;
    const reader: Plugin = {
      manifest: {
        id: 'reader',
        version: '0.1.0',
        kinds: ['parser'],
        description: 'reads irc',
        requires: ['irc'],
        reach: [{ connector: 'irc', reads: ['#lobby'] }],
      },
      create: (ctx) => {
        got = ctx.connector('irc');
        expect(() => ctx.connector('other')).toThrow('reader has no reach on other');
        return {};
      },
    };
    const core = new Core({
      clock: new VirtualClock(),
      config: { irc: IRC_CONFIG },
      secrets: secretsWith(IRC_SECRETS),
    });
    core.register(
      ircPlugin({
        nick: 'alice',
        client: (options) => {
          given.push(options);
          return {
            start: () => calls.push('start'),
            say: () => true,
            stop: () => calls.push('stop'),
          };
        },
      }),
      reader
    );
    await core.start();
    expect(calls).toEqual(['start']);
    expect(given[0]).toMatchObject({
      host: 'znc',
      password: 'secret-znc-password',
      channel: '#lobby',
    });
    expect(Object.keys(got as object).sort()).toEqual([
      'account',
      'network',
      'onMessage',
      'onStatus',
      'self',
      'status',
    ]);
    expect((got as { self(): string }).self()).toBe('alice');
    const connector = core.connector('irc');
    expect(connector?.account).toBe('irc:alice');
    expect(connector?.limits).toEqual({ minIntervalMs: 3000, maxPerHour: 60 });
    expect(core.connector('reader')).toBeUndefined();
    expect(core.connector('nobody')).toBeUndefined();
    await core.stop();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('fails the start for a bad configuration, naming the plugin and the key', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      config: { irc: { ...IRC_CONFIG, port: 0, channel: 'lobby' } },
      secrets: secretsWith(IRC_SECRETS),
    });
    core.register(ircPlugin({ nick: 'alice' }));
    await expect(core.start()).rejects.toThrow(
      /^plugin irc: config port: .*\nplugin irc: config channel: expected a channel, such as #lobby$/su
    );
  });

  it('runs on its node’s account, from its config alone', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith(IRC_SECRETS),
      graph: {
        version: 2,
        nodes: [{ id: 'net', plugin: 'irc', account: 'irc:bob', config: IRC_CONFIG }],
        edges: [],
      },
    });
    core.register(
      ircPlugin({ client: () => ({ start: () => {}, stop: () => {}, say: () => true }) })
    );
    await core.start();
    expect(core.connector('net')?.account).toBe('irc:bob');
    expect(core.available()[0]).toMatchObject({ id: 'irc' });
    await core.stop();
  });

  it('makes a real IRC client without one given, which connects only once started', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      config: { irc: IRC_CONFIG },
      secrets: secretsWith(IRC_SECRETS),
    });
    core.register(ircPlugin({ nick: 'alice' }));
    core.load();
    expect(core.status()).toEqual([{ id: 'irc', state: 'registered' }]);
  });
});

describe('transportOver', () => {
  it('gives the client the lines of one chat and the statuses, and says through the connector', () => {
    const f = fake();
    const lines: ChannelLine[] = [];
    const statuses: [string, string | undefined][] = [];
    f.connector.start();
    f.events().status('connecting');
    const transport = transportOver(
      f.connector,
      '#lobby'
    )({
      line: (l) => lines.push(l),
      status: (s, d) => statuses.push([s, d]),
    });
    transport.start();
    f.events().status('joined');
    f.events().line(line('in the channel'));
    expect(transport.say('!profile')).toBe(true);
    transport.stop();
    f.events().line(line('after stop'));
    expect(statuses).toEqual([
      ['connecting', undefined],
      ['joined', undefined],
    ]);
    expect(lines.map((l) => l.text)).toEqual(['in the channel']);
    expect(f.calls).toContain('say !profile');
  });

  it('replays no status while closed, and keeps to its chat', () => {
    const f = fake();
    const lines: string[] = [];
    const statuses: string[] = [];
    const transport = transportOver(
      f.connector,
      '#elsewhere'
    )({
      line: (l) => lines.push(l.text),
      status: (s) => statuses.push(s),
    });
    transport.start();
    f.events().line(line('in #lobby'));
    expect(statuses).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('the irc plugin’s secret', () => {
  it('fails the start when the ZNC password is not provided, naming it', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      config: { irc: IRC_CONFIG },
      secrets: secretsWith({}),
    });
    core.register(ircPlugin({ nick: 'alice' }));
    await expect(core.start()).rejects.toThrow(
      /^plugin irc: the secret znc_password is not provided \(.*\/znc_password\)$/u
    );
    const none = new Core({ clock: new VirtualClock(), config: { irc: IRC_CONFIG } });
    none.register(ircPlugin({ nick: 'alice' }));
    expect(() => none.load()).toThrow('(no secrets/znc_password)');
  });
});

describe('healthServer', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('answers 200 while connected, 503 when not, 404 elsewhere', async () => {
    const health = { connected: false };
    server = healthServer(() => health);
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
    expect((await get('/health')).status).toBe(503);
    health.connected = true;
    const ok = await get('/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ connected: true });
    expect((await get('/')).status).toBe(404);
  });
});

describe('the irc plugin’s records and health', () => {
  it('logs every line and step as irc.*, prints the steps, and serves the health', async () => {
    let events: TransportEvents | undefined;
    const records: BusEvent[] = [];
    const lines: string[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      config: { irc: { ...IRC_CONFIG, healthPort: 0 } },
      secrets: secretsWith(IRC_SECRETS),
      record: (r) => records.push(r as BusEvent),
      print: (l) => lines.push(l),
      validateEvents: true,
    });
    core.register(
      ircPlugin({
        nick: 'alice',
        client: (_options, e) => {
          events = e;
          return { start: () => e.status('connecting'), say: () => true, stop() {} };
        },
      })
    );
    await core.start();
    events?.status('joined');
    events?.line(line('played back', true));
    events?.line({ ...line('live'), time: 2000 });
    events?.status('closed', 'ECONNRESET');
    expect(records.filter((r) => r.type.startsWith('irc.'))).toEqual([
      { type: 'irc.status', t: 0, instance: 'irc', status: 'connecting' },
      { type: 'irc.status', t: 0, instance: 'irc', status: 'joined' },
      {
        type: 'irc.line',
        t: 1000,
        instance: 'irc',
        nick: 'GameBot',
        text: 'played back',
        playback: true,
      },
      {
        type: 'irc.line',
        t: 2000,
        instance: 'irc',
        nick: 'GameBot',
        text: 'live',
        playback: false,
      },
      { type: 'irc.status', t: 0, instance: 'irc', status: 'closed', detail: 'ECONNRESET' },
    ]);
    expect(lines).toEqual(['irc: connecting', 'irc: joined', 'irc: closed (ECONNRESET)']);
    await core.stop();
  });
});
