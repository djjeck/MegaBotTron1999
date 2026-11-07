import { Rng } from '@megabottron1999/core/rng.ts';
import { describe, expect, it } from 'vitest';
import {
  clockMinutes,
  DEFAULT_SCHEDULE,
  hash,
  localDate,
  Planner,
  type ScheduleParams,
  scheduleProblem,
  zonedInstant,
} from './schedule.ts';

const MIN = 60_000;
const ROME = 'Europe/Rome';
const planner = (seed = 1, p: Partial<ScheduleParams> = {}) =>
  new Planner({ ...DEFAULT_SCHEDULE, ...p }, new Rng(seed));

describe('clockMinutes', () => {
  it('reads HH:MM and refuses anything else', () => {
    expect(clockMinutes('01:30')).toBe(90);
    expect(clockMinutes('23:59')).toBe(1439);
    for (const bad of ['1:30', '24:00', '12:60', '0130', ''])
      expect(clockMinutes(bad)).toBeUndefined();
  });
});

describe('scheduleProblem', () => {
  it('accepts the defaults', () => {
    expect(scheduleProblem(DEFAULT_SCHEDULE)).toBeUndefined();
  });

  it('names what is wrong', () => {
    const bad = (p: Partial<ScheduleParams>) => scheduleProblem({ ...DEFAULT_SCHEDULE, ...p });
    expect(bad({ skipChance: -0.1 })).toBe('numbers must be finite and not negative');
    expect(bad({ maxGapMin: Number.NaN })).toBe('numbers must be finite and not negative');
    expect(bad({ minGapMin: 14, maxGapMin: 20 })).toBe(
      'minGapMin must be at least 15, the bots’ own rest'
    );
    expect(bad({ maxGapMin: 16 })).toBe('maxGapMin must not be under minGapMin');
    expect(bad({ skipChance: 1 })).toBe('skipChance must be under 1');
    expect(bad({ bedtime: '1:30' })).toBe('bedtime and wake must be HH:MM');
    const order = 'bedtime and wake, moved by jitterMin, must stay after midnight and in order';
    expect(bad({ bedtime: '00:30' })).toBe(order);
    expect(bad({ wake: '23:30' })).toBe(order);
    expect(bad({ bedtime: '05:00', wake: '06:00' })).toBe(order);
    expect(bad({ timeZone: 'Mars/Olympus' })).toBe('unknown timeZone Mars/Olympus');
  });
});

describe('zonedInstant and localDate', () => {
  it('turns a Rome wall time into an instant, on either side of the October change', () => {
    // CEST (UTC+2) until 25 Oct 2026 03:00, then CET (UTC+1).
    expect(new Date(zonedInstant('2026-10-24', 90, ROME)).toISOString()).toBe(
      '2026-10-23T23:30:00.000Z'
    );
    expect(new Date(zonedInstant('2026-10-25', 510, ROME)).toISOString()).toBe(
      '2026-10-25T07:30:00.000Z'
    );
    expect(new Date(zonedInstant('2026-03-29', 510, ROME)).toISOString()).toBe(
      '2026-03-29T06:30:00.000Z'
    );
  });

  it("gives an instant's date in Rome", () => {
    expect(localDate(Date.parse('2026-10-31T23:30:00Z'), ROME)).toBe('2026-11-01');
    expect(localDate(Date.parse('2026-10-31T22:30:00Z'), ROME)).toBe('2026-10-31');
  });
});

describe('Planner', () => {
  const noon = Date.parse('2026-11-01T11:00:00Z'); // 12:00 in Rome

  it('sends 17–20 minutes after the last send', () => {
    const p = planner(3, { skipChance: 0 });
    for (let i = 0; i < 200; i++) {
      const plan = p.next(noon, noon);
      expect(plan.at - noon).toBeGreaterThanOrEqual(17 * MIN);
      expect(plan.at - noon).toBeLessThanOrEqual(20 * MIN);
      expect(plan).toMatchObject({ skipped: 0, afterSleep: false });
    }
  });

  it('adds one interval per forgotten turn', () => {
    const plan = planner(5, { skipChance: 0.999 }).next(noon, noon);
    expect(plan.skipped).toBeGreaterThan(0);
    expect(plan.at - noon).toBeGreaterThanOrEqual(17 * MIN * (plan.skipped + 1));
    expect(plan.at - noon).toBeLessThanOrEqual(20 * MIN * (plan.skipped + 1));
  });

  it('sends at once without a known last send, or after an old one', () => {
    const p = planner(7);
    for (const last of [undefined, noon - 21 * MIN, noon - 6 * 3_600_000])
      expect(p.next(last, noon)).toEqual({ at: noon, skipped: 0, afterSleep: false });
  });

  it('turned on at night, sends at waking rather than at once', () => {
    const p = planner(8);
    const late = zonedInstant('2026-11-02', 3 * 60, ROME); // 03:00
    const plan = p.next(undefined, late);
    expect(plan.afterSleep).toBe(true);
    expect(plan.at).toBeGreaterThanOrEqual(p.night('2026-11-02').to);
  });

  it('keeps the last send as the base while its turn has not passed, even if now is late', () => {
    const { at } = planner(9, { skipChance: 0 }).next(noon - 19 * MIN, noon);
    expect(at).toBeGreaterThanOrEqual(noon - 2 * MIN);
    expect(at).toBeLessThanOrEqual(noon + MIN);
  });

  it('waits for the morning, then up to 10 minutes more', () => {
    const p = planner(11);
    const late = zonedInstant('2026-11-02', 2 * 60 + 30, ROME); // 02:30, past any bedtime
    const plan = p.next(late, late);
    const night = p.night('2026-11-02');
    expect(plan.afterSleep).toBe(true);
    expect(plan.at - night.to).toBeGreaterThanOrEqual(0);
    expect(plan.at - night.to).toBeLessThanOrEqual(10 * MIN);
  });

  it('draws each night once', () => {
    const p = planner(13);
    expect(p.night('2026-11-02')).toBe(p.night('2026-11-02'));
  });

  it('with a salt, draws the same night for every planner, whatever its own draws', () => {
    const a = new Planner(DEFAULT_SCHEDULE, new Rng(1), '');
    const b = new Planner(DEFAULT_SCHEDULE, new Rng(2), '');
    expect(a.night('2026-11-02')).toEqual(b.night('2026-11-02'));
    expect(a.night('2026-11-03')).not.toEqual(a.night('2026-11-02'));
    expect(new Planner(DEFAULT_SCHEDULE, new Rng(1), 'x').night('2026-11-02')).not.toEqual(
      a.night('2026-11-02')
    );
    expect(hash('')).toBe(0x811c9dc5);
  });

  it('after a rest the bot stated, sends up to 3 minutes after it, or in the morning', () => {
    const p = planner(15);
    for (let i = 0; i < 50; i++) {
      const { at, afterSleep, skipped } = p.after(noon + 30 * MIN);
      expect([afterSleep, skipped]).toEqual([false, 0]);
      expect(at - (noon + 30 * MIN)).toBeGreaterThanOrEqual(0);
      expect(at - (noon + 30 * MIN)).toBeLessThanOrEqual(3 * MIN);
    }
    const late = zonedInstant('2026-11-02', 3 * 60, ROME);
    expect(p.after(late)).toMatchObject({ afterSleep: true });
  });

  // 1.4 s alone, but over the default 5 s when every test file runs at once, as in `validate`.
  it('over 60 days, never sends under 17 min apart or asleep, and sleeps like a person', () => {
    const p = planner(42);
    // From 1 Oct, across the change of 25 Oct.
    let last = Date.parse('2026-10-01T10:00:00Z');
    const end = last + 60 * 24 * 3_600_000;
    let turns = 0;
    let skipped = 0;
    const sends: number[] = [];
    while (last < end) {
      const plan = p.next(last, last);
      expect(plan.at - last).toBeGreaterThanOrEqual(17 * MIN);
      expect(p.asleep(plan.at)).toBe(false);
      if (!plan.afterSleep) {
        turns += plan.skipped + 1;
        skipped += plan.skipped;
      }
      sends.push(plan.at);
      last = plan.at;
    }
    expect(skipped / turns).toBeGreaterThan(0.05);
    expect(skipped / turns).toBeLessThan(0.11);
    // Every day has one long gap, the night: from about 6 h 15 to under 9 h 15 (with the
    // wake delay, the last interval before bed and a possible forgotten turn).
    const gaps = sends.slice(1).map((t, i) => t - (sends[i] as number));
    const nights = gaps.filter((g) => g > 2 * 3_600_000);
    expect(nights.length).toBeGreaterThanOrEqual(59);
    expect(nights.length).toBeLessThanOrEqual(61);
    for (const g of nights) {
      expect(g).toBeGreaterThan(5.5 * 3_600_000);
      expect(g).toBeLessThan(9.5 * 3_600_000);
    }
    // Nights are drawn in their window, in Rome time.
    for (let d = 1; d <= 30; d++) {
      const date = `2026-11-${String(d).padStart(2, '0')}`;
      const n = p.night(date);
      expect(n.from).toBeGreaterThanOrEqual(zonedInstant(date, 45, ROME));
      expect(n.from).toBeLessThanOrEqual(zonedInstant(date, 135, ROME));
      expect(n.to).toBeGreaterThanOrEqual(zonedInstant(date, 465, ROME));
      expect(n.to).toBeLessThanOrEqual(zonedInstant(date, 555, ROME));
    }
  }, 20_000);
});
