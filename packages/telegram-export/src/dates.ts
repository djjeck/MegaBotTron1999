/**
 * Dates: the Telegram export's date formats. Pure functions, no Node APIs.
 *
 * - HTML export from Windows: `27.11.2025 19:14:19 UTC-05:00` (docs/telegram-export.md §5.1);
 *   the form the readers give every message's date in.
 * - HTML export from macOS: `27 November 2025, 19:14:19`, without an offset (§11.3).
 * - JSON export: `2025-11-27T19:14:19`, without an offset, beside its instant (`date_unixtime`, §13).
 *
 * A date is a wall clock plus a UTC offset in minutes; dates are compared as instants
 * (epoch seconds), so the same moment written with different offsets is equal. Any
 * other text, or a day that does not exist, is not a date (null).
 */

/** A wall-clock time without a UTC offset. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** A wall clock with its UTC offset, in minutes east of UTC. */
export interface ZonedDate extends WallClock {
  offsetMinutes: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WINDOWS_DATE =
  /^([0-9]{2})\.([0-9]{2})\.([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) UTC([+-])([0-9]{2}):([0-9]{2})$/;
const MAC_DATE = new RegExp(
  `^([0-9]{1,2}) (${MONTHS.join('|')}) ([0-9]{4}), ([0-9]{2}):([0-9]{2}):([0-9]{2})$`
);
/** The JSON export's `date`: the local wall clock in ISO 8601, without an offset. */
const JSON_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})$/;

/** Epoch seconds of a wall clock read as UTC, or null if the date or time does not exist. */
function utcSeconds(w: WallClock): number | null {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second);
  const exists =
    d.getUTCFullYear() === w.year &&
    d.getUTCMonth() === w.month - 1 &&
    d.getUTCDate() === w.day &&
    d.getUTCHours() === w.hour &&
    d.getUTCMinutes() === w.minute &&
    d.getUTCSeconds() === w.second;
  return exists ? d.getTime() / 1000 : null;
}

/** Minutes east of UTC of `±HH:MM` parts (hours 00-23, minutes 00-59), or null. */
function offsetMinutes(sign: string, hh: string, mm: string): number | null {
  const h = Number(hh);
  const m = Number(mm);
  if (h > 23 || m > 59) return null;
  return (sign === '-' ? -1 : 1) * (h * 60 + m);
}

/** A wall clock and an offset from regex groups (day, month, year, h, m, s, sign, oh, om). */
function zoned(g: readonly string[]): ZonedDate | null {
  const [day, month, year, h, mi, sec, sign, oh, om] = g as [string, ...string[]];
  const w = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(h),
    minute: Number(mi),
    second: Number(sec),
  };
  const off = offsetMinutes(sign as string, oh as string, om as string);
  return off === null || utcSeconds(w) === null ? null : { ...w, offsetMinutes: off };
}

/** A Windows export date title (`27.11.2025 19:14:19 UTC-05:00`), or null. */
export function parseWindowsDate(s: string | null | undefined): ZonedDate | null {
  const m = typeof s === 'string' ? WINDOWS_DATE.exec(s) : null;
  return m ? zoned(m.slice(1)) : null;
}

/** A macOS export date title (`27 November 2025, 19:14:19`: English month, 24-hour clock), or null. */
export function parseMacDate(s: string | null | undefined): WallClock | null {
  const m = typeof s === 'string' ? MAC_DATE.exec(s) : null;
  if (!m) return null;
  const w = {
    year: Number(m[3]),
    month: MONTHS.indexOf(m[2] as (typeof MONTHS)[number]) + 1,
    day: Number(m[1]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  return utcSeconds(w) === null ? null : w;
}

/**
 * The JSON export's `date` (`2025-11-27T19:14:19`, the local wall clock without an offset), or
 * null.
 */
export function parseJsonDate(s: string | null | undefined): WallClock | null {
  const m = typeof s === 'string' ? JSON_DATE.exec(s) : null;
  if (!m) return null;
  const w = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  return utcSeconds(w) === null ? null : w;
}

/**
 * The offset, in minutes east of UTC, of a wall clock shown at an instant (epoch seconds): the
 * JSON export's `date` and `date_unixtime` together; null if it is not a whole number of minutes.
 */
export function offsetAt(w: WallClock, epoch: number): number | null {
  const seconds = (utcSeconds(w) as number) - epoch;
  return seconds % 60 === 0 ? seconds / 60 : null;
}

/** Epoch seconds of a date. */
export function epochSeconds(d: ZonedDate): number {
  return (utcSeconds(d) as number) - d.offsetMinutes * 60;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** An offset in minutes as `±HH:MM`. */
export function formatOffset(minutes: number): string {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** A date in the Windows title form: `27.11.2025 19:14:19 UTC-05:00`. */
export function formatWindowsDate(d: ZonedDate): string {
  return (
    `${pad(d.day)}.${pad(d.month)}.${pad(d.year, 4)} ` +
    `${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)} UTC${formatOffset(d.offsetMinutes)}`
  );
}

/** Epoch seconds of a Windows date title, or null if it is not one. */
export function windowsDateSeconds(s: string | null | undefined): number | null {
  const d = parseWindowsDate(s);
  return d === null ? null : epochSeconds(d);
}

/** Formatters by time zone, which are costly to build. */
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    zoneFormats.set(timeZone, f);
  }
  return f;
}

/** Whether `timeZone` is an IANA time zone the runtime knows (`Europe/Rome`, `UTC`). */
export function isTimeZone(timeZone: string): boolean {
  try {
    zoneFormat(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Seconds in a block of zoneBlocks: a change of offset is never within 12 hours of another. */
const BLOCK = 12 * 3600;

/**
 * Per time zone, block (epoch seconds / BLOCK) -> the offset throughout it, or null when
 * it holds a change. Formatting a date is slow, and a run asks for every message's date.
 */
const zoneBlocks = new Map<string, Map<number, number | null>>();

/** Minutes east of UTC that `timeZone` had at an instant (epoch seconds). */
function zoneOffsetAt(timeZone: string, epoch: number): number {
  let blocks = zoneBlocks.get(timeZone);
  if (blocks === undefined) zoneBlocks.set(timeZone, (blocks = new Map()));
  const b = Math.floor(epoch / BLOCK);
  let o = blocks.get(b);
  if (o === undefined) {
    // At most one change within the block, so equal ends mean no change.
    const start = formatOffsetAt(timeZone, b * BLOCK);
    o = start === formatOffsetAt(timeZone, (b + 1) * BLOCK - 1) ? start : null;
    blocks.set(b, o);
  }
  return o ?? formatOffsetAt(timeZone, epoch);
}

/** zoneOffsetAt, read from the formatted date. */
function formatOffsetAt(timeZone: string, epoch: number): number {
  const name = zoneFormat(timeZone)
    .formatToParts(new Date(epoch * 1000))
    .find((p) => p.type === 'timeZoneName')?.value;
  // "GMT" for UTC itself, else "GMT+01:00".
  const m = /^GMT([+-])(\d\d):(\d\d)$/.exec(name ?? '');
  return m ? (offsetMinutes(m[1] as string, m[2] as string, m[3] as string) ?? 0) : 0;
}

/**
 * The UTC offset, in minutes east of UTC, that a wall clock had in `timeZone`, daylight
 * saving time included. When the clocks go back, a wall clock that happens twice takes
 * its first occurrence (the earlier offset); when they go forward, one that never happens
 * takes the offset from before the change.
 */
export function wallClockOffset(w: WallClock, timeZone: string): number {
  const local = utcSeconds(w) ?? 0;
  // A change of offset is never within 12 hours of another.
  const before = zoneOffsetAt(timeZone, local - 12 * 3600);
  const after = zoneOffsetAt(timeZone, local + 12 * 3600);
  const fits = (o: number): boolean => zoneOffsetAt(timeZone, local - o * 60) === o;
  if (fits(before)) return before;
  return fits(after) ? after : before;
}
