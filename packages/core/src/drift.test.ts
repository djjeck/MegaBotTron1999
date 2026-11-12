import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { DriftMonitor, type DriftRecord } from './drift.ts';
import { definePlugin, type Instance, type Plugin, type PluginContext } from './plugin.ts';

const MIN = 60_000;

function monitor(threshold = { unreadAt: 5, windowMin: 15 }) {
  const clock = new VirtualClock(0);
  const records: DriftRecord[] = [];
  const told: string[] = [];
  const pauses: string[] = [];
  const m = new DriftMonitor({
    clock,
    record: (r) => records.push(r),
    notify: (t) => told.push(t),
    threshold: () => threshold,
    pause: (_parser, reason) => (pauses.push(reason), ['actor']),
  });
  return { m, clock, records, told, pauses, r: m.reporter('game') };
}

describe('DriftMonitor', () => {
  it('logs and counts each unread message, and tells the owner at most once an hour', () => {
    const { r, m, clock, records, told } = monitor();
    r.read();
    r.unread({ text: 'una riga nuova', lines: ['una riga nuova'] });
    clock.advance(30 * MIN);
    r.unread({ text: 'x'.repeat(400) });
    clock.advance(31 * MIN);
    r.unread({ text: 'ancora', t: 5 });
    expect(records).toEqual([
      {
        type: 'core.drift',
        t: 0,
        plugin: 'game',
        event: 'unread',
        text: 'una riga nuova',
        lines: ['una riga nuova'],
      },
      { type: 'core.drift', t: 30 * MIN, plugin: 'game', event: 'unread', text: 'x'.repeat(400) },
      { type: 'core.drift', t: 5, plugin: 'game', event: 'unread', text: 'ancora' },
    ]);
    expect(told).toEqual([
      'Drift: game could not read a message: una riga nuova',
      'Drift: game could not read a message (and 1 more since the last told): ancora',
    ]);
    expect(m.counts()).toEqual([{ parser: 'game', read: 1, unread: 3, recent: 0, tripped: false }]);
  });

  it('pauses once past the threshold, and again only after the rate fell back', () => {
    const { r, clock, pauses, told, records, m } = monitor();
    for (let i = 0; i < 7; i++) {
      r.unread({ text: `riga ${i}` });
      clock.advance(MIN);
    }
    expect(pauses).toEqual(['drift: game could not read 6 messages in 15 minutes']);
    expect(told.at(-1)).toBe(
      'Drift: drift: game could not read 6 messages in 15 minutes; stopped actor until you clear the stop in the editor'
    );
    expect(records.filter((x) => x.event === 'pause')).toHaveLength(1);
    expect(m.counts()[0]?.tripped).toBe(true);
    clock.advance(20 * MIN);
    r.unread({ text: 'quiet again' });
    expect(m.counts()[0]?.tripped).toBe(false);
    for (let i = 0; i < 6; i++) r.unread({ text: `again ${i}` });
    expect(pauses).toHaveLength(2);
  });

  it('says when nothing that acts depends on the parser', () => {
    const told: string[] = [];
    const m = new DriftMonitor({
      clock: new VirtualClock(),
      notify: (t) => told.push(t),
      pause: () => [],
    });
    const r = m.reporter('p');
    for (let i = 0; i < 6; i++) r.unread({ text: 'x' });
    expect(told.at(-1)).toContain('nothing that acts depends on it');
  });
});

describe('drift in the core', () => {
  function plugin(
    id: string,
    kinds: ('parser' | 'actor' | 'stats')[],
    requires: string[],
    got: Record<string, PluginContext>,
    seen: string[],
    drift?: { unreadAt: number; windowMin: number }
  ): Plugin {
    return definePlugin({
      manifest: {
        id,
        version: '0.1.0',
        kinds,
        description: id,
        requires,
        ...(drift === undefined ? {} : { drift }),
      },
      create: (ctx): Instance => {
        got[id] = ctx;
        return { pause: (why) => seen.push(`${id} paused: ${why}`) };
      },
    });
  }

  it('stops the actors that require the parser, through others too, and nothing else', async () => {
    const got: Record<string, PluginContext> = {};
    const seen: string[] = [];
    const core = new Core({ clock: new VirtualClock() });
    core.register(
      plugin('parser', ['parser'], [], got, seen, { unreadAt: 1, windowMin: 5 }),
      plugin('direct', ['actor'], ['parser'], got, seen),
      plugin('stats', ['stats'], ['parser'], got, seen),
      plugin('indirect', ['actor'], ['stats'], got, seen),
      plugin('apart', ['actor'], [], got, seen)
    );
    await core.start();
    const drift = got['parser']?.drift;
    drift?.unread({ text: 'a' });
    expect(seen).toEqual([]);
    drift?.unread({ text: 'b' });
    expect(seen).toEqual([
      'direct paused: drift: parser could not read 2 messages in 5 minutes',
      'indirect paused: drift: parser could not read 2 messages in 5 minutes',
    ]);
    expect(core.state('direct')).toMatchObject({ state: 'stopped', stop: { source: 'drift' } });
    expect(core.state('stats')?.state).toBe('running');
    expect(core.state('apart')?.state).toBe('running');
    expect(core.drift()).toEqual([
      { parser: 'parser', read: 0, unread: 2, recent: 2, tripped: true },
    ]);
  });
});
