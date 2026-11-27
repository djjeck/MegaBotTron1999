import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  type BusEvent,
  Core,
  FakeConnector,
  fakeConnectorPlugin,
  GraphFile,
  type Plugin,
  type Store,
  VirtualClock,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CommandMechanics } from '#src/readiness.ts';
import { readinessPlugin } from '#src/state-plugin.ts';
import { runParser, T0 } from '#test/parser-run.ts';
import {
  QUEST,
  QUEST_READY,
  QUESTBOT,
  questGamePlugin,
  questPlugin,
  questReadyPlugin,
} from '#test/quest.ts';
import {
  type BotMessage,
  commandOf,
  isPrivate,
  isTurnCommand,
  PARSED_DOC,
  turnParserPlugin,
  type TurnParserSpec,
  type TurnReading,
  vocabularyProblem,
} from './turn-parser.ts';

const GROUP = '-1001000000001';
const MIN = 60_000;
const PRIVATE = `@${QUESTBOT}`;
const PRIVATE_ID = '1000000001';
const bot = { senderUsername: QUESTBOT };
const own = { senderUsername: 'alice', own: true };

/** A readiness state on @QuestBot's parser (bot-os.md D141), of a vocabulary and its mechanics. */
const stateOf = (
  spec: Pick<TurnParserSpec, 'turnCommands' | 'commands'> = { turnCommands: ['/play'] },
  mechanics?: Record<string, CommandMechanics>
): Plugin =>
  readinessPlugin({
    id: QUEST_READY,
    parser: { id: QUEST, bot: QUESTBOT, ...spec },
    ...(mechanics === undefined ? {} : { mechanics }),
  });

/** A turn parser of @QuestBot's on alice's account, with a readiness state on it. */
const run = (
  plugin: Plugin = questPlugin(),
  group?: string,
  state: Plugin = stateOf(),
  documents?: Record<string, Record<string, unknown>>
) => runParser(plugin, {}, group, documents, state);

/** The sends it published (D141): chat, command, by hand, id. */
const sends = (p: { all: BusEvent[] }) =>
  p.all
    .filter((e) => e.type === `${QUEST}.sent`)
    .map((e) => [e['chat'], e['command'], e['byHand'], e['id']]);

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
    const p = await run(questPlugin(['/quest']), GROUP, stateOf({ turnCommands: ['/quest'] }));
    const hand = p.hear({ ...own, chat: GROUP, text: `/quest@${QUESTBOT}` });
    p.hear({ ...bot, chat: GROUP, replyTo: hand, text: 'Found an apple.' });
    p.hear({ ...bot, chat: GROUP, replyTo: '1', text: 'Found a pear.' });
    // Another command, and another sender's message, are none of its business.
    const other = p.hear({ ...own, chat: GROUP, text: '/inventory' });
    p.hear({ ...bot, chat: GROUP, replyTo: other, text: 'Found a plum.' });
    p.hear({ senderUsername: 'someone', chat: GROUP, replyTo: hand, text: 'Found a fig.' });
    expect(p.events).toEqual([
      {
        type: 'quest.turn',
        t: T0,
        instance: 'quest',
        chat: GROUP,
        outcome: { kind: 'gain', bot: QUESTBOT, item: 'an apple' },
        // The rest it starts, when its next turn may go (D98).
        retryAt: T0 + 15 * MIN,
        // It answers the owner's send (D141).
        answer: { length: 15 },
      },
    ]);
    expect(sends(p)).toEqual([[GROUP, '/quest', true, hand]]);
    // Its state reduces them to the turn's readiness (D141).
    expect(p.iface.rest()).toMatchObject({ until: T0 + 15 * MIN, why: 'its rest after a turn' });
    expect(p.drift()).toMatchObject({ read: 1, unread: 0 });
  });

  it("publishes the owner's sends, by hand or a player's, in private or in the group (D129, D141)", async () => {
    const p = await run(questPlugin(), GROUP);
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.kit.clock.advance(MIN);
    const inGroup = p.hear({ ...own, chat: GROUP, text: `/play@${QUESTBOT}` });
    await p.iface.sent({ chat: PRIVATE, t: T0 + 2 * MIN });
    expect(sends(p)).toEqual([
      [PRIVATE, '/play', true, '1000'],
      [GROUP, '/play', true, inGroup],
      [PRIVATE, '/play', false, undefined],
    ]);
    expect(p.iface.ready()['/play']?.sent).toEqual({ t: T0 + 2 * MIN, byHand: false });
    await p.kit.stop();
  });

  it('counts a send told of it only where it reaches its bot, bare or addressed (D139)', async () => {
    const p = await run(questPlugin(), GROUP);
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    // Not its bot's: another bot's private chat, a group it does not read, another bot's command.
    await p.iface.sent({ chat: '@LoreBot', id: '1', t: T0, command: '/play' });
    await p.iface.sent({ chat: '-1009999999999', id: '2', t: T0, command: '/play' });
    await p.iface.sent({ chat: GROUP, id: '3', t: T0, command: '/play@LoreBot' });
    expect(sends(p)).toEqual([]);
    // Bare in the group it reads, or addressed to its bot: its turn, which its bot's reply answers.
    await p.iface.sent({ chat: GROUP, id: '4', t: T0, command: '/play' });
    expect(sends(p)).toEqual([[GROUP, '/play', false, '4']]);
    // Told twice, counted once.
    await p.iface.sent({ chat: GROUP, id: '4', t: T0, command: '/play' });
    expect(sends(p)).toHaveLength(1);
    p.hear({ senderUsername: QUESTBOT, chat: GROUP, replyTo: '4', text: 'Found an apple.' });
    expect(p.iface.rest()).toMatchObject({ until: T0 + 15 * MIN });
    p.kit.clock.advance(MIN);
    await p.iface.sent({ chat: GROUP, id: '5', t: T0 + MIN, command: `/Play@${QUESTBOT}` });
    expect(sends(p).at(-1)).toEqual([GROUP, '/play', false, '5']);
    // Its answers hold back no form at the outbox (D142): the state holds the turn.
    expect(outbox.held(GROUP, `/play@${QUESTBOT}`)).toBeUndefined();
    expect(outbox.held(GROUP, '/play')).toBeUndefined();
    await p.kit.stop();
  });

  it('answers a turn (D98): a too soon refuses it, any other reading takes it; the outbox holds nothing (D142)', async () => {
    const p = await run();
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Too soon: 20 minutes.' });
    expect(outbox.held(PRIVATE, '/play')).toBeUndefined();
    // The state holds it, from the wait the event states.
    expect(p.iface.rest()).toMatchObject({ until: T0 + 20 * MIN });
    p.kit.clock.advance(20 * MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found a pear.' });
    expect(outbox.held(PRIVATE, '/play')).toBeUndefined();
    expect(p.iface.rest()).toMatchObject({ until: T0 + 35 * MIN });
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
    // The owner by name and by id (D167), as the account knows them.
    expect(seen.map((m) => [m.self, m.selfId])).toEqual([
      ['alice', '1001'],
      ['alice', '1001'],
    ]);
  });

  it('marks what it reads of a message played back as history (D83)', async () => {
    const p = await run();
    p.hear({ ...own, chat: PRIVATE, text: '/play', playback: true });
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
    expect(p.all.filter((e) => e.type === 'quest.sent').map((e) => e['playback'])).toEqual([
      true,
      undefined,
      undefined,
    ]);
    // The owner's summary counts the news alone (D92).
    const now = p.kit.clock.now();
    expect(
      p.kit.core
        .summary({ since: now, until: now + 1 })
        .find((x) => x.node === QUEST)
        ?.lines.map((l) => l.text)
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
    expect(parsed).toStrictEqual({
      sends: [{ chat: PRIVATE, id: '5', t: T0, answered: true, command: '/play', byHand: false }],
    });
    // The next start: its sends kept, and a reply missed while down is read and paired.
    const next = await run(questPlugin(), undefined, stateOf(), { [QUEST]: { parsed } });
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
    expect(next.events[0]).toMatchObject({ answer: { length: 15 } });
    // Another sender in the private chat is not its edge's to hear.
    next.hear({ senderUsername: 'someone', chat: PRIVATE, replyTo: '6', text: 'Found a fig.' });
    expect(next.outcomes()).toEqual(['gain']);
  });

  it('reads nothing of the group without one', async () => {
    const p = await run();
    const hand = p.hear({ ...own, chat: GROUP, text: '/play' });
    p.hear({ ...bot, chat: GROUP, replyTo: hand, text: 'Found an apple.' });
    expect(p.events).toEqual([]);
  });

  it('matches the first message in private within two minutes, once', async () => {
    const p = await run();
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Defeated.' });
    // Only the first answers the turn.
    p.hear({ ...bot, chat: PRIVATE, text: 'Something else' });
    // A turn sent by its player, twice told; its answer comes too late.
    await p.iface.sent({ chat: PRIVATE, id: '77', t: p.kit.clock.now() });
    await p.iface.sent({ chat: PRIVATE, id: '77', t: p.kit.clock.now() });
    p.kit.runUntil(T0 + 3 * MIN);
    p.hear({ ...bot, chat: PRIVATE, text: 'Later' });
    expect(p.outcomes()).toEqual(['nothing']);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 30 * MIN, why: 'defeated' });
  });

  it('claims an answer it cannot read, reports it to drift and publishes it unknown', async () => {
    const p = await run();
    await p.iface.sent({ chat: PRIVATE, id: '5', t: p.kit.clock.now() });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '5', text: ' Level 5! ' });
    expect(p.events[0]).toMatchObject({
      chat: PRIVATE,
      outcome: { kind: 'unknown', bot: QUESTBOT, text: 'Level 5!' },
      answer: { length: 8 },
    });
    expect(p.drift()).toMatchObject({ read: 0, unread: 1 });
    // Its state records the answer, and holds nothing.
    expect(p.iface.ready()['/play']).toMatchObject({ ready: true, answer: { t: T0, length: 8 } });
    const now = p.kit.clock.now();
    expect(
      p.kit.core
        .summary({ since: now, until: now + 1 })
        .find((x) => x.node === QUEST)
        ?.lines.map((l) => l.text)
    ).toEqual(['1 answer to turns read: 1 unknown']);
    expect(p.kit.core.summary({ since: now + 1, until: now + 2 })).toEqual([]);
  });

  it('publishes a message its grammar leaves that answers a send, as a reply (D141)', async () => {
    const plugin = turnParserPlugin({
      id: QUEST,
      bot: QUESTBOT,
      description: 'x',
      turnCommands: ['/play'],
      read: () => undefined,
    });
    const p = await run(plugin);
    p.hear({ ...bot, chat: PRIVATE, text: 'Hello' });
    await p.iface.sent({ chat: PRIVATE, id: '5', t: T0 });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '5', text: 'Wait.' });
    expect(p.all.filter((e) => e.type === 'quest.reply')).toMatchObject([
      { chat: PRIVATE, command: '/play', answer: { length: 5 } },
    ]);
    expect(p.iface.ready()['/play']).toMatchObject({ ready: true, answer: { length: 5 } });
  });

  it('knows a private chat named by id by what its connector says, not by its name (D90)', async () => {
    const seen: boolean[] = [];
    // The picker keeps the bot's private chat by its id: the edge reads it so.
    const p = await run(questPlugin(), PRIVATE_ID);
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
    const q = await run(spy, '@PublicGroup');
    q.hear({ ...bot, chat: '@PublicGroup', private: false, text: 'Hi' });
    q.hear({ ...bot, ...inPrivate, chat: PRIVATE, aliases: [PRIVATE_ID], text: 'Hi' });
    // A connector that does not say: a `@username` is a private chat.
    q.hear({ ...bot, chat: PRIVATE, text: 'Hi' });
    expect(seen).toEqual([false, true, true]);
  });

  it('in private, reads a reply to a turn it does not know; its state keeps the longest rest', async () => {
    const p = await run();
    p.hear({ ...bot, chat: PRIVATE, replyTo: '9', text: 'Too soon: 40 minutes.' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '10', text: 'Found an apple.' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '11', text: 'Unreadable' });
    expect(p.outcomes()).toEqual(['nothing', 'gain']);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 40 * MIN, why: 'it said too soon' });
    p.kit.runUntil(T0 + 41 * MIN);
    expect(p.iface.rest()).toBeUndefined();
  });

  it('offers no readiness of its own: only the sends it is told of (D141)', () => {
    const { manifest } = questGamePlugin();
    expect(manifest.interface?.state).toBeUndefined();
    expect(Object.keys(manifest.interface?.actions ?? {})).toEqual(['sent']);
    expect(manifest.botCommands).toBeUndefined();
    expect(Object.keys(manifest.events ?? {})).toEqual([
      'quest.sent',
      'quest.turn',
      'quest.answer',
      'quest.reply',
    ]);
    // Turns alone, no answer event.
    expect(Object.keys(questPlugin().manifest.events ?? {})).not.toContain('quest.answer');
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
      const hear = (m: { senderUsername: string; own?: boolean; text: string }): void =>
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

describe('its other commands, as events its state reduces (bot-os.md D132, D141)', () => {
  const game = () => run(questGamePlugin(), undefined, questReadyPlugin());
  const at = (p: Awaited<ReturnType<typeof run>>, c: string) => p.iface.ready()[c];

  it('publishes an answer that announces an unlock with it, which the state takes', async () => {
    const p = await game();
    expect(p.iface.ready()).toEqual({
      '/play': { ready: true },
      '/daily': { ready: true },
      '/chest': { ready: false, why: 'waits for an unlock' },
      '/coffee': { ready: true },
    });
    // A turn by hand, whose answer announces a chest: the turn rests, the chest is ready.
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found an apple.\nA chest appears!' });
    expect(p.events.at(-1)).toMatchObject({ type: 'quest.turn', unlocks: ['/chest'] });
    expect(at(p, '/play')).toEqual({
      ready: false,
      until: T0 + 15 * MIN,
      why: 'its rest after a turn',
      sent: { t: T0, byHand: true },
      answer: { t: T0, length: 32 },
    });
    expect(at(p, '/chest')).toEqual({ ready: true, since: T0 });
    // A message no grammar reads that announces it: published as a reply.
    p.hear({ ...bot, chat: PRIVATE, text: 'A chest appears!' });
    expect(p.all.at(-1)).toMatchObject({ type: 'quest.reply', unlocks: ['/chest'] });
    expect(p.all.at(-1)).not.toHaveProperty('answer');
    await p.kit.stop();
  });

  it('reads another command’s answer as its own event, with the wait it states', async () => {
    const p = await game();
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
    // The daily: its cooldown is its state's; a "come back" holds it for the wait it says, in the
    // state alone (D142), and refuses it.
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Daily reward: 5 coins.' });
    expect(at(p, '/daily')).toMatchObject({
      ready: false,
      until: T0 + 24 * 60 * MIN,
      why: 'its cooldown',
    });
    expect(p.events.at(-1)).not.toHaveProperty('retryAt');
    p.kit.clock.advance(MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Come back in 30 minutes.' });
    expect(at(p, '/daily')).toMatchObject({ until: T0 + 31 * MIN, why: 'it said too soon' });
    expect(outbox.held(PRIVATE, '/daily')).toBeUndefined();
    // Neither is a turn: the turn's readiness is as it was.
    expect(at(p, '/play')).toEqual({ ready: true });
    // Its unlock lapses after 30 minutes.
    p.hear({ ...bot, chat: PRIVATE, text: 'A chest appears!' });
    p.kit.clock.advance(30 * MIN);
    expect(at(p, '/chest')).toMatchObject({ ready: false, why: 'its unlock lapsed' });
    await p.kit.stop();
  });

  it('publishes an effect the bot announces, which the state ends its hold on', async () => {
    const p = await game();
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Defeated.' });
    expect(p.iface.rest()?.until).toBe(T0 + 30 * MIN);
    expect(outbox.held(PRIVATE, '/play')).toBeUndefined();
    p.kit.clock.advance(MIN);
    p.hear({ ...own, chat: PRIVATE, text: '/coffee' });
    p.hear({ ...bot, chat: PRIVATE, text: 'You drink a coffee: rested.' });
    expect(at(p, '/play')).toMatchObject({ ready: true, since: T0 + MIN });
    expect(p.iface.rest()).toBeUndefined();
    expect(outbox.held(PRIVATE, '/play')).toBeUndefined();
    expect(at(p, '/coffee')).toMatchObject({ ready: false, until: T0 + 61 * MIN });
    expect(p.events.at(-1)).toMatchObject({
      command: '/coffee',
      effects: [{ command: '/play', clear: true }],
    });
    expect(p.events.at(-1)).not.toHaveProperty('holds');
    await p.kit.stop();
  });

  it('publishes the unlocks and effects a reading names, by name', async () => {
    const vocabulary = {
      turnCommands: ['/play'],
      commands: { '/chest': {}, '/daily': { aliases: ['/d'] } },
    };
    const plugin = turnParserPlugin({
      id: QUEST,
      bot: QUESTBOT,
      description: 'x',
      ...vocabulary,
      read: (m): TurnReading => {
        if (m.text === 'Found a map.')
          return {
            outcome: { kind: 'gain', bot: QUESTBOT },
            restMs: 15 * MIN,
            unlocks: ['/CHEST', '/nothing', '/play'],
            effects: [
              { command: '/d', shortenMin: 20 },
              { command: '/other', clear: true },
            ],
          };
        if (m.text === 'Shortcut.')
          return {
            outcome: { kind: 'gain', bot: QUESTBOT },
            effects: [{ command: '/play', shortenMin: 5 }],
          };
        if (m.command === '/daily' && m.text === 'Coins.')
          return { outcome: { kind: 'gain', bot: QUESTBOT }, restMs: 60 * MIN };
        return m.answers ? { unread: true } : undefined;
      },
    });
    const p = await run(plugin, undefined, stateOf(vocabulary, { '/chest': { unlock: {} } }));
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    p.hear({ ...own, chat: PRIVATE, text: '/daily' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Coins.' });
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Found a map.' });
    expect(p.events.at(-1)).toMatchObject({
      unlocks: ['/chest'],
      effects: [{ command: '/daily', shortenMin: 20 }],
    });
    expect(at(p, '/chest')).toEqual({ ready: true, since: T0 });
    expect(at(p, '/daily')).toMatchObject({
      until: T0 + 40 * MIN,
      why: 'its rest after a turn, cut by /play',
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
    const before = p.all.length;
    await p.iface.sent({ chat: PRIVATE, t: T0, command: '/unknown' });
    expect(p.all).toHaveLength(before);
    await p.kit.stop();
  });

  it('refuses a vocabulary that is wrong (D140)', () => {
    const problem = (commands: TurnParserSpec['commands'], turnCommands = ['/play']) =>
      vocabularyProblem({
        bot: 'XBot',
        turnCommands,
        ...(commands === undefined ? {} : { commands }),
      });
    expect(problem({ '/Play': {} })).toBe('/play names two commands, or one twice');
    expect(problem({ daily: {} })).toBe('daily is not a command, as /daily');
    expect(problem({ '/d': { announcedBy: '(' } })).toContain('announcedBy:');
    expect(problem({ '/d': { aliases: ['d'] } })).toContain('its alias d is not a command');
    expect(problem({ '/d': { aliases: ['/PLAY'] } })).toBe(
      '/play names two commands, or one twice'
    );
    expect(problem({ '/d': {}, '/e': { aliases: ['/d'] } })).toContain('/d names two');
    expect(problem(undefined, ['/play', '/Play'])).toContain('/play names two');
    expect(problem(undefined)).toBeUndefined();
    expect(() =>
      turnParserPlugin({
        id: 'x',
        bot: 'XBot',
        description: 'x',
        turnCommands: ['/play'],
        commands: { daily: {} },
        read: () => undefined,
      })
    ).toThrow('turn parser x: daily is not a command, as /daily');
  });
});

describe('commandOf', () => {
  it('names the command a text is, as its list spells it', () => {
    expect(commandOf('/DAILY@questbot', ['/play', '/daily'], 'QuestBot')).toBe('/daily');
    expect(commandOf('/daily@other', ['/daily'], 'QuestBot')).toBeUndefined();
    expect(commandOf('hello', ['/daily'], 'QuestBot')).toBeUndefined();
  });

  it('names an alias’s command by its name (D140)', () => {
    const commands = [{ command: '/play', aliases: ['/quest'] }, { command: '/boost' }];
    expect(commandOf('/Quest@QuestBot', commands, 'QuestBot')).toBe('/play');
    expect(commandOf('/boost', commands, 'QuestBot')).toBe('/boost');
    expect(commandOf('/b', commands, 'QuestBot')).toBeUndefined();
  });
});

describe('a command’s aliases (bot-os.md D140)', () => {
  const vocabulary = {
    turnCommands: ['/play', '/quest'],
    commands: { '/boost': { aliases: ['/b'] } },
  };
  const plugin = () =>
    turnParserPlugin({
      id: QUEST,
      bot: QUESTBOT,
      description: 'x',
      ...vocabulary,
      read: (m): TurnReading => {
        if (!m.answers) return undefined;
        if (m.text === 'Found an apple.')
          return { outcome: { kind: 'gain', bot: QUESTBOT }, restMs: 15 * MIN };
        // The bot says the turn's rest is over, naming it by an alias.
        if (m.text === 'Boosted.')
          return {
            outcome: { kind: 'boost', bot: QUESTBOT },
            effects: [{ command: '/quest', clear: true }],
          };
        return { unread: true };
      },
    });
  // Its effect names the turn by an alias: its name, resolved.
  const state = () =>
    stateOf(vocabulary, {
      '/boost': { cooldownMin: 60, effects: [{ command: '/quest', clear: true }] },
    });

  it('keeps one state per command, whichever alias is sent, bare or addressed', async () => {
    const p = await run(plugin(), GROUP, state());
    const outbox = p.kit.core.outbox('telegram:alice').as('anyone');
    const sent = p.hear({ ...own, chat: GROUP, text: '/quest' });
    p.hear({ ...bot, chat: GROUP, replyTo: sent, text: 'Found an apple.' });
    expect(Object.keys(p.iface.ready())).toEqual(['/play', '/boost']);
    expect(p.iface.ready()['/play']).toMatchObject({
      ready: false,
      until: T0 + 15 * MIN,
      sent: { t: T0, byHand: true },
      answer: { t: T0 },
    });
    // The state holds the turn, not the outbox (D142), whichever form goes.
    for (const form of ['/play', '/quest', `/play@${QUESTBOT}`, `/quest@${QUESTBOT}`])
      expect(outbox.held(GROUP, form)).toBeUndefined();
    // The boost by its alias, addressed: the boost's state; it ends the turn's rest, every form.
    p.kit.clock.advance(MIN);
    await p.iface.sent({ chat: GROUP, id: '7', t: T0 + MIN, command: `/b@${QUESTBOT}` });
    p.hear({ ...bot, chat: GROUP, replyTo: '7', text: 'Boosted.' });
    expect(p.iface.ready()['/boost']).toMatchObject({
      ready: false,
      until: T0 + 61 * MIN,
      sent: { t: T0 + MIN, byHand: false },
    });
    expect(p.iface.ready()['/play']).toMatchObject({ ready: true, since: T0 + MIN });
    expect(p.events.at(-1)).toMatchObject({
      command: '/boost',
      effects: [{ command: '/play', clear: true }],
    });
    for (const form of ['/play', '/quest', `/play@${QUESTBOT}`, `/quest@${QUESTBOT}`])
      expect(outbox.held(GROUP, form)).toBeUndefined();
    await p.kit.stop();
  });
});
