/**
 * A chart's points and its Plot options (docs/bot-os.md D174, #87 phase 4), one code for the web
 * UI's view (in the browser) and for a picture sent to the owner's chat (`chart-render.ts`, on the
 * server), so that both draw alike.
 *
 * - **Its points** (`chartData`): the rows (a list's items, a map's values) gathered by `x` and by
 *   series, each measure reduced over the rows of a point (`sum`, `count`, `mean`, `min`, `max`).
 *   A time series' `x` is a time, gathered by its `interval` in its `timeZone` (UTC by default),
 *   shown as that zone's wall time. Series: one per measure of several `y`, or one per value of a
 *   row's `series` (renamed by `seriesLabels`), else one.
 * - **Its options** (`chartPlot`): Plot's marks for them (bars, stacked or side by side, lines,
 *   areas or dots), its colours from the theme given, each point's tooltip its series, its `x`, its
 *   measure and its second measure (`value`) with their units.
 *
 * Plot itself is given (`Plot`), not imported here: the web UI loads it in a chunk of its own, only
 * on a view with a chart, and the server at its first chart.
 */
import type * as PlotModule from '@observablehq/plot';
import { type ChartMeasure, type ViewChart } from './widgets.ts';

/** A chart as drawn: a leaf's, or a plugin's (`ChartSpec`), without the read it shows. */
export type ChartShape = ViewChart extends infer T
  ? T extends ViewChart
    ? Omit<T, 'from' | 'read' | 'input' | 'path' | 'empty'> & { label?: string | undefined }
    : never
  : never;

/** A measure with its defaults: its path (none: rows counted), reduce, label, format and unit. */
export interface Measure {
  path?: string;
  reduce: 'sum' | 'count' | 'mean' | 'min' | 'max';
  label: string;
  format: 'number' | 'percent';
  unit?: string;
}

/** One point: its `x` (a category, a number, or a time as wall time), its series and measures. */
export interface ChartPoint {
  x: string | number | Date;
  /** Its `x` in words, for the tooltip and a band's ticks. */
  xLabel: string;
  series: string;
  y: number;
  /** The second measure (`value`), when the chart has one. */
  value?: number;
  /** How many rows it gathers. */
  rows: number;
}

export interface ChartData {
  points: ChartPoint[];
  /** The series in order: as `seriesLabels` names them, then as they come. */
  series: string[];
  /** The measure each point's `y` is (the first, when several each make a series). */
  y: Measure[];
  value?: Measure;
  /** Its `x` is a time. */
  time: boolean;
  /**
   * Every `x` in words, in order: a time series' intervals with none missing between its first and
   * its last (at most `MAX_INTERVALS`), so that a day with no row shows as one.
   */
  xs: string[];
}

/** The most intervals a time series lays out between its first and its last. */
export const MAX_INTERVALS = 1000;

/** The interval after a wall time's. */
function nextInterval(w: number, interval: 'minute' | 'hour' | 'day' | 'week' | 'month'): number {
  const d = new Date(w);
  switch (interval) {
    case 'minute':
      return w + 60_000;
    case 'hour':
      return w + 3_600_000;
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    case 'week':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7);
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
}

/** The colours a chart draws with, and its text, grid and background (light by default). */
export interface ChartTheme {
  colors: readonly string[];
  /** Its text and axes; `currentColor` in the browser, so that it follows the page. */
  text: string;
  background: string;
  font: string;
}

/** A light theme's series colours: distinct, legible on white and in a picture alike. */
export const CHART_COLORS = [
  '#2563eb',
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#8b5cf6',
  '#0ea5e9',
  '#ec4899',
  '#84cc16',
] as const;
/** A dark theme's: lighter, for a dark background. */
export const CHART_COLORS_DARK = [
  '#60a5fa',
  '#fbbf24',
  '#34d399',
  '#f87171',
  '#a78bfa',
  '#38bdf8',
  '#f472b6',
  '#a3e635',
] as const;

/** The font a picture's text is drawn in: the one the shell ships (`assets/fonts`). */
export const CHART_FONT = 'DejaVu Sans';

/** A picture's theme, light or dark. */
export function chartTheme(dark = false): ChartTheme {
  return dark
    ? { colors: CHART_COLORS_DARK, text: '#e5e7eb', background: '#111827', font: CHART_FONT }
    : { colors: CHART_COLORS, text: '#1f2937', background: '#ffffff', font: CHART_FONT };
}

/** A value at a dotted path of a row. */
function at(row: unknown, p: string): unknown {
  let v: unknown = row;
  for (const k of p.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const lastKey = (p: string): string => p.split('.').at(-1) ?? p;

/** A measure with its defaults filled in. */
function measureOf(m: ChartMeasure | undefined, fallback: string): Measure {
  if (m === undefined) return { reduce: 'count', label: fallback, format: 'number' };
  if (typeof m === 'string') return { path: m, reduce: 'sum', label: lastKey(m), format: 'number' };
  return {
    ...(m.path === undefined ? {} : { path: m.path }),
    reduce: m.reduce ?? (m.path === undefined ? 'count' : 'sum'),
    label: m.label ?? (m.path === undefined ? fallback : lastKey(m.path)),
    format: m.format ?? 'number',
    ...(m.unit === undefined ? {} : { unit: m.unit }),
  };
}

/** A list's items, a map's values; none for anything else. */
function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value);
  return [];
}

/** The calendar fields of an instant in a zone. */
function fields(t: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(t);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return [get('year'), get('month'), get('day'), get('hour'), get('minute'), get('second')];
}

/** An instant's wall time in a zone, as the UTC time of those fields (how Plot then shows it). */
export function wallTime(t: number, timeZone: string): number {
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = fields(t, timeZone);
  return Date.UTC(y, mo - 1, d, h, mi, s, new Date(t).getUTCMilliseconds());
}

/** The start of the interval an instant is in, in a zone, as wall time (`wallTime`). */
export function intervalStart(
  t: number,
  interval: 'minute' | 'hour' | 'day' | 'week' | 'month',
  timeZone: string
): number {
  const w = new Date(wallTime(t, timeZone));
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth();
  const d = w.getUTCDate();
  switch (interval) {
    case 'minute':
      return Date.UTC(y, mo, d, w.getUTCHours(), w.getUTCMinutes());
    case 'hour':
      return Date.UTC(y, mo, d, w.getUTCHours());
    case 'day':
      return Date.UTC(y, mo, d);
    case 'week':
      // Monday's.
      return Date.UTC(y, mo, d - ((w.getUTCDay() + 6) % 7));
    case 'month':
      return Date.UTC(y, mo, 1);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** A wall time in words, as precise as its interval: `21 Nov`, `21 Nov 14:00`, `Nov 2026`. */
export function wallLabel(w: number, interval: string | undefined): string {
  const d = new Date(w);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
  const clock = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  if (interval === 'month') return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
  if (interval === 'day' || interval === 'week') return day;
  return `${day} ${clock}`;
}

/** A measure's number in words, with its unit: `1,250 ₭`, `40%`. */
export function measureText(n: number, m: Measure): string {
  const text =
    m.format === 'percent'
      ? `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
      : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return m.unit === undefined ? text : `${text} ${m.unit}`;
}

interface Acc {
  sum: number;
  n: number;
  min: number;
  max: number;
}
const empty = (): Acc => ({ sum: 0, n: 0, min: Infinity, max: -Infinity });
function add(a: Acc, v: unknown, counting: boolean): void {
  if (counting) {
    a.n += 1;
    return;
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return;
  a.sum += n;
  a.n += 1;
  a.min = Math.min(a.min, n);
  a.max = Math.max(a.max, n);
}
function reduced(a: Acc, m: Measure): number {
  switch (m.reduce) {
    case 'count':
      return a.n;
    case 'sum':
      return a.sum;
    case 'mean':
      return a.n === 0 ? 0 : a.sum / a.n;
    case 'min':
      return a.n === 0 ? 0 : a.min;
    case 'max':
      return a.n === 0 ? 0 : a.max;
  }
}

/** A time as ms since the epoch: a number, or an ISO string; undefined for neither. */
function timeOf(v: unknown): number | undefined {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** A chart's points from the value its read gives at its path (D174). */
export function chartData(c: ChartShape, value: unknown): ChartData {
  const label = c.label ?? 'Rows';
  const ys = (Array.isArray(c.y) ? c.y : [c.y]).map((m) =>
    measureOf(m as ChartMeasure | undefined, label)
  );
  const several = ys.length > 1;
  const v = c.value === undefined ? undefined : measureOf(c.value, 'Value');
  const time = c.show === 'timeseries';
  const tz = (c.show === 'timeseries' ? c.timeZone : undefined) ?? 'UTC';
  const interval = c.show === 'timeseries' ? c.interval : undefined;
  const labels = c.seriesLabels ?? {};
  const series: string[] = several ? ys.map((m) => m.label) : Object.values(labels);
  const named = (s: string): void => {
    if (!series.includes(s)) series.push(s);
  };
  // Points by x, then by series: their measures' accumulators, in the order they come.
  const xs = new Map<
    string,
    { x: string | number | Date; xLabel: string; sort: number | string }
  >();
  const accs = new Map<string, { ys: Acc[]; v: Acc; rows: number }>();
  let numeric = true;
  for (const row of rowsOf(value)) {
    const raw = at(row, c.x);
    let key: string;
    if (time) {
      const t = timeOf(raw);
      if (t === undefined) continue;
      const w = interval === undefined ? wallTime(t, tz) : intervalStart(t, interval, tz);
      key = String(w);
      if (!xs.has(key)) xs.set(key, { x: new Date(w), xLabel: wallLabel(w, interval), sort: w });
    } else {
      if (raw === undefined || raw === null) continue;
      key = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (typeof raw !== 'number') numeric = false;
      if (!xs.has(key)) xs.set(key, { x: raw as string | number, xLabel: key, sort: xs.size });
    }
    const groups = several
      ? ys.map((m, i) => [m.label, i] as const)
      : [
          [
            c.series === undefined
              ? (ys[0]?.label ?? label)
              : (() => {
                  const s = at(row, c.series);
                  const k = typeof s === 'string' ? s : JSON.stringify(s ?? null);
                  return labels[k] ?? k;
                })(),
            0,
          ] as const,
        ];
    for (const [s, i] of groups) {
      named(s);
      const k = `${key}\u0000${s}`;
      let a = accs.get(k);
      if (a === undefined) accs.set(k, (a = { ys: ys.map(empty), v: empty(), rows: 0 }));
      a.rows += 1;
      const m = ys[i] as Measure;
      add(a.ys[i] as Acc, m.path === undefined ? undefined : at(row, m.path), m.path === undefined);
      if (v !== undefined)
        add(a.v, v.path === undefined ? undefined : at(row, v.path), v.path === undefined);
    }
  }
  // Numbers in order; categories as they came; times in order.
  const order = [...xs.entries()];
  if (time || (numeric && !time))
    order.sort(([, a], [, b]) =>
      time ? (a.sort as number) - (b.sort as number) : (a.x as number) - (b.x as number)
    );
  const points: ChartPoint[] = [];
  for (const [key, x] of order)
    for (const s of series) {
      const a = accs.get(`${key}\u0000${s}`);
      if (a === undefined) continue;
      const i = several ? ys.findIndex((m) => m.label === s) : 0;
      points.push({
        x: x.x,
        xLabel: x.xLabel,
        series: s,
        y: reduced(a.ys[i] as Acc, ys[i] as Measure),
        ...(v === undefined ? {} : { value: reduced(a.v, v) }),
        rows: a.rows,
      });
    }
  let inOrder = order.map(([, x]) => x.xLabel);
  if (interval !== undefined && order.length > 1) {
    const first = order[0]?.[1].sort as number;
    const last = order.at(-1)?.[1].sort as number;
    const all: string[] = [];
    for (let w = first; w <= last && all.length < MAX_INTERVALS; w = nextInterval(w, interval))
      all.push(wallLabel(w, interval));
    inOrder = all;
  }
  return {
    points,
    xs: inOrder,
    series: series.filter((s) => points.some((p) => p.series === s)),
    y: ys,
    ...(v === undefined ? {} : { value: v }),
    time,
  };
}

/** How a chart is drawn: its width, its theme, and whether its points show a tooltip on hover. */
export interface ChartDraw {
  width: number;
  theme: ChartTheme;
  /** A tooltip on hover, and Plot's legend (in the browser); none in a picture. */
  interactive: boolean;
  /** Plot's own `document`, for a server's DOM. */
  document?: unknown;
}

/** Whether a chart's series pile up at each x: bars or areas, stacked or of one series. */
function stacked(mark: string, c: ChartShape, data: ChartData): boolean {
  return (mark === 'bar' || mark === 'area') && (c.stack === true || data.series.length === 1);
}

/** The Plot options that draw a chart's points (D174). */
export function chartPlot(
  Plot: typeof PlotModule,
  c: ChartShape,
  data: ChartData,
  d: ChartDraw
): PlotModule.PlotOptions {
  const mark = c.mark ?? (c.show === 'timeseries' && c.interval === undefined ? 'line' : 'bar');
  const y0 = data.y[0] as Measure;
  const yOf = (p: ChartPoint): Measure =>
    data.y.length > 1 ? (data.y.find((m) => m.label === p.series) ?? y0) : y0;
  // Its tooltip: `Counted · 21 Nov`, `Donations: 5`, `Value: 1,250 ₭`.
  const title = (p: ChartPoint): string =>
    [
      data.series.length > 1 ? `${p.series} · ${p.xLabel}` : p.xLabel,
      `${yOf(p).label}: ${measureText(p.y, yOf(p))}`,
      data.value === undefined || p.value === undefined
        ? undefined
        : `${data.value.label}: ${measureText(p.value, data.value)}`,
    ]
      .filter((l) => l !== undefined)
      .join('\n');
  const tip = d.interactive ? { tip: true as const } : {};
  const band = mark === 'bar';
  // A band's x is its label, in order; a time's, its wall time; a number's, itself.
  const pts = data.points.map((p) => ({ ...p, bx: band ? p.xLabel : p.x }));
  const several = data.series.length > 1;
  const grouped = band && several && c.stack !== true;
  const marks: PlotModule.Markish[] = [];
  if (mark === 'bar')
    marks.push(
      grouped
        ? Plot.barY(pts, { fx: 'bx', x: 'series', y: 'y', fill: 'series', title, ...tip })
        : Plot.barY(pts, { x: 'bx', y: 'y', fill: 'series', title, ...tip })
    );
  else if (mark === 'area')
    marks.push(
      c.stack === true
        ? Plot.areaY(pts, { x: 'bx', y: 'y', fill: 'series', fillOpacity: 0.85 })
        : Plot.areaY(pts, { x: 'bx', y1: 0, y2: 'y', fill: 'series', fillOpacity: 0.3 }),
      ...(c.stack === true ? [] : [Plot.lineY(pts, { x: 'bx', y: 'y', stroke: 'series' })])
    );
  else if (mark === 'line')
    marks.push(
      Plot.lineY(pts, { x: 'bx', y: 'y', stroke: 'series', strokeWidth: 2 }),
      Plot.dot(pts, { x: 'bx', y: 'y', fill: 'series', r: 2.5 })
    );
  else marks.push(Plot.dot(pts, { x: 'bx', y: 'y', fill: 'series', r: 4 }));
  if (mark !== 'bar' && d.interactive)
    marks.push(Plot.tip(pts, Plot.pointerX({ x: 'bx', y: 'y', title })));
  marks.push(Plot.ruleY([0]));
  const percent = y0.format === 'percent';
  // Counts have whole ticks: at most one per unit of the tallest bar or stack.
  const counts = data.y.every((m) => m.reduce === 'count');
  const totals = new Map<string, number>();
  for (const p of data.points) {
    const k = p.xLabel;
    totals.set(
      k,
      stacked(mark, c, data) ? (totals.get(k) ?? 0) + p.y : Math.max(totals.get(k) ?? 0, p.y)
    );
  }
  const tallest = Math.max(1, ...totals.values());
  const interval = c.show === 'timeseries' ? c.interval : undefined;
  return {
    ...(d.document === undefined
      ? {}
      : { document: d.document as NonNullable<PlotModule.PlotOptions['document']> }),
    width: d.width,
    height: c.height ?? 260,
    marginLeft: 48,
    marginRight: 24,
    style: {
      background: d.theme.background,
      color: d.theme.text,
      fontFamily: d.theme.font,
      fontSize: '12px',
      overflow: 'visible',
    },
    color: {
      domain: data.series,
      range: [...d.theme.colors],
      ...(d.interactive && several ? { legend: true } : {}),
    },
    x: band
      ? { type: 'band', label: null, domain: data.xs, ...(grouped ? { axis: null } : {}) }
      : data.time
        ? {
            type: 'utc',
            label: null,
            ...(interval === undefined
              ? {}
              : { ticks: interval, tickFormat: (t: Date) => wallLabel(+t, interval) }),
          }
        : { label: lastKey(c.x) },
    ...(grouped ? { fx: { label: null, padding: 0.15, domain: data.xs } } : {}),
    y: {
      grid: true,
      label:
        data.y.length > 1 ? null : `${y0.label}${y0.unit === undefined ? '' : ` (${y0.unit})`}`,
      ...(percent ? { percent: true } : {}),
      ...(counts
        ? {
            ticks: Math.min(tallest, 8),
            tickFormat: (n: number) => (Number.isInteger(n) ? String(n) : ''),
          }
        : {}),
    },
    marks,
  };
}
