/**
 * The render service (docs/bot-os-api.md §4.13, bot-os.md D49): SVG to PNG, implemented once in the
 * shell so that a plugin or a module, which has no npm dependencies of its own, draws in SVG and
 * sends a picture. On resvg (`@resvg/resvg-js`, a native binding, loaded at the first render), off
 * the event loop (`renderAsync`, on libuv's thread pool).
 *
 * resvg reads no system font unless asked, so that a picture looks the same on every host (the
 * image has none): a plugin that draws text gives its own font files (`fonts`), which a module
 * ships in its directory.
 */

/** How a picture is rendered; every size is in pixels. */
export interface SvgToPngOptions {
  /** The picture's width; its height follows the SVG's proportions. */
  width?: number;
  /** The picture's height, when no `width` is given; its width follows. */
  height?: number;
  /** The zoom on the SVG's own size, when neither `width` nor `height` is given: 1 by default. */
  scale?: number;
  /**
   * The longest side at most, shrinking the picture to fit (a network's limit, such as the 2560
   * pixels Telegram keeps of a photo).
   */
  maxSide?: number;
  /** A CSS colour under the drawing; transparent without one. */
  background?: string;
  /** Font files (`.ttf`, `.otf`) to draw text with, by absolute path. */
  fonts?: readonly string[];
  /** The family for text that names none, or none of those loaded. */
  defaultFontFamily?: string;
  /** Whether the host's own fonts are loaded too: false by default, so that every host draws alike. */
  systemFonts?: boolean;
}

/** The render service, as a plugin's context gives it (`ctx.render`). */
export interface Render {
  /** The SVG as a PNG's bytes; rejected, with why, for an SVG resvg cannot read or a bad option. */
  svgToPng(svg: string, options?: SvgToPngOptions): Promise<Uint8Array>;
}

type Resvg = typeof import('@resvg/resvg-js');
let resvg: Promise<Resvg> | undefined;

/** The zoom that makes a picture of `width` × `height` as `o` asks. */
export function zoomFor(width: number, height: number, o: SvgToPngOptions = {}): number {
  for (const key of ['width', 'height', 'scale', 'maxSide'] as const) {
    const v = o[key];
    if (v !== undefined && !(Number.isFinite(v) && v > 0))
      throw new RangeError(`svgToPng: ${key} must be a positive number, not ${String(v)}`);
  }
  const zoom =
    o.width !== undefined ? o.width / width : o.height !== undefined ? o.height / height : o.scale;
  const longest = Math.max(width, height);
  return Math.min(zoom ?? 1, o.maxSide === undefined ? Infinity : o.maxSide / longest);
}

/** SVG to PNG, on resvg. */
export async function svgToPng(svg: string, o: SvgToPngOptions = {}): Promise<Uint8Array> {
  resvg ??= import('@resvg/resvg-js');
  const { Resvg, renderAsync } = await resvg;
  const font = {
    loadSystemFonts: o.systemFonts ?? false,
    fontFiles: [...(o.fonts ?? [])],
    ...(o.defaultFontFamily === undefined ? {} : { defaultFontFamily: o.defaultFontFamily }),
  };
  // Its own size first (parsing only, no fonts needed), for the zoom.
  const parsed = new Resvg(svg, { font: { loadSystemFonts: false } });
  const zoom = zoomFor(parsed.width, parsed.height, o);
  const image = await renderAsync(svg, {
    fitTo: { mode: 'zoom', value: zoom },
    font,
    logLevel: 'off',
    ...(o.background === undefined ? {} : { background: o.background }),
  });
  return new Uint8Array(image.asPng());
}

/** The shell's render service. */
export const resvgRender: Render = { svgToPng };
