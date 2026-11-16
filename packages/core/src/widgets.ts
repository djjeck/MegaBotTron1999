/**
 * A node's widget and page (bot-os.md P16, D11, D112; docs/bot-os-api.md §2, Widgets and pages):
 * what a plugin declares that the web UI draws of its node, from its typed reads (P11), with no
 * code of the plugin's in the UI and no game in the shell (D49). A **widget** is one section, drawn
 * in a line on its node's card in the graph editor; a **page**, a title and its sections, drawn in
 * full on a page of its own reached from the node's panel. Each section names a read of the
 * plugin's `interface.state` (and its input, if it takes one), where its value is in that read's
 * output (`path`, dotted), and how to show it (`show`): `keyValue`, `counter`, `list`, `table`,
 * `progress` or `until`. The manifest's check refuses a read it does not declare, an input its
 * schema refuses, and a path its output's schema has not, or of a kind the section cannot show.
 */
import { z } from 'zod';

/**
 * A JSON Schema, as `graph-view.ts` has it; not imported from there, whose imports lead back to the
 * manifest's, which this module's checks are part of.
 */
type JsonSchema = Record<string, unknown>;

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

/** A dotted path into a value: `gold`, `inventory.items`, `0.name`. */
export const WIDGET_PATH = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/u;
const path = z.string().regex(WIDGET_PATH, 'expected a dotted path such as inventory.items');
const label = z.string().min(1);
/** A key/value section's field, or a table's column: its path, and a label if not its schema's. */
const field = z.union([path, z.strictObject({ path, label: label.optional() })]);

/** What every section says: the read, its input, where its value is in the output, its label. */
const base = {
  /** The read of its plugin's `interface.state` it shows. */
  read: z.string().regex(/^[a-z][A-Za-z0-9_]*$/u, 'expected a read’s name such as status'),
  /** The read's input, for one that takes one, as its schema parses it. */
  input: z.record(z.string(), z.unknown()).optional(),
  /** Where the value is in the read's output; none, the whole output. */
  path: path.optional(),
  /** Its label; none, its schema's description at the path, else the path's last key. */
  label: label.optional(),
};

const max = z.number().int().positive().optional();

/** One section of a widget or a page, by the way it shows its value. */
export const widgetSchema = z.discriminatedUnion('show', [
  /** Its value's fields (those named, or every one), each `label: value`. */
  z.strictObject({
    show: z.literal('keyValue'),
    ...base,
    fields: z.array(field).min(1).optional(),
  }),
  /** A number, or how many items a list or a map holds. */
  z.strictObject({ show: z.literal('counter'), ...base }),
  /** A list's items (a map's values), each its `item` path's value, or itself; at most `max`. */
  z.strictObject({ show: z.literal('list'), ...base, item: path.optional(), max }),
  /** A list's items (a map's values) as rows, a column each of `columns`; at most `max` rows. */
  z.strictObject({ show: z.literal('table'), ...base, columns: z.array(field).min(1), max }),
  /** An amount out of a total: `of`, a number, or the path to it in the read's output. */
  z.strictObject({
    show: z.literal('progress'),
    ...base,
    of: z.union([z.number().positive(), path]),
  }),
  /** A time (ms since the epoch, or an ISO string): how long until it, or since. */
  z.strictObject({ show: z.literal('until'), ...base }),
]);

/** A page: its title, and its sections, in order. */
export const pageSchema = z.strictObject({
  title: z.string().min(1),
  sections: z.array(widgetSchema).min(1),
});

/** One section of a widget or a page, as a plugin declares it. */
export type Widget = z.output<typeof widgetSchema>;
export type WidgetShow = Widget['show'];
/** A field or a column: a path, or a path with its label. */
export type WidgetField = z.output<typeof field>;
/** A plugin's full page. */
export type WidgetPage = z.output<typeof pageSchema>;

/** The path of a field or a column. */
export const fieldPath = (f: WidgetField): string => (typeof f === 'string' ? f : f.path);

/**
 * The schema at a dotted path, through objects' properties, records' values and arrays' items;
 * `'open'` where a schema says nothing of its value (unknown, any), so that any path within it
 * stands; undefined where its schema has no such path.
 */
export function schemaAt(
  schema: JsonSchema,
  at: string | undefined
): JsonSchema | 'open' | undefined {
  let s: JsonSchema = plainSchema(schema);
  for (const key of at === undefined ? [] : at.split('.')) {
    if (isOpen(s)) return 'open';
    const props = s['properties'] as Record<string, JsonSchema> | undefined;
    if (props !== undefined && Object.hasOwn(props, key)) s = plainSchema(props[key]);
    else if (s['type'] === 'array' && /^\d+$/u.test(key))
      s = plainSchema(s['items'] as JsonSchema | undefined);
    else if (typeof s['additionalProperties'] === 'object')
      s = plainSchema(s['additionalProperties'] as JsonSchema);
    else return undefined;
  }
  return isOpen(s) ? 'open' : s;
}

/** A schema that says nothing of its value's shape: `{}`, unknown, any, a union of several. */
const isOpen = (s: JsonSchema): boolean => s['type'] === undefined && s['properties'] === undefined;

/** The schema of a list's items (an array's items, a map's values), or undefined if not a list. */
function itemsOf(s: JsonSchema): JsonSchema | 'open' | undefined {
  if (s['type'] === 'array') {
    const items = s['items'] as JsonSchema | undefined;
    return items === undefined || isOpen(plainSchema(items)) ? 'open' : plainSchema(items);
  }
  if (s['type'] === 'object' && typeof s['additionalProperties'] === 'object') {
    const values = plainSchema(s['additionalProperties'] as JsonSchema);
    return isOpen(values) ? 'open' : values;
  }
  return undefined;
}

const types = (s: JsonSchema): string[] => {
  const t = s['type'];
  return Array.isArray(t) ? (t as string[]) : typeof t === 'string' ? [t] : [];
};
const isNumber = (s: JsonSchema): boolean =>
  types(s).some((t) => t === 'number' || t === 'integer');

/** A section's problem, at a path of its own within the manifest. */
export interface WidgetIssue {
  path: (string | number)[];
  message: string;
}

/** A read as the manifest declares it: its input's and its output's schemas. */
export interface DeclaredRead {
  input?: z.ZodType | undefined;
  output: z.ZodType;
}

/** A read's output as a JSON Schema; open if zod cannot write it. */
function outputSchema(read: DeclaredRead): JsonSchema {
  try {
    return z.toJSONSchema(read.output, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
  } catch {
    return {};
  }
}

/**
 * What is wrong with a section, given the reads its plugin declares: a read it does not declare,
 * an input its schema refuses (or given to a read that takes none), a path its output has not, or
 * a value of a kind the section cannot show. Empty when it stands.
 */
export function widgetIssues(
  w: Widget,
  reads: Readonly<Record<string, DeclaredRead>>
): WidgetIssue[] {
  const read = Object.hasOwn(reads, w.read) ? reads[w.read] : undefined;
  if (read === undefined)
    return [{ path: ['read'], message: `${w.read} is not among its reads (interface.state)` }];
  const issues: WidgetIssue[] = [];
  if (read.input === undefined) {
    if (w.input !== undefined)
      issues.push({ path: ['input'], message: `the read ${w.read} takes no input` });
  } else {
    const parsed = read.input.safeParse(w.input ?? {});
    if (!parsed.success)
      issues.push({
        path: ['input'],
        message: parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
          .join('; '),
      });
  }
  const root = outputSchema(read);
  const at = schemaAt(root, w.path);
  if (at === undefined) {
    issues.push({ path: ['path'], message: `the read ${w.read} has no ${w.path ?? ''}` });
    return issues;
  }
  if (at === 'open') return issues;
  const no = (message: string, where: (string | number)[] = ['path']): void => {
    issues.push({ path: where, message });
  };
  const where = w.path === undefined ? `the read ${w.read}` : w.path;
  /** Each field's path within `s`, checked. */
  const fieldsIn = (s: JsonSchema | 'open', list: readonly WidgetField[], key: string): void => {
    if (s === 'open') return;
    list.forEach((f, i) => {
      if (schemaAt(s, fieldPath(f)) === undefined) no(`${where} has no ${fieldPath(f)}`, [key, i]);
    });
  };
  switch (w.show) {
    case 'keyValue':
      fieldsIn(at, w.fields ?? [], 'fields');
      break;
    case 'counter':
      if (!isNumber(at) && itemsOf(at) === undefined && !types(at).includes('object'))
        no(`${where} is not a number, a list or a map`);
      break;
    case 'list':
    case 'table': {
      const items = itemsOf(at);
      if (items === undefined) {
        no(`${where} is not a list or a map`);
        break;
      }
      if (w.show === 'list' && w.item !== undefined) fieldsIn(items, [w.item], 'item');
      if (w.show === 'table') fieldsIn(items, w.columns, 'columns');
      break;
    }
    case 'progress':
      if (!isNumber(at)) no(`${where} is not a number`);
      if (typeof w.of === 'string') {
        const of = schemaAt(root, w.of);
        if (of === undefined) no(`the read ${w.read} has no ${w.of}`, ['of']);
        else if (of !== 'open' && !isNumber(of)) no(`${w.of} is not a number`, ['of']);
      }
      break;
    case 'until':
      if (!isNumber(at) && !types(at).includes('string'))
        no(`${where} is not a time (ms since the epoch, or an ISO string)`);
      break;
  }
  return issues;
}
