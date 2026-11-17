import { describe, expect, it } from 'vitest';
import {
  formatWindowsDate,
  isTimeZone,
  offsetAt,
  parseJsonDate,
  parseMacDate,
  parseWindowsDate,
  type WallClock,
  wallClockOffset,
  windowsDateSeconds,
} from './dates.ts';

describe('dates', () => {
  it('parseWindowsDate reads only the Windows date title, and checks the date exists', () => {
    expect(windowsDateSeconds('27.11.2025 19:14:19 UTC-05:00')).toBe(1764288859);
    expect(parseWindowsDate('01.11.2025 19:14:19 UTC+05:30')?.offsetMinutes).toBe(330);
    for (const bad of [
      '27.11.2025 19:14:60 UTC-05:00',
      '30.02.2025 01:02:03 UTC+00:00',
      '27.11.2025 24:00:00 UTC+00:00',
      '27.11.2025 19:14:19 UTC+25:00',
      '27.11.2025 19:14:19 UTC-05:00x',
      '27.11.2025 19:14:19 -05:00',
      ' 1.11.2025 19:14:19 UTC-05:00',
      '27.11.2025 19:14:19',
      null,
    ]) {
      expect(parseWindowsDate(bad), String(bad)).toBeNull();
    }
  });

  it('formatWindowsDate writes the parsed date back', () => {
    const d = parseWindowsDate('07.03.2026 05:04:03 UTC-05:00');
    expect(d && formatWindowsDate(d)).toBe('07.03.2026 05:04:03 UTC-05:00');
  });

  it('wallClockOffset follows daylight saving time', () => {
    const at = (month: number, day: number, hour: number) => ({
      year: 2025,
      month,
      day,
      hour,
      minute: 30,
      second: 0,
    });
    const rome = (month: number, day: number, hour: number) =>
      wallClockOffset(at(month, day, hour), 'Europe/Rome');
    expect([rome(11, 28, 19), rome(7, 1, 19)]).toStrictEqual([60, 120]);
    // 30 March: 02:30 never happens (clocks go forward): the offset from before.
    expect(rome(3, 30, 2)).toBe(60);
    expect(rome(3, 30, 4)).toBe(120); // hours after the change: the new offset
    // 26 October: 02:30 happens twice (clocks go back): the first one.
    expect([rome(10, 26, 2), rome(10, 26, 3)]).toStrictEqual([120, 60]);
    expect(wallClockOffset(at(11, 28, 0), 'Asia/Kolkata')).toBe(330);
    expect(wallClockOffset(at(11, 28, 0), 'UTC')).toBe(0);
  });

  it('wallClockOffset is the same at every minute around a change, read again', () => {
    // Rome, 2025: forward at 02:00 on 30 March, back at 03:00 on 26 October.
    const before = (day: number, hour: number, change: number): boolean =>
      day < change || (day === change && hour < 3);
    const expected = (month: number, day: number, hour: number): number =>
      month === 3 ? (before(day, hour, 30) ? 60 : 120) : before(day, hour, 26) ? 120 : 60;
    const read = (): [number, number][] => {
      const out: [number, number][] = [];
      for (const [month, first] of [
        [3, 29],
        [10, 25],
      ] as const)
        for (let day = first; day < first + 3; day++)
          for (let hour = 0; hour < 24; hour++)
            for (let minute = 0; minute < 60; minute += 10) {
              const w = { year: 2025, month, day, hour, minute, second: 0 };
              out.push([wallClockOffset(w, 'Europe/Rome'), expected(month, day, hour)]);
            }
      return out;
    };
    for (const pairs of [read(), read()]) for (const [got, want] of pairs) expect(got).toBe(want);
  });

  it('isTimeZone knows IANA zones only', () => {
    expect(['Europe/Rome', 'UTC', 'America/New_York'].map(isTimeZone)).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(['Mars/Base', 'Italia'].map(isTimeZone)).toStrictEqual([false, false]);
  });

  it("parseJsonDate reads the JSON export's wall clock, and offsetAt its offset", () => {
    const w = parseJsonDate('2025-11-27T19:14:19');
    expect(w).toStrictEqual({ year: 2025, month: 11, day: 27, hour: 19, minute: 14, second: 19 });
    expect(offsetAt(w as WallClock, 1764288859)).toBe(-300);
    expect(offsetAt(w as WallClock, 1764288858)).toBeNull();
    for (const bad of ['2025-02-30T00:00:00', '2025-11-27 19:14:19', '2025-11-27T19:14:19Z', null])
      expect(parseJsonDate(bad), String(bad)).toBeNull();
  });

  it('parseMacDate reads the macOS date title, and checks the date exists', () => {
    expect(parseMacDate('7 November 2025, 19:14:19')).toMatchObject({ month: 11, day: 7 });
    expect(parseMacDate('31 February 2025, 19:14:19')).toBeNull();
    expect(parseMacDate('7 Novembre 2025, 19:14:19')).toBeNull();
  });
});
