import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { type Connector, ConnectorBase } from './connector.ts';
import { Core } from './core.ts';
import {
  FloodWait,
  isMode,
  Modes,
  modesIn,
  Outbox,
  type SenderPolicy,
  type SendRecord,
} from './outbox.ts';
import { Stores } from './store.ts';

/** A connector whose sends answer later, as Telegram's do. */
class LaterConnector extends ConnectorBase implements Connector {
  answers: (() => Promise<{ id?: string }>)[] = [];
  formats: (string | undefined)[] = [];
  constructor() {
    super('test:me', 'test');
    this.changed({ state: 'connected', phase: 'up' });
  }
  send(): boolean {
    return true;
  }
  deliver(_chat: string, _text: string, options?: { format?: string }): Promise<{ id?: string }> {
    this.formats.push(options?.format);
    return (this.answers.shift() ?? (() => Promise.resolve({})))();
  }
  down(): void {
    this.changed({ state: 'connecting', phase: 'retry' });
  }
}

class FakeConnector extends ConnectorBase implements Connector {
  sent: string[] = [];
  up = true;
  flood: number | undefined;
  send(chat: string, text: string): boolean {
    if (this.flood !== undefined) {
      const ms = this.flood;
      this.flood = undefined;
      throw new FloodWait(ms);
    }
    if (!this.up) return false;
    this.sent.push(`${chat} ${text}`);
    return true;
  }
}

function setup(o: { policy?: SenderPolicy; limits?: boolean } = {}) {
  const clock = new VirtualClock(0);
  const connector = new FakeConnector('test:me', 'test');
  const modes = new Modes();
  const records: SendRecord[] = [];
  const outbox = new Outbox({
    account: 'test:me',
    connector: () => connector,
    ...(o.limits === false ? {} : { limits: () => ({ minIntervalMs: 3000, maxPerHour: 3 }) }),
    clock,
    modes,
    ...(o.policy === undefined ? {} : { policy: () => o.policy as SenderPolicy }),
    record: (r) => (r.type === 'core.send' ? records.push(r) : undefined),
  });
  modes.set('p', 'live');
  return { clock, connector, modes, records, outbox, p: outbox.as('p') };
}

describe('Modes', () => {
  it('start read-only, are kept, and only the owner raises them', () => {
    const stores = new Stores();
    const modes = new Modes(modesIn(stores.open('core')));
    const changes: string[] = [];
    modes.onChange((p, m) => changes.push(`${p} ${m}`));
    expect(modes.get('p')).toBe('read-only');
    expect(modes.set('p', 'live')).toBeUndefined();
    expect(modes.set('p', 'dry-run', 'safety')).toBe('only the owner raises a mode');
    expect(modes.set('p', 'read-only', 'safety')).toBeUndefined();
    expect(modes.set('p', 'on' as never)).toBe('not a mode: on');
    modes.set('q', 'dry-run');
    expect(new Modes(modesIn(stores.open('core'))).get('q')).toBe('dry-run');
    expect(new Modes(modesIn(stores.open('core'))).get('p')).toBe('read-only');
    expect(changes).toEqual(['p live', 'p read-only', 'q dry-run']);
    expect([isMode('live'), isMode('on')]).toEqual([true, false]);
    expect([modes.has('q'), modes.has('nobody')]).toEqual([true, false]);
  });
});

describe('deliver', () => {
  function later() {
    const clock = new VirtualClock(0);
    const connector = new LaterConnector();
    const modes = new Modes();
    const records: SendRecord[] = [];
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      limits: () => ({ minIntervalMs: 3000, maxPerHour: 3 }),
      clock,
      modes,
      record: (r) => (r.type === 'core.send' ? records.push(r) : undefined),
    });
    modes.set('p', 'live');
    return { clock, connector, modes, records, p: outbox.as('p') };
  }

  it("waits for the network's answer, with the message's id, and logs it once", async () => {
    const { connector, records, p } = later();
    connector.answers.push(() => Promise.resolve({ id: '42' }));
    await expect(p.deliver('#c', '/a')).resolves.toEqual({ text: '/a', outcome: 'sent', id: '42' });
    expect(records).toEqual([
      expect.objectContaining({ type: 'core.send', outcome: 'sent', id: '42', chat: '#c' }),
    ]);
  });

  it('hands the connector the format of a Markdown text, and nothing for a plain one', async () => {
    const { clock, connector, p } = later();
    await p.deliver('#c', '**a**', { format: 'markdown' });
    clock.advance(5000);
    await p.deliver('#c', 'b');
    expect(connector.formats).toEqual(['markdown', undefined]);
  });

  it('counts a send when it leaves, so two at once keep to the limits', async () => {
    const { connector, p } = later();
    let answer: (v: { id?: string }) => void = () => {};
    connector.answers.push(() => new Promise((r) => (answer = r)));
    const first = p.deliver('#c', '/a');
    await expect(p.deliver('#c', '/b')).resolves.toMatchObject({ reason: 'too soon' });
    answer({});
    await expect(first).resolves.toEqual({ text: '/a', outcome: 'sent' });
  });

  it('fails a send the network refused, and holds the account on a flood wait', async () => {
    const { clock, connector, records, p } = later();
    connector.answers.push(
      () => Promise.reject(new Error('CHAT_WRITE_FORBIDDEN')),
      () => Promise.reject('no reason')
    );
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'CHAT_WRITE_FORBIDDEN',
    });
    clock.advance(3000);
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({ reason: 'no reason' });
    clock.advance(3000);
    connector.answers.push(() => Promise.reject(new FloodWait(60_000)));
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'flood wait of 60 s',
    });
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({ reason: 'flood wait, 60 s more' });
    expect(records.map((r) => r.outcome)).toEqual(['failed', 'failed', 'refused', 'refused']);
  });

  it('refuses as send does, and dry runs stop before the network', async () => {
    const { connector, modes, p } = later();
    modes.set('p', 'read-only');
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({ reason: 'read-only' });
    modes.set('p', 'dry-run');
    await expect(p.deliver('#c', '/a')).resolves.toEqual({ text: '/a', outcome: 'dry-run' });
    modes.set('p', 'live');
    connector.down();
    await expect(p.deliver('#d', '/a')).resolves.toMatchObject({ reason: 'too soon' });
  });

  it('refuses while the connector is not connected', async () => {
    const { connector, p } = later();
    connector.down();
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({ reason: 'not connected' });
  });

  it("sends through a connector's send where it has no deliver", async () => {
    const { connector, p } = setup();
    await expect(p.deliver('#c', '!a')).resolves.toEqual({ text: '!a', outcome: 'sent' });
    connector.up = false;
    await expect(p.deliver('#c', '!b')).resolves.toMatchObject({ reason: 'too soon' });
  });
});

describe('Outbox.send', () => {
  it('sends in live, logging every attempt with who sent it', () => {
    const { p, connector, records } = setup();
    expect(p.send('#c', '!roll Bob', { origin: 'strategy' })).toEqual({
      text: '!roll Bob',
      outcome: 'sent',
    });
    expect(connector.sent).toEqual(['#c !roll Bob']);
    expect(records).toEqual([
      {
        type: 'core.send',
        t: 0,
        plugin: 'p',
        account: 'test:me',
        chat: '#c',
        origin: 'strategy',
        mode: 'live',
        text: '!roll Bob',
        outcome: 'sent',
      },
    ]);
    expect(p.account).toBe('test:me');
    expect(p.mode()).toBe('live');
  });

  it('checks in order: the caller, the reach, the mode, a pause', () => {
    const reach = { sends: ['#c'], commands: ['!roll'] };
    const a = setup({ policy: { reach } });
    expect(a.p.send('#c', '!roll x', { refuse: 'not a game command' }).reason).toBe(
      'not a game command'
    );
    expect(a.p.send('#other', '!roll x').reason).toBe('p does not send to #other');
    expect(a.p.send('#c', '!nuke x').reason).toBe("!nuke is not among p's commands");
    a.modes.set('p', 'read-only');
    expect(a.p.send('#c', '!roll x').reason).toBe('read-only');
    const b = setup({ policy: { reach: { sends: ['#c'] }, held: 'stopped: drift' } });
    expect(b.p.send('#c', 'anything').reason).toBe('stopped: drift');
    expect(a.records.map((r) => r.origin)).toEqual(['p', 'p', 'p', 'p']);
    expect(a.connector.sent).toEqual([]);
  });

  it('keeps the account’s interval and hourly limit, dry runs counted, refusals not', () => {
    const { p, clock, modes, connector } = setup();
    modes.set('p', 'dry-run');
    expect(p.send('#c', '!a').outcome).toBe('dry-run');
    clock.advanceTo(2999);
    expect(p.send('#c', '!a').reason).toBe('too soon');
    modes.set('p', 'live');
    clock.advanceTo(3000);
    connector.up = false;
    expect(p.send('#c', '!a').reason).toBe('not connected');
    connector.up = true;
    expect(p.send('#c', '!a').outcome).toBe('sent');
    clock.advanceTo(6000);
    p.send('#c', '!a');
    clock.advanceTo(9000);
    expect(p.send('#c', '!a').reason).toBe('hourly limit');
    clock.advanceTo(3_600_000);
    expect(p.send('#c', '!a').outcome).toBe('sent');
  });

  it('holds the account for a flood wait, and passes other errors on', () => {
    const { p, clock, connector } = setup({ limits: false });
    connector.flood = 30_000;
    expect(p.send('#c', '!a').reason).toBe('flood wait of 30 s');
    clock.advance(10_000);
    expect(p.send('#c', '!a').reason).toBe('flood wait, 20 s more');
    clock.advance(20_000);
    expect(p.send('#c', '!a').outcome).toBe('sent');
    connector.send = () => {
      throw new Error('boom');
    };
    expect(() => p.send('#c', '!a')).toThrow('boom');
  });

  it('refuses without a connector', () => {
    const modes = new Modes();
    modes.set('p', 'live');
    const outbox = new Outbox({
      account: 'a:b',
      connector: () => undefined,
      clock: new VirtualClock(),
      modes,
    });
    expect(outbox.send('p', '#c', 'x').reason).toBe('not connected');
  });
});

describe('Outbox.enqueue', () => {
  it('spaces the queue within the limits, and waits out the hour', async () => {
    const { p, clock, connector, records, outbox } = setup();
    const all = ['!1', '!2', '!3', '!4'].map((t) => p.enqueue('#c', t));
    expect(outbox.waiting).toBe(3);
    expect(connector.sent).toEqual(['#c !1']);
    clock.advance(3000);
    clock.advance(3000);
    expect(connector.sent).toHaveLength(3);
    clock.advanceTo(3_600_000);
    expect((await Promise.all(all)).map((r) => r.outcome)).toEqual([
      'sent',
      'sent',
      'sent',
      'sent',
    ]);
    expect(records.map((r) => `${r.text} ${r.t}`)).toEqual([
      '!1 0',
      '!2 3000',
      '!3 6000',
      '!4 3600000',
    ]);
  });

  it('refuses at once what can never go now, and waits out a flood', async () => {
    const { p, clock, connector, modes } = setup({ limits: false });
    modes.set('p', 'read-only');
    expect((await p.enqueue('#c', '!a')).reason).toBe('read-only');
    modes.set('p', 'live');
    connector.flood = 5000;
    expect((await p.enqueue('#c', '!a')).reason).toBe('flood wait of 5 s');
    const later = p.enqueue('#c', '!b');
    clock.advance(5000);
    expect((await later).outcome).toBe('sent');
  });
});

describe('the outboxes of the core', () => {
  /** A connector plugin on `connector`, and a plugin that sends through it if `reach`. */
  function plugins(connector: FakeConnector, seen: { handle?: unknown; error?: unknown }) {
    const conn = {
      manifest: {
        id: 'conn',
        version: '0.1.0',
        kinds: ['connector' as const],
        description: 'conn',
        account: 'test:me',
      },
      create: () => ({ connector }),
    };
    const actor = (id: string, reach: boolean) => ({
      manifest: {
        id,
        version: '0.1.0',
        kinds: ['actor' as const],
        description: id,
        requires: ['conn'],
        ...(reach ? { reach: [{ connector: 'conn', sends: ['#c'], commands: ['!a'] }] } : {}),
      },
      create: (ctx: { outbox(a: string): unknown }) => {
        try {
          seen.handle = ctx.outbox('test:me');
        } catch (e) {
          seen.error = e;
        }
        return {};
      },
    });
    return { conn, actor };
  }

  it('give each plugin its way out within its reach, a dry run by its edge, and its state', async () => {
    const connector = new FakeConnector('test:me', 'test');
    const seen: { handle?: unknown; error?: unknown } = {};
    const { conn, actor } = plugins(connector, seen);
    const records: { type: string }[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      record: (r) => records.push(r),
      // The sender's edge a dry run (D64).
      graph: (g) => ({
        ...g,
        edges: g.edges.map((e) => (e.type === 'chat-out' ? { ...e, dryRun: true } : e)),
      }),
    });
    const early = core.outbox('test:me');
    expect(early.send('sender', '#c', '!a').reason).toBe('sender does not send to #c');
    core.register(conn, actor('sender', true), actor('stranger', false));
    await core.start();
    expect(core.outbox('test:me')).toBe(early);
    const handle = seen.handle as ReturnType<Outbox['as']>;
    expect(handle.mode()).toBe('dry-run');
    expect(handle.send('#c', '!a').outcome).toBe('dry-run');
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'core.send', mode: 'dry-run', outcome: 'dry-run' })
    );
    expect(handle.send('#c', '!b').reason).toBe("!b is not among sender's commands");
    expect(String(seen.error)).toContain('stranger has no reach on the account test:me');
    expect(early.send('stranger', '#c', '!a').reason).toBe('stranger does not send to #c');
    core.stopNode('sender', 'drift', 'drift');
    expect(handle.send('#c', '!a').reason).toBe('stopped: drift');
    await core.stop();
    expect(handle.send('#c', '!a').reason).toBe('not running (stopped)');
    expect(core.outbox('nobody:here').send('sender', '#c', '!a').reason).toBe(
      'sender does not send to #c'
    );
    expect(records.filter((r) => r.type === 'core.send')).toHaveLength(7);
    expect(connector.sent).toEqual([]);
  });
});
