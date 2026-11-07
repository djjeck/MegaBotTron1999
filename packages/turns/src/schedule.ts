/**
 * When to send the next turn to a game bot: at the pace of a person, not of a
 * timer. The game bots answer a turn every 15 minutes at most; a person neither presses it at the
 * 15th minute nor all night. So, for each bot's turn-actor
 * (packages/turns/src/turn-actor.ts):
 *
 * - each send comes 17–20 minutes (uniform) after the owner's last turn with that bot, whoever sent
 *   it, and never sooner; after a rest the bot states, a few minutes after it ends (`after`);
 * - about 8% of turns are forgotten: that send comes one more interval later;
 * - it sleeps from about 01:30 to 08:30 in its time zone (`timeZone`, by default Europe/Rome),
 *   bedtime and waking each moved by up to 45 minutes, drawn once a day, and after waking it
 *   waits up to 10 more minutes. With a `nightSalt` the day's night is drawn from the date and the salt alone, so that the planners of every bot
 *   (one person) sleep the same night, and a restart keeps it.
 *
 * Pure: the clock is the caller's, and the draws come from the seeded `Rng`, so a simulation over
 * many days can check all of the above.
 */
import { Rng } from '@megabottron1999/core/rng.ts';

export interface ScheduleParams {
  /** The interval between sends, in minutes. */
  minGapMin: number;
  maxGapMin: number;
  /** The chance that a turn is forgotten. */
  skipChance: number;
  /** The night, `HH:MM` in `timeZone`, both after midnight: asleep from bedtime to waking. */
  bedtime: string;
  wake: string;
  /** How far bedtime and waking may each move, either way, in minutes. */
  jitterMin: number;
  /** The most extra minutes after waking before the first send. */
  wakeDelayMaxMin: number;
  timeZone: string;
}

export const DEFAULT_SCHEDULE: ScheduleParams = {
  minGapMin: 17,
  maxGapMin: 20,
  skipChance: 0.08,
  bedtime: '01:30',
  wake: '08:30',
  jitterMin: 45,
  wakeDelayMaxMin: 10,
  timeZone: 'Europe/Rome',
};

const MINUTE = 60_000;

/** Minutes after midnight of an `HH:MM`, or undefined if it is not one. */
export function clockMinutes(hhmm: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** What is wrong with `p`, or undefined if nothing. */
export function scheduleProblem(p: ScheduleParams): string | undefined {
  const bed = clockMinutes(p.bedtime);
  const wake = clockMinutes(p.wake);
  const finite = [p.minGapMin, p.maxGapMin, p.skipChance, p.jitterMin, p.wakeDelayMaxMin];
  if (!finite.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))
    return 'numbers must be finite and not negative';
  if (p.minGapMin < 15) return 'minGapMin must be at least 15, the bots’ own rest';
  if (p.maxGapMin < p.minGapMin) return 'maxGapMin must not be under minGapMin';
  if (p.skipChance >= 1) return 'skipChance must be under 1';
  if (bed === undefined || wake === undefined) return 'bedtime and wake must be HH:MM';
  // The whole night, jitter included, stays within one calendar day.
  if (
    bed - p.jitterMin < 0 ||
    wake + p.jitterMin >= 24 * 60 ||
    bed + p.jitterMin >= wake - p.jitterMin
  )
    return 'bedtime and wake, moved by jitterMin, must stay after midnight and in order';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: p.timeZone });
  } catch {
    return `unknown timeZone ${p.timeZone}`;
  }
  return undefined;
}

/** The calendar date and the offset from UTC (ms) of instant `t` in `timeZone`. */
function zoned(t: number, timeZone: string): { date: string; offset: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(t)
      .map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((k) =>
    Number(parts[k])
  ) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    offset: wall - (t - (t % 1000)),
  };
}

/** The instant of `minutes` after midnight on `date` (YYYY-MM-DD) in `timeZone`. */
export function zonedInstant(date: string, minutes: number, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  // The offset at the guess, then again at the result, for a guess on the other side of a change.
  const first = wall - zoned(wall, timeZone).offset;
  return wall - zoned(first, timeZone).offset;
}

/** The local calendar date of `t` in `timeZone`. */
export function localDate(t: number, timeZone: string): string {
  return zoned(t, timeZone).date;
}

export interface Plan {
  /** When to send. */
  at: number;
  /** How many turns were forgotten before it. */
  skipped: number;
  /** Whether it waits for the morning. */
  afterSleep: boolean;
}

export class Planner {
  private readonly p: ScheduleParams;
  private readonly rng: Rng;
  /** Each day's night, drawn once. */
  private readonly nights = new Map<string, { from: number; to: number }>();

  private readonly nightSalt: string | undefined;

  constructor(params: ScheduleParams, rng: Rng, nightSalt?: string) {
    this.p = params;
    this.rng = rng;
    this.nightSalt = nightSalt;
  }

  /** A uniform draw in [lo, hi] minutes, in ms. */
  private minutes(lo: number, hi: number): number {
    return (lo + this.rng.next() * (hi - lo)) * MINUTE;
  }

  /** The night of local `date`: from bedtime to waking, each moved by the day's jitter. */
  night(date: string): { from: number; to: number } {
    let n = this.nights.get(date);
    if (n === undefined) {
      const { jitterMin: j, timeZone } = this.p;
      const rng =
        this.nightSalt === undefined ? this.rng : new Rng(hash(`${this.nightSalt}${date}`));
      const bed = (clockMinutes(this.p.bedtime) as number) + (rng.next() * 2 - 1) * j;
      const wake = (clockMinutes(this.p.wake) as number) + (rng.next() * 2 - 1) * j;
      n = { from: zonedInstant(date, bed, timeZone), to: zonedInstant(date, wake, timeZone) };
      this.nights.set(date, n);
    }
    return n;
  }

  /** Whether `t` falls in its day's night. */
  asleep(t: number): boolean {
    const n = this.night(localDate(t, this.p.timeZone));
    return t >= n.from && t < n.to;
  }

  /**
   * The next send after the owner's last `/play` at `last` (undefined if none is known), as of
   * `now`. With none known, or a last one so old that its turn has passed, it sends at once: the
   * author turned it on with no recent `/play` to wait for.
   */
  next(last: number | undefined, now: number): Plan {
    const { minGapMin: lo, maxGapMin: hi } = this.p;
    let at: number;
    let skipped = 0;
    if (last === undefined || last + hi * MINUTE < now) at = now;
    else {
      at = last + this.minutes(lo, hi);
      while (this.rng.chance(this.p.skipChance)) {
        at += this.minutes(lo, hi);
        skipped++;
      }
    }
    return this.awake(at, skipped);
  }

  /**
   * The next send after a rest the bot stated, ending at `until`: a few minutes after it (up to the
   * spread of the interval, `maxGapMin - minGapMin`), as a person would come back to it.
   */
  after(until: number): Plan {
    return this.awake(until + this.minutes(0, this.p.maxGapMin - this.p.minGapMin), 0);
  }

  /** `at`, or the morning after the night it falls in. */
  private awake(at: number, skipped: number): Plan {
    const n = this.night(localDate(at, this.p.timeZone));
    if (at < n.from || at >= n.to) return { at, skipped, afterSleep: false };
    return { at: n.to + this.minutes(0, this.p.wakeDelayMaxMin), skipped, afterSleep: true };
  }
}

/** A 32-bit FNV-1a hash of `text`: a seed that depends on it alone. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
