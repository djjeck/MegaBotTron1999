import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusEvent } from './bus.ts';
import { DevKit, FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { type GraphInput } from './graph.ts';
import { type QueuedSend, type QueueOptions, type QueueRecord, type SendRecord } from './outbox.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const S = 1000;
const T0 = Date.UTC(2026, 10, 12, 9);

/** A game's parser that publishes what the test says: its state changed, which sections. */
const game = definePlugin({
  manifest: {
    id: 'game',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'a made-up game',
    games: { registers: ['game'] },
    events: {
      'game.changed': z.object({ sections: z.array(z.string()) }),
      'game.tick': z.object({}),
    },
  },
  create: (ctx) => {
    contexts.set('game', ctx);
    return {};
  },
});

const contexts = new Map<string, PluginContext>();

/** An acting node: it queues what the test asks, through its chat-out output `chat`. */
const actor = definePlugin({
  manifest: {
    id: 'actor',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'queues sends',
    inputs: { events: { type: 'events', namespace: 'game', optional: true } },
    outputs: { chat: { type: 'chat-out' } },
  },
  create: (ctx) => {
    contexts.set(ctx.id, ctx);
    return {};
  },
});

/** A kit: the fake account `chat`, the game, and acting nodes `a` and `b` with their edges. */
async function kit(
  o: {
    edge?: Record<string, unknown>;
    edgeB?: Record<string, unknown>;
    commandIntervalMs?: number;
  } = {}
) {
  contexts.clear();
  const account = new FakeConnector({
    account: 'chat:me',
    limits: {
      minIntervalMs: 2 * S,
      ...(o.commandIntervalMs === undefined ? {} : { commandIntervalMs: o.commandIntervalMs }),
    },
  });
  const records: (QueueRecord | SendRecord)[] = [];
  const edge = (from: string, more: Record<string, unknown> = {}) => ({
    from: `${from}.chat`,
    to: 'chat.chat',
    type: 'chat-out' as const,
    sends: ['@Bot'],
    commands: ['/inventory', '/adventure', '/roll'],
    minIntervalS: { '/inventory': 300 },
    ...more,
  });
  const graph: GraphInput = {
    version: 2,
    nodes: [
      { id: 'chat', plugin: 'chat' },
      { id: 'game', plugin: 'game' },
      { id: 'a', plugin: 'actor' },
      { id: 'b', plugin: 'actor' },
    ],
    edges: [
      edge('a', o.edge),
      edge('b', o.edgeB),
      { from: 'game.events', to: 'a.events', type: 'events' },
      { from: 'game.events', to: 'b.events', type: 'events' },
    ],
  };
  const k = new DevKit({
    start: T0,
    plugins: [fakeConnectorPlugin('chat', account), game, actor],
    graph,
    record: (r) => {
      if (r.type === 'core.queue' || r.type === 'core.send') records.push(r as QueueRecord);
    },
  });
  await k.start();
  account.open();
  const ctx = (id: string) => contexts.get(id) as PluginContext;
  const queue = (id: string, text: string, options: QueueOptions = {}): QueuedSend =>
    ctx(id).outbox('chat').enqueue('@Bot', text, options);
  const publish = (type: string, payload: Record<string, unknown>) =>
    ctx('game').bus.publish(type, payload);
  const steps = () =>
    records
      .filter((r): r is QueueRecord => r.type === 'core.queue')
      .map((r) => `${r.plugin} ${r.text} ${r.event}${r.by === undefined ? '' : ` by ${r.by}`}`);
  return { k, account, records, queue, publish, steps, ctx };
}

describe('the outbox’s queue (bot-os.md D73)', () => {
  it('spaces each command in its chat by its interval, other commands not held behind it', async () => {
    const { k, queue, account } = await kit();
    const first = queue('a', '/inventory');
    expect(first.status()).toBe('sent');
    const again = queue('a', '/inventory');
    const other = queue('a', '/adventure');
    expect(again.status()).toBe('waiting');
    // The other command goes at the account's pace (2 s), not behind the inventory's 300 s.
    k.runUntil(T0 + 2 * S);
    expect(other.status()).toBe('sent');
    k.runUntil(T0 + 299 * S);
    expect(again.status()).toBe('waiting');
    k.runUntil(T0 + 300 * S);
    expect(await again).toEqual({ text: '/inventory', outcome: 'sent' });
    expect(account.sent.map((s) => s.text)).toEqual(['/inventory', '/adventure', '/inventory']);
    // A send now (`send`) is not held, and counts for the interval.
    k.runUntil(T0 + 400 * S);
    expect(k.core.outbox('chat:me').send('a', '@Bot', '/inventory').outcome).toBe('sent');
    const after = queue('a', '/inventory');
    expect(k.core.controls.queue('chat')?.entries).toEqual([
      expect.objectContaining({ text: '/inventory', waitingUntil: T0 + 700 * S, intervalS: 300 }),
    ]);
    k.runUntil(T0 + 700 * S);
    expect(after.status()).toBe('sent');
  });

  it('spaces a command the edge does not name by the connector’s default', async () => {
    const { k, queue } = await kit({ commandIntervalMs: 60 * S });
    queue('a', '/roll 1');
    const second = queue('a', '/roll 2');
    k.runUntil(T0 + 59 * S);
    expect(second.status()).toBe('waiting');
    k.runUntil(T0 + 60 * S);
    expect(second.status()).toBe('sent');
  });

  it('coalesces the same text for the same chat into one send, each node with its handle', async () => {
    const { k, queue, records, steps, account } = await kit();
    queue('a', '/inventory');
    const a = queue('a', '/inventory');
    const b = queue('b', '/inventory');
    expect(k.core.controls.queue('chat')?.entries).toHaveLength(1);
    expect(k.core.controls.queue('chat')?.entries[0]?.nodes.map((n) => n.plugin)).toEqual([
      'a',
      'b',
    ]);
    k.runUntil(T0 + 300 * S);
    expect([(await a).outcome, (await b).outcome]).toEqual(['sent', 'sent']);
    expect(account.sent).toHaveLength(2);
    const send = records.filter((r) => r.type === 'core.send').at(-1);
    expect(send).toMatchObject({ plugin: 'a', with: ['b'], outcome: 'sent' });
    expect(steps()).toEqual([
      'a /inventory queued',
      'a /inventory sent',
      'a /inventory queued',
      'b /inventory coalesced',
      'a /inventory sent',
      'b /inventory sent',
    ]);
  });

  it('coalesces another node’s same send wherever it waits in the queue, not only the last', async () => {
    const { k, queue, account } = await kit();
    queue('a', '/inventory');
    const a = queue('a', '/inventory');
    queue('a', '/adventure');
    queue('b', '/roll 1');
    // Two sends wait after a's inventory: b's same inventory still joins it.
    const b = queue('b', '/inventory');
    const entries = () => k.core.controls.queue('chat')?.entries ?? [];
    expect(entries().map((e) => [e.text, e.nodes.map((n) => n.plugin)])).toEqual([
      ['/inventory', ['a', 'b']],
      ['/adventure', ['a']],
      ['/roll 1', ['b']],
    ]);
    k.runUntil(T0 + 300 * S);
    expect([(await a).outcome, (await b).outcome]).toEqual(['sent', 'sent']);
    expect(account.sent.filter((x) => x.text === '/inventory')).toHaveLength(2);
  });

  it('keeps a node’s own repeated sends apart: each goes, and another node joins one each', async () => {
    const buys = { commands: ['/buy'], minIntervalS: {} };
    const { k, queue, account, steps } = await kit({ edge: buys, edgeB: buys });
    // Three copies of the same item, three sends: the first at once, the others at the pace.
    const mine = [queue('a', '/buy rope'), queue('a', '/buy rope'), queue('a', '/buy rope')];
    const entries = () => k.core.controls.queue('chat')?.entries ?? [];
    expect(entries().map((e) => e.nodes.map((n) => n.plugin))).toEqual([['a'], ['a']]);
    // Another node's same buys join a's, one send each, never two of b's in one.
    const theirs = [queue('b', '/buy rope'), queue('b', '/buy rope')];
    expect(entries().map((e) => e.nodes.map((n) => n.plugin))).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    k.runUntil(T0 + 4 * S);
    expect((await Promise.all([...mine, ...theirs])).map((r) => r.outcome)).toEqual([
      'sent',
      'sent',
      'sent',
      'sent',
      'sent',
    ]);
    expect(account.sent.map((x) => x.text)).toEqual(['/buy rope', '/buy rope', '/buy rope']);
    expect(steps().filter((x) => x.endsWith('coalesced'))).toEqual([
      'b /buy rope coalesced',
      'b /buy rope coalesced',
    ]);
  });

  it('cancels a waiting send when an event of its cancel arrives, or its deadline passes', async () => {
    const { k, queue, publish, steps } = await kit();
    queue('a', '/inventory');
    const byEvent = queue('a', '/inventory', {
      cancel: { on: 'game.changed', when: { sections: 'inventory' } },
    });
    const byTest = queue('b', '/inventory', {
      cancel: { on: ['game.changed'], test: (e) => (e['sections'] as string[]).length > 1 },
    });
    const byTime = queue('a', '/adventure', { cancel: { withinMs: 1 * S } });
    expect(k.core.controls.queue('chat')?.entries.map((e) => e.nodes)).toEqual([
      [
        {
          plugin: 'a',
          origin: 'a',
          cancel: { on: ['game.changed'], when: { sections: 'inventory' } },
        },
        { plugin: 'b', origin: 'b', cancel: { on: ['game.changed'], test: true } },
      ],
      [{ plugin: 'a', origin: 'a', cancel: { deadline: T0 + 1 * S } }],
    ]);
    // Neither condition holds: nothing cancelled.
    publish('game.changed', { sections: ['profile'] });
    expect(byEvent.status()).toBe('waiting');
    publish('game.changed', { sections: ['profile', 'inventory'] });
    const r = await byEvent;
    expect(r).toMatchObject({ outcome: 'cancelled', reason: 'cancelled by game.changed' });
    expect((r.event as BusEvent)['sections']).toEqual(['profile', 'inventory']);
    expect(byTest.status()).toBe('cancelled');
    k.runUntil(T0 + 1 * S);
    expect(await byTime).toEqual({
      text: '/adventure',
      outcome: 'expired',
      reason: 'its deadline passed',
    });
    expect(k.core.controls.queue('chat')?.entries).toEqual([]);
    expect(steps().slice(-3)).toEqual([
      'a /inventory cancelled by game.changed',
      'b /inventory cancelled by game.changed',
      'a /adventure expired',
    ]);
    // Its node cancels it itself; once gone, nothing to cancel.
    const mine = queue('a', '/inventory');
    expect(mine.cancel()).toBe(true);
    expect(mine.cancel()).toBe(false);
    expect((await mine).reason).toBe('cancelled by its node');
    // An event its node does not hear cannot cancel: refused at once, nothing queued.
    expect(() => queue('a', '/inventory', { cancel: { on: 'other.thing' } })).toThrow(
      'a does not consume other'
    );
    expect(k.core.controls.queue('chat')?.entries).toEqual([]);
  });

  it('sends through a dry-run edge as a dry run, and for real once a live node shares it', async () => {
    const { k, queue, account, records } = await kit({ edge: { dryRun: true } });
    expect((await queue('a', '/roll')).outcome).toBe('dry-run');
    expect(account.sent).toEqual([]);
    // The dry run counts: the next /inventory waits its interval after a dry one.
    k.runUntil(T0 + 2 * S);
    expect((await queue('a', '/inventory')).outcome).toBe('dry-run');
    const dry = queue('a', '/inventory');
    const live = queue('b', '/inventory');
    k.runUntil(T0 + 301 * S);
    expect(dry.status()).toBe('waiting');
    k.runUntil(T0 + 302 * S);
    expect([(await dry).outcome, (await live).outcome]).toEqual(['dry-run', 'sent']);
    expect(account.sent.map((s) => s.text)).toEqual(['/inventory']);
    expect(records.filter((r) => r.type === 'core.send').at(-1)).toMatchObject({
      plugin: 'b',
      with: ['a'],
      mode: 'live',
    });
  });

  it('drops what a node queued when it stops, and everything when the instance stops', async () => {
    const { k, queue } = await kit();
    queue('a', '/inventory');
    const a = queue('a', '/inventory');
    const b = queue('b', '/inventory');
    const c = queue('b', '/adventure');
    k.core.stopNode('a', 'a test', 'owner');
    expect(await a).toMatchObject({ outcome: 'cancelled', reason: 'a is stopped' });
    expect(b.status()).toBe('waiting');
    expect(k.core.controls.queue('chat')?.entries.map((e) => e.nodes.length)).toEqual([1, 1]);
    // Refused at once, nothing queued: a stopped node sends nothing.
    expect((await queue('a', '/roll')).outcome).toBe('refused');
    await k.stop();
    expect((await b).outcome).toBe('cancelled');
    expect((await c).reason).toBe('the instance stops');
    expect(k.core.controls.queue('game')).toBeUndefined();
  });
});
