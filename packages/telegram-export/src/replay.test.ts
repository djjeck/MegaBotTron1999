import {
  FakeConnector,
  fakeConnectorPlugin,
  type Graph,
  type GraphInput,
  type Inbound,
} from '@megabottron1999/core';
import { QUEST, QUESTBOT, questPlugin } from '@megabottron1999/turns/test/quest.ts';
import { describe, expect, it } from 'vitest';
import { LOBBY, QUEST_GRAPH, QUEST_HTML, QUEST_JSON, QUEST_MAPPING, T0 } from '#test/quest.ts';
import { readExportPaths } from './files.ts';
import { toInbounds } from './inbound.ts';
import { asMonitored, replay } from './replay.ts';

const S = 1000;
const MIN = 60 * S;

const inbounds = (dir: string): Inbound[] =>
  toInbounds(readExportPaths([dir], () => {}).messages, QUEST_MAPPING);

/** The parser's turn events, as the log has them. */
const turns = (records: readonly { type: string }[]) =>
  records
    .filter((r) => r.type === `${QUEST}.turn`)
    .map((r) => {
      const e = r as unknown as {
        t: number;
        chat: string;
        outcome: { kind: string; reason?: string };
        retryAt?: number;
        playback?: true;
      };
      return {
        t: e.t - T0,
        chat: e.chat,
        kind: e.outcome.kind,
        ...(e.outcome.reason === undefined ? {} : { reason: e.outcome.reason }),
        ...(e.retryAt === undefined ? {} : { retryAt: e.retryAt - T0 }),
        ...(e.playback === undefined ? {} : { playback: e.playback }),
      };
    });

/** What the replay of the invented chat reads, live: alice's turns by hand, and @QuestBot's answers. */
const EXPECTED = [
  // A turn by hand in private, answered: 15 minutes' rest.
  { t: 2 * S, chat: '@QuestBot', kind: 'gain', retryAt: 2 * S + 15 * MIN },
  // Too soon: a refusal, the wait it states.
  {
    t: 301 * S,
    chat: '@QuestBot',
    kind: 'nothing',
    reason: 'cooldown',
    retryAt: 301 * S + 12 * MIN,
  },
  // An answer the grammar cannot read: drift.
  { t: 1201 * S, chat: '@QuestBot', kind: 'unknown' },
  // A turn by hand in the group, answered by a reply (bob's turn and its answer are not alice's).
  { t: 1861 * S, chat: LOBBY, kind: 'nothing', reason: 'defeated', retryAt: 1861 * S + 30 * MIN },
];

describe('replay', () => {
  it("replays an HTML export's turns through a real parser, private and group", async () => {
    const r = await replay({
      plugins: [questPlugin()],
      inbounds: inbounds(QUEST_HTML),
      // The parser's edge also reads the game's group, as a graph would bind it.
      graph: (defaults) => ({
        ...defaults,
        edges: defaults.edges.map((e) => ({ ...e, reads: ['@QuestBot', LOBBY] })),
      }),
      self: 'alice',
    });
    expect(r.delivered).toBe(11);
    expect(turns(r.records())).toStrictEqual(EXPECTED);
    expect(r.drift()).toStrictEqual([
      { parser: QUEST, read: 3, unread: 1, recent: 1, tripped: false },
    ]);
    // The clock stands at the last message: the group turn is the last, its rest still running.
    expect(r.kit.clock.now()).toBe(T0 + 1921 * S);
    expect(r.read(QUEST, 'lastTurn')).toStrictEqual({ t: T0 + 1860 * S, id: '7001' });
    expect(r.read(QUEST, 'rest')).toStrictEqual({
      until: T0 + 1861 * S + 30 * MIN,
      why: 'defeated',
    });
    // The group's answer holds the turn command back in the group, until the rest it states.
    const outbox = r.kit.core.outbox('telegram:owner').as('anyone');
    expect(outbox.held(LOBBY, '/play')).toStrictEqual({
      until: T0 + 1861 * S + 30 * MIN,
      reason: 'cooldown: rest',
    });
    expect(r.sent()).toStrictEqual([]);
    expect(() => r.read(QUEST, 'nothing')).toThrow(/^replay: quest\.nothing: /u);
    await r.stop();
  });

  it('answers the turns as live: a "too soon" holds the next one back (D98)', async () => {
    // The chat up to the "too soon", the clock at its answer.
    const r = await replay({
      plugins: [questPlugin()],
      inbounds: inbounds(QUEST_HTML).slice(0, 4),
    });
    const outbox = r.kit.core.outbox('telegram:owner').as('anyone');
    expect(outbox.held('@QuestBot', '/play')).toStrictEqual({
      until: T0 + 301 * S + 12 * MIN,
      reason: 'cooldown: cooldown',
    });
    expect(r.read(QUEST, 'rest')).toStrictEqual({
      until: T0 + 301 * S + 12 * MIN,
      why: 'it said too soon',
    });
    await r.stop();
  });

  it('runs a graph file, its telegram-user swapped, on the JSON export, live or as history', async () => {
    for (const playback of [false, true]) {
      const r = await replay({
        plugins: [questPlugin()],
        inbounds: inbounds(QUEST_JSON),
        graph: QUEST_GRAPH,
        playback,
        until: T0 + 4 * 3600 * S,
      });
      expect([...r.connectors.keys()]).toStrictEqual(['alice-account']);
      expect(r.connectors.get('alice-account')?.account).toBe('telegram:alice');
      expect(r.connectors.get('alice-account')?.self()).toBe('alice');
      expect(turns(r.records())).toStrictEqual(
        EXPECTED.map((e) => (playback ? { ...e, playback: true } : e))
      );
      expect(r.drift()[0]).toMatchObject({ read: 3, unread: 1 });
      // The clock ran on: every rest is over.
      expect(r.kit.clock.now()).toBe(T0 + 4 * 3600 * S);
      expect(r.read(QUEST, 'rest')).toBeUndefined();
      await r.stop();
    }
  });

  it("delivers only what a node's chats list, named as listed", async () => {
    const all = inbounds(QUEST_JSON);
    const r = await replay({
      plugins: [questPlugin()],
      inbounds: all,
      graph: (defaults) => ({
        ...defaults,
        nodes: defaults.nodes.map((n) =>
          n.plugin === 'telegram-user' ? { ...n, config: { chats: ['1000000001'] } } : n
        ),
        edges: defaults.edges.map((e) => ({ ...e, reads: ['1000000001'] })),
      }),
    });
    // The private chat's messages alone, under the id the config lists.
    expect(r.delivered).toBe(6);
    expect(turns(r.records()).map((e) => [e.chat, e.kind])).toStrictEqual([
      ['1000000001', 'gain'],
      ['1000000001', 'nothing'],
      ['1000000001', 'unknown'],
    ]);
    await r.stop();
  });

  it('routes each message to the node of its account, and refuses one of none', async () => {
    const bot = new FakeConnector({ account: 'telegram:bot' });
    const two = (defaults: Graph): GraphInput => ({
      ...defaults,
      nodes: [
        ...defaults.nodes,
        { id: 'second', plugin: 'telegram-user', account: 'telegram:alice' },
      ],
    });
    const plugins = [questPlugin(), fakeConnectorPlugin('telegram-bot', bot)];
    const r = await replay({ plugins, inbounds: inbounds(QUEST_HTML), graph: two });
    // The default node is the owner's account, the second alice's: the messages are alice's.
    expect(r.connectors.size).toBe(2);
    expect(r.delivered).toBe(11);
    await r.stop();
    await expect(
      replay({
        plugins,
        inbounds: inbounds(QUEST_HTML).map((m) => ({ ...m, account: 'telegram:carol' })),
        graph: two,
      })
    ).rejects.toThrow(
      /^replay: message 100 is of telegram:carol, and the graph's telegram-user nodes are of /u
    );
  });

  it('starts where it is told, with nothing to feed', async () => {
    const r = await replay({ plugins: [questPlugin()], inbounds: [], start: T0, until: T0 + MIN });
    expect(r.kit.clock.now()).toBe(T0 + MIN);
    expect(r.delivered).toBe(0);
    expect(r.connectors.get('telegram-user')?.self()).toBe('owner');
    await r.stop();
    const empty = await replay({ plugins: [], inbounds: [], graph: { version: 2, nodes: [] } });
    expect(empty.kit.clock.now()).toBe(0);
    expect(empty.sent()).toStrictEqual([]);
    await empty.stop();
  });

  it('acts through the contract, as the owner does', async () => {
    const r = await replay({ plugins: [questPlugin()], inbounds: [], start: T0 });
    await r.act(QUEST, 'sent', { chat: `@${QUESTBOT}`, t: T0 });
    expect(r.read(QUEST, 'lastTurn')).toStrictEqual({ t: T0 });
    await r.stop();
  });
});

describe('asMonitored', () => {
  const m = { chat: '@QuestBot', aliases: ['1000000001'] } as unknown as Inbound;
  it("names a chat as a node's config lists it", () => {
    expect(asMonitored(m, undefined)).toBe(m);
    expect(asMonitored(m, ['-1001'])).toBeUndefined();
    expect(asMonitored(m, ['1000000001'])).toStrictEqual({
      chat: '1000000001',
      aliases: ['@QuestBot'],
    });
    expect(asMonitored(m, ['@questbot'])).toStrictEqual({
      chat: '@questbot',
      aliases: ['1000000001'],
    });
    expect(asMonitored({ chat: '@QuestBot' } as unknown as Inbound, ['@QuestBot'])).toStrictEqual({
      chat: '@QuestBot',
    });
  });
});
