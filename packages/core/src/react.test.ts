import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DevKit, FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import { fill, matches, react, REACT_MAX_AGE_MS, type Reaction, valueAt } from './react.ts';

const T0 = Date.UTC(2026, 10, 8, 12);
const BOT = '@QuestBot';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/**
 * A parser of a made-up game (`quest`), alice's faked account, and `watcher`, a plugin that hands
 * its context out for the test's reactions: its chat edge reads @QuestBot and #lobby, and sends
 * only `/look` to @QuestBot; a dry run through a dry-run edge, refused once `watcher` is stopped.
 */
async function run(state: 'live' | 'dry-run' | 'stopped' = 'live') {
  const account = new FakeConnector({ account: 'telegram:alice' });
  let quest: PluginContext | undefined;
  let watcher: PluginContext | undefined;
  const kit = new DevKit({
    start: T0,
    graph: (g) => ({
      ...g,
      edges: g.edges.map((e) =>
        e.type === 'chat-out' && state === 'dry-run' ? { ...e, dryRun: true } : e
      ),
    }),
    plugins: [
      fakeConnectorPlugin('tg', account),
      definePlugin({
        manifest: {
          id: 'quest',
          version: '0.1.0',
          kinds: ['parser'],
          description: 'reads @QuestBot',
          games: { registers: ['quest'] },
          events: {
            'quest.turn': z.object({
              chat: z.string(),
              outcome: z.record(z.string(), z.unknown()),
            }),
            'quest.other': z.object({}),
          },
        },
        create: (ctx) => {
          quest = ctx;
          return {};
        },
      }),
      definePlugin({
        manifest: {
          id: 'watcher',
          version: '0.1.0',
          kinds: ['actor'],
          description: 'reacts',
          inputs: {
            chat: {
              type: 'chat',
              bind: { node: 'tg', reads: [BOT, '#lobby'], sends: [BOT], commands: ['/look'] },
            },
            quest: { type: 'events', namespace: 'quest' },
          },
        },
        create: (ctx) => {
          watcher = ctx;
          return {};
        },
      }),
    ],
  });
  await kit.start();
  if (state === 'stopped') kit.core.stopNode('watcher', 'a safety stop', 'safety');
  account.open();
  const records = () =>
    kit.log
      .recordsSince(0, Number.MAX_SAFE_INTEGER)
      .filter((r) => r.type === 'watcher.reaction')
      .map(({ type: _, t: __, instance: ___, ...r }) => r);
  const sends = () =>
    kit.log
      .recordsSince(0, Number.MAX_SAFE_INTEGER)
      .filter((r) => r.type === 'core.send')
      .map((r) => `${String(r['outcome'])} ${String(r['origin'])}: ${String(r['text'])}`);
  return {
    kit,
    account,
    quest: quest as PluginContext,
    on: (r: Omit<Reaction, 'record'> & { record?: string }) =>
      react(watcher as PluginContext, { record: 'watcher.reaction', ...r }),
    records,
    sends,
  };
}

const gain = (item: string, sure = true) => ({
  chat: BOT,
  outcome: { kind: 'gain', bot: 'QuestBot', item, sure },
});

describe('a payload', () => {
  it('is read by dotted path, compared by when, and made into a text', () => {
    const p = { a: { b: [{ c: 'x' }] }, n: 0, f: false, o: null };
    expect(valueAt(p, 'a.b.0.c')).toBe('x');
    expect(valueAt(p, 'a.z')).toBeUndefined();
    expect(valueAt(p, 'n.x')).toBeUndefined();
    expect(matches(p, { 'a.b.0.c': 'x', n: 0, f: false, o: null })).toBe(true);
    expect(matches(p, { n: '0' })).toBe(false);
    expect(matches(p)).toBe(true);
    expect(fill('/look {a.b.0.c} {n} {f} {not a path}', p)).toEqual({
      text: '/look x 0 false {not a path}',
    });
    expect(fill('/look {a.b}', p)).toEqual({ missing: 'a.b' });
    expect(fill('/look {o} {gone}', p)).toEqual({ missing: 'o' });
    expect(fill((q) => `/look ${String(q['n'])}`, p)).toEqual({ text: '/look 0' });
    expect(fill(() => undefined, p)).toEqual({ missing: '(the function made no text)' });
  });
});

describe('react on an event', () => {
  it('sends through the outbox when the payload matches, and records each reaction', async () => {
    const { quest, on, records, sends, account } = await run();
    const stop = on({
      on: 'quest.turn',
      when: { 'outcome.kind': 'gain', 'outcome.sure': true },
      chat: BOT,
      send: '/look {outcome.item}',
      name: 'looker',
    });
    quest.bus.publish('quest.turn', gain('lantern'));
    quest.bus.publish('quest.turn', gain('rope', false));
    quest.bus.publish('quest.turn', { chat: BOT, outcome: { kind: 'nothing', bot: 'QuestBot' } });
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look lantern' }]);
    expect(sends()).toEqual(['sent looker: /look lantern']);
    expect(records()).toEqual([
      { reaction: 'looker', on: 'quest.turn', outcome: 'sent', chat: BOT, text: '/look lantern' },
    ]);
    stop();
    quest.bus.publish('quest.turn', gain('torch'));
    await flush();
    expect(account.sent).toHaveLength(1);
  });

  it('skips, and records, a template whose path has no value', async () => {
    const { quest, on, records, account } = await run();
    on({ on: 'quest', chat: '{chat}', send: '/look {outcome.item}' });
    quest.bus.publish('quest.turn', { chat: BOT, outcome: { kind: 'nothing', bot: 'QuestBot' } });
    quest.bus.publish('quest.other', {});
    await flush();
    expect(account.sent).toEqual([]);
    expect(records()).toEqual([
      { reaction: 'react', on: 'quest', outcome: 'skipped', reason: 'no value at outcome.item' },
      { reaction: 'react', on: 'quest', outcome: 'skipped', reason: 'no value at chat' },
    ]);
  });

  it('skips an event older than its limit: a replay of history', async () => {
    const { quest, on, records, account } = await run();
    on({
      on: 'quest.turn',
      when: { 'outcome.sure': true },
      chat: BOT,
      send: '/look {outcome.item}',
    });
    quest.bus.publish('quest.turn', gain('lantern'), T0 - REACT_MAX_AGE_MS - 1);
    quest.bus.publish('quest.turn', gain('rope', false), T0 - REACT_MAX_AGE_MS - 1);
    quest.bus.publish('quest.turn', gain('torch'), T0 - REACT_MAX_AGE_MS);
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look torch' }]);
    expect(records()[0]).toEqual({
      reaction: 'react',
      on: 'quest.turn',
      outcome: 'skipped',
      reason: `an event of ${new Date(T0 - REACT_MAX_AGE_MS - 1).toISOString()}, too old`,
    });
    expect(records()).toHaveLength(2);
  });

  it('keeps to the reach of its edge, a dry run through a dry-run one, and its stop', async () => {
    const dry = await run('dry-run');
    dry.on({ on: 'quest.turn', chat: BOT, send: '/look {outcome.item}' });
    dry.quest.bus.publish('quest.turn', gain('lantern'));
    await flush();
    expect(dry.account.sent).toEqual([]);
    expect(dry.records().map((r) => r['outcome'])).toEqual(['dry-run']);

    const ro = await run('stopped');
    ro.on({ on: 'quest.turn', chat: BOT, send: '/look {outcome.item}' });
    ro.quest.bus.publish('quest.turn', gain('lantern'));
    await flush();
    expect(ro.records()).toEqual([
      {
        reaction: 'react',
        on: 'quest.turn',
        outcome: 'refused',
        reason: 'stopped: a safety stop',
        chat: BOT,
        text: '/look lantern',
      },
    ]);

    const live = await run();
    live.on({ on: 'quest.turn', chat: BOT, send: '/drop {outcome.item}' });
    live.on({ on: 'quest.turn', chat: '#lobby', send: '/look {outcome.item}' });
    live.on({ on: 'quest.turn', chat: BOT, send: '/look', via: 'nothing' });
    live.quest.bus.publish('quest.turn', gain('lantern'));
    await flush();
    expect(live.account.sent).toEqual([]);
    expect(live.records().map((r) => `${String(r['outcome'])}: ${String(r['reason'])}`)).toEqual([
      'refused: watcher has no reach on the account nothing: no edge binds a chat-out of it',
      expect.stringMatching(/^refused: .*\/drop/u),
      expect.stringMatching(/^refused: .*#lobby/u),
    ]);
  });

  it('is refused for a namespace its plugin does not consume', async () => {
    const { on } = await run();
    expect(() => on({ on: 'dice.roll', chat: BOT, send: '/look' })).toThrow(
      'watcher does not consume dice'
    );
  });
});

describe('react on a message', () => {
  it('sends when a message read matches, its named groups in the payload', async () => {
    const { account, on, records } = await run();
    on({
      on: { match: /a (?<item>\w+) lies here/u, chats: ['@questbot'] },
      when: { sender: 'QuestBot' },
      chat: '{chat}',
      send: '/look {item}',
    });
    const say = (text: string, more: Record<string, unknown> = {}) =>
      account.hear({ chat: BOT, sender: 'QuestBot', text, time: T0, id: '7', ...more });
    say('a lantern lies here');
    say('a rope lies here', { playback: true });
    say('a torch lies here', { own: true });
    say('a coin lies here', { sender: 'bob' });
    say('nothing lies here');
    account.hear({ chat: '#lobby', sender: 'QuestBot', text: 'a key lies here', time: T0 });
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look lantern' }]);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ on: 'message', outcome: 'sent' });
  });

  it('matches a text it contains, in every chat its edge reads, its fields winning over groups', async () => {
    const { account, on } = await run();
    on({ on: { match: 'the draw opens' }, chat: BOT, send: '/look {chat}{replyTo}' });
    on({ on: { match: /(?<chat>\w+) opens/u, port: 'chat' }, chat: '{chat}', send: '/look' });
    account.hear({
      chat: '#lobby',
      sender: 'QuestBot',
      text: 'the draw opens',
      time: T0,
      replyTo: '!',
    });
    account.hear({ chat: '#lobby', sender: 'QuestBot', text: 'the gate', time: T0 });
    await flush();
    // The second: to #lobby, which its edge does not send to.
    expect(account.sent).toEqual([{ chat: BOT, text: '/look #lobby!' }]);
  });
});
