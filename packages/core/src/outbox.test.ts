import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { type Connector, ConnectorBase } from './connector.ts';
import { Core } from './core.ts';
import { type Notice } from './notices.ts';
import {
  CONNECT_WAIT_MS,
  DEFAULT_UNANSWERED_AT,
  FloodWait,
  type Limits,
  Outbox,
  type OutboxHandle,
  type QueuedSend,
  type SenderPolicy,
  type SendRecord,
  unreachableHint,
} from './outbox.ts';

/** A connector whose sends answer later, as Telegram's do. */
class LaterConnector extends ConnectorBase implements Connector {
  answers: (() => Promise<{ id?: string }>)[] = [];
  formats: (string | undefined)[] = [];
  buttons: unknown[] = [];
  constructor() {
    super('test:me', 'test');
    this.changed({ state: 'connected', phase: 'up' });
  }
  send(): boolean {
    return true;
  }
  deliver(
    _chat: string,
    _text: string,
    options?: { format?: string; buttons?: unknown }
  ): Promise<{ id?: string }> {
    this.formats.push(options?.format);
    if (options?.buttons !== undefined) this.buttons.push(options.buttons);
    return (this.answers.shift() ?? (() => Promise.resolve({})))();
  }
  down(): void {
    this.changed({ state: 'connecting', phase: 'retry' });
  }
  up(): void {
    this.changed({ state: 'connected', phase: 'up' });
  }
}

class FakeConnector extends ConnectorBase implements Connector {
  sent: string[] = [];
  up = true;
  flood: number | undefined;
  buttons: unknown[] = [];
  send(chat: string, text: string, options?: { buttons?: unknown }): boolean {
    if (options?.buttons !== undefined) this.buttons.push(options.buttons);
    if (this.flood !== undefined) {
      const ms = this.flood;
      this.flood = undefined;
      throw new FloodWait(ms);
    }
    if (!this.up) return false;
    this.sent.push(`${chat} ${text}`);
    return true;
  }
  /** Its connection's state, as a connector tells it. */
  connecting(state: 'connecting' | 'connected' | 'closed'): void {
    this.up = state === 'connected';
    this.changed({ state, phase: state });
  }
}

/**
 * Each sender's policy, as the core's edges and stops make it, changed as a test goes: anything,
 * live (none set); a dry run to `#c` and `#d`; or held, with why.
 */
class Senders {
  private readonly of = new Map<string, SenderPolicy>();
  private readonly base: SenderPolicy;
  constructor(base: SenderPolicy = {}) {
    this.base = base;
  }
  live(plugin: string): void {
    this.of.delete(plugin);
  }
  dryRun(plugin: string): void {
    this.of.set(plugin, { reach: { sends: ['#c', '#d'], dryRun: true } });
  }
  hold(plugin: string, why: string): void {
    this.of.set(plugin, { ...this.base, held: why });
  }
  readonly policy = (plugin: string): SenderPolicy => this.of.get(plugin) ?? this.base;
}

function setup(o: { policy?: SenderPolicy; limits?: boolean } = {}) {
  const clock = new VirtualClock(0);
  const connector = new FakeConnector('test:me', 'test');
  const senders = new Senders(o.policy);
  const records: SendRecord[] = [];
  const outbox = new Outbox({
    account: 'test:me',
    connector: () => connector,
    ...(o.limits === false ? {} : { limits: () => ({ minIntervalMs: 3000, maxPerHour: 3 }) }),
    clock,
    policy: senders.policy,
    record: (r) => (r.type === 'core.send' ? records.push(r) : undefined),
  });
  return { clock, connector, senders, records, outbox, p: outbox.as('p') };
}

describe('deliver', () => {
  function later() {
    const clock = new VirtualClock(0);
    const connector = new LaterConnector();
    const senders = new Senders();
    const records: SendRecord[] = [];
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      limits: () => ({ minIntervalMs: 3000, maxPerHour: 3 }),
      clock,
      policy: senders.policy,
      record: (r) => (r.type === 'core.send' ? records.push(r) : undefined),
    });
    return { clock, connector, senders, records, p: outbox.as('p') };
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

  it('hands the connector the buttons of a send (D94)', async () => {
    const { connector, p } = later();
    const buttons = [[{ label: 'Go', action: '/go' }]];
    await p.deliver('#c', 'pick', { buttons });
    expect(connector.buttons).toEqual([buttons]);
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
    const { connector, senders, p } = later();
    senders.hold('p', 'stopped: drift');
    await expect(p.deliver('#c', '/a')).resolves.toMatchObject({ reason: 'stopped: drift' });
    senders.dryRun('p');
    await expect(p.deliver('#c', '/a')).resolves.toEqual({ text: '/a', outcome: 'dry-run' });
    senders.live('p');
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

  it('checks in order: the caller, the reach, a pause', () => {
    const reach = { sends: ['#c'], commands: ['!roll'] };
    const a = setup({ policy: { reach } });
    expect(a.p.send('#c', '!roll x', { refuse: 'not a game command' }).reason).toBe(
      'not a game command'
    );
    expect(a.p.send('#other', '!roll x').reason).toBe('p does not send to #other');
    expect(a.p.send('#c', '!nuke x').reason).toBe("!nuke is not among p's commands");
    a.senders.hold('p', 'stopped: drift');
    expect(a.p.send('#c', '!roll x').reason).toBe('stopped: drift');
    expect(a.p.send('#other', '!roll x').reason).toBe('p does not send to #other');
    expect(a.records.map((r) => r.origin)).toEqual(['p', 'p', 'p', 'p', 'p']);
    expect(a.connector.sent).toEqual([]);
  });

  it('keeps the account’s interval and hourly limit, dry runs counted, refusals not', () => {
    const { p, clock, senders, connector } = setup();
    senders.dryRun('p');
    expect(p.send('#c', '!a').outcome).toBe('dry-run');
    clock.advanceTo(2999);
    expect(p.send('#c', '!a').reason).toBe('too soon');
    senders.live('p');
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
    const outbox = new Outbox({
      account: 'a:b',
      connector: () => undefined,
      clock: new VirtualClock(),
    });
    expect(outbox.send('p', '#c', 'x').reason).toBe('not connected');
  });
});

describe('Outbox.enqueue', () => {
  it('hands the connector the buttons of a send, and never coalesces one that has them', async () => {
    const { connector, outbox, clock } = setup();
    const buttons = [[{ label: 'Go', action: '/go' }]];
    const q = outbox.as('q');
    const r = outbox.as('r');
    // The account's pace holds the first while the others queue.
    const sends = [
      q.enqueue('#c', 'hold'),
      q.enqueue('#c', 'pick', { buttons }),
      r.enqueue('#c', 'pick'),
      r.enqueue('#c', 'pick', { buttons }),
    ];
    clock.advanceTo(3_600_000);
    expect((await Promise.all(sends)).map((x) => x.outcome)).toEqual([
      'sent',
      'sent',
      'sent',
      'sent',
    ]);
    expect(connector.sent).toEqual(['#c hold', '#c pick', '#c pick', '#c pick']);
    expect(connector.buttons).toEqual([buttons, buttons]);
    // And `send` hands them too.
    clock.advance(3000);
    q.send('#c', 'now', { buttons });
    expect(connector.buttons).toHaveLength(3);
  });

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
    const { p, clock, connector, senders } = setup({ limits: false });
    senders.hold('p', 'stopped: drift');
    expect((await p.enqueue('#c', '!a')).reason).toBe('stopped: drift');
    senders.live('p');
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
        ...(reach
          ? {
              inputs: { conn: { type: 'chat-in' as const, bind: { node: 'conn', reads: [] } } },
              outputs: {
                conn: {
                  type: 'chat-out' as const,
                  bind: { node: 'conn', sends: ['#c'], commands: ['!a'] },
                },
              },
            }
          : { requires: ['conn'] }),
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
  it("hold a queued send from the start until the account's connector connects (D108)", async () => {
    const connector = new FakeConnector('test:me', 'test');
    const { conn } = plugins(connector, {});
    const clock = new VirtualClock(0);
    const core = new Core({ clock });
    let q: QueuedSend | undefined;
    // A sender that queues a send once the instance is up, its connector still connecting.
    core.register(
      {
        manifest: {
          id: 'early',
          version: '0.1.0',
          kinds: ['actor' as const],
          description: 'early',
          inputs: {
            conn: { type: 'chat-in' as const, optional: true, bind: { node: 'conn', reads: [] } },
          },
          outputs: {
            conn: {
              type: 'chat-out' as const,
              optional: true,
              bind: { node: 'conn', sends: ['#c'], commands: ['!a'] },
            },
          },
        },
        create: (ctx: { outbox(a: string): OutboxHandle }) => ({
          ready: () => {
            q = ctx.outbox('test:me').enqueue('#c', '!a');
          },
        }),
      },
      conn
    );
    connector.connecting('connecting');
    await core.start();
    clock.advance(5000);
    expect(q?.status()).toBe('waiting');
    connector.connecting('connected');
    clock.advance(1000);
    await expect(q).resolves.toMatchObject({ outcome: 'sent' });
    expect(connector.sent).toEqual(['#c !a']);
    // Its connector stopped: refused at once, as before.
    core.stopNode('conn', 'by hand', 'drift');
    connector.connecting('closed');
    await expect(core.outbox('test:me').as('early').enqueue('#c', '!a')).resolves.toMatchObject({
      outcome: 'refused',
    });
    await core.stop();
  });
});

describe('the send-queue watchdog (D93)', () => {
  /** An outbox whose senders are all watched, with every pause and notice kept. */
  function watched(
    o: { limits?: Limits; dryRun?: readonly string[]; watch?: (p: string) => boolean } = {}
  ) {
    const clock = new VirtualClock(0);
    const connector = new FakeConnector('test:me', 'test');
    const paused: [string, string][] = [];
    const notices: Omit<Notice, 't'>[] = [];
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      limits: () => o.limits,
      clock,
      policy: (plugin) => ({
        reach: {
          sends: ['#lobby'],
          ...(o.dryRun?.includes(plugin) === true ? { dryRun: true } : {}),
        },
      }),
      watch: (plugin) => o.watch?.(plugin) ?? true,
      pause: (plugin, reason) => paused.push([plugin, reason]),
      notice: (n) => notices.push(n),
    });
    return { clock, connector, outbox, paused, notices };
  }

  it('counts the sends of a command gone unanswered, and pauses the node at the threshold', () => {
    const { connector, outbox, paused, notices } = watched({ limits: { unansweredAt: 3 } });
    const p = outbox.as('p');
    for (let i = 0; i < 3; i++) expect(p.send('#lobby', `/inventory ${i}`).outcome).toBe('sent');
    // Another command, another count.
    expect(p.send('#lobby', '/give alice sword').outcome).toBe('sent');
    const reason = 'stalled: 3 sends of /inventory to #lobby went unanswered';
    expect(p.send('#lobby', '/inventory')).toEqual({
      text: '/inventory',
      outcome: 'refused',
      reason: `stopped: ${reason}`,
    });
    expect(paused).toEqual([['p', reason]]);
    expect(notices).toEqual([
      {
        kind: 'stalled',
        node: 'p',
        text: 'p sent /inventory to #lobby 3 times with no answer read from it; stopped until you clear the stop in the editor',
        detail: { account: 'test:me', chat: '#lobby', command: '/inventory', count: 3, reason },
      },
    ]);
    expect(connector.sent).toHaveLength(4);
  });

  it('starts again once an event is read from the chat, by any of its names', async () => {
    const { outbox, paused } = watched({ limits: { unansweredAt: 2 } });
    const p = outbox.as('p');
    p.send('#lobby', '/inventory');
    p.send('#lobby', '/inventory');
    // Answered, by another of the chat's names, without case.
    outbox.heard({ chat: '-100123', aliases: ['#LOBBY'] });
    p.send('#lobby', '/inventory');
    // Another chat's answer is not this one's.
    outbox.heard({ chat: '#elsewhere' });
    expect((await p.deliver('#lobby', '/inventory')).outcome).toBe('sent');
    expect(paused).toEqual([]);
    expect((await p.deliver('#lobby', '/inventory')).reason).toBe(
      'stopped: stalled: 2 sends of /inventory to #lobby went unanswered'
    );
    expect(paused).toHaveLength(1);
  });

  it('keeps each node its own count, per command its threshold, and may be off', () => {
    const { outbox, paused } = watched({
      limits: { unansweredAt: 2, unansweredAtBy: { '/look': 0, '/turn': 4 } },
    });
    const [p, q] = [outbox.as('p'), outbox.as('q')];
    for (let i = 0; i < 6; i++) expect(p.send('#lobby', '/look').outcome).toBe('sent');
    for (let i = 0; i < 4; i++) expect(p.send('#lobby', '/turn').outcome).toBe('sent');
    expect(p.send('#lobby', '/turn').outcome).toBe('refused');
    p.send('#lobby', '/buy');
    q.send('#lobby', '/buy');
    p.send('#lobby', '/buy');
    expect(q.send('#lobby', '/buy').outcome).toBe('sent');
    expect(paused.map(([node]) => node)).toEqual(['p']);
    expect(p.send('#lobby', '/buy').outcome).toBe('refused');
    // Off for the whole account.
    const off = watched({ limits: { unansweredAt: 0 } });
    for (let i = 0; i < 20; i++) off.outbox.send('p', '#lobby', '/look');
    expect(off.paused).toEqual([]);
  });

  it('defaults to DEFAULT_UNANSWERED_AT, and counts no node it does not watch', () => {
    const { outbox, paused } = watched({ watch: (p) => p === 'p' });
    for (let i = 0; i < DEFAULT_UNANSWERED_AT; i++) outbox.send('p', '#lobby', '/look');
    for (let i = 0; i < 2 * DEFAULT_UNANSWERED_AT; i++) outbox.send('q', '#lobby', '/look');
    expect(paused).toEqual([]);
    expect(outbox.send('p', '#lobby', '/look').outcome).toBe('refused');
    expect(paused.map(([node]) => node)).toEqual(['p']);
  });

  it('never counts a dry run', async () => {
    const { outbox, paused } = watched({ limits: { unansweredAt: 1 }, dryRun: ['p'] });
    const p = outbox.as('p');
    for (let i = 0; i < 5; i++) expect(p.send('#lobby', '/look').outcome).toBe('dry-run');
    expect((await p.deliver('#lobby', '/look')).outcome).toBe('dry-run');
    expect((await p.enqueue('#lobby', '/look')).outcome).toBe('dry-run');
    expect(paused).toEqual([]);
  });

  it('counts each live node of a coalesced send, and refuses the share of one it pauses', async () => {
    const { clock, outbox, paused, connector } = watched({
      limits: { unansweredAt: 2, minIntervalMs: 1000 },
      dryRun: ['d'],
      watch: (node) => node !== 'x',
    });
    const [p, q, d] = [outbox.as('p'), outbox.as('q'), outbox.as('d')];
    /** One send for p, q and d, coalesced while the account's pace holds it. */
    const round = () => {
      outbox.send('x', '#lobby', '/ping');
      const all = Promise.all([
        p.enqueue('#lobby', '/inventory'),
        q.enqueue('#lobby', '/inventory'),
        d.enqueue('#lobby', '/inventory'),
      ]);
      clock.advance(1000);
      return all;
    };
    expect((await round()).map((r) => r.outcome)).toEqual(['sent', 'sent', 'dry-run']);
    expect((await round()).map((r) => r.outcome)).toEqual(['sent', 'sent', 'dry-run']);
    // Both at the threshold: each paused, its share refused; the dry run goes, as a dry run.
    const third = await round();
    expect(third.map((r) => r.outcome)).toEqual(['refused', 'refused', 'dry-run']);
    expect(third[0]?.reason).toBe(
      'stopped: stalled: 2 sends of /inventory to #lobby went unanswered'
    );
    expect(paused.map(([node]) => node)).toEqual(['p', 'q']);
    expect(connector.sent.filter((s) => s.endsWith('/inventory'))).toHaveLength(2);
  });

  it('lets the others of a coalesced send go when it pauses one', async () => {
    const { clock, outbox, paused, connector } = watched({
      limits: { unansweredAt: 1, minIntervalMs: 1000 },
    });
    const [p, q] = [outbox.as('p'), outbox.as('q')];
    expect((await p.enqueue('#lobby', '/inventory')).outcome).toBe('sent');
    const both = Promise.all([
      p.enqueue('#lobby', '/inventory'),
      q.enqueue('#lobby', '/inventory'),
    ]);
    expect(outbox.pending()[0]?.nodes.map((n) => n.plugin)).toEqual(['p', 'q']);
    clock.advance(1000);
    expect((await both).map((r) => r.outcome)).toEqual(['refused', 'sent']);
    expect(paused.map(([node]) => node)).toEqual(['p']);
    expect(connector.sent).toHaveLength(2);
  });
});

describe('a send the network refuses (D95)', () => {
  function refusing(o: { quiet?: boolean } = {}) {
    const clock = new VirtualClock(0);
    const connector = new LaterConnector();
    const records: { type: string }[] = [];
    const notices: Omit<Notice, 't'>[] = [];
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      clock,
      record: (r) => records.push(r),
      notice: (n) => notices.push(n),
      quiet: (plugin) => o.quiet === true && plugin === 'p',
      title: (chat) => (chat === '42' ? 'Alice' : undefined),
    });
    return { clock, connector, records, notices, outbox };
  }
  const fail = (reason: string) => () => Promise.reject(new Error(reason));

  it('settles a queued send failed, records it and raises an unreachable notice', async () => {
    const { connector, records, notices, outbox } = refusing();
    connector.answers.push(fail('400: Bad Request: chat not found'));
    const r = await outbox.as('q').enqueue('42', 'hello');
    expect(r).toMatchObject({ outcome: 'failed', reason: '400: Bad Request: chat not found' });
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'core.send-failed',
        plugins: ['q'],
        chat: '42',
        title: 'Alice',
        hint: expect.stringContaining('cannot find that chat') as unknown,
      })
    );
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'core.queue', event: 'failed' })
    );
    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'unreachable',
        node: 'q',
        text: expect.stringContaining('q could not send to Alice (42) through test:me') as unknown,
      }),
    ]);
  });

  it('tells nothing of a quiet node, and records it all the same', async () => {
    const { connector, records, notices, outbox } = refusing({ quiet: true });
    connector.answers.push(fail('Forbidden: bot was blocked by the user'));
    await outbox.as('p').send('7', 'hi');
    await Promise.resolve();
    await Promise.resolve();
    expect(notices).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'core.send-failed', hint: 'the person blocked the bot' })
    );
  });

  it("raises one for a deliver's failure, and holds the account on a flood wait", async () => {
    const { clock, connector, notices, outbox } = refusing();
    connector.answers.push(fail('CHAT_WRITE_FORBIDDEN'));
    await expect(outbox.as('q').deliver('#c', 'x')).resolves.toMatchObject({ outcome: 'failed' });
    expect(notices[0]?.text).toContain('give it the right to send');
    connector.answers.push(() => Promise.reject(new FloodWait(5000)));
    await expect(outbox.as('q').enqueue('#c', 'y')).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'flood wait of 5 s',
    });
    expect(notices).toHaveLength(1);
    expect(outbox.as('q').send('#c', 'z')).toMatchObject({ outcome: 'refused' });
    clock.advance(6000);
    connector.down();
    expect(outbox.as('q').send('#c', 'z')).toMatchObject({ reason: 'not connected' });
  });
});

describe('command answers (D98)', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const OK = { commands: ['/give'], holds: ['/give'], answer: { status: 'ok' as const } };
  const refused = (retryAt?: number) => ({
    commands: ['/give'],
    holds: ['/give'],
    answer: {
      status: 'refused' as const,
      reason: 'cooldown',
      ...(retryAt === undefined ? {} : { retryAt }),
    },
  });

  /** An outbox whose `/give` waits a minute for its answer, through a connector of `deliver`. */
  function answering(o: { dryRun?: boolean; limits?: Limits } = {}) {
    const clock = new VirtualClock(0);
    const connector = new LaterConnector();
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      limits: () => o.limits,
      clock,
      policy: () => ({
        reach: { sends: ['@QuestBot'], ...(o.dryRun === true ? { dryRun: true } : {}) },
      }),
      watch: () => true,
      expects: (_chat, command) => (command === '/give' ? 60_000 : undefined),
    });
    return { clock, connector, outbox, p: outbox.as('p') };
  }

  it('settles a queued send with what the game answered, or unanswered past its window', async () => {
    const { clock, outbox, p } = answering();
    const q = p.enqueue('@QuestBot', '/give alice sword');
    await flush();
    expect(q.status()).toBe('sent');
    expect(q.cancel()).toBe(false);
    outbox.answered({ chat: '42', aliases: ['@questbot'] }, OK);
    await expect(q).resolves.toEqual({
      text: '/give alice sword',
      outcome: 'sent',
      answer: { status: 'ok' },
    });
    const late = p.enqueue('@QuestBot', '/give bob shield');
    clock.advance(60_000);
    await expect(late.result).resolves.toEqual({
      text: '/give bob shield',
      outcome: 'sent',
      answer: { status: 'unanswered' },
    });
    // A command no parser answers, and a dry run, are settled as they go.
    await expect(p.enqueue('@QuestBot', '/look')).resolves.toEqual({
      text: '/look',
      outcome: 'sent',
    });
    const dry = answering({ dryRun: true });
    await expect(dry.p.enqueue('@QuestBot', '/give')).resolves.toEqual({
      text: '/give',
      outcome: 'dry-run',
    });
  });

  it('pairs an answer before the network acks the send, and by the id it replies to', async () => {
    const { connector, outbox, p } = answering();
    let ack!: (r: { id?: string }) => void;
    connector.answers.push(() => new Promise((r) => (ack = r)));
    connector.answers.push(() => Promise.resolve({ id: '7' }));
    const first = p.enqueue('@QuestBot', '/give a');
    outbox.answered({ chat: '@QuestBot' }, refused());
    ack({ id: '6' });
    await expect(first).resolves.toMatchObject({ outcome: 'sent', answer: { status: 'refused' } });
    const delivered = await p.deliver('@QuestBot', '/give b');
    expect(delivered).toEqual({ text: '/give b', outcome: 'sent', id: '7' });
    const third = p.enqueue('@QuestBot', '/give c');
    await flush();
    // A reply to the delivered one answers it, not the queued one waiting.
    outbox.answered({ chat: '@QuestBot', replyTo: '7' }, OK);
    expect(third.status()).toBe('sent');
    outbox.answered({ chat: '@QuestBot' }, OK);
    await expect(third).resolves.toMatchObject({ answer: { status: 'ok' } });
  });

  it('waits for no answer to a send the network refused', async () => {
    const { clock, connector, p } = answering();
    connector.answers.push(() => Promise.reject(new Error('chat not found')));
    connector.answers.push(() => Promise.reject(new Error('blocked')));
    await expect(p.enqueue('@QuestBot', '/give a')).resolves.toEqual({
      text: '/give a',
      outcome: 'failed',
      reason: 'chat not found',
    });
    await expect(p.deliver('@QuestBot', '/give b')).resolves.toMatchObject({ outcome: 'failed' });
    clock.advance(60_000);
  });

  it("holds a command back while the bot's cooldown lasts: queued, it waits; sent now, refused", async () => {
    const { clock, connector, outbox, p } = answering();
    outbox.answered({ chat: '@QuestBot' }, refused(30_000));
    expect(p.held('@QuestBot', '/give alice')).toEqual({
      until: 30_000,
      reason: 'cooldown: cooldown',
    });
    expect(p.send('@QuestBot', '/give alice')).toEqual({
      text: '/give alice',
      outcome: 'refused',
      reason: 'cooldown: cooldown, 30 s more',
      retryAt: 30_000,
    });
    await expect(p.deliver('@QuestBot', '/give alice')).resolves.toMatchObject({
      outcome: 'refused',
      retryAt: 30_000,
    });
    const q = p.enqueue('@QuestBot', '/give alice');
    expect(outbox.pending()[0]?.waitingUntil).toBe(30_000);
    clock.advance(29_999);
    expect(q.status()).toBe('waiting');
    clock.advance(1);
    await flush();
    expect(q.status()).toBe('sent');
    expect(connector.formats).toHaveLength(1);
  });

  it('answers the watchdog: an answer clears the count, an answer that never came adds to it', () => {
    const clock = new VirtualClock(0);
    const connector = new FakeConnector('test:me', 'test');
    const paused: string[] = [];
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      limits: () => ({ unansweredAt: 2 }),
      clock,
      watch: () => true,
      pause: (plugin) => paused.push(plugin),
      expects: () => 1000,
    });
    const p = outbox.as('p');
    expect(p.send('@QuestBot', '/give').outcome).toBe('sent');
    outbox.answered({ chat: '@QuestBot' }, OK);
    expect(p.send('@QuestBot', '/give').outcome).toBe('sent');
    outbox.answered({ chat: '@QuestBot' }, OK);
    // Two that time out: the threshold, before a third is sent.
    expect(p.send('@QuestBot', '/give').outcome).toBe('sent');
    clock.advance(1000);
    expect(p.send('@QuestBot', '/give').outcome).toBe('sent');
    clock.advance(1000);
    expect(p.send('@QuestBot', '/give').reason).toBe(
      'stopped: stalled: 2 sends of /give to @QuestBot went unanswered'
    );
    expect(paused).toEqual(['p']);
    expect(outbox.backoffs('p')).toEqual([]);
  });
});

describe('a queued send while the account connects (D108)', () => {
  function connecting() {
    const clock = new VirtualClock(0);
    const connector = new LaterConnector();
    let down = false;
    const senders = new Senders();
    const records: SendRecord[] = [];
    const outbox = new Outbox({
      account: 'test:me',
      connector: () => connector,
      limits: () => ({ minIntervalMs: 3000 }),
      clock,
      policy: senders.policy,
      record: (r) => (r.type === 'core.send' ? records.push(r) : undefined),
      connection: () =>
        down ? 'down' : connector.status().state === 'connected' ? 'connected' : 'connecting',
    });
    connector.down();
    const flush = () => new Promise((r) => setImmediate(r));
    return {
      clock,
      connector,
      senders,
      records,
      p: outbox.as('p'),
      flush,
      stop: () => {
        down = true;
      },
    };
  }

  it('waits for the connection, then goes within the rate', async () => {
    const { clock, connector, records, p, flush } = connecting();
    const one = p.enqueue('#c', '/a');
    const two = p.enqueue('#c', '/b');
    clock.advance(60_000);
    expect([one.status(), two.status()]).toEqual(['waiting', 'waiting']);
    expect(records).toEqual([]);
    connector.up();
    clock.advance(1000);
    await flush();
    expect([one.status(), two.status()]).toEqual(['sent', 'waiting']);
    clock.advance(3000);
    await flush();
    await expect(two).resolves.toMatchObject({ outcome: 'sent' });
    expect(records.map((r) => [r.text, r.t])).toEqual([
      ['/a', 61_000],
      ['/b', 64_000],
    ]);
  });

  it('expires at its deadline, else is refused after the wait; a dry run does not wait', async () => {
    const { clock, senders, p, flush } = connecting();
    const timed = p.enqueue('#c', '/a', { cancel: { withinMs: 10_000 } });
    const untimed = p.enqueue('#c', '/b');
    clock.advance(10_000);
    await expect(timed).resolves.toMatchObject({ outcome: 'expired' });
    clock.advance(CONNECT_WAIT_MS);
    await flush();
    await expect(untimed).resolves.toEqual({
      text: '/b',
      outcome: 'refused',
      reason: 'not connected: waited 5 min for the connection',
    });
    senders.dryRun('p');
    await expect(p.enqueue('#c', '/c')).resolves.toMatchObject({ outcome: 'dry-run' });
  });

  it('is refused at once when no connector runs', async () => {
    const { p, stop } = connecting();
    stop();
    await expect(p.enqueue('#c', '/a')).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'not connected',
    });
  });
});

describe('unreachableHint', () => {
  it.each([
    ['Forbidden: bot was kicked from the group chat', 'not a member'],
    ['Forbidden: user is deactivated', 'deleted'],
    ['PEER_ID_INVALID', 'cannot find'],
    ['it sends only to its channel #lobby', 'only to its channel'],
    ['something else', 'refused: something else'],
  ])('%s', (reason, hint) => expect(unreachableHint(reason)).toContain(hint));
});
