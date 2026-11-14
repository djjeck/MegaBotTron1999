import {
  definePlugin,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type GraphInput,
  type Notice,
  type PluginContext,
  type Store,
  Tally,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PACE,
  OWNER_NOTICE,
  ownerNoticeConfig,
  ownerNoticePlugin,
  reportedOf,
  span,
  START_WAIT_MS,
  SUMMARY_DOC,
  type SummaryKept,
  WARNED_DOC,
  wordNotices,
  wordStart,
  wordSummary,
} from './owner-notice.ts';

const S = 1000;
const MIN = 60 * S;
const T0 = Date.UTC(2026, 10, 14, 9);
/** The owner's private chat with the bot, by the owner's (made-up) user id. */
const OWNER = '1000000002';

/**
 * A node that raises what the test says, or fails; and adds to the owner's summary what it counted
 * (`counts`), as a game's plugin would (D92).
 */
const noisy = (seen: Map<string, PluginContext>, counts: Map<string, Tally>) =>
  definePlugin({
    manifest: {
      id: 'noisy',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'raises notices',
      summary: true,
    },
    create: (ctx) => {
      seen.set(ctx.id, ctx);
      const tally = new Tally(ctx.clock);
      counts.set(ctx.id, tally);
      ctx.summary?.contribute((w) =>
        tally.counts(w).map(([what, n]) => `${what} ${n} ${n === 1 ? 'time' : 'times'}`)
      );
      return {};
    },
  });

/** A node that fails as it starts. */
const crashy = definePlugin({
  manifest: { id: 'crashy', version: '0.1.0', kinds: ['stats'], description: 'fails' },
  create: () => ({
    start() {
      throw new Error('boom');
    },
  }),
});

/** owner-notice, its store at hand: what a restart reads back. */
const withStore = (stores: Map<string, Store>) => {
  const inner = ownerNoticePlugin();
  return definePlugin({
    manifest: inner.manifest,
    create: (ctx) => (stores.set(ctx.id, ctx.store), inner.create(ctx)),
  });
};

/** A connector that monitors the chats its config lists (D89), and a reader on it. */
const monitoring = (account: FakeConnector) =>
  definePlugin({
    manifest: {
      id: 'irc',
      version: '0.1.0',
      kinds: ['connector'],
      description: 'a fake IRC account',
      account: account.account,
      config: z.object({ chats: z.array(z.string()).default(['#lobby']) }),
      monitors: { config: 'chats' },
    },
    create: () => ({ connector: account }),
  });
const reader = definePlugin({
  manifest: {
    id: 'reader',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'reads a chat',
    inputs: { chat: { type: 'chat-in' } },
  },
  create: () => ({}),
});

interface RunOptions {
  config?: Record<string, unknown>;
  live?: boolean;
  /** Its edge reads a chat the IRC account does not monitor: the load warns. */
  warn?: boolean;
  documents?: Record<string, unknown>;
  /** The run's start; T0 by default. */
  start?: number;
  /** A node that fails as it starts. */
  crash?: boolean;
  build?: { version: string; commit?: string };
}

/** Its D91 tells alone: no start notice, no summary, unless a test asks. */
const D91_ONLY = { startNotice: false, summaryEveryMin: 0 };

async function run(o: RunOptions = {}) {
  const seen = new Map<string, PluginContext>();
  const counts = new Map<string, Tally>();
  const stores = new Map<string, Store>();
  const start = o.start ?? T0;
  const bot = new FakeConnector({ account: 'telegram-bot:ExampleBot' });
  const irc = new FakeConnector({ account: 'irc:alice' });
  const graph: GraphInput = {
    version: 2,
    nodes: [
      { id: 'bot', plugin: 'bot', account: bot.account },
      { id: 'irc', plugin: 'irc', account: irc.account },
      { id: 'a', plugin: 'noisy' },
      { id: 'b', plugin: 'noisy' },
      { id: 'reader', plugin: 'reader' },
      ...(o.crash === true ? [{ id: 'crashy', plugin: 'crashy' }] : []),
      { id: 'notice', plugin: OWNER_NOTICE, config: { chat: OWNER, ...o.config } },
    ],
    edges: [
      {
        from: 'irc.chat',
        to: 'reader.chat',
        type: 'chat-in',
        reads: o.warn === true ? ['#lobby', '#elsewhere'] : ['#lobby'],
      },
      {
        from: 'notice.chat',
        to: 'bot.chat',
        type: 'chat-out',
        sends: [OWNER],
        ...(o.live === false ? { dryRun: true } : {}),
      },
    ],
  };
  const kit = new DevKit({
    start,
    graph,
    plugins: [
      fakeConnectorPlugin('bot', bot),
      monitoring(irc),
      noisy(seen, counts),
      reader,
      crashy,
      withStore(stores),
    ],
    ...(o.documents === undefined ? {} : { documents: { notice: o.documents } }),
    ...(o.build === undefined ? {} : { build: o.build }),
  });
  // A node failed at the start fails the kit's start, after every node has started.
  await kit.start().catch((e: unknown) => {
    if (o.crash !== true) throw e;
  });
  bot.open();
  const ctx = (id: string) => seen.get(id) as PluginContext;
  const count = (id: string) => counts.get(id) as Tally;
  const store = () => stores.get('notice') as Store;
  const at = (t: number) => kit.runUntil(start + t);
  const sent = () => bot.sent.map((m) => `${m.chat}: ${m.text}`);
  const records = (type: string) =>
    kit.log.recordsSince(0, Number.MAX_SAFE_INTEGER).filter((r) => r.type === type);
  return { kit, bot, ctx, count, store, at, sent, records };
}

const refused = (ctx: PluginContext, event: string, reason: string) =>
  ctx.notice('refused', `${ctx.id} refused ${event}: ${reason}`, { event, reason });

const d91 = (o: RunOptions = {}) => run({ ...o, config: { ...D91_ONLY, ...o.config } });

describe('owner-notice (D91)', () => {
  it('tells a single notice as its own line, once its kind has gathered', async () => {
    const r = await d91();
    r.ctx('a').fail('its script hung: a handler of quest.tick spent over 1000 ms of CPU');
    r.at(9 * S);
    expect(r.sent()).toEqual([]);
    r.at(10 * S);
    expect(r.sent()).toEqual([
      `${OWNER}: a failed: its script hung: a handler of quest.tick spent over 1000 ms of CPU`,
    ]);
    expect(r.records(`${OWNER_NOTICE}.told`)).toMatchObject([
      { kind: 'failed', count: 1, chat: OWNER },
    ]);
  });

  it('groups a burst into one message by node, and paces the next', async () => {
    const r = await d91();
    refused(r.ctx('a'), 'quest.gain', 'no room');
    r.at(20 * S);
    refused(r.ctx('a'), 'quest.gain', 'no room');
    refused(r.ctx('b'), 'quest.loss', 'below zero');
    r.at(59 * S);
    expect(r.sent()).toEqual([]);
    r.at(60 * S);
    expect(r.sent()).toEqual([
      [
        `${OWNER}: a refused 2 events in the last 1 min:`,
        '- quest.gain: no room (×2)',
        'b refused 1 event in the last 1 min:',
        '- quest.loss: below zero',
      ].join('\n'),
    ]);
    // The next waits out the kind's least gap (10 min), whatever comes meanwhile.
    r.at(3 * MIN);
    refused(r.ctx('a'), 'quest.gain', 'no room');
    r.at(9 * MIN);
    refused(r.ctx('a'), 'quest.drop', 'unknown item');
    r.at(10 * MIN + 59 * S);
    expect(r.sent()).toHaveLength(1);
    r.at(11 * MIN);
    expect(r.sent()[1]).toBe(
      [
        `${OWNER}: a refused 2 events in the last 8 min:`,
        '- quest.gain: no room',
        '- quest.drop: unknown item',
      ].join('\n')
    );
    // Each kind has its own pace: a failure meanwhile goes at once.
    refused(r.ctx('a'), 'quest.gain', 'no room');
    r.ctx('b').fail('crashed');
    r.at(11 * MIN + 10 * S);
    expect(r.sent()[2]).toBe(`${OWNER}: b failed: crashed`);
  });

  it('through a dry-run edge, logs what it would tell and sends nothing (D64)', async () => {
    const r = await d91({ live: false });
    r.ctx('a').fail('crashed');
    r.at(10 * S);
    expect(r.sent()).toEqual([]);
    expect(r.records('core.send')).toMatchObject([
      { plugin: 'notice', chat: OWNER, text: 'a failed: crashed', outcome: 'dry-run' },
    ]);
  });

  it('leaves out the kinds turned off, and takes a kind’s own pace', async () => {
    const r = await d91({
      config: { report: { refused: false }, pace: { failed: { gatherS: 0 } } },
    });
    refused(r.ctx('a'), 'quest.gain', 'no room');
    r.ctx('b').fail('crashed');
    r.at(0);
    expect(r.sent()).toEqual([`${OWNER}: b failed: crashed`]);
    r.at(30 * MIN);
    expect(r.sent()).toHaveLength(1);
  });

  it('tells the kinds plugins raise of their own as other, and none of its own', async () => {
    const r = await d91();
    r.ctx('a').notice('watchdog', 'a sent /inventory 5 times without an answer: paused');
    r.ctx('a').notice('watchdog', 'a sent /inventory 6 times without an answer: paused');
    // Its own sends, shared, would tell of themselves in a loop.
    r.ctx('a').notice('coalesced', 'a shared a send with notice', { with: ['notice'] });
    r.at(60 * S);
    expect(r.sent()).toEqual([
      [
        `${OWNER}: 2 notices in the last 1 min:`,
        '- watchdog: a sent /inventory 5 times without an answer: paused',
        '- watchdog: a sent /inventory 6 times without an answer: paused',
      ].join('\n'),
    ]);
  });

  it('lists at most maxLines items, and counts the rest', async () => {
    const r = await d91({ config: { maxLines: 2 } });
    for (const e of ['one', 'two', 'three', 'four']) refused(r.ctx('a'), `quest.${e}`, 'bad');
    r.at(60 * S);
    expect(r.sent()).toEqual([
      [
        `${OWNER}: a refused 4 events in the last 1 min:`,
        '- quest.one: bad',
        '- quest.two: bad',
        '- and 2 more',
      ].join('\n'),
    ]);
  });

  it("tells the load's warnings, and at the next start only new ones", async () => {
    const r = await d91({ warn: true });
    r.at(30 * S);
    const warning =
      'node reader: input port chat reads #elsewhere, which irc does not monitor (its chats: #lobby) (edge irc.chat → reader.chat)';
    expect(r.sent()).toEqual([`${OWNER}: ${warning}`]);
    // Told already: the next start keeps quiet.
    const next = await d91({ warn: true, documents: { [WARNED_DOC]: [warning] } });
    next.at(30 * MIN);
    expect(next.sent()).toEqual([]);
  });

  it('drops what waits when its node stops', async () => {
    const r = await d91();
    r.ctx('a').fail('crashed');
    await r.kit.stop();
    r.at(MIN);
    expect(r.sent()).toEqual([]);
  });
});

const H = 60 * MIN;
const WARNING =
  'node reader: input port chat reads #elsewhere, which irc does not monitor (its chats: #lobby) (edge irc.chat → reader.chat)';

describe('owner-notice: the start notice (D92)', () => {
  const quiet = { summaryEveryMin: 0 };

  it('tells the release, the nodes, a failure and the warnings at each start, once', async () => {
    const r = await run({
      config: quiet,
      crash: true,
      warn: true,
      build: { version: '0.1.15', commit: 'abcdef0123456789' },
    });
    r.at(START_WAIT_MS - 1);
    expect(r.sent()).toEqual([]);
    r.at(START_WAIT_MS);
    expect(r.sent()).toEqual([
      [
        `${OWNER}: Started 0.1.15 (abcdef0)`,
        '6 nodes running: bot, irc, a, b, reader, and 1 more',
        'Not running: crashy: failed (boom)',
        `The graph warns (1 new): ${WARNING}`,
      ].join('\n'),
    ]);
    // The failure and the warning were its news: no message of their own follows.
    r.at(H);
    expect(r.sent()).toHaveLength(1);
    expect(r.records(`${OWNER_NOTICE}.told`)).toMatchObject([{ kind: 'start', chat: OWNER }]);
    // A restart is news: told again, the warning told already only counted.
    const next = await run({
      config: { ...quiet, maxLines: 10 },
      warn: true,
      documents: { [WARNED_DOC]: [WARNING] },
    });
    next.at(START_WAIT_MS);
    expect(next.sent()).toEqual([
      [
        `${OWNER}: Started`,
        '6 nodes running: bot, irc, a, b, reader, notice',
        'The graph warns of 1 thing told before',
      ].join('\n'),
    ]);
  });

  it('names a failure’s state alone when the core tells it (failed off), and lists the rest', async () => {
    const r = await run({
      config: { ...quiet, report: { failed: false, warning: false } },
      crash: true,
      warn: true,
    });
    r.ctx('a').fail('its script hung');
    r.at(START_WAIT_MS);
    expect(r.sent()).toEqual([
      [
        `${OWNER}: Started`,
        '5 nodes running: bot, irc, b, reader, notice',
        'Not running:',
        '- a: failed',
        '- crashy: failed',
      ].join('\n'),
    ]);
    // After it, a failure is told as D91 tells it, when its kind is on.
    r.ctx('b').fail('crashed');
    r.at(H);
    expect(r.sent()).toHaveLength(1);
  });

  it('is not sent when turned off', async () => {
    const r = await run({ config: { ...quiet, startNotice: false } });
    r.at(H);
    expect(r.sent()).toEqual([]);
  });

  it('words a start with no node running, and many down', () => {
    const text = wordStart(
      {
        version: '0.1.15',
        nodes: ['a', 'b', 'c'].map((id) => ({ id, plugin: 'x', state: 'disabled' })),
      },
      { fresh: ['w1', 'w2', 'w3'], told: 2 },
      2,
      () => true
    );
    expect(text).toBe(
      [
        'Started 0.1.15',
        'No node running',
        'Not running:',
        '- a: disabled',
        '- b: disabled',
        '- and 1 more',
        'The graph warns (3 new, 2 told before):',
        '- w1',
        '- w2',
        '- and 1 more',
      ].join('\n')
    );
  });
});

describe('owner-notice: the summary (D92)', () => {
  const summary = (minutes = 60) => ({ startNotice: false, summaryEveryMin: minutes });

  it('goes on its cadence, the core’s lines first, then each contributor’s', async () => {
    const r = await run({ config: { ...summary(), report: { refused: false } } });
    r.at(10 * MIN);
    r.count('a').add('quest.tick', 3);
    r.count('b').add('quest.gain');
    r.count('b').add('quest.loss', 2);
    refused(r.ctx('a'), 'quest.gain', 'no room');
    r.at(H - 1);
    expect(r.sent()).toEqual([]);
    r.at(H);
    expect(r.sent()).toEqual([
      [
        `${OWNER}: Summary since the start, 60 min ago:`,
        'Notices: 1 refused',
        'a: quest.tick 3 times',
        'b:',
        '- quest.gain 1 time',
        '- quest.loss 2 times',
      ].join('\n'),
    ]);
    expect(r.records(`${OWNER_NOTICE}.told`)).toMatchObject([{ kind: 'summary', count: 3 }]);
    // The next covers what happened since: its own send is left out of the sends.
    r.at(H + 5 * MIN);
    r.count('a').add('quest.tick');
    r.at(2 * H);
    expect(r.sent()[1]).toBe(`${OWNER}: Summary of the last 60 min:\na: quest.tick 1 time`);
  });

  it('is skipped while nothing happened, and covers since the last one sent', async () => {
    const r = await run({ config: summary(30) });
    r.at(2 * H);
    expect(r.sent()).toEqual([]);
    expect(r.store().read<SummaryKept>(SUMMARY_DOC)).toEqual({ checkedAt: T0 + 2 * H });
    r.ctx('a').fail('crashed');
    r.at(2 * H + 30 * MIN);
    // The failure is told by its kind (D91), and counted in the summary.
    expect(r.sent()).toEqual([
      `${OWNER}: a failed: crashed`,
      `${OWNER}: Summary since the start, 2 h 30 min ago:\nNotices: 1 failed`,
    ]);
    r.at(5 * H);
    expect(r.sent()).toHaveLength(2);
  });

  it('keeps its time across a restart: neither sent again nor put off', async () => {
    const r = await run({ config: summary() });
    r.count('a').add('quest.tick');
    r.at(H);
    expect(r.sent()).toHaveLength(1);
    const kept = r.store().read<SummaryKept>(SUMMARY_DOC);
    expect(kept).toEqual({ sentAt: T0 + H, checkedAt: T0 + H });
    await r.kit.stop();
    // Back 20 minutes later: the next is still due an hour after the last, covering the start on.
    const next = await run({
      config: summary(),
      start: T0 + H + 20 * MIN,
      documents: { [SUMMARY_DOC]: kept },
    });
    next.count('b').add('quest.gain');
    next.at(40 * MIN - 1);
    expect(next.sent()).toEqual([]);
    next.at(40 * MIN);
    expect(next.sent()).toEqual([
      `${OWNER}: Summary since the start, 40 min ago:\nb: quest.gain 1 time`,
    ]);
    // Back after a long time: overdue, the next is a cadence after the start, not at once.
    const late = await run({
      config: summary(),
      start: T0 + 10 * H,
      documents: { [SUMMARY_DOC]: kept },
    });
    late.count('a').add('quest.tick');
    late.at(H - 1);
    expect(late.sent()).toEqual([]);
    late.at(H);
    expect(late.sent()).toHaveLength(1);
  });

  it('sends nothing on a cadence of 0, and nothing after its node stops', async () => {
    const off = await run({ config: summary(0) });
    off.count('a').add('quest.tick');
    off.at(24 * H);
    expect(off.sent()).toEqual([]);
    const r = await run({ config: summary() });
    r.count('a').add('quest.tick');
    await r.kit.stop();
    r.at(2 * H);
    expect(r.sent()).toEqual([]);
  });

  it('words a section of one line on its title, and lists at most maxLines', () => {
    const w = { since: T0, until: T0 + 90 * MIN, sinceStart: false };
    expect(
      wordSummary(
        [
          { title: 'Sends', lines: ['questbot-actor 3 sent'] },
          { title: 'inventory', node: 'inventory', lines: ['l1', 'l2', 'l3'] },
        ],
        w,
        2
      )
    ).toBe(
      [
        'Summary of the last 90 min:',
        'Sends: questbot-actor 3 sent',
        'inventory:',
        '- l1',
        '- l2',
        '- and 1 more',
      ].join('\n')
    );
  });
});

describe('owner-notice: its view (D72, D91)', () => {
  it('shows the node panel what waits, what it told last, and when the summary is due', async () => {
    const r = await run({ config: { summaryEveryMin: 60 }, warn: true });
    const view = () => r.kit.core.controls.view('notice');
    const line = () => r.kit.core.controls.status().plugins.find((p) => p.id === 'notice')?.summary;
    expect(view()).toMatchObject({
      value: {
        state: {
          waiting: {},
          lastTold: {},
          startNotice: 'waiting',
          summary: { everyMin: 60, dueAt: T0 + H },
          warnings: [WARNING],
        },
        pin: ['waiting'],
      },
    });
    expect(line()).toBeUndefined();
    refused(r.ctx('a'), 'quest.gain', 'no room');
    refused(r.ctx('b'), 'quest.loss', 'below zero');
    r.at(30 * S);
    expect(view()).toMatchObject({
      value: { state: { waiting: { refused: { count: 2, dueAt: T0 + 60 * S } } } },
    });
    expect(line()).toBe('2 notices waiting');
    r.at(60 * S);
    expect(view()).toMatchObject({
      value: {
        state: { waiting: {}, lastTold: { refused: T0 + 60 * S }, startNotice: 'sent' },
        updatedAt: T0 + 60 * S,
      },
    });
    expect(line()).toBeUndefined();
    const schema = (
      view() as unknown as { value: { schema: { properties: Record<string, unknown> } } }
    ).value.schema;
    expect(schema.properties['waiting']).toMatchObject({ description: 'Waiting to be told' });
    r.count('a').add('quest.tick');
    r.at(H);
    expect(view()).toMatchObject({
      value: { state: { summary: { sentAt: T0 + H, checkedAt: T0 + H, dueAt: T0 + 2 * H } } },
    });
    const off = await run({ config: { startNotice: false, summaryEveryMin: 0 } });
    expect(off.kit.core.controls.view('notice')).toMatchObject({
      value: { state: { startNotice: 'off', summary: { everyMin: 0 } } },
    });
  });
});

describe('its wording', () => {
  const n = (
    kind: string,
    node: string,
    text: string,
    detail?: Record<string, unknown>
  ): Notice => ({
    kind,
    t: T0,
    node,
    text,
    ...(detail === undefined ? {} : { detail }),
  });

  it('words several notices of each kind', () => {
    const word = (kind: Parameters<typeof wordNotices>[0], xs: Notice[]) =>
      wordNotices(kind, xs, T0 + 30 * S, 5);
    expect(
      word('coalesced', [
        n('coalesced', 'b', '', { chat: '@QuestBot', text: '/inventory', with: ['a'] }),
        n('coalesced', 'b', '', { chat: '@QuestBot', text: '/inventory', with: ['a'] }),
      ])
    ).toBe(
      'b shared 2 sends with other nodes (the graph may duplicate logic):\n- "/inventory" to @QuestBot, with a (×2)'
    );
    expect(
      word('drift', [n('drift', 'p', 'drift: p …; stopped a'), n('drift', 'q', 'drift: q')])
    ).toBe('Drift, 2 times:\n- drift: p …; stopped a\n- drift: q');
    expect(
      word('cascade', [
        n('cascade', 'c', 'c is inactive: needs a (stopped)', { reason: 'needs a (stopped)' }),
        n('cascade', 'd', 'd is inactive: needs c (inactive)'),
      ])
    ).toBe(
      '2 nodes made inactive by a stop:\n- c: needs a (stopped)\n- d: is inactive: needs c (inactive)'
    );
    expect(
      word('failed', [
        n('failed', 'a', 'a failed: x', { reason: 'x' }),
        n('failed', 'b', 'b failed'),
      ])
    ).toBe('2 nodes failed:\n- a: x\n- b: b failed');
    expect(
      word('stalled', [
        n('stalled', 'a', 'a sent /look …', { chat: '#lobby', command: '/look', count: 10 }),
        n('stalled', 'b', 'b sent /turn to @QuestBot 3 times …'),
      ])
    ).toBe(
      '2 nodes stopped: their commands went unanswered:\n- a: /look to #lobby, 10 times\n- b: b sent /turn to @QuestBot 3 times …'
    );
    expect(word('warning', [n('warning', 'a', 'w1'), n('warning', 'b', 'w2')])).toBe(
      'The graph warns (2):\n- w1\n- w2'
    );
    expect(word('refused', [n('refused', 'a', ''), n('refused', 'a', '')])).toBe(
      'a refused 2 events:\n- ?:  (×2)'
    );
    expect(word('drift', [])).toBe('');
  });

  it('says how long, and maps every other kind to other', () => {
    expect([span(40 * S), span(10 * MIN), span(3 * 60 * MIN), span(150 * MIN)]).toEqual([
      '40 s',
      '10 min',
      '3 h',
      '2 h 30 min',
    ]);
    expect([
      reportedOf('failed'),
      reportedOf('stalled'),
      reportedOf('watchdog'),
      reportedOf('other'),
    ]).toEqual(['failed', 'stalled', 'other', 'other']);
  });

  it('shows each kind’s default pace in its config', () => {
    const c = ownerNoticeConfig.parse({ chat: OWNER });
    expect(c.pace).toEqual(DEFAULT_PACE);
    expect(Object.values(c.report).every((on) => on)).toBe(true);
    expect(c.maxLines).toBe(5);
    expect(c.summaryEveryMin).toBe(60);
    expect(c.startNotice).toBe(true);
  });
});
