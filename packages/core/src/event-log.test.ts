import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { behind, EventLog, MemoryEventLog } from './event-log.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the core’s EventLog', () => {
  it('keeps records by day, in time order', () => {
    const log = new EventLog(path.join(dir, 'sub'));
    const t = Date.UTC(2026, 10, 5, 23, 59);
    log.write({ type: 'game.b', t: t + 120_000 });
    log.write({ type: 'game.a', t });
    fs.appendFileSync(log.fileFor(t), '{"cut sho\n{"type":1,"t":2}\n');
    expect(log.recordsSince(t, t + 120_000)).toEqual([
      { type: 'game.a', t },
      { type: 'game.b', t: t + 120_000 },
    ]);
    expect(log.recordsSince(t + 1, t + 2)).toEqual([]);
    expect(log.firstDay()).toBe(Date.UTC(2026, 10, 5));
    expect(new EventLog(dir).firstDay()).toBeUndefined();
  });
});

describe('a cursor into the log (bot-os.md D72)', () => {
  const T = Date.UTC(2026, 10, 10, 12);
  const DAY = 86_400_000;

  for (const kind of ['files', 'memory'] as const) {
    it(`reads what was written after it, each day as written, the days merged by time (${kind})`, () => {
      const log = kind === 'files' ? new EventLog(dir) : new MemoryEventLog();
      const a = log.write({ type: 'game.a', t: T });
      expect(a.day).toBe('2026-11-10');
      const first = log.after({});
      expect(first.entries.map((e) => e.entry.type)).toEqual(['game.a']);
      expect(first.entries[0]?.at).toEqual(a);
      expect(behind(a, first.cursor)).toBe(true);
      // Later: today's file, an old day's (a record of an old time), a new day's.
      const b = log.write({ type: 'game.b', t: T + 1000 });
      log.write({ type: 'game.old', t: T - DAY });
      log.write({ type: 'game.next', t: T + DAY });
      log.write({ type: 'game.c', t: T - 1000 });
      expect(behind(b, first.cursor)).toBe(false);
      const second = log.after(first.cursor);
      expect(second.entries.map((e) => e.entry.type)).toEqual([
        'game.old',
        'game.b',
        'game.c',
        'game.next',
      ]);
      expect(Object.keys(second.cursor).sort()).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
      expect(log.after(second.cursor).entries).toEqual([]);
    });
  }

  it('reads whole lines only, keeps a half line cut by a crash apart, and survives a file put back', () => {
    const log = new EventLog(dir);
    log.write({ type: 'game.a', t: T });
    const file = log.fileFor(T);
    fs.appendFileSync(file, '{"type":"game.half"');
    // Not ended yet: not read, and the cursor stops before it.
    const tail = log.after({});
    expect(tail.entries.map((e) => e.entry.type)).toEqual(['game.a']);
    expect(tail.cursor['2026-11-10']).toBe(fs.statSync(file).size - '{"type":"game.half"'.length);
    // A new process writes after it on a line of its own: the half line is passed, once.
    const again = new EventLog(dir);
    again.write({ type: 'game.b', t: T });
    expect(again.after(tail.cursor).entries.map((e) => e.entry.type)).toEqual(['game.b']);
    expect(fs.readFileSync(file, 'utf8').split('\n')).toHaveLength(4);
    // A file shorter than the cursor (a backup put back): nothing of it read again.
    const end = again.after({}).cursor;
    fs.writeFileSync(file, `${JSON.stringify({ type: 'game.a', t: T })}\n`);
    const shrunk = again.after(end);
    expect(shrunk.entries).toEqual([]);
    expect(shrunk.cursor['2026-11-10']).toBe(fs.statSync(file).size);
  });
});
