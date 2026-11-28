/**
 * A chart as a picture for the owner's chat (bot-os.md D174): a made-up shop's donations per day,
 * drawn on the server and rendered in the shell's font.
 */
import { type ChartShape } from '@megabottron1999/chart/chart.ts';
import { describe, expect, it } from 'vitest';
import { chartFontFile, chartPng, chartSvg } from './chart-render.ts';
import { resvgRender } from './render.ts';

const at = (d: number, h: number): number => Date.UTC(2026, 10, d, h);
const DONATIONS = [
  { at: at(20, 9), counted: true, amount: 120 },
  { at: at(20, 15), counted: false, amount: 40 },
  { at: at(21, 10), counted: true, amount: 210 },
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

describe('a chart’s picture (D174)', () => {
  it('draws the SVG with its title and legend, and a PNG in the shell’s font', async () => {
    const svg = await chartSvg(PER_DAY as never, DONATIONS);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/u);
    expect(svg).toContain('Donations per day');
    expect(svg).toContain('Not counted');
    expect(svg).toContain('21 Nov');
    const png = await chartPng(PER_DAY as never, DONATIONS, { dark: true, maxSide: 800 });
    expect([...png.slice(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
    expect(chartFontFile()).toMatch(/DejaVuSans\.ttf$/u);
    // A legend that wraps, a chart with no title, and the render service's own.
    const many = Array.from({ length: 8 }, (_, i) => ({ k: `a rather long series ${i}`, x: 'a' }));
    const wrapped = await resvgRender.chartSvg({ show: 'chart', x: 'x', series: 'k' }, many, {
      width: 300,
    });
    expect(wrapped).not.toContain('font-weight="bold"');
    expect((await resvgRender.chart({ show: 'chart', x: 'x' }, many)).length).toBeGreaterThan(100);
  });

  it('refuses a spec that is no chart, saying why', async () => {
    await expect(chartSvg({ show: 'chart' } as never, [])).rejects.toThrow('chart: x:');
    await expect(chartSvg({ show: 'pie', x: 'a' } as never, [])).rejects.toThrow(
      'expected show to be one of: chart, timeseries'
    );
  });
});
