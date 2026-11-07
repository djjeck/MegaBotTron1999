import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from './event-log.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the core’s EventLog', () => {
  it('keeps records by day, in time order, under the names its table gives the old ones', () => {
    const log = new EventLog(path.join(dir, 'sub'), { legacy: { old: 'game.old' } });
    const t = Date.UTC(2026, 10, 5, 23, 59);
    log.write({ type: 'game.b', t: t + 120_000 });
    log.write({ type: 'old', t });
    fs.appendFileSync(log.fileFor(t), '{"cut sho\n{"type":1,"t":2}\n');
    expect(log.typeOf('old')).toBe('game.old');
    expect(log.typeOf('toString')).toBe('toString');
    expect(log.recordsSince(t, t + 120_000)).toEqual([
      { type: 'game.old', t },
      { type: 'game.b', t: t + 120_000 },
    ]);
    expect(log.recordsSince(t + 1, t + 2)).toEqual([]);
    expect(log.firstDay()).toBe(Date.UTC(2026, 10, 5));
    expect(new EventLog(dir).firstDay()).toBeUndefined();
  });
});
