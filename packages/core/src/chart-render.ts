/**
 * A chart as a picture (docs/bot-os.md D174, bot-os-api.md §4.13): the same chart a view draws
 * (`chart.ts`), drawn by Plot on the server, in a DOM of its own (linkedom), as an SVG, then a PNG
 * through the render service (`svgToPng`), for a plugin to send to the owner's chat (P18: what fits
 * one plotted picture). Its text is in the font the shell ships (`assets/fonts`, DejaVu Sans, which
 * has the currency signs, ₭ among them), so that it looks the same on every host; its title and its
 * legend are drawn above it in the SVG, since Plot's legend is HTML.
 *
 * Plot and linkedom are loaded at the first chart.
 */
import { fileURLToPath } from 'node:url';
import { CHART_FONT, chartData, chartPlot, chartTheme } from './chart.ts';
import { svgToPng, type SvgToPngOptions } from './render.ts';
import { type ChartSpec, chartSpecSchema } from './widgets.ts';

/** How a chart is drawn as a picture. */
export interface ChartPictureOptions {
  /** Its width in the SVG's pixels: 640 by default (its height is the chart's, plus its title). */
  width?: number;
  /** A dark background and light text: false by default. */
  dark?: boolean;
  /** The PNG's zoom on that size: 2 by default, sharp on a phone. */
  scale?: number;
  /** The PNG's longest side at most (a network's limit). */
  maxSide?: number;
}

/** The font file the shell ships, for a chart's text: found as it is asked, not as this loads. */
export function chartFontFile(): string {
  return fileURLToPath(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url));
}

type PlotModule = typeof import('@observablehq/plot');
let modules: Promise<[PlotModule, typeof import('linkedom')]> | undefined;

const xml = (s: string): string =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** About how wide a text is at 12px, for the legend's layout. */
const textWidth = (s: string): number => s.length * 7;

/**
 * A chart's SVG: its spec checked (`chartSpecSchema`, thrown with why), its points from `rows` (a
 * list's items, a map's values), drawn by Plot, with its title (`label`) and legend above.
 */
export async function chartSvg(
  spec: ChartSpec,
  rows: unknown,
  o: ChartPictureOptions = {}
): Promise<string> {
  const parsed = chartSpecSchema.safeParse(spec);
  if (!parsed.success)
    throw new Error(
      `chart: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(spec)'}: ${i.message}`).join('; ')}`
    );
  const c = parsed.data;
  modules ??= Promise.all([import('@observablehq/plot'), import('linkedom')]);
  const [Plot, { parseHTML }] = await modules;
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const width = o.width ?? 640;
  const theme = chartTheme(o.dark === true);
  const data = chartData(c, rows);
  const plotted = Plot.plot(
    chartPlot(Plot, c, data, { width, theme, interactive: false, document })
  ) as unknown as { outerHTML: string; getAttribute(n: string): string | null };
  const height = Number(plotted.getAttribute('height') ?? c.height ?? 260);
  // Its title, then its legend's swatches, in rows as wide as the chart.
  const pad = 12;
  let y = pad;
  const head: string[] = [];
  if (c.label !== undefined) {
    y += 16;
    head.push(
      `<text x="${pad}" y="${y}" font-size="15" font-weight="bold" fill="${theme.text}">${xml(c.label)}</text>`
    );
    y += 8;
  }
  if (data.series.length > 1) {
    let x = pad;
    y += 14;
    data.series.forEach((s, i) => {
      const w = 16 + textWidth(s) + 14;
      if (x + w > width - pad && x > pad) {
        x = pad;
        y += 18;
      }
      const colour = theme.colors[i % theme.colors.length] ?? theme.text;
      head.push(
        `<rect x="${x}" y="${y - 10}" width="11" height="11" rx="2" fill="${colour}"/>`,
        `<text x="${x + 16}" y="${y}" font-size="12" fill="${theme.text}">${xml(s)}</text>`
      );
      x += w;
    });
    y += 6;
  }
  const top = head.length === 0 ? 0 : y + 4;
  const total = top + height;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" font-family="${CHART_FONT}">`,
    `<rect width="${width}" height="${total}" fill="${theme.background}"/>`,
    ...head,
    `<g transform="translate(0,${top})">${plotted.outerHTML}</g>`,
    '</svg>',
  ].join('');
}

/** A chart as a PNG's bytes (`chartSvg`, then `svgToPng` in the shell's font). */
export async function chartPng(
  spec: ChartSpec,
  rows: unknown,
  o: ChartPictureOptions = {}
): Promise<Uint8Array> {
  const svg = await chartSvg(spec, rows, o);
  const png: SvgToPngOptions = {
    fonts: [chartFontFile()],
    defaultFontFamily: CHART_FONT,
    scale: o.scale ?? 2,
    ...(o.maxSide === undefined ? {} : { maxSide: o.maxSide }),
  };
  return svgToPng(svg, png);
}
