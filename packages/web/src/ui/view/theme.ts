/**
 * A view's theme as CSS custom properties on its root (docs/bot-os.md D175): each colour it sets,
 * light (`--view-light-<name>`) and dark (`--view-dark-<name>`), which the stylesheet's tokens
 * (`--view-<name>`) take in their scheme; its density, its corners' radius and its font. Set
 * through the DOM's style (React's), not an inline sheet, so that the CSP takes it as it is.
 */
import type { ViewTheme } from '@megabottron1999/core';

/** How much a density scales a view's spacing. */
export const DENSITY: Readonly<Record<string, number>> = {
  compact: 0.75,
  comfortable: 1,
  spacious: 1.3,
};

/** The stack each named font is: the host's own fonts. */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  system: 'system-ui, sans-serif',
  sans: "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

/** The custom properties a view's root takes from its theme; none for no theme. */
export function themeStyle(theme: ViewTheme | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (theme === undefined) return out;
  for (const scheme of ['light', 'dark'] as const) {
    const colours = theme[scheme];
    if (colours === undefined) continue;
    for (const [name, value] of Object.entries(colours)) {
      if (name === 'chart' && Array.isArray(value))
        value.forEach((c, i) => (out[`--view-${scheme}-chart-${i + 1}`] = c));
      else if (typeof value === 'string') out[`--view-${scheme}-${name}`] = value;
    }
  }
  if (theme.density !== undefined) out['--view-density'] = String(DENSITY[theme.density] ?? 1);
  if (theme.radius !== undefined) out['--view-radius'] = `${theme.radius}px`;
  if (theme.font !== undefined) out['--view-font'] = FONT_STACKS[theme.font] ?? 'inherit';
  return out;
}
