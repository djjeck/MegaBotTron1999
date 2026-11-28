/**
 * A chart's points and Plot options (bot-os.md D174): a made-up shop's donations per day, counted
 * and not, with their value in ₭.
 */
import * as Plot from '@observablehq/plot';
import { describe, expect, it } from 'vitest';
import {
  chartData,
  chartPlot,
  type ChartShape,
  chartTheme,
  intervalStart,
  MAX_INTERVALS,
  measureText,
  wallLabel,
  wallTime,
} from './chart.ts';

const at = (d: number, h: number): number => Date.UTC(2026, 10, d, h);
const DONATIONS = [
  { at: at(20, 9), counted: true, amount: 120 },
  { at: at(20, 15), counted: false, amount: 40 },
  // 23:00 UTC is midnight in Rome: the 21st there.
  { at: at(20, 23), counted: true, amount: 60 },
  { at: new Date(at(21, 10)).toISOString(), counted: true, amount: 210 },
  { at: at(23, 11), counted: false, amount: 90 },
  { at: 'not a time', counted: true, amount: 5 },
];
const PER_DAY: ChartShape = {
  show: 'timeseries',
  label: 'Donations per day',
  x: 'at',
  interval: 'day',
  timeZone: 'Europe/Rome',
  stack: true,
  series: 'counted',
  seriesLabels: { true: 'Counted', false: 'Not counted' },
  y: { label: 'Donations' },
  value: { path: 'amount', label: 'Value', unit: '₭' },
};

describe('a chart’s points (D174)', () => {
  it('gathers a time series by day in its zone, by series, counting and summing', () => {
    const d = chartData(PER_DAY, DONATIONS);
    expect(d.series).toEqual(['Counted', 'Not counted']);
    expect(d.points.map((p) => [p.xLabel, p.series, p.y, p.value])).toEqual([
      ['20 Nov', 'Counted', 1, 120],
      ['20 Nov', 'Not counted', 1, 40],
      ['21 Nov', 'Counted', 2, 270],
      ['23 Nov', 'Not counted', 1, 90],
    ]);
    // A day with no donation still shows, as a gap.
    expect(d.xs).toEqual(['20 Nov', '21 Nov', '22 Nov', '23 Nov']);
    expect(d.time).toBe(true);
    expect(d.value).toMatchObject({ reduce: 'sum', unit: '₭' });
  });

  it('makes a series of each measure, and reduces each its own way', () => {
    const d = chartData(
      {
        show: 'chart',
        x: 'player',
        y: [
          'amount',
          { path: 'amount', reduce: 'mean', label: 'Mean' },
          { path: 'amount', reduce: 'min', label: 'Least' },
          { path: 'amount', reduce: 'max', label: 'Most', format: 'percent' },
        ],
      },
      {
        a: { player: 'bob', amount: 10 },
        b: { player: 'alice', amount: 5 },
        c: { player: 'bob', amount: '30' },
        d: { player: 'bob', amount: 'many' },
        e: { amount: 1 },
      }
    );
    expect(d.series).toEqual(['amount', 'Mean', 'Least', 'Most']);
    // Categories as they came.
    expect(d.xs).toEqual(['bob', 'alice']);
    expect(d.points.filter((p) => p.x === 'bob').map((p) => p.y)).toEqual([40, 20, 10, 30]);
    expect(chartData({ show: 'chart', x: 'n' }, 'nothing').points).toEqual([]);
  });

  it('orders numbers, takes one series of rows counted, and a time series of no interval', () => {
    const n = chartData({ show: 'chart', x: 'level' }, [{ level: 3 }, { level: 1 }, { level: 3 }]);
    expect(n.points.map((p) => [p.x, p.y])).toEqual([
      [1, 1],
      [3, 2],
    ]);
    expect(n.series).toEqual(['Rows']);
    const t = chartData({ show: 'timeseries', x: 't', y: 'v' }, [
      { t: at(2, 1), v: 2 },
      { t: at(1, 1), v: 1 },
    ]);
    expect(t.points.map((p) => p.xLabel)).toEqual(['1 Nov 01:00', '2 Nov 01:00']);
  });

  it('keeps wall times and intervals in a zone', () => {
    const t = Date.UTC(2026, 10, 25, 23, 30); // a Wednesday, 00:30 the 26th in Rome
    expect(wallTime(t, 'Europe/Rome')).toBe(Date.UTC(2026, 10, 26, 0, 30));
    expect(intervalStart(t, 'minute', 'UTC')).toBe(Date.UTC(2026, 10, 25, 23, 30));
    expect(intervalStart(t, 'hour', 'UTC')).toBe(Date.UTC(2026, 10, 25, 23));
    expect(intervalStart(t, 'week', 'Europe/Rome')).toBe(Date.UTC(2026, 10, 23));
    expect(intervalStart(t, 'month', 'UTC')).toBe(Date.UTC(2026, 10, 1));
    expect(wallLabel(Date.UTC(2026, 10, 1), 'month')).toBe('Nov 2026');
    expect(wallLabel(Date.UTC(2026, 10, 1, 14), 'hour')).toBe('1 Nov 14:00');
    for (const interval of ['minute', 'hour', 'week', 'month'] as const)
      expect(
        chartData({ show: 'timeseries', x: 't', interval }, [
          { t: at(1, 0) },
          { t: Date.UTC(2027, 1, 1) },
        ]).xs.length
      ).toBeGreaterThan(1);
    const long = chartData({ show: 'timeseries', x: 't', interval: 'minute' }, [
      { t: 0 },
      { t: 10 * 365 * 86_400_000 },
    ]);
    expect(long.xs).toHaveLength(MAX_INTERVALS);
  });

  it('words a measure with its unit', () => {
    expect(measureText(1250, { reduce: 'sum', label: 'v', format: 'number', unit: '₭' })).toBe(
      '1,250 ₭'
    );
    expect(measureText(0.4, { reduce: 'sum', label: 'v', format: 'percent' })).toBe('40%');
  });
});

describe('a chart’s Plot options (D174)', () => {
  const draw = { width: 600, theme: chartTheme(), interactive: true };
  it('stacks bars of a band by day, with a tooltip and whole ticks for counts', () => {
    const o = chartPlot(Plot, PER_DAY, chartData(PER_DAY, DONATIONS), draw);
    expect(o.x).toMatchObject({ type: 'band', domain: ['20 Nov', '21 Nov', '22 Nov', '23 Nov'] });
    expect(o.color).toMatchObject({ domain: ['Counted', 'Not counted'], legend: true });
    const y = o.y as { ticks: number; tickFormat: (n: number) => string };
    expect(y.ticks).toBe(2);
    expect([y.tickFormat(1), y.tickFormat(1.5)]).toEqual(['1', '']);
    expect(o.height).toBe(260);
  });

  it('puts several series of bars side by side, unless stacked', () => {
    const c: ChartShape = { show: 'chart', x: 'p', series: 's' };
    const rows = [
      { p: 'a', s: 'x' },
      { p: 'a', s: 'y' },
    ];
    expect(chartPlot(Plot, c, chartData(c, rows), draw)).toHaveProperty('fx');
  });

  it('draws lines, areas and dots on a time or a number, and renders each', () => {
    const rows = DONATIONS.slice(0, 5);
    for (const mark of ['line', 'area', 'dot'] as const)
      for (const stack of mark === 'area' ? [true, undefined] : [undefined]) {
        const c = {
          ...PER_DAY,
          mark,
          ...(stack === undefined ? { stack: undefined } : {}),
        } as ChartShape;
        const o = chartPlot(Plot, c, chartData(c, rows), { ...draw, interactive: false });
        expect(o.x).toMatchObject({ type: 'utc', ticks: 'day' });
        expect(
          (o.x as { tickFormat: (d: Date) => string }).tickFormat(new Date(Date.UTC(2026, 10, 2)))
        ).toBe('2 Nov');
      }
    const n: ChartShape = {
      show: 'chart',
      x: 'level',
      mark: 'line',
      y: { path: 'v', format: 'percent' },
    };
    const o = chartPlot(Plot, n, chartData(n, [{ level: 1, v: 0.5 }]), draw);
    expect(o.x).toEqual({ label: 'level' });
    expect(o.y).toMatchObject({ percent: true });
  });
});
