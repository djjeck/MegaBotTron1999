/**
 * A value as a view shows it (docs/bot-os.md D170): by its column's `format`, a text, a number (its
 * `unit` after it), a percent, a time (`datetime`, or how long ago or until, `relative`), a badge
 * coloured by its value (`tones`), a list of tags, or a picture, or a list of them one at a time
 * (`image`, `carousel`, from the node's files or a media, D157, D163). Text is drawn as text, never
 * as HTML: an item's name or a caption is a player's.
 */
import type { ReactNode } from 'react';
import type { Format, MemberView, Tone, Widget, WidgetField } from '#src/ui/api.ts';
import type { CarouselAt } from '#src/ui/graph/TableRow.tsx';
import { CarouselCell, PictureCell, pictureSrc } from '#src/ui/graph/TableRow.tsx';
import { at, fieldsOf, relative, timeOf, utc, words } from '#src/ui/graph/widget-text.ts';

/** A column as drawn: its path, its label, and how it is formatted. */
export interface Col {
  path: string;
  label: string;
  format: Format;
  unit?: string | undefined;
  tones?: Readonly<Record<string, Tone>> | undefined;
  source: 'files' | 'media';
}

/** The columns as drawn: each its label (its own, else its schema's) and its format. */
export function colsOf(
  w: Widget,
  reads: readonly MemberView[],
  value: unknown,
  list: readonly WidgetField[] | undefined,
  within?: string
): Col[] {
  return fieldsOf(w, reads, value, list, within).map((f, i) => {
    const spec = list?.[i];
    const o = typeof spec === 'object' ? spec : undefined;
    return {
      path: f.path,
      label: f.label,
      format: o?.format ?? 'text',
      unit: o?.unit,
      tones: o?.tones,
      source: o?.source ?? 'files',
    };
  });
}

/** A value's tone, by its text: its own, else `'*'`'s, else neutral. */
export function toneOf(value: unknown, tones: Readonly<Record<string, Tone>> | undefined): Tone {
  const key = words(value);
  return tones?.[key] ?? tones?.['*'] ?? 'neutral';
}

/** A number as people read it: grouped, at most two decimals. */
const numberText = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** A value as text, by its format: what a search reads and a cell says when it is plain. */
export function formatted(value: unknown, format: Format, unit?: string, now = Date.now()): string {
  if (value === undefined || value === null) return '—';
  switch (format) {
    case 'number':
      return typeof value === 'number'
        ? `${numberText(value)}${unit === undefined ? '' : ` ${unit}`}`
        : words(value);
    case 'percent':
      return typeof value === 'number' ? `${numberText(value)}%` : words(value);
    case 'datetime': {
      const t = timeOf(value);
      return t === undefined
        ? words(value)
        : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
    case 'relative': {
      const t = timeOf(value);
      return t === undefined ? words(value) : relative(t, now);
    }
    case 'tags':
      return Array.isArray(value) ? value.map((v) => words(v)).join(', ') : words(value);
    default:
      return words(value);
  }
}

/** What a column sorts by: a number for numbers and times, else its text without case. */
export function sortKey(value: unknown, format: Format): number | string {
  if (typeof value === 'number') return value;
  if (format === 'datetime' || format === 'relative') return timeOf(value) ?? words(value);
  return words(value).toLowerCase();
}

/** The addresses of a carousel's pictures (D163): those of its list that are one. */
export function pictures(node: string, source: 'files' | 'media', value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p: unknown) => pictureSrc(node, source, p) ?? []);
}

/** A value in a cell, by its column's format. */
export function Cell(props: {
  col: Col;
  row: unknown;
  /** The node whose files a picture is; none, no picture. */
  node: string | undefined;
  /** The row's name, for a picture's label: `Picture of harbour`. */
  name: string;
  now?: number;
  carousels?: Map<string, CarouselAt> | undefined;
}): ReactNode {
  const { col: c, row, node, name } = props;
  const v = at(row, c.path);
  switch (c.format) {
    case 'image':
      return node === undefined ? null : (
        <PictureCell src={pictureSrc(node, c.source, v)} alt={`${c.label} of ${name}`} />
      );
    case 'carousel':
      return node === undefined ? null : (
        <CarouselCell
          srcs={pictures(node, c.source, v)}
          alt={`${c.label} of ${name}`}
          memory={props.carousels}
          memoryKey={`${c.path}\n${name}`}
        />
      );
    case 'badge':
      return v === undefined || v === null ? (
        <span className="muted">—</span>
      ) : (
        <span className={`badge tone-${toneOf(v, c.tones)}`}>{words(v)}</span>
      );
    case 'tags':
      return Array.isArray(v) && v.length > 0 ? (
        <span className="tags">
          {v.map((t, i) => (
            <span key={i} className="tag">
              {words(t)}
            </span>
          ))}
        </span>
      ) : (
        <span className="muted">—</span>
      );
    case 'relative': {
      const t = timeOf(v);
      return t === undefined ? (
        formatted(v, 'text')
      ) : (
        <time dateTime={new Date(t).toISOString()} title={utc(t)}>
          {relative(t, props.now ?? Date.now())}
        </time>
      );
    }
    case 'number':
    case 'percent':
      return <span className="num">{formatted(v, c.format, c.unit)}</span>;
    default:
      return formatted(v, c.format, c.unit);
  }
}
