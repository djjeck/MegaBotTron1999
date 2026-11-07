import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { definePlugin, type Plugin } from './plugin.ts';
import { type KeptTimer, MAX_DELAY_MS, PluginScheduler } from './scheduler.ts';

function scheduler(clock: VirtualClock, kept?: Record<string, KeptTimer>) {
  const fired: [string, unknown, number][] = [];
  const dropped: [string, number][] = [];
  let saved: Record<string, KeptTimer> | undefined = kept;
  const s = new PluginScheduler({
    clock,
    load: () => saved,
    save: (t) => (saved = t),
    fire: (name, payload) => fired.push([name, payload, clock.now()]),
    dropped: (name, _t, late) => dropped.push([name, late]),
  });
  return { s, fired, dropped, saved: () => saved };
}

describe('PluginScheduler', () => {
  it('fires named timers at their time once armed, each kept until it fires', () => {
    const clock = new VirtualClock(1000);
    const { s, fired, saved } = scheduler(clock);
    s.at('a', 1500, { payload: { n: 1 } });
    s.after('b', 100);
    expect(s.names()).toEqual(['a', 'b']);
    expect(s.get('a')).toEqual({ at: 1500, payload: { n: 1 } });
    expect(s.get('b')).toEqual({ at: 1100 });
    clock.advance(1000);
    expect(fired).toEqual([]);
    s.arm();
    s.arm();
    clock.advance(0);
    expect(fired).toEqual([
      ['b', undefined, 2000],
      ['a', { n: 1 }, 2000],
    ]);
    expect(saved()).toEqual({});
  });

  it('replaces a timer by name, and cancels one by name', () => {
    const clock = new VirtualClock();
    const { s, fired } = scheduler(clock);
    s.arm();
    s.at('a', 100);
    s.at('a', 300, { payload: 'later' });
    s.at('b', 200);
    expect(s.cancel('b')).toBe(true);
    expect(s.cancel('b')).toBe(false);
    clock.advance(500);
    expect(fired).toEqual([['a', 'later', 300]]);
    expect(s.get('a')).toBeUndefined();
  });

  it('keeps its timers when disarmed, and fires them when armed again', () => {
    const clock = new VirtualClock();
    const { s, fired } = scheduler(clock);
    s.arm();
    s.at('a', 100);
    s.disarm();
    clock.advance(200);
    expect(fired).toEqual([]);
    s.arm();
    clock.advance(0);
    expect(fired).toEqual([['a', undefined, 200]]);
  });

  it('settles the timers due while down by their policy, before anything sees them', () => {
    const clock = new VirtualClock(10_000);
    const { s, fired, dropped, saved } = scheduler(clock, {
      fire: { at: 1000, late: 'fire' },
      drop: { at: 9000, late: 'drop' },
      graced: { at: 9500, late: 'fire', graceMs: 1000 },
      tooLate: { at: 5000, late: 'fire', graceMs: 1000 },
      future: { at: 20_000, late: 'drop', payload: 1 },
    });
    expect(dropped).toEqual([
      ['drop', 1000],
      ['tooLate', 5000],
    ]);
    expect(s.names()).toEqual(['fire', 'future', 'graced']);
    expect(Object.keys(saved() ?? {}).sort()).toEqual(['fire', 'future', 'graced']);
    s.arm();
    clock.advance(10_000);
    expect(fired.map(([n]) => n)).toEqual(['fire', 'graced', 'future']);
  });

  it('arms again a timer beyond the longest delay of Node’s timers', () => {
    const clock = new VirtualClock();
    const { s, fired } = scheduler(clock);
    s.arm();
    s.after('far', MAX_DELAY_MS + 1000);
    clock.advance(MAX_DELAY_MS);
    expect(fired).toEqual([]);
    clock.advance(1000);
    expect(fired).toEqual([['far', undefined, MAX_DELAY_MS + 1000]]);
  });

  it('refuses a bad name or time', () => {
    const { s } = scheduler(new VirtualClock());
    expect(() => s.at('../x', 1)).toThrow('not a timer name');
    expect(() => s.at('a', Number.NaN)).toThrow('not a time');
  });
});

describe('the scheduler in the core', () => {
  /** A plugin that sets its timers at its first start and writes what fires to `seen`. */
  function timed(seen: string[], options: { onTimer?: boolean } = {}): Plugin {
    return definePlugin({
      manifest: { id: 'timed', version: '0.1.0', kinds: ['actor'], description: 'timed' },
      create: (ctx) => {
        if (ctx.store.read('set') === undefined) {
          ctx.scheduler.after('send', 60_000, { payload: { what: 'hello' } });
          ctx.scheduler.at('stale', 1000, { late: 'drop' });
          ctx.scheduler.at('boom', 2000);
          ctx.store.write('set', true);
        }
        seen.push(`timers ${ctx.scheduler.names().join(',')}`);
        if (options.onTimer === false) return {};
        return {
          onTimer: (name, payload) => {
            seen.push(`${name} ${JSON.stringify(payload)} at ${ctx.clock.now()}`);
            if (name === 'boom') throw new Error('bad timer');
          },
        };
      },
    });
  }

  it('keeps timers across a restart: one due fires at once, one to drop is dropped', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-'));
    const clock = new VirtualClock(0);
    const records: { type: string }[] = [];
    const seen: string[] = [];
    const first = new Core({ clock, dataDir });
    first.register(timed(seen));
    await first.start();
    await first.stop();
    // Down for two minutes: nothing fires meanwhile.
    clock.advance(120_000);
    expect(seen).toEqual(['timers boom,send,stale']);
    const second = new Core({ clock, dataDir, record: (r) => records.push(r) });
    second.register(timed(seen));
    await second.start();
    clock.advance(0);
    expect(seen.slice(1)).toEqual([
      'timers boom,send',
      'boom undefined at 120000',
      'send {"what":"hello"} at 120000',
    ]);
    expect(records).toContainEqual({
      type: 'core.timer',
      t: 120_000,
      plugin: 'timed',
      timer: 'stale',
      event: 'dropped',
      at: 1000,
    });
    fs.rmSync(dataDir, { recursive: true });
  });

  it('logs a handler that throws, or a plugin without one, and goes on', async () => {
    const clock = new VirtualClock(0);
    const lines: string[] = [];
    const seen: string[] = [];
    const core = new Core({ clock, print: (l) => lines.push(l) });
    core.register(timed(seen));
    await core.start();
    clock.advance(60_000);
    expect(seen.slice(1)).toEqual([
      'stale undefined at 1000',
      'boom undefined at 2000',
      'send {"what":"hello"} at 60000',
    ]);
    expect(lines).toEqual(['timed: error: timer boom: bad timer']);
    const quiet = new Core({ clock, print: (l) => lines.push(l) });
    quiet.register(timed([], { onTimer: false }));
    await quiet.start();
    clock.advance(1000);
    expect(lines).toContain('timed: warning: timer stale fired, and the plugin has no onTimer');
  });

  it('fires nothing for a plugin that failed or stopped', async () => {
    const clock = new VirtualClock(0);
    const seen: string[] = [];
    const failing = definePlugin({
      manifest: { id: 'failing', version: '0.1.0', kinds: ['actor'], description: 'failing' },
      create: (ctx) => {
        ctx.scheduler.after('never', 10);
        return {
          start: () => {
            throw new Error('no');
          },
          onTimer: (name) => seen.push(name),
        };
      },
    });
    const core = new Core({ clock });
    core.register(failing, timed(seen));
    await core.start();
    await core.stop();
    clock.advance(100_000);
    expect(seen).toEqual(['timers boom,send,stale']);
  });
});
