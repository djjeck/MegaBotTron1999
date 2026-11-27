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
 *
 * A table (D157) may show a column as a picture (`show: 'image'`: a file of the node's own, or a
 * media), or a list of them one at a time (`show: 'carousel'`, D163), and give each row buttons that run one of the node's actions (`actions`), their input
 * built from the row (`'$row.<path>'`) and constants, the rest picked by the owner in a form; the
 * check refuses an action not declared, a key its input has not, a constant its schema refuses and
 * a row path the rows have not. An action's input field may take its options from a read
 * (`.meta({ options: { read, path?, value?, label? } })`, `optionsIssues`).
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

/**
 * A table's column shown as a picture (D157), a thumbnail that opens it whole: its value a file
 * name in its node's own files (`from: 'files'`, the default, D149), or a media (`from: 'media'`:
 * a `Media` as JSON carries it, or a kept one's reference `{ id: 'sha256:<hex>', mime }`, whose
 * file is `sha256-<hex>`, as a collection keeps it, D155). An empty value, an empty cell.
 *
 * A column `show: 'carousel'` (D163) takes a list of them, shown one at a time with a previous and
 * a next button and its place among them (`3 / 12`); an empty list, an empty cell.
 */
const pictureColumn = z.strictObject({
  path,
  label: label.optional(),
  show: z.enum(['image', 'carousel']),
  from: z.enum(['files', 'media']).default('files'),
});
const column = z.union([path, z.strictObject({ path, label: label.optional() }), pictureColumn]);

/** A value of a row's: `$row` (the row itself) or `$row.<path>`. */
export const ROW_REF = /^\$row(?:\.[A-Za-z0-9_$-]+)*$/u;
const rowRef = z.string().regex(ROW_REF, 'expected $row.<path>, as $row.place');

/**
 * A button on each row of a table (D157) that runs an action of its node's interface: its input's
 * keys from `input`, each a constant or a row's value (a string `'$row.<path>'`), the others the
 * owner picks in a form the button opens (drawn from the action's input schema, as every form),
 * each of `current` preselected with the row's value; `confirm`, asked first.
 */
const rowAction = z.strictObject({
  label,
  action: z.string().regex(/^[a-z][A-Za-z0-9_]*$/u, 'expected an action’s name such as repaint'),
  input: z.record(z.string(), z.unknown()).optional(),
  current: z.record(z.string(), rowRef).optional(),
  confirm: z.string().min(1).optional(),
});

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

/**
 * The kinds of section, each with `extra` beside what every section says: a view's (D170) name the
 * input their node is bound to, a page's none.
 */
function sectionKinds<E extends z.ZodRawShape>(extra: E) {
  return z.discriminatedUnion('show', [
    /** Its value's fields (those named, or every one), each `label: value`. */
    z.strictObject({
      show: z.literal('keyValue'),
      ...base,
      ...extra,
      fields: z.array(field).min(1).optional(),
    }),
    /** A number, or how many items a list or a map holds. */
    z.strictObject({ show: z.literal('counter'), ...base, ...extra }),
    /** A list's items (a map's values), each its `item` path's value, or itself; at most `max`. */
    z.strictObject({ show: z.literal('list'), ...base, ...extra, item: path.optional(), max }),
    /**
     * A list's items (a map's values) as rows, a column each of `columns` (a picture, `show:
     * 'image'`, or a list of them, `show: 'carousel'`); at most `max` rows; a button per row for
     * each of `actions` (D157).
     */
    z.strictObject({
      show: z.literal('table'),
      ...base,
      ...extra,
      columns: z.array(column).min(1),
      max,
      actions: z.array(rowAction).min(1).optional(),
    }),
    /** An amount out of a total: `of`, a number, or the path to it in the read's output. */
    z.strictObject({
      show: z.literal('progress'),
      ...base,
      ...extra,
      of: z.union([z.number().positive(), path]),
    }),
    /** A time (ms since the epoch, or an ISO string): how long until it, or since. */
    z.strictObject({ show: z.literal('until'), ...base, ...extra }),
  ]);
}

/** One section of a widget or a page, by the way it shows its value. */
export const widgetSchema = sectionKinds({});

/** A page: its title, and its sections, in order. */
export const pageSchema = z.strictObject({
  title: z.string().min(1),
  sections: z.array(widgetSchema).min(1),
});

/**
 * In a view's section (D170): the page's selected value, in a read's input or a row action's
 * (`{ player: '$selector' }`).
 */
export const SELECTOR_REF = '$selector';

/** An input port's name, as a view's section names the one its node is bound to. */
const inputPort = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 'expected an input port’s name');

/**
 * A view's section (D170): a section of a page, read from the node bound to its view's input
 * `from` (an interface input), its reads and actions that node's.
 */
export const viewSectionSchema = sectionKinds({ from: inputPort });

/**
 * A view's selector (D170): one choice on the page, its options the items at `path` of a read of
 * the node bound to `from`, each option's value at `value` (the item itself for none) and its
 * label at `label` (its value for none); its sections take the value chosen as `'$selector'`.
 */
export const selectorSchema = z.strictObject({
  from: inputPort,
  read: base.read,
  input: base.input,
  path: path.optional(),
  value: path.optional(),
  label: path.optional(),
  /** What it is a choice of, shown beside it; none: the read's description. */
  title: label.optional(),
});

/**
 * A view (D170): a title, an optional selector, and its sections, in order, each read from one of
 * its inputs; none yet, an empty page (a view node just added). Its layout is a list for now: a
 * later kind of section may hold others.
 */
export const viewSchema = z.strictObject({
  title: z.string().min(1),
  selector: selectorSchema.optional(),
  sections: z.array(viewSectionSchema).default([]),
});

/** One section of a widget or a page, as a plugin declares it. */
export type Widget = z.output<typeof widgetSchema>;
/** A view's section, its selector, and the view, as a plugin declares them (D170). */
export type ViewSection = z.output<typeof viewSectionSchema>;
export type ViewSelector = z.output<typeof selectorSchema>;
export type View = z.output<typeof viewSchema>;
export type WidgetShow = Widget['show'];
/** A field or a column: a path, or a path with its label (a column, maybe a picture's). */
export type WidgetField = z.output<typeof column>;
/** A table's row action (D157). */
export type RowAction = z.output<typeof rowAction>;
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

/** An action as the manifest declares it: its input's schema. */
export interface DeclaredAction {
  input: z.ZodType;
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
  reads: Readonly<Record<string, DeclaredRead>>,
  actions: Readonly<Record<string, DeclaredAction>> = {},
  /** A view's (D170): its sections may take its selector's value, `'$selector'`. */
  options: { selector?: boolean } = {}
): WidgetIssue[] {
  const read = Object.hasOwn(reads, w.read) ? reads[w.read] : undefined;
  if (read === undefined)
    return [{ path: ['read'], message: `${w.read} is not among its reads (interface.state)` }];
  const issues: WidgetIssue[] = [];
  issues.push(...readInputIssues(read, w.read, w.input, options.selector === true));
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
      if (w.show === 'table') {
        fieldsIn(items, w.columns, 'columns');
        // A carousel's value is a list of pictures (D163).
        w.columns.forEach((c, i) => {
          if (typeof c !== 'object' || !('show' in c) || c.show !== 'carousel') return;
          const s = items === 'open' ? 'open' : schemaAt(items, c.path);
          if (s !== undefined && s !== 'open' && !types(s).includes('array'))
            no(`${c.path} is not a list of pictures`, ['columns', i]);
        });
        (w.actions ?? []).forEach((a, i) => {
          for (const issue of rowActionIssues(a, items, actions, options))
            no(issue.message, ['actions', i, ...issue.path]);
        });
      }
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

/**
 * What is wrong with a read's input: given to a read that takes none, or refused by its schema. In
 * a view (`selector`), a key whose value is `'$selector'` is the page's choice, so its schema is
 * not asked of it, only of the others.
 */
function readInputIssues(
  read: DeclaredRead,
  name: string,
  input: Record<string, unknown> | undefined,
  selector: boolean
): WidgetIssue[] {
  if (read.input === undefined)
    return input === undefined
      ? []
      : [{ path: ['input'], message: `the read ${name} takes no input` }];
  // The keys the selector gives that the schema names: those left out of its check. Any other is
  // checked as given, so that a key the read does not take is still refused.
  const shape = read.input instanceof z.ZodObject ? read.input.shape : {};
  const chosen = selector
    ? Object.keys(input ?? {}).filter((k) => input?.[k] === SELECTOR_REF && Object.hasOwn(shape, k))
    : [];
  const schema =
    chosen.length > 0 && read.input instanceof z.ZodObject
      ? read.input.partial(Object.fromEntries(chosen.map((k) => [k, true])) as never)
      : read.input;
  const given = Object.fromEntries(
    Object.entries(input ?? {}).filter(([k]) => !chosen.includes(k))
  );
  const parsed = schema.safeParse(given);
  if (parsed.success) return [];
  return [
    {
      path: ['input'],
      message: parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
        .join('; '),
    },
  ];
}

/**
 * What is wrong with a view's selector (D170), given the reads of the node its input is bound to:
 * a read it does not declare, an input it refuses, a path that is no list, an option's value or
 * label its items have not.
 */
export function selectorIssues(
  sel: ViewSelector,
  reads: Readonly<Record<string, DeclaredRead>>
): WidgetIssue[] {
  const read = Object.hasOwn(reads, sel.read) ? reads[sel.read] : undefined;
  if (read === undefined)
    return [{ path: ['read'], message: `${sel.read} is not among its reads (interface.state)` }];
  const issues = readInputIssues(read, sel.read, sel.input, false);
  const at = schemaAt(outputSchema(read), sel.path);
  if (at === undefined)
    return [
      ...issues,
      { path: ['path'], message: `the read ${sel.read} has no ${sel.path ?? ''}` },
    ];
  if (at === 'open') return issues;
  const items = itemsOf(at);
  if (items === undefined)
    return [
      ...issues,
      { path: ['path'], message: `${sel.path ?? `the read ${sel.read}`} is not a list or a map` },
    ];
  for (const key of ['value', 'label'] as const) {
    const p = sel[key];
    if (p !== undefined && items !== 'open' && schemaAt(items, p) === undefined)
      issues.push({ path: [key], message: `its options have no ${p}` });
  }
  return issues;
}

/** The input keys of an action's schema, when it is an object that names them; undefined if open. */
function inputKeys(schema: z.ZodType): { keys: string[]; closed: boolean } | undefined {
  const json = (() => {
    try {
      return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    } catch {
      return {};
    }
  })();
  const props = json['properties'] as Record<string, unknown> | undefined;
  if (props === undefined) return undefined;
  return { keys: Object.keys(props), closed: json['additionalProperties'] === false };
}

/** The schema of an object's key, for a constant's check; undefined when it cannot tell. */
function keySchema(schema: z.ZodType, key: string): z.ZodType | undefined {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  return shape !== undefined && Object.hasOwn(shape, key) ? shape[key] : undefined;
}

/**
 * What is wrong with a table's row action (D157), given its rows' schema and the node's actions:
 * an action it does not declare, a key its input has not (an object that allows no other), a
 * constant its schema refuses, a row path the rows have not, a key both given and preselected.
 */
export function rowActionIssues(
  a: RowAction,
  rows: JsonSchema | 'open',
  actions: Readonly<Record<string, DeclaredAction>>,
  /** A view's (D170): a key may take its selector's value, `'$selector'`. */
  options: { selector?: boolean } = {}
): WidgetIssue[] {
  const action = Object.hasOwn(actions, a.action) ? actions[a.action] : undefined;
  if (action === undefined)
    return [
      { path: ['action'], message: `${a.action} is not among its actions (interface.actions)` },
    ];
  const issues: WidgetIssue[] = [];
  const known = inputKeys(action.input);
  const fromRow = (ref: string, where: (string | number)[]): void => {
    const p = ref === '$row' ? undefined : ref.slice('$row.'.length);
    if (p !== undefined && rows !== 'open' && schemaAt(rows, p) === undefined)
      issues.push({ path: where, message: `its rows have no ${p}` });
  };
  const keyIn = (key: string, where: (string | number)[]): void => {
    if (known?.closed === true && !known.keys.includes(key))
      issues.push({ path: where, message: `the action ${a.action} takes no ${key}` });
  };
  for (const [key, v] of Object.entries(a.input ?? {})) {
    keyIn(key, ['input', key]);
    if (typeof v === 'string' && v.startsWith('$row')) {
      if (ROW_REF.test(v)) fromRow(v, ['input', key]);
      else issues.push({ path: ['input', key], message: `expected $row.<path>, as $row.place` });
      continue;
    }
    if (options.selector === true && v === SELECTOR_REF) continue;
    const s = keySchema(action.input, key);
    const parsed = s?.safeParse(v);
    if (parsed !== undefined && !parsed.success)
      issues.push({
        path: ['input', key],
        message: `the action ${a.action} refuses ${JSON.stringify(v)}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
  }
  for (const [key, ref] of Object.entries(a.current ?? {})) {
    keyIn(key, ['current', key]);
    if (Object.hasOwn(a.input ?? {}, key))
      issues.push({
        path: ['current', key],
        message: `${key} is given by input: the owner picks none`,
      });
    fromRow(ref, ['current', key]);
  }
  return issues;
}

/**
 * Where an action's input field takes its options from (D157): `.meta({ options })` on a field,
 * `{ read, path?, value?, label? }`: the items at `path` of the read's output (the whole output
 * for none), each option's value at `value` (the item itself for none), its label at `label` (its
 * value for none). The form draws a choice of them; the action still checks what it gets.
 */
export const optionsSchema = z.strictObject({
  read: z.string().regex(/^[a-z][A-Za-z0-9_]*$/u),
  path: path.optional(),
  value: path.optional(),
  label: path.optional(),
});
export type OptionsSource = z.output<typeof optionsSchema>;

/** Every `options` an input schema's fields declare, with where (D157). */
function optionsIn(schema: JsonSchema, at: string[] = []): { at: string[]; options: unknown }[] {
  const out: { at: string[]; options: unknown }[] = [];
  if ('options' in schema) out.push({ at, options: schema['options'] });
  const props = schema['properties'] as Record<string, JsonSchema> | undefined;
  for (const [k, v] of Object.entries(props ?? {}))
    if (typeof v === 'object' && v !== null) out.push(...optionsIn(v, [...at, k]));
  for (const key of ['anyOf', 'oneOf', 'allOf'])
    for (const v of (schema[key] as JsonSchema[] | undefined) ?? [])
      if (typeof v === 'object' && v !== null) out.push(...optionsIn(v, at));
  const items = schema['items'];
  if (typeof items === 'object' && items !== null) out.push(...optionsIn(items as JsonSchema, at));
  return out;
}

/**
 * What is wrong with the options an action's input declares (D157): one that does not read as
 * `{ read, path?, value?, label? }`, names a read it does not declare, or a path its output has
 * not.
 */
export function optionsIssues(
  input: z.ZodType,
  reads: Readonly<Record<string, DeclaredRead>>
): WidgetIssue[] {
  let json: JsonSchema;
  try {
    json = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  } catch {
    return [];
  }
  const issues: WidgetIssue[] = [];
  for (const found of optionsIn(json)) {
    const where = [...found.at, 'options'];
    const parsed = optionsSchema.safeParse(found.options);
    if (!parsed.success) {
      issues.push({ path: where, message: 'expected { read, path?, value?, label? }' });
      continue;
    }
    const o = parsed.data;
    const read = Object.hasOwn(reads, o.read) ? reads[o.read] : undefined;
    if (read === undefined) {
      issues.push({ path: where, message: `${o.read} is not among its reads (interface.state)` });
      continue;
    }
    const at = schemaAt(outputSchema(read), o.path);
    if (at === undefined)
      issues.push({ path: where, message: `the read ${o.read} has no ${o.path ?? ''}` });
    else if (at !== 'open' && itemsOf(at) === undefined)
      issues.push({
        path: where,
        message: `${o.path ?? `the read ${o.read}`} is not a list or a map`,
      });
  }
  return issues;
}
