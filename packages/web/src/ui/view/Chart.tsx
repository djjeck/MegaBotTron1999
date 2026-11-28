/**
 * A view's chart and time series (docs/bot-os.md D174), drawn by Observable Plot: this module is a
 * chunk of its own (`ViewPage.tsx` loads it lazily), so that only a view with a chart loads Plot.
 * Its points and Plot's options are `@megabottron1999/chart`'s, the same a picture for the owner's
 * chat is drawn from. Its text and axes take the page's colour (`currentColor`), and its series the
 * view's colours (`--chart-1` … `--chart-8`, light and dark), drawn again when the scheme changes;
 * its width is its card's, drawn again as that changes; each point's tooltip on hover.
 */
import type { ChartShape } from '@megabottron1999/chart/chart.ts';
import {
  CHART_COLORS,
  CHART_COLORS_DARK,
  chartData,
  chartPlot,
} from '@megabottron1999/chart/chart.ts';
import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

/** The page's dark scheme, as the browser says, followed as it changes. */
function useDark(): boolean {
  const query = (): MediaQueryList | undefined =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined;
  const [dark, setDark] = useState(() => query()?.matches === true);
  useEffect(() => {
    const q = query();
    if (q === undefined) return undefined;
    const changed = (): void => setDark(q.matches);
    q.addEventListener('change', changed);
    return () => q.removeEventListener('change', changed);
  }, []);
  return dark;
}

/** The view's series colours: its `--chart-<n>` tokens, else the core's palette. */
function colours(el: HTMLElement, dark: boolean): string[] {
  const style = getComputedStyle(el);
  const fallback = dark ? CHART_COLORS_DARK : CHART_COLORS;
  return fallback.map((c, i) => style.getPropertyValue(`--chart-${i + 1}`).trim() || c);
}

export default function Chart(props: { chart: ChartShape; value: unknown; empty: string }) {
  const { chart, value } = props;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const dark = useDark();
  const data = useMemo(() => chartData(chart, value), [chart, value]);
  useEffect(() => {
    const el = box.current;
    if (el === null) return undefined;
    const measure = (): void => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const el = box.current;
    if (el === null || data.points.length === 0) return undefined;
    const drawn = Plot.plot(
      chartPlot(Plot, chart, data, {
        width: Math.max(width, 280),
        theme: {
          colors: colours(el, dark),
          text: 'currentColor',
          background: 'transparent',
          font: 'inherit',
        },
        interactive: true,
      })
    );
    el.replaceChildren(drawn);
    return () => drawn.remove();
  }, [chart, data, width, dark]);
  return (
    <>
      {data.points.length === 0 ? <p className="muted">{props.empty}</p> : null}
      <div ref={box} className="chart" role="figure" aria-label={chart.label ?? 'chart'} />
    </>
  );
}
