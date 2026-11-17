/**
 * A node's widget and page in words (docs/bot-os.md D112): the value a section shows, from its
 * read's output, its labels, from what the section says or else its read's schema, and the one
 * line its node's card shows. Pure, so that the card, the page and the tests share it; the web UI
 * draws what the plugin declares and knows nothing of what it is (D49).
 */
import type { JsonSchema, MemberView, Widget, WidgetField } from '#src/ui/api.ts';
import { duration } from '#src/ui/hooks.ts';

/** The value at a dotted path (`bag.0.item`); the whole value for none. */
export function at(value: unknown, path: string | undefined): unknown {
  if (path === undefined) return value;
  let v = value;
  for (const key of path.split('.')) {
    if (typeof v !== 'object' || v === null) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** Two paths joined; either may be none. */
const join = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined ? a : `${a}.${b}`;

/** A value in words: a scalar as it reads, nothing as a dash, anything else as short JSON. */
export function words(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** A list's items: an array's, or a map's values; undefined for anything else. */
export function itemsOf(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && v !== null) return Object.values(v);
  return undefined;
}

/** How many: a number as it is, or how many items a list or a map holds. */
export function countOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  return itemsOf(v)?.length;
}

/** A time as ms since the epoch: a number as it is, a string as a date; undefined if neither. */
export function timeOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** How long until a time, or since it: `in 12m 5s`, `3h 2m ago`. */
export function relative(t: number, now: number): string {
  const s = Math.round((t - now) / 1000);
  return s >= 0 ? `in ${duration(s)}` : `${duration(-s)} ago`;
}

/** A time as UTC, to the minute: `2026-11-16 14:05 UTC`. */
export const utc = (t: number): string =>
  `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The description of a JSON Schema at a dotted path, through properties, items and maps. */
function describedAt(schema: JsonSchema | undefined, path: string | undefined): string | undefined {
  let s = plain(schema);
  for (const key of path === undefined ? [] : path.split('.')) {
    const props = s['properties'] as Record<string, JsonSchema> | undefined;
    if (props !== undefined && Object.hasOwn(props, key)) s = plain(props[key]);
    else if (s['type'] === 'array') s = plain(s['items'] as JsonSchema | undefined);
    else if (typeof s['additionalProperties'] === 'object')
      s = plain(s['additionalProperties'] as JsonSchema);
    else return undefined;
  }
  const d = s['description'];
  return typeof d === 'string' && d !== '' ? d : undefined;
}

/** A schema without the `anyOf` of an optional or nullable value. */
function plain(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined) return {};
  const choices = schema['anyOf'];
  if (!Array.isArray(choices)) return schema;
  const real = (choices as JsonSchema[]).filter((c) => c['type'] !== 'null');
  return real.length === 1
    ? {
        ...plain(real[0]),
        ...('description' in schema ? { description: schema['description'] } : {}),
      }
    : schema;
}

/** The output schema of the read a section shows. */
const outputOf = (w: Widget, reads: readonly MemberView[]): JsonSchema | undefined =>
  reads.find((r) => r.name === w.read)?.output;

/** A path's label: its schema's description, else its last key. */
const labelAt = (w: Widget, reads: readonly MemberView[], path: string): string =>
  describedAt(outputOf(w, reads), path) ?? path.split('.').at(-1) ?? path;

/** A section's label: its own, else its schema's at its path, else its path's last key. */
export function sectionLabel(w: Widget, reads: readonly MemberView[]): string | undefined {
  if (w.label !== undefined) return w.label;
  return w.path === undefined ? undefined : labelAt(w, reads, w.path);
}

/** A field or a column, with its label: its own, else its schema's, else its last key. */
export interface Field {
  path: string;
  label: string;
}

/**
 * A key/value section's fields: those it names, else every key of its value; or a table's columns,
 * within each of its rows (`within`).
 */
export function fieldsOf(
  w: Widget,
  reads: readonly MemberView[],
  value: unknown,
  list: readonly WidgetField[] | undefined,
  within?: string
): Field[] {
  const named =
    list ??
    (typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.keys(value)
      : []);
  return named.map((f) => {
    const path = typeof f === 'string' ? f : f.path;
    const own = typeof f === 'string' ? undefined : f.label;
    return { path, label: own ?? labelAt(w, reads, join(join(w.path, within), path) ?? path) };
  });
}

/** The total a progress section counts towards: its number, or the value at its path. */
export function totalOf(w: Widget & { show: 'progress' }, output: unknown): number | undefined {
  if (typeof w.of === 'number') return w.of;
  const v = at(output, w.of);
  return typeof v === 'number' ? v : undefined;
}

/** `label: text`, or the text alone for no label. */
const labelled = (label: string | undefined, text: string): string =>
  label === undefined ? text : `${label}: ${text}`;

/** How many items a card's line names before `+N`. */
const ON_CARD = 3;

/**
 * The one line a node's card shows of its widget, from its read's output, at `now`: its fields
 * (`Gold: 40 · Who: alice`), a count (`12 Items`), a list's first items, a table's rows counted, an
 * amount out of its total (`Quest: 3/10`), or how long until a time (`Next turn: in 12m 5s`; a
 * string that is no time, as it is).
 */
export function widgetLine(
  w: Widget,
  reads: readonly MemberView[],
  output: unknown,
  now: number
): string {
  const label = sectionLabel(w, reads);
  const v = at(output, w.path);
  switch (w.show) {
    case 'keyValue': {
      const fields = fieldsOf(w, reads, v, w.fields);
      if (fields.length === 0) return labelled(label, words(v));
      const shown = fields
        .slice(0, ON_CARD)
        .map((f) => `${f.label}: ${words(at(v, f.path))}`)
        .join(' · ');
      return label === undefined ? shown : `${label} — ${shown}`;
    }
    case 'counter': {
      const n = countOf(v);
      return label === undefined ? words(n) : `${words(n)} ${label}`;
    }
    case 'list': {
      const items = itemsOf(v) ?? [];
      const names = items.slice(0, ON_CARD).map((i) => words(at(i, w.item)));
      const more = items.length > ON_CARD ? ` +${items.length - ON_CARD}` : '';
      return labelled(label, items.length === 0 ? 'none' : `${names.join(', ')}${more}`);
    }
    case 'table': {
      const n = itemsOf(v)?.length ?? 0;
      return `${n} ${label ?? (n === 1 ? 'row' : 'rows')}`;
    }
    case 'progress':
      return labelled(label, `${words(v)}/${words(totalOf(w, output))}`);
    case 'until': {
      const t = timeOf(v);
      // A word in place of a time (an `attention` that plans none, D138) is shown as it is.
      if (t === undefined) return labelled(label, typeof v === 'string' && v !== '' ? v : '—');
      return labelled(label, relative(t, now));
    }
  }
}
