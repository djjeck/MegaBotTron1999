import {
  definePlugin,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type GraphInput,
  type Notice,
  type PluginContext,
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
  WARNED_DOC,
  wordNotices,
} from './owner-notice.ts';

const S = 1000;
const MIN = 60 * S;
const T0 = Date.UTC(2026, 10, 14, 9);
/** The owner's private chat with the bot, by the owner's (made-up) user id. */
const OWNER = '1000000002';

/** A node that raises what the test says, or fails. */
const noisy = (seen: Map<string, PluginContext>) =>
  definePlugin({
    manifest: {
      id: 'noisy',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'raises notices',
    },
    create: (ctx) => (seen.set(ctx.id, ctx), {}),
  });

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
}

async function run(o: RunOptions = {}) {
  const seen = new Map<string, PluginContext>();
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
    start: T0,
    graph,
    plugins: [
      fakeConnectorPlugin('bot', bot),
      monitoring(irc),
      noisy(seen),
      reader,
      ownerNoticePlugin(),
    ],
    ...(o.documents === undefined ? {} : { documents: { notice: o.documents } }),
  });
  await kit.start();
  bot.open();
  const ctx = (id: string) => seen.get(id) as PluginContext;
  const at = (t: number) => kit.runUntil(T0 + t);
  const sent = () => bot.sent.map((m) => `${m.chat}: ${m.text}`);
  const records = (type: string) =>
    kit.log.recordsSince(0, Number.MAX_SAFE_INTEGER).filter((r) => r.type === type);
  return { kit, bot, ctx, at, sent, records };
}

const refused = (ctx: PluginContext, event: string, reason: string) =>
  ctx.notice('refused', `${ctx.id} refused ${event}: ${reason}`, { event, reason });

describe('owner-notice (D91)', () => {
  it('tells a single notice as its own line, once its kind has gathered', async () => {
    const r = await run();
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
    const r = await run();
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
    const r = await run({ live: false });
    r.ctx('a').fail('crashed');
    r.at(10 * S);
    expect(r.sent()).toEqual([]);
    expect(r.records('core.send')).toMatchObject([
      { plugin: 'notice', chat: OWNER, text: 'a failed: crashed', outcome: 'dry-run' },
    ]);
  });

  it('leaves out the kinds turned off, and takes a kind’s own pace', async () => {
    const r = await run({
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
    const r = await run();
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
    const r = await run({ config: { maxLines: 2 } });
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
    const r = await run({ warn: true });
    r.at(30 * S);
    const warning =
      'node reader: input port chat reads #elsewhere, which irc does not monitor (its chats: #lobby) (edge irc.chat → reader.chat)';
    expect(r.sent()).toEqual([`${OWNER}: ${warning}`]);
    // Told already: the next start keeps quiet.
    const next = await run({ warn: true, documents: { [WARNED_DOC]: [warning] } });
    next.at(30 * MIN);
    expect(next.sent()).toEqual([]);
  });

  it('drops what waits when its node stops', async () => {
    const r = await run();
    r.ctx('a').fail('crashed');
    await r.kit.stop();
    r.at(MIN);
    expect(r.sent()).toEqual([]);
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
    expect(word('warning', [n('warning', 'a', 'w1'), n('warning', 'b', 'w2')])).toBe(
      'The graph warns (2):\n- w1\n- w2'
    );
    expect(word('refused', [n('refused', 'a', ''), n('refused', 'a', '')])).toBe(
      'a refused 2 events:\n- ?:  (×2)'
    );
    expect(word('drift', [])).toBe('');
  });

  it('says how long, and maps every other kind to other', () => {
    expect([span(40 * S), span(10 * MIN), span(3 * 60 * MIN)]).toEqual(['40 s', '10 min', '3 h']);
    expect([reportedOf('failed'), reportedOf('watchdog'), reportedOf('other')]).toEqual([
      'failed',
      'other',
      'other',
    ]);
  });

  it('shows each kind’s default pace in its config', () => {
    const c = ownerNoticeConfig.parse({ chat: OWNER });
    expect(c.pace).toEqual(DEFAULT_PACE);
    expect(Object.values(c.report).every((on) => on)).toBe(true);
    expect(c.maxLines).toBe(5);
  });
});
