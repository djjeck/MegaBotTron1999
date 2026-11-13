/**
 * What each node costs (bot-os.md D77): its handlers' time where the core dispatches events,
 * messages and timers to it, and what its instance says of its own, in `GET /status`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Costs } from './costs.ts';
import { DevKit, FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

describe('Costs', () => {
  it('counts each call’s time per node, and its longest, even one that throws', () => {
    const c = new Costs();
    expect(c.of('a')).toEqual({ calls: 0, ms: 0, maxMs: 0 });
    expect(c.time('a', () => 7)).toBe(7);
    expect(() =>
      c.time('a', () => {
        const end = performance.now() + 2;
        while (performance.now() < end);
        throw new Error('no');
      })
    ).toThrow('no');
    const a = c.of('a');
    expect(a.calls).toBe(2);
    expect(a.maxMs).toBeGreaterThanOrEqual(2);
    expect(a.ms).toBeGreaterThanOrEqual(a.maxMs);
  });
});

describe('a node’s cost', () => {
  it('counts the events, messages and timers the core hands it, and adds its own', async () => {
    const connector = new FakeConnector({ account: 'irc:alice' });
    let publish: ((n: number) => void) | undefined;
    let ctx: PluginContext | undefined;
    const kit = new DevKit({
      plugins: [
        fakeConnectorPlugin('irc', connector),
        definePlugin({
          manifest: {
            id: 'game',
            version: '0.1.0',
            kinds: ['parser'],
            description: 'A game',
            games: { registers: ['game'] },
            events: { 'game.turn': z.object({ n: z.number() }) },
          },
          create: (c) => {
            publish = (n) => c.bus.publish('game.turn', { n });
            return {};
          },
        }),
        definePlugin({
          manifest: {
            id: 'watch',
            version: '0.1.0',
            kinds: ['stats'],
            description: 'Watches',
            inputs: {
              turns: { type: 'events', namespace: 'game' },
              chat: { type: 'chat-in', bind: { node: 'irc', reads: ['#lobby'] } },
            },
          },
          create: (c) => {
            ctx = c;
            return {
              start() {
                c.bus.subscribe('game', () => {});
                c.connector('chat').onMessage(() => {});
                c.scheduler.after('soon', 10);
              },
              onTimer() {},
              cost: () => ({ cpuMs: 3 }),
            };
          },
        }),
        definePlugin({
          manifest: { id: 'broken', version: '0.1.0', kinds: ['stats'], description: 'Broken' },
          create: () => ({
            cost: () => {
              throw new Error('no idea');
            },
          }),
        }),
      ],
    });
    await kit.start();
    publish?.(1);
    publish?.(2);
    connector.hear({ chat: '#lobby', sender: 'bob', text: 'hi', time: 0 });
    kit.runUntil(20);
    const watch = kit.core.cost('watch');
    expect(watch?.dispatch.calls).toBe(4);
    expect(watch?.own).toEqual({ cpuMs: 3 });
    expect(kit.core.cost('broken')).toEqual({ dispatch: { calls: 0, ms: 0, maxMs: 0 } });
    expect(kit.core.cost('nowhere')).toBeUndefined();
    const status = kit.core.controls.status().plugins.find((p) => p.id === 'watch');
    expect(status?.cost?.dispatch.calls).toBe(4);
    expect(ctx).toBeDefined();
    await kit.stop();
  });
});
