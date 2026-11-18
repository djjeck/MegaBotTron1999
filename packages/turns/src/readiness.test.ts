import { type BusEvent } from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runParser, T0 } from '#test/parser-run.ts';
import {
  QUEST,
  QUEST_MECHANICS,
  QUEST_VOCABULARY,
  QUESTBOT,
  questGamePlugin,
} from '#test/quest.ts';
import { ReadinessModel, type ReadinessSpec, type ReadinessState } from './readiness.ts';
import { statePlugin } from './state-plugin.ts';

const MIN = 60_000;
const PARSER = { id: QUEST, ...QUEST_VOCABULARY };
const model = () => new ReadinessModel({ parser: PARSER, mechanics: QUEST_MECHANICS });
const event = (type: string, t: number, payload: Record<string, unknown> = {}): BusEvent => ({
  type: `${QUEST}.${type}`,
  t,
  instance: QUEST,
  ...payload,
});
const reduceAll = (m: ReadinessModel, events: BusEvent[]): ReadinessState =>
  events.reduce((s, e) => m.reduce(s, e), m.initial());

describe('ReadinessModel (bot-os.md D141)', () => {
  it('declares its commands, the turn first, from the vocabulary and the mechanics', () => {
    const m = new ReadinessModel({
      parser: {
        id: QUEST,
        bot: QUESTBOT,
        turnCommands: ['/play', '/go'],
        commands: {
          '/shop': {},
          '/coffee': { aliases: ['/c'] },
          '/chest': { announcedBy: 'A chest!' },
          '/nap': {},
        },
      },
      mechanics: {
        '/shop': { interactive: true },
        '/coffee': { cooldownMin: 60, effects: [{ command: '/go', clear: true }] },
        '/chest': { unlock: {} },
        '/nap': { effects: [{ command: '/c', shortenMin: 5 }], unlock: { forMin: 5 } },
      },
    });
    expect(m.declared).toEqual([
      { command: '/play', aliases: ['/go'], turn: true },
      { command: '/shop', interactive: true },
      {
        command: '/coffee',
        aliases: ['/c'],
        cooldownMin: 60,
        effects: [{ command: '/play', clear: true }],
      },
      { command: '/chest', unlock: { pattern: 'A chest!' } },
      { command: '/nap', unlock: { forMin: 5 }, effects: [{ command: '/coffee', shortenMin: 5 }] },
    ]);
    expect(m.consumes).toEqual(['quest.sent', 'quest.turn', 'quest.answer', 'quest.reply']);
    expect(m.turn).toBe('/play');
    expect(m.bot).toBe(QUESTBOT);
  });

  it('refuses mechanics that are wrong', () => {
    const problem = (mechanics: ReadinessSpec['mechanics'], parser = PARSER): string => {
      try {
        new ReadinessModel({ parser, ...(mechanics === undefined ? {} : { mechanics }) });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(problem({ '/play': {} })).toBe(
      "readiness of quest: /play is the turn: its readiness is the rest's"
    );
    expect(problem({ daily: {} })).toContain('daily is not a command, as /daily');
    expect(problem({ '/dance': {} })).toContain("/dance is not one of its parser's commands");
    expect(problem({ '/daily': { cooldownMin: 0 } })).toContain('cooldownMin must be over 0');
    expect(problem({ '/chest': { unlock: { forMin: -1 } } })).toContain('forMin must be over 0');
    expect(problem({ '/daily': { effects: [{ command: '/x', clear: true }] } })).toContain(
      'its effect names /x, not one of its commands or aliases'
    );
    expect(problem({ '/daily': { effects: [{ command: '/play' }] } })).toContain(
      'clears its command'
    );
    // A command announced needs an unlock to be announced.
    expect(problem({})).toContain(
      '/chest is announced (announcedBy), but its mechanics have no unlock'
    );
    expect(problem({}, { ...PARSER, turnCommands: [] })).toContain('expected its turn commands');
    expect(problem(QUEST_MECHANICS)).toBe('');
  });

  it('reduces sends, answers, unlocks and effects, and ignores what is not its parser’s', () => {
    const m = model();
    const s = reduceAll(m, [
      event('sent', T0, { command: '/play', byHand: true }),
      // An older send told late keeps the newer.
      event('sent', T0 - MIN, { command: '/play', byHand: false }),
      event('sent', T0, { command: '/dance', byHand: true }),
      event('turn', T0, {
        outcome: { kind: 'gain', bot: QUESTBOT },
        retryAt: T0 + 15 * MIN,
        answer: { length: 5 },
        unlocks: ['/chest'],
      }),
      // A shorter rest after it does not shorten the turn's.
      event('turn', T0 + MIN, { outcome: { kind: 'gain', bot: QUESTBOT }, retryAt: T0 + 5 * MIN }),
      event('reply', T0 + MIN, { command: '/daily', answer: { length: 3 } }),
      { type: 'other.turn', t: T0, instance: 'other' },
      event('changed', T0),
    ]);
    const ready = m.ready(s, T0 + 2 * MIN);
    expect(ready['/play']).toEqual({
      ready: false,
      until: T0 + 15 * MIN,
      why: 'its rest after a turn',
      sent: { t: T0, byHand: true },
      answer: { t: T0, length: 5 },
    });
    expect(ready['/chest']).toEqual({ ready: true, since: T0 });
    expect(ready['/daily']).toEqual({ ready: true, answer: { t: T0 + MIN, length: 3 } });
    // An unread answer changes no hold; a "too soon" to another command holds it as it says.
    const t = reduceAll(m, [
      event('answer', T0, { command: '/daily', outcome: { kind: 'unknown', bot: QUESTBOT } }),
      event('answer', T0, {
        command: '/daily',
        outcome: { kind: 'nothing', bot: QUESTBOT, reason: 'cooldown' },
        retryAt: T0 + 30 * MIN,
      }),
      event('answer', T0, {
        command: '/coffee',
        outcome: { kind: 'nothing', bot: QUESTBOT, reason: 'cooldown' },
      }),
      event('answer', T0, { command: '/chest', outcome: { kind: 'gain', bot: QUESTBOT } }),
    ]);
    expect(m.ready(t, T0)['/daily']).toMatchObject({
      until: T0 + 30 * MIN,
      why: 'it said too soon',
    });
    expect(m.ready(t, T0)['/coffee']).toEqual({ ready: true });
  });

  it('holds a success for the wait the bot states when longer than its cooldown, and cuts holds', () => {
    const m = model();
    const s = reduceAll(m, [
      event('turn', T0, {
        outcome: { kind: 'nothing', bot: QUESTBOT, reason: 'defeated' },
        retryAt: T0 + 30 * MIN,
      }),
      event('answer', T0, {
        command: '/coffee',
        outcome: { kind: 'rested', bot: QUESTBOT },
        retryAt: T0 + 90 * MIN,
      }),
      event('answer', T0, {
        command: '/daily',
        outcome: { kind: 'gain', bot: QUESTBOT },
        effects: [{ command: '/coffee', shortenMin: 20 }],
      }),
    ]);
    const ready = m.ready(s, T0);
    expect(ready['/coffee']).toMatchObject({
      until: T0 + 70 * MIN,
      why: 'its rest after a turn, cut by /daily',
    });
    expect(ready['/play']).toEqual({ ready: true, since: T0 });
    expect(ready['/daily']).toMatchObject({ why: 'its cooldown' });
  });

  it('takes a game’s own facts: a success, an unlock, a lock, a hold (a ban)', () => {
    const m = model();
    let s = m.initial();
    s = m.unlock(s, '/chest', T0);
    expect(m.ready(s, T0)['/chest']).toEqual({ ready: true, since: T0 });
    s = m.lock(s, '/chest');
    expect(m.ready(s, T0)['/chest']).toMatchObject({ ready: false, why: 'waits for an unlock' });
    expect(m.lock(s, '/chest')).toBe(s);
    expect(m.lock(s, '/nothing')).toBe(s);
    expect(m.unlock(s, '/daily', T0)).toEqual(s);
    // A success: its cooldown and its effects.
    s = m.reduce(
      s,
      event('turn', T0, { outcome: { kind: 'gain', bot: QUESTBOT }, retryAt: T0 + 15 * MIN })
    );
    s = m.succeed(s, '/coffee', T0 + MIN);
    expect(m.ready(s, T0 + MIN)['/play']).toMatchObject({ ready: true, since: T0 + MIN });
    expect(m.ready(s, T0 + MIN)['/coffee']).toMatchObject({ until: T0 + 61 * MIN });
    expect(m.succeed(s, '/play', T0)).toBe(s);
    expect(m.succeed(s, '/nothing', T0)).toBe(s);
    // A ban: every command, until it ends, over a shorter hold; a hold longer than it stands.
    s = m.hold(s, 'ban', { until: T0 + 30 * MIN, why: 'banned' });
    const banned = m.ready(s, T0 + MIN);
    expect(banned['/play']).toMatchObject({ ready: false, until: T0 + 30 * MIN, why: 'banned' });
    expect(banned['/coffee']).toMatchObject({ until: T0 + 61 * MIN, why: 'its cooldown' });
    expect(m.ready(s, T0 + 30 * MIN)['/play']).toMatchObject({ ready: true });
    // On some commands, by alias too; one with no end.
    s = m.hold(s, 'gate', { why: 'gated', commands: ['/DAILY'] });
    expect(s.holds['gate']).toEqual({ why: 'gated', commands: ['/daily'] });
    expect(m.ready(s, T0 + 31 * MIN)['/daily']).toEqual({ ready: false, why: 'gated' });
    expect(m.ready(s, T0 + 31 * MIN)['/play']).toMatchObject({ ready: true });
    // Over a command waiting for its unlock: the hold, which says why it may not go.
    expect(m.ready(s, T0 + 31 * MIN)['/chest']).toMatchObject({ why: 'waits for an unlock' });
    s = m.hold(s, 'all', { why: 'paused' });
    expect(m.ready(s, T0 + 31 * MIN)['/chest']).toEqual({ ready: false, why: 'paused' });
    s = m.hold(m.hold(s, 'gate', undefined), 'all', undefined);
    expect(m.hold(s, 'gate', undefined)).toBe(s);
    expect(m.ready(s, T0 + 61 * MIN)['/daily']).toMatchObject({ ready: true });
  });
});

describe('a state plugin with a readiness (bot-os.md D141)', () => {
  /**
   * A game's state: its defeats, each of which (as this made-up game has it) holds every command
   * an hour, folded into the readiness as a hold, with no wrapper.
   */
  const defeats = () => {
    const readiness = model();
    return statePlugin<{ defeats: number; readiness?: ReadinessState }>({
      id: 'quest-state',
      description: 'x',
      schema: z.object({ defeats: z.number() }),
      initial: { defeats: 0 },
      consumes: ['quest.turn'],
      readiness,
      reduce: (s, e) => {
        const o = e['outcome'] as { reason?: string } | undefined;
        if (e.type !== 'quest.turn' || o?.reason !== 'defeated') return s;
        return {
          ...s,
          defeats: s.defeats + 1,
          readiness: readiness.hold(s.readiness as ReadinessState, 'defeat', {
            until: e.t + 60 * MIN,
            why: 'defeated',
          }),
        };
      },
    });
  };

  it('declares its commands, its bot, its parser input and the player’s contract', () => {
    const { manifest } = defeats();
    expect(manifest.botCommands?.[0]).toEqual({ command: '/play', turn: true });
    expect(manifest.botUsername).toBe(QUESTBOT);
    expect(manifest.inputs).toMatchObject({
      events: { type: 'events', namespace: QUEST },
      parser: { type: 'interface', members: ['actions.sent'], bind: { node: QUEST } },
    });
    expect(Object.keys(manifest.interface?.state ?? {})).toEqual([
      'get',
      'freshness',
      'ready',
      'commands',
      'bot',
    ]);
    expect(Object.keys(manifest.interface?.actions ?? {})).toEqual(['sent']);
  });

  it('folds a game’s fact into the readiness, and hands a player’s send to its parser', async () => {
    const p = await runParser(questGamePlugin(), {}, undefined, undefined, defeats());
    const read = (what: string): unknown => {
      const r = p.kit.core.controls.read('quest-state', what);
      return 'value' in r ? r.value : r;
    };
    expect(read('bot')).toBe(QUESTBOT);
    expect(read('commands')).toHaveLength(4);
    p.kit.core.controls.act('quest-state', 'sent', { chat: `@${QUESTBOT}`, id: '5', t: T0 });
    p.hear({ sender: QUESTBOT, chat: `@${QUESTBOT}`, replyTo: '5', text: 'Found an apple.' });
    expect(p.iface.ready()['/play']).toMatchObject({
      ready: false,
      until: T0 + 15 * MIN,
      sent: { t: T0, byHand: false },
    });
    // A defeat holds every command an hour, the game's fact folded in by its own reducer.
    p.hear({ sender: 'alice', own: true, chat: `@${QUESTBOT}`, text: '/play' });
    p.hear({ sender: QUESTBOT, chat: `@${QUESTBOT}`, text: 'Defeated.' });
    expect(p.iface.ready()['/daily']).toMatchObject({
      ready: false,
      until: T0 + 60 * MIN,
      why: 'defeated',
    });
    // The state as its viewer shows it, the readiness a section of it.
    expect(read('get')).toMatchObject({ defeats: 1, readiness: { holds: { defeat: {} } } });
    await p.kit.stop();
  });

  it('refuses a schema with its own readiness section, a reserved query, or nothing to consume', () => {
    const base = {
      id: 'x-state',
      description: 'x',
      schema: z.object({ readiness: z.number() }),
      initial: { readiness: 0 },
      consumes: [],
      reduce: (s: { readiness: number }) => s,
      readiness: { parser: PARSER, mechanics: QUEST_MECHANICS },
    };
    expect(() => statePlugin(base)).toThrow('its schema cannot have a section readiness');
    expect(() =>
      statePlugin({
        ...base,
        schema: z.object({ n: z.number() }),
        initial: { n: 0 },
        reduce: (s: { n: number }) => s,
        queries: { ready: { help: 'x', output: z.boolean(), run: () => true } },
      })
    ).toThrow('a query cannot be named ready');
    const { readiness: _, ...none } = base;
    expect(() =>
      statePlugin({ ...none, schema: z.object({}), initial: {}, reduce: (s) => s })
    ).toThrow('it consumes no event type');
  });
});
