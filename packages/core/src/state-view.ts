/**
 * A node's state as the owner sees it (bot-os.md D72, docs/bot-os-api.md §4.11): what a plugin
 * that keeps a state (a game's player state, made with the state plugins' base) offers the node
 * panel's generic viewer, which draws any state from its schema alone, and the one line of it its
 * card shows. The types are the core's so that the web UI, which imports the core's types alone,
 * reads them; the helpers are shared by the plugins that make a view and the UI that draws one.
 */
import { type JsonSchema } from './graph-view.ts';

/** When, and by what event, a part of a state was set: the event's time and its type. */
export interface Stamp {
  t: number;
  event: string;
}

/**
 * How fresh one section of a state is (a top-level key of its schema): the last full snapshot of
 * it (`snapshot`), the changes since (`deltas`), and how many of those were uncertain (an unknown
 * delta: a loss the bot did not itemise); and its last change (`updated`). "The inventory was a
 * full snapshot at T, plus 3 deltas since, 1 of them uncertain" is
 * `{ snapshot: { t: T, event: 'quest.inventory' }, deltas: 3, uncertain: 1, updated: … }`.
 */
export interface SectionFreshness {
  snapshot?: Stamp;
  deltas: number;
  uncertain: number;
  updated?: Stamp;
}

/** A node's state, for the viewer (`GET /plugins/<id>/view`). */
export interface StateView {
  /** Its state's schema, as a JSON Schema: the viewer's only guide, its descriptions the labels. */
  schema: JsonSchema;
  state: unknown;
  /** When it last changed (ms), if ever. */
  updatedAt?: number;
  /** Each section's freshness, by section. */
  freshness?: Record<string, SectionFreshness>;
  /** The paths the owner pinned (dotted, `inventory.items`), drawn first. */
  pin?: string[];
}

/** The value at a dotted path (`inventory.items.0.name`); the whole value for no path. */
export function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === '') return value;
  let v: unknown = value;
  for (const key of path.split('.')) {
    if (typeof v !== 'object' || v === null) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/**
 * A JSON Schema without its wrappers: one of an `anyOf` that is not null (an optional or nullable
 * value), and a `$ref`-free schema as zod writes it.
 */
export function plainSchema(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined) return {};
  const choices = schema['anyOf'] as JsonSchema[] | undefined;
  if (Array.isArray(choices)) {
    const real = choices.filter((c) => c['type'] !== 'null');
    if (real.length === 1) return { ...plainSchema(real[0]), ...pick(schema) };
  }
  return schema;
}

/** The labels a wrapper carries over what it wraps. */
const pick = (s: JsonSchema): JsonSchema =>
  Object.fromEntries(
    ['description', 'title', 'default'].filter((k) => k in s).map((k) => [k, s[k]])
  );

/** The schema at a dotted path: through objects' properties, records' values and arrays' items. */
export function schemaAtPath(schema: JsonSchema, path: string | undefined): JsonSchema | undefined {
  let s: JsonSchema | undefined = plainSchema(schema);
  if (path === undefined || path === '') return s;
  for (const key of path.split('.')) {
    if (s === undefined) return undefined;
    const props = s['properties'] as Record<string, JsonSchema> | undefined;
    if (props?.[key] !== undefined) s = plainSchema(props[key]);
    else if (s['type'] === 'array') s = plainSchema(s['items'] as JsonSchema | undefined);
    else if (typeof s['additionalProperties'] === 'object')
      s = plainSchema(s['additionalProperties'] as JsonSchema);
    else return undefined;
  }
  return s;
}

/** A path's label: its schema's description, else its last key. */
export function labelOf(schema: JsonSchema, path: string): string {
  const d = schemaAtPath(schema, path)?.['description'];
  return typeof d === 'string' && d !== '' ? d : (path.split('.').at(-1) ?? path);
}

/**
 * One line of a state for its card, from its first pins (at most `max`): a list or a map counted
 * (`12 Items`), a value shown (`Gold: 40`), each labelled by its schema; undefined with no pin.
 */
export function summaryOf(view: StateView, max = 2): string | undefined {
  const parts = (view.pin ?? []).slice(0, max).map((path) => {
    const v = valueAtPath(view.state, path);
    const label = labelOf(view.schema, path);
    if (Array.isArray(v)) return `${v.length} ${label}`;
    if (typeof v === 'object' && v !== null) return `${Object.keys(v).length} ${label}`;
    return `${label}: ${v === undefined ? '—' : String(v as string | number | boolean | null)}`;
  });
  return parts.length === 0 ? undefined : parts.join(' · ');
}
