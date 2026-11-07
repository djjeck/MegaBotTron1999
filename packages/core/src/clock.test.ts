import { describe, expect, it, vi } from 'vitest';
import { VirtualClock, wallClock } from './clock.ts';

describe('VirtualClock', () => {
  it('runs the timers due, in time order, each at its own time', () => {
    const clock = new VirtualClock(1000);
    const seen: [string, number][] = [];
    clock.setTimeout(() => seen.push(['b', clock.now()]), 200);
    clock.setTimeout(() => seen.push(['a', clock.now()]), 100);
    clock.setTimeout(() => seen.push(['c', clock.now()]), 500);
    clock.advance(300);
    expect(seen).toEqual([
      ['a', 1100],
      ['b', 1200],
    ]);
    expect(clock.now()).toBe(1300);
    expect(clock.pending).toBe(1);
  });

  it('runs a timer set by a timer, if due on the way', () => {
    const clock = new VirtualClock();
    const seen: number[] = [];
    clock.setTimeout(() => {
      seen.push(clock.now());
      clock.setTimeout(() => seen.push(clock.now()), 50);
    }, 50);
    clock.advanceTo(200);
    expect(seen).toEqual([50, 100]);
  });

  it('forgets a cleared timer, and never goes back', () => {
    const clock = new VirtualClock(100);
    const fn = vi.fn();
    const handle = clock.setTimeout(fn, 10);
    clock.clearTimeout(handle);
    clock.clearTimeout(undefined);
    clock.advanceTo(50);
    expect(clock.now()).toBe(100);
    clock.advance(20);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('wallClock', () => {
  it('reads the time and runs and clears real timers', async () => {
    const clock = wallClock();
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
    const cleared = vi.fn();
    clock.clearTimeout(clock.setTimeout(cleared, 0));
    clock.clearTimeout(undefined);
    await new Promise<void>((resolve) => clock.setTimeout(resolve, 1));
    expect(cleared).not.toHaveBeenCalled();
  });
});

describe('VirtualClock, driven one timer at a time', () => {
  it('says when the next timer is due, runs it, and keeps ties in the order set', () => {
    const clock = new VirtualClock(0);
    const seen: string[] = [];
    expect(clock.nextAt()).toBeUndefined();
    expect(clock.runNext()).toBe(false);
    clock.at(100, () => seen.push('b'));
    const dropped = clock.at(50, () => seen.push('x'));
    clock.at(100, () => seen.push('c'));
    clock.at(20, () => seen.push('a'));
    clock.clearTimeout(dropped);
    expect(clock.nextAt()).toBe(20);
    expect(clock.runNext()).toBe(true);
    expect([seen, clock.now()]).toEqual([['a'], 20]);
    // The cleared timer is skipped; the two at 100 run in the order they were set.
    expect(clock.nextAt()).toBe(100);
    while (clock.runNext());
    expect([seen, clock.now(), clock.pending]).toEqual([['a', 'b', 'c'], 100, 0]);
    // A time already past is now.
    clock.at(10, () => seen.push('late'));
    expect(clock.nextAt()).toBe(100);
  });

  it('keeps time order over many timers', () => {
    const clock = new VirtualClock(0);
    const seen: number[] = [];
    const times = Array.from({ length: 200 }, (_, i) => (i * 7919) % 1000);
    for (const t of times) clock.at(t, () => seen.push(clock.now()));
    clock.advanceTo(1000);
    expect(seen).toEqual([...times].sort((a, b) => a - b));
  });
});
