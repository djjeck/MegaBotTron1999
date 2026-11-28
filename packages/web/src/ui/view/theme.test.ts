/** A view's theme as custom properties on its root (bot-os.md D175). */
import { describe, expect, it } from 'vitest';
import { themeStyle } from './theme.ts';

describe('themeStyle', () => {
  it('writes each colour by its scheme, and its density, radius and font', () => {
    expect(themeStyle(undefined)).toEqual({});
    expect(
      themeStyle({
        light: { text: '#111', chart: ['red', 'blue'] },
        dark: { text: '#eee' },
        density: 'compact',
        radius: 0,
        font: 'mono',
      })
    ).toEqual({
      '--view-light-text': '#111',
      '--view-light-chart-1': 'red',
      '--view-light-chart-2': 'blue',
      '--view-dark-text': '#eee',
      '--view-density': '0.75',
      '--view-radius': '0px',
      '--view-font': "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    });
  });

  it('falls back for a density or a font it does not know, and skips a colour that is no text', () => {
    expect(
      themeStyle({
        light: { accent: 3, chart: 7 } as never,
        density: 'airy' as never,
        font: 'comic' as never,
      })
    ).toEqual({ '--view-density': '1', '--view-font': 'inherit' });
    expect(themeStyle({})).toEqual({});
  });
});
