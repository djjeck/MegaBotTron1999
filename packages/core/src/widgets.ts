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
import { INTERVALS, MARKS, REDUCES } from '@megabottron1999/chart/chart.ts';
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

/**
 * How a value is formatted (D170, phase 2), on a column, a stat or a gallery's badge: as text (the
 * default); a number (`unit` after it); a percent (a number out of 100); a time, as a date and an
 * hour (`datetime`) or as how long ago or until (`relative`); a badge coloured by its value
 * (`tones`); a list of texts as tags; a picture (`image`, D157) or a list of them one at a time
 * (`carousel`, D163), from the node's files or a media (`source`).
 */
export const FORMATS = [
  'text',
  'number',
  'percent',
  'datetime',
  'relative',
  'badge',
  'tags',
  'image',
  'carousel',
] as const;
export type Format = (typeof FORMATS)[number];

/** A badge's or a stat's colour: what it says at a glance. */
export const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
export type Tone = (typeof TONES)[number];
const tone = z.enum(TONES, { error: `expected a tone: ${TONES.join(', ')}` });
const format = z.enum(FORMATS, { error: `expected a format: ${FORMATS.join(', ')}` });
/** Each value's tone, by the value as text (`refunded`, `true`); `'*'`, any other's. */
const tones = z.record(z.string(), tone);
/** Where a picture is: a file of the node's own (`files`, D149), or a media (`media`, D155). */
const source = z.enum(['files', 'media'], { error: 'expected a source: files or media' });

/**
 * A column of a table, a field of a drawer or a gallery's badge: its path, a label if not its
 * schema's, and how its value is formatted (`format`). Phase 1's columns said a picture's with
 * `show` and `from` (D157, D163), still read as `format` and `source`.
 */
const formatted = z
  .strictObject({
    path,
    label: label.optional(),
    format: format.optional(),
    /** Phase 1's `format`, for a picture column: read as it. */
    show: z.enum(['image', 'carousel']).optional(),
    unit: z.string().min(1).optional(),
    tones: tones.optional(),
    source: source.optional(),
    /** Phase 1's `source`: read as it. */
    from: source.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.show !== undefined && c.format !== undefined)
      ctx.addIssue({ code: 'custom', path: ['show'], message: 'say format alone' });
    const f = c.format ?? c.show ?? 'text';
    const picture = f === 'image' || f === 'carousel';
    if ((c.source ?? c.from) !== undefined && !picture)
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'only a picture (format image or carousel) has a source',
      });
    if (c.tones !== undefined && f !== 'badge')
      ctx.addIssue({ code: 'custom', path: ['tones'], message: 'only a badge has tones' });
    if (c.unit !== undefined && f !== 'number')
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'only a number has a unit' });
  })
  .transform(({ show, from, ...c }) => {
    const f = c.format ?? show;
    const picture = f === 'image' || f === 'carousel';
    return {
      ...c,
      ...(f === undefined ? {} : { format: f }),
      ...(picture ? { source: c.source ?? from ?? 'files' } : {}),
    };
  });
/**
 * A column: a path, or a path with its label and its format. Told apart by its type, so that an
 * error says what is wrong with the one written, not that it is neither.
 */
const column = z.unknown().transform((v, ctx): string | z.output<typeof formatted> => {
  const r = typeof v === 'string' ? path.safeParse(v) : formatted.safeParse(v);
  if (r.success) return r.data;
  for (const i of r.error.issues)
    ctx.addIssue({ code: 'custom', message: i.message, path: i.path as (string | number)[] });
  return z.NEVER;
});

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

const readName = z.string().regex(/^[a-z][A-Za-z0-9_]*$/u, 'expected a read’s name such as status');

/** What every section says: the read, its input, where its value is in the output, its label. */
const base = {
  /** The read of its plugin's `interface.state` it shows. */
  read: readName,
  /** The read's input, for one that takes one, as its schema parses it. */
  input: z.record(z.string(), z.unknown()).optional(),
  /** Where the value is in the read's output; none, the whole output. */
  path: path.optional(),
  /** Its label; none, its schema's description at the path, else the path's last key. */
  label: label.optional(),
  /** What it says when its value is empty (no row, no item, none); none: `Nothing yet`. */
  empty: z.string().min(1).optional(),
};

const max = z.number().int().positive().optional();

/** A table's or a gallery's search: every text it shows (`true`), or the paths named. */
const search = z.union([z.literal(true), z.array(path).min(1)]).optional();
/** How many rows or items a page of it holds; past it, it pages. */
const pageSize = z.number().int().min(1).max(500).optional();

/** An input port's name, as a view's section names the one its node is bound to. */
const inputPort = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 'expected an input port’s name');

/** A row's drawer's title, fields and actions (D170): what a node page's drawer may hold. */
const detailBase = {
  /** Its title: a path of the row. */
  title: path.optional(),
  /** The row's fields shown, each formatted as a column is. */
  fields: z.array(column).min(1).optional(),
  /** The row's actions, as buttons. */
  actions: z.array(rowAction).min(1).optional(),
};

/**
 * The leaves every page has (the sections that show a value), each with `extra` (a view's input,
 * `from`) and `opening` (a table's drawer, and the key its rows are told apart by), as its page
 * allows them.
 */
function leafKinds<E extends z.ZodRawShape, O extends z.ZodRawShape>(extra: E, opening: O) {
  return [
    /** Its value's fields (those named, or every one), each `label: value`. */
    z.strictObject({
      show: z.literal('keyValue'),
      ...base,
      ...extra,
      fields: z.array(column).min(1).optional(),
    }),
    /** A number, or how many items a list or a map holds. */
    z.strictObject({ show: z.literal('counter'), ...base, ...extra }),
    /** A list's items (a map's values), each its `item` path's value, or itself; at most `max`. */
    z.strictObject({ show: z.literal('list'), ...base, ...extra, item: path.optional(), max }),
    /**
     * A list's items (a map's values) as rows, a column each of `columns`; at most `max` rows; a
     * button per row for each of `actions` (D157); searched, sorted and paged when it says so, and
     * a drawer per row (`detail`), its rows told apart by `key` (`id` by default).
     */
    z.strictObject({
      show: z.literal('table'),
      ...base,
      ...extra,
      columns: z.array(column).min(1),
      max,
      actions: z.array(rowAction).min(1).optional(),
      search,
      sort: z.literal(true).optional(),
      defaultSort: z
        .strictObject({ path, direction: z.enum(['asc', 'desc']).default('asc') })
        .optional(),
      pageSize,
      ...opening,
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
  ] as const;
}

/** Whether a time zone is one this runtime knows (`Europe/Rome`, `UTC`). */
export function knownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A chart's measure (D174): a path of its rows' numbers, summed per point; or with its `reduce`
 * (`sum`, `count`, `mean`, `min`, `max`), its `label` (a series' name, the tooltip's), its
 * `format` and `unit` (`₭`). No path: its rows counted.
 */
const measureObject = z
  .strictObject({
    path: path.optional(),
    reduce: z.enum(REDUCES).optional(),
    label: label.optional(),
    format: z.enum(['number', 'percent']).optional(),
    unit: z.string().min(1).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.path === undefined && m.reduce !== undefined && m.reduce !== 'count')
      ctx.addIssue({
        code: 'custom',
        path: ['reduce'],
        message: 'a measure with no path counts its rows: name its path to reduce them',
      });
  });
const measure = z.union([path, measureObject]);

/**
 * What a chart and a time series say (D174): their rows (a list's items, a map's values, at
 * `path`), `x` (a category or a number, a time for a time series), `y` (one measure, or several,
 * each a series; none: the rows counted), `series` (a row's value that names its series, each
 * renamed by `seriesLabels`), `stack` (bars and areas), `value` (a second measure, in each point's
 * tooltip) and its `height` in pixels.
 */
const chartFields = {
  ...base,
  from: inputPort,
  mark: z.enum(MARKS, { error: `expected a mark: ${MARKS.join(', ')}` }).optional(),
  x: path,
  y: z.union([measure, z.array(measure).min(1).max(8)]).optional(),
  series: path.optional(),
  seriesLabels: z.record(z.string(), label).optional(),
  stack: z.literal(true).optional(),
  value: measure.optional(),
  height: z.number().int().min(120).max(800).optional(),
};
const chartRules = (
  c: {
    y?: unknown;
    series?: string | undefined;
    seriesLabels?: unknown;
    stack?: true | undefined;
    mark?: string | undefined;
  },
  ctx: z.RefinementCtx
): void => {
  if (Array.isArray(c.y) && c.y.length > 1 && c.series !== undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['series'],
      message: 'a chart splits its rows by series, or shows several measures (y): not both',
    });
  if (c.seriesLabels !== undefined && c.series === undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['seriesLabels'],
      message: 'only a chart split by series renames them',
    });
  if (c.stack === true && (c.mark === 'line' || c.mark === 'dot'))
    ctx.addIssue({ code: 'custom', path: ['stack'], message: 'only bars and areas stack' });
};

/** A chart (D174): its rows' measures by `x`, a category or a number, drawn by Plot. */
const chartObject = z.strictObject({ show: z.literal('chart'), ...chartFields });
/**
 * A time series (D174): a chart whose `x` is a time (ms since the epoch, or an ISO string), its
 * rows gathered by `interval` (a `day`, …) in `timeZone` (an IANA zone, UTC by default).
 */
const timeseriesObject = z.strictObject({
  show: z.literal('timeseries'),
  ...chartFields,
  interval: z
    .enum(INTERVALS, { error: `expected an interval: ${INTERVALS.join(', ')}` })
    .optional(),
  timeZone: z
    .string()
    .refine(knownZone, { error: 'expected a time zone such as Europe/Rome or UTC' })
    .optional(),
});
const notRead = { from: true, read: true, input: true, path: true, empty: true } as const;
/**
 * A chart as a plugin draws it for the owner's chat (`ctx.render.chart`, D174): a chart leaf or a
 * time series without the read it shows, its rows given.
 */
export const chartSpecSchema = z.discriminatedUnion(
  'show',
  [
    chartObject.omit(notRead).superRefine(chartRules),
    timeseriesObject.omit(notRead).superRefine(chartRules),
  ],
  { error: 'expected show to be one of: chart, timeseries' }
);
export type ChartSpec = z.input<typeof chartSpecSchema>;

/** A view's own leaves (D170): a stat tile and a gallery, as its page allows them. */
function viewLeafKinds<O extends z.ZodRawShape>(opening: O) {
  return [
    /**
     * A tile (D170): one value, large, formatted (`format`, `unit`), its label under it, `of` a
     * total beside it, its colour a `tone`, or its value's (`tones`).
     */
    z.strictObject({
      show: z.literal('stat'),
      ...base,
      from: inputPort,
      format: format.optional(),
      unit: z.string().min(1).optional(),
      of: z.union([z.number().positive(), path]).optional(),
      tone: tone.optional(),
      tones: tones.optional(),
    }),
    /**
     * A list's items as cards (D170): each its picture (`image`: a path, its `source`, and
     * `carousel` for a list of them), a caption, badges, the item's actions; searched and paged
     * when it says so, and a drawer per item (`detail`), told apart by `key` (`id` by default).
     */
    z.strictObject({
      show: z.literal('gallery'),
      ...base,
      from: inputPort,
      image: z.strictObject({
        path,
        source: source.optional(),
        carousel: z.literal(true).optional(),
      }),
      caption: path.optional(),
      badges: z.array(column).min(1).optional(),
      actions: z.array(rowAction).min(1).optional(),
      search,
      pageSize,
      ...opening,
    }),
    chartObject.superRefine(chartRules),
    timeseriesObject.superRefine(chartRules),
  ] as const;
}

/**
 * A form (D170): several fields set at once, then sent: an action's input (`action`), its fields
 * the owner's but those `input` gives (constants, `'$selector'`), shown only those of `fields` if
 * named, preset from a read (`current`); or the node's live settings (`settings`, their keys),
 * each changed one set.
 */
const formSchema = z
  .strictObject({
    show: z.literal('form'),
    from: inputPort,
    label: label.optional(),
    action: z
      .string()
      .regex(/^[a-z][A-Za-z0-9_]*$/u, 'expected an action’s name such as repaint')
      .optional(),
    settings: z.array(z.string().min(1)).min(1).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    fields: z.array(z.string().min(1)).min(1).optional(),
    current: z
      .strictObject({ read: readName, input: base.input, path: path.optional() })
      .optional(),
    submit: label.optional(),
    confirm: z.string().min(1).optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.action === undefined) === (f.settings === undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'a form runs an action (action) or sets settings (settings): name one',
      });
    if (f.settings !== undefined)
      for (const k of ['input', 'fields', 'current'] as const)
        if (f[k] !== undefined)
          ctx.addIssue({ code: 'custom', path: [k], message: `a settings form takes no ${k}` });
  });

/** An error that names every kind a section may be. */
const kinds = (names: readonly string[]) => ({
  error: `expected show to be one of: ${names.join(', ')}`,
});
const LEAF_KINDS = ['keyValue', 'counter', 'list', 'table', 'progress', 'until'] as const;
const VIEW_LEAF_KINDS = [...LEAF_KINDS, 'stat', 'gallery', 'chart', 'timeseries', 'form'] as const;
const LAYOUTS = ['tabs', 'grid', 'card'] as const;

/** One section of a widget or a page, by the way it shows its value. */
export const widgetSchema = z.discriminatedUnion(
  'show',
  leafKinds({}, { key: path.optional(), detail: z.strictObject(detailBase).optional() }),
  kinds(LEAF_KINDS)
);

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

/** A drawer's sections (D170): a view's leaves, read with the row's values, opening no drawer. */
const drawerSectionSchema = z.discriminatedUnion(
  'show',
  [...leafKinds({ from: inputPort }, {}), ...viewLeafKinds({}), formSchema],
  kinds(VIEW_LEAF_KINDS)
);

/** A view's row drawer (D170): a page's, and sections read with the row's values. */
const viewDetail = z.strictObject({
  ...detailBase,
  sections: z.array(drawerSectionSchema).min(1).optional(),
});
const viewOpening = { key: path.optional(), detail: viewDetail.optional() };
/** A view's leaves (D170): the sections that show a value, each read from an input, and a form. */
const viewLeafOptions = [
  ...leafKinds({ from: inputPort }, viewOpening),
  ...viewLeafKinds(viewOpening),
  formSchema,
] as const;

/** A tab's count, beside its title: a number, or a list's or a map's size, of a read. */
const countSchema = z.strictObject({
  from: inputPort,
  read: readName,
  input: base.input,
  path: path.optional(),
});

/**
 * A view's section (D170): a leaf, read from the node bound to its view's input `from` (an
 * interface input), its reads and actions that node's; or a layout that holds others: `tabs`
 * (one shown at a time, each in the address, `?tab=`), a `grid` of `columns`, or a `card`.
 */
export const viewSectionSchema: z.ZodType<ViewSection> = z.lazy(() =>
  z.discriminatedUnion(
    'show',
    [
      ...viewLeafOptions,
      z.strictObject({
        show: z.literal('tabs'),
        tabs: z
          .array(
            z.strictObject({
              title: label,
              count: countSchema.optional(),
              sections: z.array(viewSectionSchema),
            })
          )
          .min(1),
      }),
      z.strictObject({
        show: z.literal('grid'),
        columns: z.number().int().min(1).max(6).optional(),
        sections: z.array(viewSectionSchema),
      }),
      z.strictObject({
        show: z.literal('card'),
        title: label.optional(),
        sections: z.array(viewSectionSchema),
      }),
    ],
    kinds([...VIEW_LEAF_KINDS, ...LAYOUTS])
  )
) as unknown as z.ZodType<ViewSection>;

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
 * A view (D170): a title, an optional selector, and its sections, in order, each a leaf read from
 * one of its inputs or a layout of others; none yet, an empty page (a view node just added).
 */
export const viewSchema = z.strictObject({
  title: z.string().min(1),
  selector: selectorSchema.optional(),
  sections: z.array(viewSectionSchema).default([]),
});

/** One section of a widget or a page, as a plugin declares it. */
export type Widget = z.output<typeof widgetSchema>;
/** A view's leaf (D170): a section that shows a value, read from an input, or a form. */
export type ViewLeaf = z.output<(typeof viewLeafOptions)[number]>;
/** A view's form (D170). */
export type ViewForm = z.output<typeof formSchema>;
/** A drawer's section: a leaf that opens no drawer. */
export type DrawerSection = z.output<typeof drawerSectionSchema>;
/** A view's tabs, grid and card (D170): layouts that hold sections. */
export interface ViewTabs {
  show: 'tabs';
  tabs: { title: string; count?: ViewCount | undefined; sections: ViewSection[] }[];
}
export interface ViewGrid {
  show: 'grid';
  columns?: number | undefined;
  sections: ViewSection[];
}
export interface ViewCard {
  show: 'card';
  title?: string | undefined;
  sections: ViewSection[];
}
export type ViewCount = z.output<typeof countSchema>;
/** A view's section, its selector, and the view, as a plugin declares them (D170). */
export type ViewSection = ViewLeaf | ViewTabs | ViewGrid | ViewCard;
export type ViewSelector = z.output<typeof selectorSchema>;
/** A chart or a time series (D174), as a view's leaf says it. */
export type ViewChart = Extract<ViewLeaf, { show: 'chart' | 'timeseries' }>;
/** A chart's measure (D174): a path, or a path with its reduce, label, format and unit. */
export type ChartMeasure = z.output<typeof measure>;
export type View = z.output<typeof viewSchema>;
export type WidgetShow = Widget['show'];
/** A field or a column: a path, or a path with its label and its format. */
export type WidgetField = z.output<typeof column>;
/** A table's row action (D157). */
export type RowAction = z.output<typeof rowAction>;
/** A row's drawer (D170): a view's, its sections too. */
export type Detail = z.output<typeof viewDetail>;
/** A plugin's full page. */
export type WidgetPage = z.output<typeof pageSchema>;

/** Whether a section is a layout (D170): tabs, a grid or a card. */
export const isLayout = (s: ViewSection): s is ViewTabs | ViewGrid | ViewCard =>
  s.show === 'tabs' || s.show === 'grid' || s.show === 'card';

/** A tab's slug (D170), its title's, as the address names it (`?tab=`). */
export const tabSlug = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'tab';

/** A column's format: its own, else a text. */
export const formatOf = (f: WidgetField): Format =>
  typeof f === 'string' ? 'text' : (f.format ?? 'text');

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

/** What a view's check knows beside the bound node's reads and actions (D170). */
export interface CheckOptions {
  /** Its view has a selector: `'$selector'` stands for its value. */
  selector?: boolean;
  /** Its section is in a row's drawer: `'$row.<path>'` stands for a value of that row's. */
  rows?: JsonSchema | 'open' | undefined;
}

/** A leaf that shows a value of a read: every section but a form and a layout. */
export type ReadLeaf = Widget | Exclude<ViewLeaf, ViewForm>;

/**
 * What is wrong with a section, given the reads and actions of the node it shows: a read it does
 * not declare, an input its schema refuses (or given to a read that takes none), a path its output
 * has not, a value of a kind the section cannot show, a column, a badge or a picture its rows have
 * not, an action they cannot run. Empty when it stands. A drawer's sections, read from other inputs,
 * are checked on their own.
 */
export function widgetIssues(
  w: ReadLeaf,
  reads: Readonly<Record<string, DeclaredRead>>,
  actions: Readonly<Record<string, DeclaredAction>> = {},
  options: CheckOptions = {}
): WidgetIssue[] {
  const read = Object.hasOwn(reads, w.read) ? reads[w.read] : undefined;
  if (read === undefined)
    return [{ path: ['read'], message: `${w.read} is not among its reads (interface.state)` }];
  const issues: WidgetIssue[] = [];
  issues.push(...readInputIssues(read, w.read, w.input, options.selector === true, options.rows));
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
  /** A list's items, or a problem said. */
  const listOf = (): JsonSchema | 'open' | undefined => {
    const items = itemsOf(at);
    if (items === undefined) no(`${where} is not a list or a map`);
    return items;
  };
  /** Paths within the rows, each checked: `key` names where, its entry each the index. */
  const pathsIn = (
    rows: JsonSchema | 'open',
    list: readonly string[],
    key: (string | number)[]
  ): void => {
    if (rows === 'open') return;
    list.forEach((p, i) => {
      if (schemaAt(rows, p) === undefined)
        no(`${where} has no ${p}`, list.length === 1 && key.length > 1 ? key : [...key, i]);
    });
  };
  const columns = (
    rows: JsonSchema | 'open',
    list: readonly WidgetField[],
    key: (string | number)[]
  ): void => {
    list.forEach((c, i) => {
      for (const m of columnIssues(c, rows, where)) no(m.message, [...key, i, ...m.path]);
    });
  };
  const rowActions = (
    rows: JsonSchema | 'open',
    list: readonly RowAction[] | undefined,
    key: (string | number)[]
  ): void => {
    (list ?? []).forEach((a, i) => {
      for (const issue of rowActionIssues(a, rows, actions, options))
        no(issue.message, [...key, i, ...issue.path]);
    });
  };
  /** A table's or a gallery's search, key and drawer, within its rows. */
  const opening = (
    rows: JsonSchema | 'open',
    o: {
      search?: true | string[] | undefined;
      key?: string | undefined;
      detail?:
        | {
            title?: string | undefined;
            fields?: WidgetField[] | undefined;
            actions?: RowAction[] | undefined;
          }
        | undefined;
    }
  ): void => {
    if (Array.isArray(o.search)) pathsIn(rows, o.search, ['search']);
    if (o.detail === undefined) return;
    if (rows !== 'open' && schemaAt(rows, o.key ?? 'id') === undefined)
      no(
        o.key === undefined
          ? 'its rows have no id: a drawer needs a key that tells its rows apart (key)'
          : `its rows have no ${o.key}`,
        ['key']
      );
    if (o.detail.title !== undefined) pathsIn(rows, [o.detail.title], ['detail', 'title']);
    columns(rows, o.detail.fields ?? [], ['detail', 'fields']);
    rowActions(rows, o.detail.actions, ['detail', 'actions']);
  };
  switch (w.show) {
    case 'keyValue':
      columns(at, w.fields ?? [], ['fields']);
      break;
    case 'counter':
      if (!isNumber(at) && itemsOf(at) === undefined && !types(at).includes('object'))
        no(`${where} is not a number, a list or a map`);
      break;
    case 'list': {
      const items = listOf();
      if (items !== undefined && w.item !== undefined) pathsIn(items, [w.item], ['item']);
      break;
    }
    case 'table': {
      const items = listOf();
      if (items === undefined) break;
      columns(items, w.columns, ['columns']);
      rowActions(items, w.actions, ['actions']);
      if (w.defaultSort !== undefined)
        pathsIn(items, [w.defaultSort.path], ['defaultSort', 'path']);
      opening(items, w);
      break;
    }
    case 'gallery': {
      const items = listOf();
      if (items === undefined) break;
      for (const m of columnIssues(
        { path: w.image.path, format: w.image.carousel === true ? 'carousel' : 'image' },
        items
      ))
        no(m.message, ['image', ...m.path]);
      if (w.caption !== undefined) pathsIn(items, [w.caption], ['caption']);
      columns(items, w.badges ?? [], ['badges']);
      rowActions(items, w.actions, ['actions']);
      opening(items, w);
      break;
    }
    case 'stat': {
      const f = w.format ?? 'text';
      if ((f === 'number' || f === 'percent') && !isNumber(at)) no(`${where} is not a number`);
      if ((f === 'datetime' || f === 'relative') && !isNumber(at) && !types(at).includes('string'))
        no(`${where} is not a time (ms since the epoch, or an ISO string)`);
      if (f === 'image' || f === 'carousel' || f === 'tags')
        no(`a stat shows one value: format ${f} is a column’s`, ['format']);
      if (typeof w.of === 'string') {
        const of = schemaAt(root, w.of);
        if (of === undefined) no(`the read ${w.read} has no ${w.of}`, ['of']);
        else if (of !== 'open' && !isNumber(of)) no(`${w.of} is not a number`, ['of']);
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
    case 'chart':
    case 'timeseries': {
      const items = listOf();
      if (items === undefined || items === 'open') break;
      const x = schemaAt(items, w.x);
      if (x === undefined) no(`${where} has no ${w.x}`, ['x']);
      else if (
        w.show === 'timeseries' &&
        x !== 'open' &&
        !isNumber(x) &&
        !types(x).includes('string')
      )
        no(`${w.x} is not a time (ms since the epoch, or an ISO string)`, ['x']);
      const measureAt = (m: ChartMeasure, key: (string | number)[]): void => {
        const p = typeof m === 'string' ? m : m.path;
        if (p === undefined) return;
        const s = schemaAt(items, p);
        if (s === undefined) no(`${where} has no ${p}`, key);
        else if (s !== 'open' && !isNumber(s)) no(`${p} is not a number`, key);
      };
      if (Array.isArray(w.y)) w.y.forEach((m, i) => measureAt(m, ['y', i]));
      else if (w.y !== undefined) measureAt(w.y, ['y']);
      if (w.value !== undefined) measureAt(w.value, ['value']);
      if (w.series !== undefined) pathsIn(items, [w.series], ['series']);
      break;
    }
  }
  return issues;
}

/**
 * What is wrong with a column (or a drawer's field, a gallery's badge) within its rows: a path
 * they have not, a list format (`carousel`, `tags`) on a value that is no list, a number format on
 * one that is no number.
 */
function columnIssues(
  c: WidgetField,
  rows: JsonSchema | 'open',
  where = 'its rows'
): WidgetIssue[] {
  const p = fieldPath(c);
  const s = rows === 'open' ? 'open' : schemaAt(rows, p);
  if (s === undefined) return [{ path: [], message: `${where} has no ${p}` }];
  if (s === 'open') return [];
  const f = formatOf(c);
  if ((f === 'carousel' || f === 'tags') && !types(s).includes('array'))
    return [
      {
        path: [],
        message: `${p} is not a list${f === 'carousel' ? ' of pictures' : ' of texts'}`,
      },
    ];
  if ((f === 'number' || f === 'percent') && !isNumber(s))
    return [{ path: [], message: `${p} is not a number` }];
  return [];
}

/**
 * What is wrong with a tab's count (D170), given the reads of the node its input is bound to: a
 * read it has not, an input it refuses, a path that is no number, list or map.
 */
export function countIssues(
  c: ViewCount,
  reads: Readonly<Record<string, DeclaredRead>>,
  options: CheckOptions = {}
): WidgetIssue[] {
  return widgetIssues({ show: 'counter', ...c } as ReadLeaf, reads, {}, options);
}

/**
 * What is wrong with a form (D170), given the node its input is bound to: an action it has not, a
 * key its input has not or a constant it refuses, a field it has not, a `current` read it has not
 * or whose value is no object; or a setting it does not declare.
 */
export function formIssues(
  f: ViewForm,
  node: {
    reads: Readonly<Record<string, DeclaredRead>>;
    actions: Readonly<Record<string, DeclaredAction>>;
    settings?: z.ZodType | undefined;
  },
  options: CheckOptions = {}
): WidgetIssue[] {
  if (f.settings !== undefined) {
    const keys = inputKeys(node.settings ?? z.object({}))?.keys ?? [];
    return f.settings.flatMap((k, i) =>
      keys.includes(k) ? [] : [{ path: ['settings', i], message: `${k} is not among its settings` }]
    );
  }
  const name = f.action ?? '';
  const action = Object.hasOwn(node.actions, name) ? node.actions[name] : undefined;
  if (action === undefined)
    return [{ path: ['action'], message: `${name} is not among its actions (interface.actions)` }];
  const issues = rowActionIssues(
    { label: 'form', action: name, ...(f.input === undefined ? {} : { input: f.input }) },
    options.rows ?? 'open',
    node.actions,
    options
  );
  if (options.rows === undefined)
    for (const [k, v] of Object.entries(f.input ?? {}))
      if (typeof v === 'string' && v.startsWith('$row'))
        issues.push({ path: ['input', k], message: 'only a form in a drawer has a row ($row)' });
  const known = inputKeys(action.input);
  (f.fields ?? []).forEach((k, i) => {
    if (known !== undefined && !known.keys.includes(k))
      issues.push({ path: ['fields', i], message: `the action ${name} takes no ${k}` });
  });
  if (f.current !== undefined) {
    const read = Object.hasOwn(node.reads, f.current.read) ? node.reads[f.current.read] : undefined;
    if (read === undefined)
      issues.push({
        path: ['current', 'read'],
        message: `${f.current.read} is not among its reads (interface.state)`,
      });
    else {
      for (const i of readInputIssues(
        read,
        f.current.read,
        f.current.input,
        options.selector === true,
        options.rows
      ))
        issues.push({ ...i, path: ['current', ...i.path] });
      const at = schemaAt(outputSchema(read), f.current.path);
      if (at === undefined)
        issues.push({
          path: ['current', 'path'],
          message: `the read ${f.current.read} has no ${f.current.path ?? ''}`,
        });
      else if (at !== 'open' && !types(at).includes('object'))
        issues.push({
          path: ['current', 'path'],
          message: `${f.current.path ?? `the read ${f.current.read}`} is not an object of the form’s fields`,
        });
    }
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
  selector: boolean,
  /** In a drawer (D170): its row's schema, whose values `'$row.<path>'` names. */
  rows?: JsonSchema | 'open'
): WidgetIssue[] {
  const fromRows: WidgetIssue[] = [];
  if (rows !== undefined)
    for (const [k, v] of Object.entries(input ?? {}))
      if (typeof v === 'string' && ROW_REF.test(v) && v !== '$row' && rows !== 'open') {
        const p = v.slice('$row.'.length);
        if (schemaAt(rows, p) === undefined)
          fromRows.push({ path: ['input', k], message: `its row has no ${p}` });
      }
  if (read.input === undefined)
    return input === undefined
      ? []
      : [{ path: ['input'], message: `the read ${name} takes no input` }];
  // The keys the selector gives that the schema names: those left out of its check. Any other is
  // checked as given, so that a key the read does not take is still refused.
  const shape = read.input instanceof z.ZodObject ? read.input.shape : {};
  const given = (k: string): boolean => {
    const v = input?.[k];
    return (
      (selector && v === SELECTOR_REF) ||
      (rows !== undefined && typeof v === 'string' && ROW_REF.test(v))
    );
  };
  const chosen = Object.keys(input ?? {}).filter((k) => given(k) && Object.hasOwn(shape, k));
  const schema =
    chosen.length > 0 && read.input instanceof z.ZodObject
      ? read.input.partial(Object.fromEntries(chosen.map((k) => [k, true])) as never)
      : read.input;
  const left = Object.fromEntries(Object.entries(input ?? {}).filter(([k]) => !chosen.includes(k)));
  const parsed = schema.safeParse(left);
  if (parsed.success) return fromRows;
  return [
    ...fromRows,
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

/** A leaf of a view (D170), with its place: its path in the manifest, its tab, its drawer's row. */
export interface LeafAt {
  leaf: ViewLeaf;
  /** Its path from the view: `['sections', 0, 'tabs', 1, 'sections', 2]`. */
  path: (string | number)[];
  /** The slug of the tab it is in; none, outside the tabs. */
  tab?: string;
  /** The leaf whose row's drawer it is in: its sections read that row's values. */
  drawerOf?: ViewLeaf;
}

/** A tab's count (D170), with its path in the manifest. */
export interface CountAt {
  count: ViewCount;
  path: (string | number)[];
}

/** Every leaf of a view (D170), in order, a drawer's sections after the leaf that opens it. */
export function viewLeaves(view: { sections: readonly ViewSection[] }): LeafAt[] {
  const out: LeafAt[] = [];
  const walk = (list: readonly ViewSection[], at: (string | number)[], tab?: string): void => {
    list.forEach((s, i) => {
      const path = [...at, 'sections', i];
      const here = tab === undefined ? {} : { tab };
      if (s.show === 'tabs')
        s.tabs.forEach((t, j) => walk(t.sections, [...path, 'tabs', j], tab ?? tabSlug(t.title)));
      else if (s.show === 'grid' || s.show === 'card') walk(s.sections, path, tab);
      else {
        out.push({ leaf: s, path, ...here });
        const detail = 'detail' in s ? s.detail : undefined;
        (detail?.sections ?? []).forEach((d, k) =>
          out.push({
            leaf: d as ViewLeaf,
            path: [...path, 'detail', 'sections', k],
            ...here,
            drawerOf: s,
          })
        );
      }
    });
  };
  walk(view.sections, []);
  return out;
}

/** Every tab's count of a view (D170). */
export function viewCounts(view: { sections: readonly ViewSection[] }): CountAt[] {
  const out: CountAt[] = [];
  const walk = (list: readonly ViewSection[], at: (string | number)[]): void => {
    list.forEach((s, i) => {
      const path = [...at, 'sections', i];
      if (s.show === 'tabs')
        s.tabs.forEach((t, j) => {
          if (t.count !== undefined)
            out.push({ count: t.count, path: [...path, 'tabs', j, 'count'] });
          walk(t.sections, [...path, 'tabs', j]);
        });
      else if (s.show === 'grid' || s.show === 'card') walk(s.sections, path);
    });
  };
  walk(view.sections, []);
  return out;
}

/**
 * What a view's layout refuses (D170), whatever its nodes: tabs within tabs (one level of tabs),
 * two tabs of one slug (the address could not tell them apart), and two drawers on one tab (or
 * outside the tabs): `?row=` names one row of one leaf.
 */
export function layoutIssues(view: { sections: readonly ViewSection[] }): WidgetIssue[] {
  const issues: WidgetIssue[] = [];
  const walk = (list: readonly ViewSection[], at: (string | number)[], inTab: boolean): void => {
    list.forEach((s, i) => {
      const path = [...at, 'sections', i];
      if (s.show === 'tabs') {
        if (inTab) issues.push({ path, message: 'tabs within tabs: a view has one level of tabs' });
        const seen = new Map<string, number>();
        s.tabs.forEach((t, j) => {
          const slug = tabSlug(t.title);
          const other = seen.get(slug);
          if (other !== undefined)
            issues.push({
              path: [...path, 'tabs', j, 'title'],
              message: `its address is tab ${other}'s too (?tab=${slug}): give it another title`,
            });
          else seen.set(slug, j);
          walk(t.sections, [...path, 'tabs', j], true);
        });
      } else if (s.show === 'grid' || s.show === 'card') walk(s.sections, path, inTab);
    });
  };
  walk(view.sections, [], false);
  const drawers = new Map<string, (string | number)[]>();
  for (const { leaf, path, tab, drawerOf } of viewLeaves(view)) {
    if (drawerOf !== undefined || !('detail' in leaf) || leaf.detail === undefined) continue;
    const where = tab ?? '';
    const other = drawers.get(where);
    if (other !== undefined)
      issues.push({
        path: [...path, 'detail'],
        message: `a second drawer ${tab === undefined ? 'outside the tabs' : `on tab ${tab}`} (the first: ${other.join('.')}): ?row= opens one leaf’s`,
      });
    else drawers.set(where, path);
  }
  return issues;
}

/** The schema of a leaf's rows (D170), given its node's reads: what its drawer's `$row` names. */
export function rowsOf(
  leaf: ViewLeaf,
  reads: Readonly<Record<string, DeclaredRead>>
): JsonSchema | 'open' {
  if (!('read' in leaf)) return 'open';
  const read = Object.hasOwn(reads, leaf.read) ? reads[leaf.read] : undefined;
  if (read === undefined) return 'open';
  const at = schemaAt(outputSchema(read), leaf.path);
  if (at === undefined || at === 'open') return 'open';
  return itemsOf(at) ?? 'open';
}
