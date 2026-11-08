import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusEvent, type BusHandle } from './bus.ts';
import { VirtualClock } from './clock.ts';
import { Core, StartError } from './core.ts';
import { definePlugin, type Plugin } from './plugin.ts';

/** A test plugin that hands its bus out, with what its manifest says of games and events. */
function onBus(
  id: string,
  got: Record<string, BusHandle>,
  games: { registers?: string[]; consumes?: string[] },
  events: Record<string, z.ZodType> = {}
): Plugin {
  return definePlugin({
    manifest: { id, version: '0.1.0', kinds: ['stats'], description: id, games, events },
    create: (ctx) => {
      got[id] = ctx.bus;
      return {};
    },
  });
}

const roll = z.object({ player: z.string(), points: z.number() });

async function start(plugins: (got: Record<string, BusHandle>) => Plugin[], validate = true) {
  const got: Record<string, BusHandle> = {};
  const logged: BusEvent[] = [];
  const lines: string[] = [];
  const core = new Core({
    clock: new VirtualClock(5000),
    record: (r) => logged.push(r as BusEvent),
    print: (l) => lines.push(l),
    validateEvents: validate,
  });
  core.register(...plugins(got));
  await core.start();
  return { core, got, logged: () => logged.filter((r) => !r.type.startsWith('core.')), lines };
}

describe('the bus', () => {
  it('delivers an event to the plugins that consume its namespace, in order, and logs it', async () => {
    const { got, logged } = await start((g) => [
      onBus('game', g, { registers: ['dice'] }, { 'dice.roll': roll }),
      onBus('stats', g, { consumes: ['dice'] }),
      onBus('other', g, { consumes: ['dice'] }),
    ]);
    const seen: string[] = [];
    g(got, 'stats').subscribe('dice', (e) => seen.push(`stats ${e.type} ${String(e['player'])}`));
    const stop = g(got, 'other').subscribe('dice.roll', (e) => seen.push(`other at ${e.t}`));
    g(got, 'game').subscribe('dice.roll', () => seen.push('game hears itself'));
    g(got, 'game').publish('dice.roll', { player: 'Bob', points: 30 });
    g(got, 'game').publish('dice.roll', { player: 'Carol', points: 1 }, 7000);
    stop();
    g(got, 'game').publish('dice.roll', { player: 'Sigma', points: 2 });
    expect(seen).toEqual([
      'stats dice.roll Bob',
      'other at 5000',
      'game hears itself',
      'stats dice.roll Carol',
      'other at 7000',
      'game hears itself',
      'stats dice.roll Sigma',
      'game hears itself',
    ]);
    expect(logged()).toEqual([
      { type: 'dice.roll', t: 5000, instance: 'game', player: 'Bob', points: 30 },
      { type: 'dice.roll', t: 7000, instance: 'game', player: 'Carol', points: 1 },
      { type: 'dice.roll', t: 5000, instance: 'game', player: 'Sigma', points: 2 },
    ]);
  });

  it('refuses to publish an unregistered type, another plugin’s, or a bad payload', async () => {
    const { got } = await start((g) => [
      onBus('game', g, { registers: ['dice'] }, { 'dice.roll': roll }),
      onBus('stats', g, { registers: ['stats'], consumes: ['dice'] }),
    ]);
    expect(() => g(got, 'game').publish('dice.nothing', {})).toThrow(
      'no event type dice.nothing is registered'
    );
    expect(() => g(got, 'stats').publish('dice.roll', { player: 'x', points: 1 })).toThrow(
      'stats cannot publish dice.roll: game registers it'
    );
    expect(() => g(got, 'game').publish('dice.roll', { player: 'x' })).toThrow(
      /^dice\.roll: points: /u
    );
  });

  it('checks no payload when validation is off, as in production', async () => {
    const { got, logged } = await start(
      (g) => [onBus('game', g, { registers: ['dice'] }, { 'dice.roll': roll })],
      false
    );
    g(got, 'game').publish('dice.roll', { player: 'x' });
    expect(logged()).toHaveLength(1);
  });

  it('lets a plugin subscribe only to what it consumes or registers', async () => {
    const { got } = await start((g) => [
      onBus('game', g, { registers: ['dice'] }, { 'dice.roll': roll }),
      onBus('quizzer', g, { registers: ['quiz'] }),
    ]);
    expect(() => g(got, 'quizzer').subscribe('dice', () => {})).toThrow(
      'quizzer does not consume dice: add an events input of it'
    );
    expect(() => g(got, 'quizzer').subscribe('dice.roll', () => {})).toThrow('does not consume');
    expect(() => g(got, 'game').subscribe('dice.unknown', () => {})).toThrow(
      'no event type dice.unknown is registered'
    );
    expect(() => g(got, 'quizzer').subscribe('quiz', () => {})).not.toThrow();
  });

  it('logs a subscriber that throws, and still delivers to the others', async () => {
    const { got, lines } = await start((g) => [
      onBus('game', g, { registers: ['dice'] }, { 'dice.roll': roll }),
      onBus('stats', g, { consumes: ['dice'] }),
    ]);
    const seen: string[] = [];
    g(got, 'stats').subscribe('dice', () => {
      throw new Error('broken');
    });
    g(got, 'stats').subscribe('dice', () => {
      throw 'a string';
    });
    g(got, 'game').subscribe('dice', () => seen.push('still here'));
    g(got, 'game').publish('dice.roll', { player: 'x', points: 1 });
    expect(seen).toEqual(['still here']);
    expect(lines).toEqual([
      'stats: error: on dice.roll: broken',
      'stats: error: on dice.roll: a string',
    ]);
  });

  it('fails the start for a type two plugins register', async () => {
    await expect(
      start((g) => [
        onBus('a', g, { registers: ['dice'] }, { 'dice.roll': roll }),
        onBus('b', g, { registers: ['dice'] }, { 'dice.roll': roll }),
      ])
    ).rejects.toThrow(new StartError('plugin b: event dice.roll is registered by a too'));
  });

  it('stops delivering to a plugin once it has stopped', async () => {
    const { core, got } = await start((g) => [
      onBus('game', g, { registers: ['dice'] }, { 'dice.roll': roll }),
      onBus('stats', g, { consumes: ['dice'] }),
    ]);
    const seen: string[] = [];
    g(got, 'stats').subscribe('dice', () => seen.push('stats'));
    const game = g(got, 'game');
    await core.stop();
    game.publish('dice.roll', { player: 'x', points: 1 });
    expect(seen).toEqual([]);
  });
});

/** The bus handed to plugin `id`. */
function g(got: Record<string, BusHandle>, id: string): BusHandle {
  const handle = got[id];
  if (handle === undefined) throw new Error(`no bus for ${id}`);
  return handle;
}

describe('an event', () => {
  it('starts with its type, time and instance, which its payload cannot replace', async () => {
    const got: Record<string, BusHandle> = {};
    const logged: BusEvent[] = [];
    const core = new Core({
      clock: new VirtualClock(5),
      record: (r) => logged.push(r as BusEvent),
      validateEvents: false,
    });
    core.register(onBus('game', got, { registers: ['dice'] }, { 'dice.roll': roll }));
    await core.start();
    g(got, 'game').publish('dice.roll', { player: 'x', type: 'other', t: 1, instance: 'no' });
    const event = logged.find((r) => r.type === 'dice.roll');
    expect(JSON.stringify(event)).toBe(
      '{"type":"dice.roll","t":5,"instance":"game","player":"x"}'
    );
  });
});
