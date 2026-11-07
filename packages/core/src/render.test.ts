import { describe, expect, it } from 'vitest';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import { resvgRender, svgToPng, zoomFor } from './render.ts';

/** The width and height in a PNG's IHDR chunk. */
const size = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const svg = (w: number, h: number, body = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`;

describe('zoomFor', () => {
  it('zooms to a width, a height or a scale, 1 by default', () => {
    expect(zoomFor(100, 50)).toBe(1);
    expect(zoomFor(100, 50, { scale: 2 })).toBe(2);
    expect(zoomFor(100, 50, { width: 300, height: 10, scale: 9 })).toBe(3);
    expect(zoomFor(100, 50, { height: 25 })).toBe(0.5);
  });

  it('keeps the longest side within maxSide', () => {
    expect(zoomFor(1600, 400, { scale: 2, maxSide: 2560 })).toBe(1.6);
    expect(zoomFor(100, 400, { scale: 2, maxSide: 2560 })).toBe(2);
  });

  it('refuses a size that is not a positive number', () => {
    expect(() => zoomFor(10, 10, { scale: 0 })).toThrow('scale must be a positive number, not 0');
    expect(() => zoomFor(10, 10, { maxSide: Number.NaN })).toThrow(/maxSide/u);
  });
});

describe('svgToPng', () => {
  it('renders a PNG at the scale asked, within the longest side', async () => {
    const png = await svgToPng(svg(1600, 400), { scale: 2, maxSide: 2560 });
    expect(new TextDecoder('latin1').decode(png.subarray(1, 4))).toBe('PNG');
    expect(size(png)).toEqual({ width: 2560, height: 640 });
  });

  it('renders at the SVG’s own size, on a background, with fonts from files', async () => {
    const png = await svgToPng(svg(40, 20, '<text x="2" y="15">hi</text>'), {
      background: '#ffffff',
      fonts: [],
      defaultFontFamily: 'Example Sans',
    });
    expect(size(png)).toEqual({ width: 40, height: 20 });
  });

  it('rejects an SVG it cannot read', async () => {
    await expect(svgToPng('not an svg')).rejects.toThrow();
  });

  it('is what a plugin’s context offers, unless the wiring gives another', async () => {
    const seen: PluginContext[] = [];
    const plugin = definePlugin({
      manifest: { id: 'painter', version: '0.1.0', kinds: ['stats'], description: 'Draws' },
      create: (ctx) => {
        seen.push(ctx);
        return {};
      },
    });
    const core = new Core({ clock: new VirtualClock(0) });
    core.register(plugin);
    await core.start();
    expect(seen[0]?.render).toBe(resvgRender);
    const other = { svgToPng: () => Promise.resolve(new Uint8Array()) };
    const stubbed = new Core({ clock: new VirtualClock(0), render: other });
    stubbed.register(plugin);
    await stubbed.start();
    expect(seen[1]?.render).toBe(other);
  });
});
