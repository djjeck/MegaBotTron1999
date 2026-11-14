import { Rng } from '@megabottron1999/core/rng.ts';
import { describe, expect, it } from 'vitest';
import {
  addDays,
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
const NY = 'America/New_York';
const HOUR = 3_600_000;
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
    expect(bad({ bedtime: '08:30' })).toBe('bedtime and wake must differ');
    const night = 'the night, bedtime to wake, must be longer than 2 × jitterMin';
    expect(bad({ bedtime: '05:00', wake: '06:00' })).toBe(night);
    expect(bad({ bedtime: '23:30', wake: '00:30' })).toBe(night);
    const day = 'the day, wake to bedtime, must be longer than 2 × jitterMin + wakeDelayMaxMin';
    expect(bad({ bedtime: '09:00', wake: '08:00' })).toBe(day); // asleep 23 h
    expect(bad({ bedtime: '01:30', wake: '23:50' })).toBe(day);
    expect(bad({ timeZone: 'Mars/Olympus' })).toBe('unknown timeZone Mars/Olympus');
  });
});

describe('scheduleProblem, any pair of times', () => {
  it('accepts a night across midnight, one after it, and one that starts in the evening', () => {
    const ok = (bedtime: string, wake: string) =>
      scheduleProblem({ ...DEFAULT_SCHEDULE, bedtime, wake, timeZone: NY });
    expect(ok('23:00', '07:00')).toBeUndefined();
    expect(ok('21:00', '10:00')).toBeUndefined();
    expect(ok('01:00', '09:00')).toBeUndefined();
    expect(ok('00:00', '06:00')).toBeUndefined(); // jittered into the evening before
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

describe('Planner, a night across midnight', () => {
  const p = (seed: number, bedtime: string, wake: string, more: Partial<ScheduleParams> = {}) =>
    planner(seed, { bedtime, wake, timeZone: NY, ...more });

  it('adds days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('bedtime 21:00, wake 10:00: asleep from the evening to the next morning', () => {
    const q = p(1, '21:00', '10:00', { jitterMin: 0, wakeDelayMaxMin: 0 });
    const at = (date: string, h: number) => zonedInstant(date, h * 60, NY);
    expect(q.night('2026-11-13')).toEqual({
      from: at('2026-11-13', 21),
      to: at('2026-11-14', 10),
    });
    expect(q.asleep(at('2026-11-13', 20.9))).toBe(false);
    expect(q.asleep(at('2026-11-13', 21))).toBe(true);
    expect(q.asleep(at('2026-11-14', 3))).toBe(true); // after midnight, the night of the 13th
    expect(q.asleep(at('2026-11-14', 10))).toBe(false);
    expect(q.asleep(at('2026-11-14', 15))).toBe(false);
    // A send due at 23:00 waits for 10:00 the next day.
    expect(q.next(at('2026-11-13', 23), at('2026-11-13', 23))).toEqual({
      at: at('2026-11-14', 10),
      skipped: 0,
      afterSleep: true,
    });
  });

  it('bedtime 01:00, wake 09:00: a night after midnight, as before', () => {
    const q = p(2, '01:00', '09:00', { jitterMin: 0 });
    const at = (h: number) => zonedInstant('2026-11-14', h * 60, NY);
    expect(q.night('2026-11-14')).toEqual({ from: at(1), to: at(9) });
    expect(q.asleep(zonedInstant('2026-11-13', 23 * 60, NY))).toBe(false);
    expect(q.asleep(at(0.5))).toBe(false);
    expect(q.asleep(at(5))).toBe(true);
    expect(q.asleep(at(9))).toBe(false);
  });

  it('bedtime 00:00 moved into the evening before: asleep then too', () => {
    const q = p(3, '00:00', '06:00', { jitterMin: 45 });
    // Find a night drawn before midnight; with 45 minutes either way, about half are.
    let date = '2026-11-01';
    while (q.night(date).from >= zonedInstant(date, 0, NY)) date = addDays(date, 1);
    const { from } = q.night(date);
    expect(localDate(from, NY)).toBe(addDays(date, -1));
    expect(q.asleep(from)).toBe(true);
    expect(q.asleep(from - MIN)).toBe(false);
  });

  it('keeps the wall clock over the March change: a night an hour shorter', () => {
    // New York: EST (UTC−5) until 8 Mar 2026 02:00, then EDT (UTC−4).
    const q = p(4, '23:00', '07:00', { jitterMin: 0 });
    const n = q.night('2026-03-07');
    expect(new Date(n.from).toISOString()).toBe('2026-03-08T04:00:00.000Z'); // 23:00 EST
    expect(new Date(n.to).toISOString()).toBe('2026-03-08T11:00:00.000Z'); // 07:00 EDT
    expect(n.to - n.from).toBe(7 * HOUR);
    expect(q.asleep(Date.parse('2026-03-08T07:30:00Z'))).toBe(true); // 03:30 EDT
  });

  it('keeps the wall clock over the November change: a night an hour longer', () => {
    // EDT until 1 Nov 2026 02:00, then EST; 01:30 comes twice.
    const q = p(5, '23:00', '07:00', { jitterMin: 0 });
    const n = q.night('2026-10-31');
    expect(new Date(n.from).toISOString()).toBe('2026-11-01T03:00:00.000Z'); // 23:00 EDT
    expect(new Date(n.to).toISOString()).toBe('2026-11-01T12:00:00.000Z'); // 07:00 EST
    expect(n.to - n.from).toBe(9 * HOUR);
    for (const t of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'])
      // 01:30 EDT, then EST
      expect(q.asleep(Date.parse(t))).toBe(true);
  });

  it('a bedtime the change skips falls within the skipped hour', () => {
    // 02:30 does not exist on 8 Mar 2026 in New York.
    const n = p(6, '02:30', '09:00', { jitterMin: 0 }).night('2026-03-08');
    expect(n.from).toBeGreaterThanOrEqual(Date.parse('2026-03-08T06:00:00Z')); // 01:00 EST
    expect(n.from).toBeLessThanOrEqual(Date.parse('2026-03-08T07:00:00Z')); // 03:00 EDT
  });

  // Over the default 5 s when every test file runs at once, as in `validate`.
  it('over 60 days across a change, never sends asleep, and has one night a day', () => {
    const q = p(42, '21:00', '10:00');
    let last = Date.parse('2026-10-01T16:00:00Z');
    const end = last + 60 * 24 * HOUR;
    const sends: number[] = [];
    while (last < end) {
      const plan = q.next(last, last);
      expect(plan.at - last).toBeGreaterThanOrEqual(17 * MIN);
      expect(q.asleep(plan.at)).toBe(false);
      sends.push(plan.at);
      last = plan.at;
    }
    const nights = sends
      .slice(1)
      .map((t, i) => t - (sends[i] as number))
      .filter((g) => g > 2 * HOUR);
    expect(nights.length).toBeGreaterThanOrEqual(59);
    expect(nights.length).toBeLessThanOrEqual(61);
    // 13 h, give or take 1 h 30 of jitter, an hour of the change, and the intervals around it.
    for (const g of nights) {
      expect(g).toBeGreaterThan(11 * HOUR);
      expect(g).toBeLessThan(15.5 * HOUR);
    }
  }, 20_000);
});
