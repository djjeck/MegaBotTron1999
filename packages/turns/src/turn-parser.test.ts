import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  Core,
  FakeConnector,
  fakeConnectorPlugin,
  GraphFile,
  type Store,
  VirtualClock,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runParser as run, T0 } from '#test/parser-run.ts';
import { QUEST, QUESTBOT, questGamePlugin, questPlugin } from '#test/quest.ts';
import {
  type BotMessage,
  commandOf,
  isPrivate,
  isTurnCommand,
  PARSED_DOC,
  turnParserPlugin,
  type TurnParserSpec,
  type TurnReading,
} from './turn-parser.ts';

const GROUP = '-1001000000001';
const MIN = 60_000;
const PRIVATE = `@${QUESTBOT}`;
const PRIVATE_ID = '1000000001';
const bot = { sender: QUESTBOT };
const own = { sender: 'alice', own: true };

describe('isTurnCommand', () => {
  it('knows a turn command bare or addressed to its bot, in any case', () => {
    expect(isTurnCommand('/quest', ['/quest'], 'QuestBot')).toBe(true);
    expect(isTurnCommand(' /Quest@questbot ', ['/quest'], 'QuestBot')).toBe(true);
    expect(isTurnCommand('/quest@OtherBot', ['/quest'], 'QuestBot')).toBe(false);
    expect(isTurnCommand('/lore', ['/quest'], 'QuestBot')).toBe(false);
    expect(isTurnCommand('/quest now', ['/quest'], 'QuestBot')).toBe(false);
  });
});

describe('isPrivate', () => {
  it("takes the connector's word, else a `@username`'s shape", () => {
    expect(isPrivate({ chat: PRIVATE_ID, private: true })).toBe(true);
    expect(isPrivate({ chat: '@PublicGroup', private: false })).toBe(false);
    expect(isPrivate({ chat: PRIVATE })).toBe(true);
    expect(isPrivate({ chat: GROUP })).toBe(false);
  });
});

describe('a turn parser', () => {
  it("reads the replies to the owner's turns in the group, by hand, and no one else's", async () => {
    const p = await run(questPlugin(['/quest']), {}, GROUP);
    const hand = p.hear({ ...own, chat: GROUP, text: `/quest@${QUESTBOT}` });
    p.hear({ ...bot, chat: GROUP, replyTo: hand, text: 'Found an apple.' });
    p.hear({ ...bot, chat: GROUP, replyTo: '1', text: 'Found a pear.' });
    // Another command, and another sender's message, are none of its business.
    const other = p.hear({ ...own, chat: GROUP, text: '/inventory' });
    p.hear({ ...bot, chat: GROUP, replyTo: other, text: 'Found a plum.' });
    p.hear({ sender: 'someone', chat: GROUP, replyTo: hand, text: 'Found a fig.' });
    expect(p.events).toEqual([
      {
        type: 'quest.turn',
        t: T0,
        instance: 'quest',
        chat: GROUP,
        outcome: { kind: 'gain', bot: QUESTBOT, item: 'an apple' },
        // The rest it starts, when its next turn may go (D98).
        retryAt: T0 + 15 * MIN,
      },
    ]);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 15 * MIN, why: 'its rest after a turn' });
    expect(p.drift()).toMatchObject({ read: 1, unread: 0 });
  });

  it("tells the owner's last turn, by hand or its actor's, in private or in the group (D99, D129)", async () => {
    const p = await run(questPlugin(), {}, GROUP);
    const last = () => {
      const r = p.kit.core.controls.read(QUEST, 'lastTurn');
      return 'value' in r ? r.value : r;
    };
    expect(last()).toBeUndefined();
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    expect(last()).toEqual({ t: T0, id: '1000' });
    p.kit.clock.advance(MIN);
    const inGroup = p.hear({ ...own, chat: GROUP, text: `/play@${QUESTBOT}` });
    expect(last()).toEqual({ t: T0 + MIN, id: inGroup });
    p.iface.sent({ chat: PRIVATE, t: T0 + 2 * MIN });
    expect(last()).toEqual({ t: T0 + 2 * MIN });
    await p.kit.stop();
  });

  it("answers a turn (D98): a too soon refuses it, its rest holds the bot's turns back", async () => {
    const p = await run(questPlugin());
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Too soon: 20 minutes.' });
    expect(outbox.held(PRIVATE, '/play')).toEqual({
      until: T0 + 20 * MIN,
      reason: 'cooldown: cooldown',
    });
    p.kit.clock.advance(20 * MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found a pear.' });
    expect(outbox.held(PRIVATE, '/play')).toEqual({
      until: T0 + 35 * MIN,
      reason: 'cooldown: rest',
    });
    // Unread, it answers nothing: the rest stays as it was.
    p.kit.clock.advance(15 * MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'The sky is green.' });
    expect(outbox.held(PRIVATE, '/play')).toBeUndefined();
    await p.kit.stop();
  });

  it("hands its grammar a message's file with its caption (D82)", async () => {
    const seen: BotMessage[] = [];
    const plugin = turnParserPlugin({
      id: QUEST,
      bot: QUESTBOT,
      description: 'x',
      turnCommands: ['/play'],
      read: (m) => (seen.push(m), undefined),
    });
    const p = await run(plugin);
    const document = { name: 'bag.txt', mime: 'text/plain', size: 12, text: '- 1 x Pebble' };
    p.hear({ ...bot, chat: PRIVATE, text: 'Your bag', document });
    p.hear({ ...bot, chat: PRIVATE, text: 'Hello' });
    expect(seen.map((m) => [m.text, m.document])).toEqual([
      ['Your bag', document],
      ['Hello', undefined],
    ]);
  });

  it('marks what it reads of a message played back as history (D83)', async () => {
    const p = await run(questPlugin());
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found a fig.', playback: true, missed: true });
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Something odd.', playback: true });
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found a pear.' });
    expect(p.events.map((e) => [e['outcome'], e['playback']])).toEqual([
      [{ kind: 'gain', bot: QUESTBOT, item: 'a fig' }, true],
      [{ kind: 'unknown', bot: QUESTBOT, text: 'Something odd.' }, true],
      [{ kind: 'gain', bot: QUESTBOT, item: 'a pear' }, undefined],
    ]);
    // The owner's summary counts the news alone (D92).
    const now = p.kit.clock.now();
    expect(
      p.kit.core.summary({ since: now, until: now + 1 }).find((x) => x.node === QUEST)?.lines
    ).toEqual(['1 answer to turns read: 1 gain']);
  });

  it('resumes from what it parsed, kept in its store, and reads missed messages as any', async () => {
    const plugin = questPlugin();
    const stores: Store[] = [];
    const first = await run({
      ...plugin,
      create: (ctx) => {
        stores.push(ctx.store);
        return plugin.create(ctx);
      },
    });
    await first.iface.sent({ chat: PRIVATE, id: '5', t: first.kit.clock.now() });
    first.hear({ ...bot, chat: PRIVATE, replyTo: '5', text: 'Too soon: 40 minutes.' });
    await first.kit.stop();
    const parsed = stores[0]?.read(PARSED_DOC);
    expect(parsed).toMatchObject({
      turns: [{ chat: PRIVATE, id: '5', answered: true }],
      rest: { until: T0 + 40 * MIN },
    });
    // The next start: its rest kept, its turns too, and a reply missed while down is read.
    const next = await run(questPlugin(), {}, undefined, { parsed });
    expect(next.iface.rest()).toMatchObject({ until: T0 + 40 * MIN, why: 'it said too soon' });
    await next.iface.sent({ chat: PRIVATE, id: '6', t: next.kit.clock.now() });
    next.hear({
      ...bot,
      chat: PRIVATE,
      replyTo: '6',
      text: 'Found an apple.',
      playback: true,
      missed: true,
    });
    expect(next.outcomes()).toEqual(['gain']);
    // Another sender in the private chat is not its edge's to hear.
    next.hear({ sender: 'someone', chat: PRIVATE, replyTo: '6', text: 'Found a fig.' });
    expect(next.outcomes()).toEqual(['gain']);
  });

  it('reads nothing of the group without one', async () => {
    const p = await run(questPlugin());
    const hand = p.hear({ ...own, chat: GROUP, text: '/play' });
    p.hear({ ...bot, chat: GROUP, replyTo: hand, text: 'Found an apple.' });
    expect(p.events).toEqual([]);
  });

  it('matches the first message in private within two minutes, once', async () => {
    const p = await run(questPlugin());
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Defeated.' });
    // Only the first answers the turn.
    p.hear({ ...bot, chat: PRIVATE, text: 'Something else' });
    // A turn sent by its actor, twice told; its answer comes too late.
    await p.iface.sent({ chat: PRIVATE, id: '77', t: p.kit.clock.now() });
    await p.iface.sent({ chat: PRIVATE, id: '77', t: p.kit.clock.now() });
    p.kit.runUntil(T0 + 3 * MIN);
    p.hear({ ...bot, chat: PRIVATE, text: 'Later' });
    expect(p.outcomes()).toEqual(['nothing']);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 30 * MIN, why: 'defeated' });
  });

  it('claims an answer it cannot read, reports it to drift and publishes it unknown', async () => {
    const p = await run(questPlugin());
    await p.iface.sent({ chat: PRIVATE, id: '5', t: p.kit.clock.now() });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '5', text: ' Level 5! ' });
    expect(p.events[0]).toMatchObject({
      chat: PRIVATE,
      outcome: { kind: 'unknown', bot: QUESTBOT, text: 'Level 5!' },
    });
    expect(p.drift()).toMatchObject({ read: 0, unread: 1 });
    const now = p.kit.clock.now();
    expect(
      p.kit.core.summary({ since: now, until: now + 1 }).find((x) => x.node === QUEST)?.lines
    ).toEqual(['1 answer to turns read: 1 unknown']);
    expect(p.kit.core.summary({ since: now + 1, until: now + 2 })).toEqual([]);
  });

  it('knows a private chat named by id by what its connector says, not by its name (D90)', async () => {
    const seen: boolean[] = [];
    // The picker keeps the bot's private chat by its id: the edge reads it so.
    const p = await run(questPlugin(), {}, PRIVATE_ID);
    const inPrivate = { chat: PRIVATE_ID, aliases: [PRIVATE], private: true };
    p.hear({ ...own, ...inPrivate, text: '/play' });
    // No reply-to: only a private chat's window matches it to the turn.
    p.hear({ ...bot, ...inPrivate, text: 'Found an apple.' });
    expect(p.outcomes()).toEqual(['gain']);
    // A public group named by `@username` is a group all the same.
    const spy = turnParserPlugin({
      id: QUEST,
      bot: QUESTBOT,
      description: 'x',
      turnCommands: ['/play'],
      read: (m) => (seen.push(m.private), undefined),
    });
    const q = await run(spy, {}, '@PublicGroup');
    q.hear({ ...bot, chat: '@PublicGroup', private: false, text: 'Hi' });
    q.hear({ ...bot, ...inPrivate, chat: PRIVATE, aliases: [PRIVATE_ID], text: 'Hi' });
    // A connector that does not say: a `@username` is a private chat.
    q.hear({ ...bot, chat: PRIVATE, text: 'Hi' });
    expect(seen).toEqual([false, true, true]);
  });

  it('in private, reads a reply to a turn it does not know, and keeps the longest rest', async () => {
    const p = await run(questPlugin());
    p.hear({ ...bot, chat: PRIVATE, replyTo: '9', text: 'Too soon: 40 minutes.' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '10', text: 'Found an apple.' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '11', text: 'Unreadable' });
    expect(p.outcomes()).toEqual(['nothing', 'gain']);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 40 * MIN, why: 'it said too soon' });
    p.kit.runUntil(T0 + 41 * MIN);
    expect(p.iface.rest()).toBeUndefined();
  });
});

describe('its turn commands, its game’s (bot-os.md D70)', () => {
  it('come from its spec, and it has no config', () => {
    const { manifest } = questPlugin(['/quest']);
    expect(manifest.config).toBeUndefined();
    // Its event type says what it is, for the editor's list of what it publishes (D71).
    expect(manifest.events?.['quest.turn']?.description).toBe(
      "What @QuestBot answered to a turn of the owner's, as its grammar reads it"
    );
    const spec = { id: 'x', bot: 'XBot', description: 'x', read: () => undefined };
    expect(() => turnParserPlugin({ ...spec, turnCommands: [] })).toThrow(
      'turn parser x: expected its turn commands, as /play, not []'
    );
    expect(() => turnParserPlugin({ ...spec, turnCommands: ['play'] })).toThrow('["play"]');
  });

  it('ignore a node’s config that still names commands, as a graph saved before does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-parser-'));
    try {
      // A version 2 graph, saved while the commands were the node's config.
      const graph = {
        version: 2,
        nodes: [
          { id: TELEGRAM_USER, plugin: TELEGRAM_USER, account: 'telegram:alice' },
          { id: QUEST, plugin: QUEST, config: { commands: ['/play'] } },
        ],
        edges: [
          {
            from: `${TELEGRAM_USER}.chat`,
            to: `${QUEST}.chat`,
            type: 'chat-in',
            reads: [PRIVATE],
            senders: [PRIVATE, 'me'],
          },
        ],
      };
      fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph));
      const account = new FakeConnector({ account: 'telegram:alice' });
      const turns: unknown[] = [];
      const core = new Core({
        clock: new VirtualClock(T0),
        graphFile: new GraphFile(dir),
        record: (r) => {
          if (r.type === 'quest.turn') turns.push(r['outcome']);
        },
      });
      core.register(fakeConnectorPlugin(TELEGRAM_USER, account), questPlugin(['/quest']));
      await core.start();
      expect(core.graphProblems()).toEqual([]);
      expect(core.status().map((s) => `${s.id} ${s.state}`)).toEqual([
        `${TELEGRAM_USER} running`,
        `${QUEST} running`,
      ]);
      // The file keeps the key, untouched; the parser counts its spec's commands alone.
      expect(core.graph()?.nodes[1]).toEqual(graph.nodes[1]);
      const hear = (m: { sender: string; own?: boolean; text: string }): void =>
        account.hear({ ...m, chat: PRIVATE, time: T0 });
      hear({ ...own, text: '/play' });
      hear({ ...bot, text: 'Found an apple.' });
      hear({ ...own, text: '/quest' });
      hear({ ...bot, text: 'Found a pear.' });
      expect(turns).toEqual([{ kind: 'gain', bot: QUESTBOT, item: 'a pear' }]);
      await core.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('each command’s readiness (bot-os.md D132)', () => {
  const at = (p: Awaited<ReturnType<typeof run>>, c: string) => p.iface.ready()[c];

  it('derives the turn’s from its rest, and tells the others’ from their mechanics', async () => {
    const p = await run(questGamePlugin());
    expect(p.iface.ready()).toEqual({
      '/play': { ready: true },
      '/daily': { ready: true },
      '/chest': { ready: false, why: 'waits for an unlock' },
      '/coffee': { ready: true },
    });
    // A turn by hand, whose answer announces a chest: the turn rests, the chest is ready.
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found an apple.\nA chest appears!' });
    expect(at(p, '/play')).toEqual({
      ready: false,
      until: T0 + 15 * MIN,
      why: 'its rest after a turn',
      sent: { t: T0, byHand: true },
      answer: { t: T0, length: 32 },
    });
    expect(at(p, '/chest')).toEqual({ ready: true, since: T0 });
    expect(p.iface.rest()).toMatchObject({ until: T0 + 15 * MIN });
    expect(p.outcomes()).toEqual(['gain']);
    await p.kit.stop();
  });

  it('reads another command’s answer as its own event, and holds it as its mechanics say', async () => {
    const p = await run(questGamePlugin());
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    // The chest, unlocked, then opened by its player: used up.
    p.hear({ ...bot, chat: PRIVATE, text: 'A chest appears!' });
    await p.iface.sent({ chat: PRIVATE, id: '7', t: T0, command: '/chest' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '7', text: 'The chest holds a gem.' });
    expect(at(p, '/chest')).toEqual({
      ready: false,
      why: 'waits for an unlock',
      sent: { t: T0, byHand: false },
      answer: { t: T0, length: 22 },
    });
    expect(p.events.at(-1)).toMatchObject({
      type: 'quest.answer',
      command: '/chest',
      outcome: { kind: 'gain', item: 'a gem' },
    });
    // The daily: once a day; a "come back" holds it for the wait it says, and refuses it.
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Daily reward: 5 coins.' });
    expect(at(p, '/daily')).toMatchObject({
      ready: false,
      until: T0 + 24 * 60 * MIN,
      why: 'its cooldown',
    });
    expect(outbox.held(PRIVATE, '/daily')?.until).toBe(T0 + 24 * 60 * MIN);
    p.kit.clock.advance(MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Come back in 30 minutes.' });
    expect(at(p, '/daily')).toMatchObject({ until: T0 + 31 * MIN, why: 'it said too soon' });
    expect(outbox.held(PRIVATE, '/daily')).toEqual({
      until: T0 + 24 * 60 * MIN,
      reason: 'cooldown: rest',
    });
    // Neither is a turn: the turn's readiness and the owner's last turn are as they were.
    expect(at(p, '/play')).toEqual({ ready: true });
    expect(p.kit.core.controls.read(QUEST, 'lastTurn')).toEqual({ value: undefined });
    // Its unlock lapses after 30 minutes.
    p.hear({ ...bot, chat: PRIVATE, text: 'A chest appears!' });
    p.kit.clock.advance(30 * MIN);
    expect(at(p, '/chest')).toMatchObject({ ready: false, why: 'its unlock lapsed' });
    await p.kit.stop();
  });

  it('ends the turn’s rest on a reset, in the outbox too, and the reset holds itself an hour', async () => {
    const p = await run(questGamePlugin());
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Defeated.' });
    expect(outbox.held(PRIVATE, '/play')?.until).toBe(T0 + 30 * MIN);
    p.kit.clock.advance(MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/coffee' });
    p.hear({ ...bot, chat: PRIVATE, text: 'You drink a coffee: rested.' });
    expect(at(p, '/play')).toMatchObject({ ready: true, since: T0 + MIN });
    expect(p.iface.rest()).toBeUndefined();
    expect(outbox.held(PRIVATE, '/play')).toBeUndefined();
    expect(at(p, '/coffee')).toMatchObject({ ready: false, until: T0 + 61 * MIN });
    expect(p.events.at(-1)).toMatchObject({
      command: '/coffee',
      holds: { '/play': T0 + MIN },
      retryAt: T0 + 61 * MIN,
    });
    // An effect on a command not held does nothing.
    p.kit.clock.advance(61 * MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/coffee' });
    p.hear({ ...bot, chat: PRIVATE, text: 'You drink a coffee: rested.' });
    expect(p.events.at(-1)).not.toHaveProperty('holds');
    await p.kit.stop();
  });

  it('takes the unlocks and effects a reading names, and an unread answer to drift', async () => {
    const plugin = turnParserPlugin({
      id: QUEST,
      bot: QUESTBOT,
      description: 'x',
      turnCommands: ['/play'],
      commands: { '/chest': { unlock: {} }, '/daily': { cooldownMin: 60 } },
      read: (m): TurnReading => {
        if (m.text === 'Found a map.')
          return {
            outcome: { kind: 'gain', bot: QUESTBOT },
            restMs: 15 * MIN,
            unlocks: ['/CHEST', '/nothing'],
            effects: [
              { command: '/daily', shortenMin: 20 },
              { command: '/other', clear: true },
            ],
          };
        if (m.text === 'Shortcut.')
          return {
            outcome: { kind: 'gain', bot: QUESTBOT },
            effects: [{ command: '/play', shortenMin: 5 }],
          };
        if (m.command === '/daily' && m.text === 'Coins.')
          return { outcome: { kind: 'gain', bot: QUESTBOT } };
        return m.answers ? { unread: true } : undefined;
      },
    });
    const p = await run(plugin);
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Coins.' });
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found a map.' });
    expect(at(p, '/chest')).toEqual({ ready: true, since: T0 });
    expect(at(p, '/daily')).toMatchObject({
      until: T0 + 40 * MIN,
      why: 'its cooldown, cut by /play',
    });
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Shortcut.' });
    expect(at(p, '/play')).toMatchObject({ until: T0 + 10 * MIN });
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Gibberish' });
    expect(p.events.at(-1)).toMatchObject({
      type: 'quest.answer',
      command: '/daily',
      outcome: { kind: 'unknown', text: 'Gibberish' },
    });
    expect(p.drift()).toMatchObject({ unread: 1 });
    // A send told for a command it does not know is none of its business.
    await p.iface.sent({ chat: PRIVATE, t: T0, command: '/unknown' });
    expect(at(p, '/play')?.sent?.byHand).toBe(true);
    await p.kit.stop();
  });

  it('keeps its commands’ state across a restart', async () => {
    const plugin = questGamePlugin();
    const stores: Store[] = [];
    const first = await run({
      ...plugin,
      create: (ctx) => {
        stores.push(ctx.store);
        return plugin.create(ctx);
      },
    });
    first.hear({ ...bot, chat: PRIVATE, text: 'A chest appears!' });
    await first.kit.stop();
    const next = await run(questGamePlugin(), {}, undefined, {
      parsed: stores[0]?.read(PARSED_DOC),
    });
    expect(next.iface.ready()['/chest']).toEqual({ ready: true, since: T0 });
    await next.kit.stop();
  });

  it('refuses a spec whose other commands are wrong', () => {
    const spec = {
      id: 'x',
      bot: 'XBot',
      description: 'x',
      turnCommands: ['/play'],
      read: () => undefined,
    };
    const problem = (commands: TurnParserSpec['commands']): string => {
      try {
        turnParserPlugin({ ...spec, ...(commands === undefined ? {} : { commands }) });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(problem({ '/Play': {} })).toBe(
      "turn parser x: /Play is a turn command: its readiness is the rest's"
    );
    expect(problem({ daily: {} })).toBe('turn parser x: daily is not a command, as /daily');
    expect(problem({ '/d': { cooldownMin: 0 } })).toContain('cooldownMin must be over 0');
    expect(problem({ '/d': { unlock: { forMin: -1 } } })).toContain('forMin must be over 0');
    expect(problem({ '/d': { unlock: { pattern: '(' } } })).toContain('unlock.pattern:');
    expect(problem({ '/d': { effects: [{ command: '/x', clear: true }] } })).toContain(
      'its effect names /x, not one of its commands'
    );
    expect(problem({ '/d': { effects: [{ command: '/play' }] } })).toContain('clears its command');
    expect(problem({ '/d': { effects: [{ command: '/play', shortenMin: 5 }] } })).toBe('');
    expect(problem(undefined)).toBe('');
  });
});

describe('its declared commands (bot-os.md D137)', () => {
  it('publishes them in its manifest and its read, the turns first, in the spec’s order', async () => {
    const plugin = turnParserPlugin({
      id: 'quest',
      bot: QUESTBOT,
      description: 'x',
      turnCommands: ['/play', '/go'],
      commands: {
        '/shop': { interactive: true },
        '/coffee': { cooldownMin: 60, effects: [{ command: '/play', clear: true }] },
        '/chest': { unlock: { pattern: 'A chest!' } },
        '/nap': { effects: [{ command: '/coffee', shortenMin: 5 }], unlock: { forMin: 5 } },
      },
      read: () => undefined,
    });
    const declared = [
      { command: '/play', turn: true },
      { command: '/go', turn: true },
      { command: '/shop', interactive: true },
      { command: '/coffee', cooldownMin: 60, effects: [{ command: '/play', clear: true }] },
      { command: '/chest', unlock: { pattern: 'A chest!' } },
      { command: '/nap', unlock: { forMin: 5 }, effects: [{ command: '/coffee', shortenMin: 5 }] },
    ];
    expect(plugin.manifest.botCommands).toEqual(declared);
    // Its read gives the same, for a player's defaults at run time; an interactive command is
    // tracked as any other.
    const p = await run(plugin);
    const r = p.kit.core.controls.read('quest', 'commands');
    expect('value' in r ? r.value : r).toEqual(declared);
    expect(p.iface.ready()['/shop']).toEqual({ ready: true });
    await p.kit.stop();
  });
});

describe('commandOf', () => {
  it('names the command a text is, as its list spells it', () => {
    expect(commandOf('/DAILY@questbot', ['/play', '/daily'], 'QuestBot')).toBe('/daily');
    expect(commandOf('/daily@other', ['/daily'], 'QuestBot')).toBeUndefined();
    expect(commandOf('hello', ['/daily'], 'QuestBot')).toBeUndefined();
  });
});
