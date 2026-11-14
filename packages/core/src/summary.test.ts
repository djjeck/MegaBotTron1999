import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { FakeConnector } from './devkit.ts';
import { type GraphInput } from './graph.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import {
  counted,
  Summaries,
  type SummaryWindow,
  Tally,
  TALLY_KEPT_MS,
  TALLY_MAX,
} from './summary.ts';

const T0 = Date.UTC(2026, 10, 14, 9);
const MIN = 60_000;

describe('Tally', () => {
  it('counts by key over a window, from its start to before its end', () => {
    const clock = new VirtualClock(T0);
    const tally = new Tally(clock);
    tally.add('applied', 2);
    clock.advance(MIN);
    tally.add('refused');
    tally.add('applied');
    const all: SummaryWindow = { since: T0, until: T0 + 2 * MIN };
    expect(tally.counts(all)).toEqual([
      ['applied', 3],
      ['refused', 1],
    ]);
    expect(tally.count('applied', { since: T0, until: T0 + MIN })).toBe(2);
    expect(tally.counts({ since: T0 + 2 * MIN, until: T0 + 3 * MIN })).toEqual([]);
    expect(tally.count('missing', all)).toBe(0);
  });

  it('forgets what is older than it keeps, and beyond its most per key', () => {
    const clock = new VirtualClock(T0);
    const tally = new Tally(clock);
    tally.add('x');
    clock.advance(TALLY_KEPT_MS + 1);
    tally.add('x');
    expect(tally.count('x', { since: 0, until: clock.now() + 1 })).toBe(1);
    tally.add('y', TALLY_MAX + 5);
    expect(tally.count('y', { since: 0, until: clock.now() + 1 })).toBe(TALLY_MAX);
  });

  it('counts in words', () => {
    expect([counted(1, 'turn'), counted(2, 'turn'), counted(2, 'entry', 'entries')]).toEqual([
      '1 turn',
      '2 turns',
      '2 entries',
    ]);
  });
});

const contexts = new Map<string, PluginContext>();

/** A node that sends, and adds a line to the summary when told to. */
const sender = definePlugin({
  manifest: {
    id: 'sender',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'sends',
    summary: true,
    outputs: { chat: { type: 'chat-out' } },
  },
  create: (ctx) => (contexts.set(ctx.id, ctx), {}),
});

/** A node that tells the owner: its sends are the summaries, left out of them. */
const teller = definePlugin({
  manifest: {
    id: 'teller',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'tells the owner',
    notices: true,
    summary: true,
    outputs: { chat: { type: 'chat-out' } },
  },
  create: (ctx) => (contexts.set(ctx.id, ctx), {}),
});

const plain = definePlugin({
  manifest: { id: 'plain', version: '0.1.0', kinds: ['stats'], description: 'no summary' },
  create: (ctx) => (contexts.set(ctx.id, ctx), {}),
});

const graph: GraphInput = {
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg', account: 'tg:me' },
    { id: 'b', plugin: 'sender' },
    { id: 'a', plugin: 'sender' },
    { id: 'teller', plugin: 'teller' },
    { id: 'plain', plugin: 'plain', disabled: true },
  ],
  edges: [
    { from: 'a.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
    { from: 'b.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'], dryRun: true },
    { from: 'teller.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
  ],
};

describe("the core's summary (D92)", () => {
  it('counts each node’s sends and the notices, then each contributor’s lines', async () => {
    contexts.clear();
    const clock = new VirtualClock(T0);
    // Paced: a queued send waits, and may be cancelled.
    const account = new FakeConnector({ account: 'tg:me', limits: { minIntervalMs: 2000 } });
    const errors: string[] = [];
    const core = new Core({
      clock,
      graph,
      build: { version: '0.1.15', commit: 'abcdef0123' },
      print: (line) => errors.push(line),
    });
    core.register(
      definePlugin({
        manifest: {
          id: 'tg',
          version: '0.1.0',
          kinds: ['connector'],
          description: 'a fake account',
          account: 'tg:me',
        },
        create: () => ({ connector: account }),
      }),
      sender,
      teller,
      plain
    );
    await core.start();
    account.open();
    const ctx = (id: string) => contexts.get(id) as PluginContext;
    expect(ctx('plain')).toBeUndefined();
    const summary = ctx('a').summary;
    if (summary === undefined) throw new Error('no summary');
    expect(summary.instance()).toEqual({
      version: '0.1.15',
      commit: 'abcdef0123',
      startedAt: T0,
      nodes: [
        { id: 'tg', plugin: 'tg', state: 'running' },
        { id: 'b', plugin: 'sender', state: 'running' },
        { id: 'a', plugin: 'sender', state: 'running' },
        { id: 'teller', plugin: 'teller', state: 'running' },
        { id: 'plain', plugin: 'plain', state: 'disabled' },
      ],
    });
    // Nothing yet: nothing to say.
    const w = (): SummaryWindow => ({ since: T0, until: clock.now() + 1 });
    expect(summary.collect(w())).toEqual([]);
    // Sends: sent, a dry run, refused, a queued one cancelled; the teller's left out.
    ctx('b').outbox('chat').send('#lobby', '/three');
    clock.advance(2000);
    ctx('a').outbox('chat').send('#lobby', '/one');
    ctx('a').outbox('chat').send('#elsewhere', '/two');
    const queued = ctx('a').outbox('chat').enqueue('#lobby', '/four');
    queued.cancel();
    ctx('teller').outbox('chat').send('#lobby', 'Summary');
    ctx('a').notice('refused', 'a refused x');
    ctx('b').notice('refused', 'b refused y');
    ctx('b').notice('watchdog', 'b paused');
    // Contributors, in load order whatever order they came in; one with nothing, one that throws.
    ctx('a').summary?.contribute(() => ['a did 2 things']);
    const stop = ctx('b').summary?.contribute(() => ['b did 1 thing', ' ']);
    ctx('b').summary?.contribute(() => undefined);
    ctx('teller').summary?.contribute(() => {
      throw new Error('boom');
    });
    expect(summary.collect(w())).toEqual([
      { title: 'Sends', lines: ['b 1 dry-run', 'a 1 sent, 1 refused, 1 cancelled'] },
      { title: 'Notices', lines: ['2 refused, 1 watchdog'] },
      { title: 'b', node: 'b', lines: ['b did 1 thing'] },
      { title: 'a', node: 'a', lines: ['a did 2 things'] },
    ]);
    expect(errors.some((l) => l.includes('its summary lines: boom'))).toBe(true);
    stop?.();
    expect(summary.collect(w()).map((s) => s.title)).toEqual(['Sends', 'Notices', 'a']);
    // A later window: what happened before it is not in it.
    clock.advance(MIN);
    expect(summary.collect({ since: T0 + MIN, until: T0 + 2 * MIN })).toEqual([
      { title: 'a', node: 'a', lines: ['a did 2 things'] },
    ]);
    await core.stop();
  });

  it('says no release nor start when the wiring gives none, and a node unknown last', () => {
    const clock = new VirtualClock(T0);
    const summaries = new Summaries({
      clock,
      nodes: () => [{ id: 'a', plugin: 'x', state: 'running' }],
      tellers: () => new Set(),
    });
    expect(summaries.instance()).toEqual({ nodes: [{ id: 'a', plugin: 'x', state: 'running' }] });
    summaries.sent('gone', 'failed');
    summaries.sent('a', 'expired');
    expect(summaries.collect({ since: T0, until: T0 + 1 })).toEqual([
      { title: 'Sends', lines: ['a 1 expired', 'gone 1 failed'] },
    ]);
  });
});
