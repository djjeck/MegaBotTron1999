/**
 * A view's stylesheet (docs/bot-os.md D175, #87 phase 5): CSS a module may ship with a view plugin
 * (`view.stylesheet`, `views/<name>.css`, no script), parsed as the module loads and refused, the
 * module with it, unless it is safe; then served from the instance (`GET /views/<node>/style.css`),
 * never inline, the CSP unchanged.
 *
 * - **Scoped:** the shell wraps it in `@scope` of the view's body (`[data-view-body="<node>"]`),
 *   so that it styles the view's sections alone, never the shell's page around them; the body
 *   clips what it holds (`overflow: clip`, its own stacking context), so that nothing drawn in it
 *   reaches past it.
 * - **At-rules:** `@media`, `@supports` and `@container` only: no `@import`, `@font-face`, `@scope`
 *   of its own, nor any other.
 * - **Properties on an allow-list** (`ALLOWED`), and custom properties (`--view-accent`): what
 *   arranges and colours, not what hides or draws (no `content`, `visibility`, `opacity`,
 *   `transform`, `filter`, `clip-path`, `animation`, `pointer-events`), `display` but `none`,
 *   `position` but `fixed` and `sticky`, a `z-index` from 0 to `MAX_Z`; no `!important`.
 * - **Values:** functions on a list (`FUNCTIONS`: colours, gradients, `calc`, `var`, …); `url()`
 *   only to a picture of the module's own beside the stylesheet (PNG, JPEG, GIF, WebP), served at
 *   `GET /views/<node>/files/<path>`, the URL rewritten to it.
 *
 * A browser's own confirm (a row action's `confirm`) is no element of the page, so no stylesheet
 * reaches it.
 */
import * as csstree from 'css-tree';

/** The largest stylesheet a view may have, in bytes. */
export const MAX_SHEET_BYTES = 64 * 1024;
/** The highest `z-index` a view's stylesheet may give (its body is a stacking context of its own). */
export const MAX_Z = 10;

/** The at-rules a view's stylesheet may hold. */
const AT_RULES = new Set(['media', 'supports', 'container']);

/** The properties a view's stylesheet may set: those that arrange and colour (D175). */
export const ALLOWED: ReadonlySet<string> = new Set([
  // Colour and backgrounds.
  'color',
  'background',
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  'background-clip',
  'background-origin',
  'accent-color',
  'caret-color',
  'box-shadow',
  'text-shadow',
  // Borders and outlines.
  ...['', '-top', '-right', '-bottom', '-left', '-block', '-inline'].flatMap((side) =>
    ['', '-color', '-style', '-width'].map((part) => `border${side}${part}`)
  ),
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-collapse',
  'border-spacing',
  'outline',
  'outline-color',
  'outline-style',
  'outline-width',
  'outline-offset',
  // Text.
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-variant-numeric',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-overflow',
  'white-space',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'vertical-align',
  'list-style',
  'list-style-type',
  'list-style-position',
  // Spacing.
  ...['margin', 'padding'].flatMap((p) =>
    ['', '-top', '-right', '-bottom', '-left', '-block', '-inline'].map((side) => `${p}${side}`)
  ),
  'gap',
  'row-gap',
  'column-gap',
  // Layout.
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'z-index',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-flow',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  'align-items',
  'align-content',
  'align-self',
  'justify-items',
  'justify-content',
  'justify-self',
  'place-items',
  'place-content',
  'place-self',
  'grid',
  'grid-template',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
  'grid-area',
  'grid-column',
  'grid-column-start',
  'grid-column-end',
  'grid-row',
  'grid-row-start',
  'grid-row-end',
  'table-layout',
  // Size.
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'aspect-ratio',
  'box-sizing',
  'object-fit',
  'object-position',
  'overflow',
  'overflow-x',
  'overflow-y',
]);

/** The functions a value may call: colours, gradients, arithmetic, grids and `url()` (checked). */
const FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'calc',
  'min',
  'max',
  'clamp',
  'var',
  'repeat',
  'minmax',
  'fit-content',
]);

/** The pictures a stylesheet may point at, by extension, and their media types. */
const PICTURES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const PICTURE_PATH = /^(?:[a-z0-9_][a-z0-9_.-]*\/)*[a-z0-9_][a-z0-9_.-]*\.(png|jpe?g|gif|webp)$/iu;

/** A stylesheet checked: its CSS, its URLs rewritten, and the pictures it points at. */
export interface ViewStyle {
  /** The checked CSS, its rules as written, not yet scoped (`scopedSheet`). */
  css: string;
  /** Each picture by its path beside the stylesheet: its file, and its media type. */
  files: Readonly<Record<string, { file: string; type: string }>>;
}

/** Why a stylesheet is refused: each problem, at its line. */
export class ViewStyleError extends Error {
  readonly problems: string[];
  constructor(sheet: string, problems: string[]) {
    super(`${sheet} is refused: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export interface CheckSheetOptions {
  /** The stylesheet's path in its module, for the problems (`views/shop.css`). */
  name: string;
  /** A picture's file beside the stylesheet, by its path from there; undefined when it has none. */
  picture(path: string): string | undefined;
}

/**
 * The stylesheet checked (D175): its CSS, with each `url()` pointing at its picture as the instance
 * serves it (`files/<path>`), and the pictures; thrown (`ViewStyleError`) with every problem, at its
 * line, when it is not safe.
 */
export function checkViewSheet(text: string, o: CheckSheetOptions): ViewStyle {
  const problems: string[] = [];
  const at = (node: csstree.CssNode): string =>
    node.loc === undefined || node.loc === null ? '' : `line ${node.loc.start.line}: `;
  if (Buffer.byteLength(text) > MAX_SHEET_BYTES)
    throw new ViewStyleError(o.name, [`it is over ${MAX_SHEET_BYTES / 1024} KiB`]);
  const ast = csstree.parse(text, {
    positions: true,
    onParseError: (e) => problems.push(`line ${e.line}: ${e.message}`),
  });
  const files: Record<string, { file: string; type: string }> = {};
  csstree.walk(ast, {
    enter(node: csstree.CssNode) {
      switch (node.type) {
        case 'Atrule':
          if (!AT_RULES.has(node.name.toLowerCase()))
            problems.push(
              `${at(node)}@${node.name} is not allowed: only @media, @supports, @container`
            );
          break;
        case 'Declaration': {
          const p = node.property.toLowerCase();
          if (node.important !== false) problems.push(`${at(node)}${p}: !important is not allowed`);
          if (p.startsWith('--')) break;
          if (!ALLOWED.has(p)) {
            problems.push(
              `${at(node)}${p} is not allowed: a view's stylesheet arranges and colours`
            );
            break;
          }
          const value = csstree.generate(node.value).trim().toLowerCase();
          if (p === 'display' && /\bnone\b/u.test(value))
            problems.push(
              `${at(node)}display: none is not allowed: it would hide what the view shows`
            );
          if (p === 'position' && /\b(fixed|sticky)\b/u.test(value))
            problems.push(
              `${at(node)}position: ${value} is not allowed: it would reach past the view`
            );
          if (p === 'z-index' && value !== 'auto') {
            const z = Number(value);
            if (!Number.isInteger(z) || z < 0 || z > MAX_Z)
              problems.push(`${at(node)}z-index: ${value} is not allowed: from 0 to ${MAX_Z}`);
          }
          break;
        }
        case 'Function':
          if (!FUNCTIONS.has(node.name.toLowerCase()))
            problems.push(`${at(node)}${node.name}() is not allowed`);
          break;
        case 'Url': {
          const ref = node.value;
          const type = PICTURES[ref.split('.').at(-1)?.toLowerCase() ?? ''];
          const file =
            PICTURE_PATH.test(ref) && !ref.split('/').includes('..') ? o.picture(ref) : undefined;
          if (type === undefined || file === undefined)
            problems.push(
              `${at(node)}url(${ref}) is not allowed: only a picture of the module's beside the stylesheet (PNG, JPEG, GIF, WebP)`
            );
          else {
            files[ref] = { file, type };
            node.value = `files/${ref}`;
          }
          break;
        }
        default:
          break;
      }
    },
  });
  if (problems.length > 0) throw new ViewStyleError(o.name, problems);
  return { css: csstree.generate(ast), files };
}

/** A node's id, as the stylesheet's scope names it: lower-case words and dashes. */
const NODE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** A view's stylesheet as the instance serves it for its node: scoped to that node's view body. */
export function scopedSheet(style: ViewStyle, node: string): string {
  if (!NODE_ID.test(node)) throw new Error(`not a node's id: ${node}`);
  return `@scope ([data-view-body="${node}"]) {\n${style.css}\n}\n`;
}
