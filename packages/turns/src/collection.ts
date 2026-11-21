/**
 * The collection (docs/bot-os.md D155, docs/bot-os-api.md §5): a node that holds records of a
 * schema its config gives, edited by the owner in its panel, read by other nodes through its
 * interface. Data apart from logic: a writer's cast of characters, a list of sentences, a list of
 * pictures, each kept by a collection, and read by every node that needs it.
 *
 * - **Its schema** is its config's `fields`, a small declarative format the editor draws: each
 *   field named, of a type (`text`, one line or `long`; `number`; `boolean`; `choice` of its
 *   `options`; `list` of texts; `media`, a `Media` within its `kinds`, `mimes` and `maxBytes`),
 *   with its `help`, and `required` or `unique` (a text, a number or a choice). `title` names the
 *   field that names a record in lists.
 * - **Its records** are its store's document `records`: each with a stable id (`r1`, `r2`, …, never
 *   reused) and its place in the order. A media field's bytes are its store's files (D149), named
 *   by their SHA-256 (`sha256-<hex>`: a file's name takes no colon), the same bytes kept once; the
 *   record holds `{ id: "sha256:<hex>", mime, width?, height? }`. A file no record refers to is
 *   deleted after each change and at the start.
 * - **A schema changed** keeps the records: a field gone is dropped from them at the start (kept
 *   so); a value its field no longer takes (a type changed, an option removed) is kept but left
 *   out of what is read, and the record is `incomplete`, saying why, as one missing a required
 *   field or repeating a unique one is; the node starts all the same.
 * - **Read** through an interface edge (`list`, `get`, `schema`, `media`, the last a
 *   `MediaResult`, D153), **changed** through its actions (`add`, `update`, `remove`, `reorder`),
 *   each checked against the schema; each change announced as `<node>.changed`.
 *
 * Its node's manifest is its own (D74): the actions' inputs are made from its fields, so that the
 * panel's forms are, and its event type is in its node's namespace.
 */
import {
  definePlugin,
  type Instance,
  type ManifestInput,
  type Media,
  MEDIA_KINDS,
  mediaField,
  mediaKind,
  mediaOfFile,
  type MediaResult,
  mediaResultSchema,
  type Plugin,
  type PluginContext,
} from '@megabottron1999/core';
import crypto from 'node:crypto';
import { z } from 'zod';

export const COLLECTION = 'collection';

/** A field's types (D155). */
export const FIELD_TYPES = ['text', 'number', 'boolean', 'choice', 'list', 'media'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** The types a field may be `unique` in: those whose values compare as one value. */
const UNIQUE_TYPES: readonly FieldType[] = ['text', 'number', 'choice'];

/** A field's name: a word, as a config key is. */
const FIELD_NAME = /^[a-z][A-Za-z0-9_]*$/u;
/** A media's id: its bytes' SHA-256. */
const MEDIA_ID = /^sha256:([0-9a-f]{64})$/u;
/** A record's id. */
const RECORD_ID = /^r[1-9][0-9]*$/u;

/** One field of a collection's schema, as its config says it (D155). */
export const fieldSpec = z
  .object({
    name: z
      .string()
      .regex(FIELD_NAME, 'expected a name such as faceImage: a letter, then letters or digits')
      .describe('Its name, a word: name, role, face'),
    type: z
      .enum(FIELD_TYPES)
      .meta({
        choices: {
          text: 'Text',
          number: 'Number',
          boolean: 'Yes or no',
          choice: 'One of options',
          list: 'List of texts',
          media: 'Media (a file)',
        },
      })
      .describe('What it holds'),
    help: z.string().min(1).optional().describe('What it is for, shown under it in the forms'),
    required: z.boolean().default(false).describe('Every record has it'),
    unique: z
      .boolean()
      .default(false)
      .describe('No two records have the same value (a text, a number or a choice; case ignored)'),
    long: z
      .boolean()
      .default(false)
      .meta({ shownWhen: { type: 'text' } })
      .describe('Several lines, typed in a larger box'),
    options: z
      .array(z.string().min(1))
      .optional()
      .meta({ shownWhen: { type: 'choice' } })
      .describe('The values it may take'),
    kinds: z
      .array(z.enum(MEDIA_KINDS))
      .optional()
      .meta({ shownWhen: { type: 'media' } })
      .describe('The kinds of media it takes (image, video, audio, document); any if unset'),
    mimes: z
      .array(z.string().min(1))
      .optional()
      .meta({ shownWhen: { type: 'media' } })
      .describe('The media types it takes (image/png); any of its kinds if unset'),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ shownWhen: { type: 'media' } })
      .describe('The most bytes a file may have; the store’s limit for a file if unset'),
  })
  .superRefine((f, ctx) => {
    const only = (key: 'long' | 'options' | 'kinds' | 'mimes' | 'maxBytes', type: FieldType) => {
      const v = f[key];
      if (f.type !== type && v !== undefined && v !== false)
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is for a ${type} field` });
    };
    only('long', 'text');
    only('options', 'choice');
    only('kinds', 'media');
    only('mimes', 'media');
    only('maxBytes', 'media');
    if (f.type === 'choice' && (f.options ?? []).length === 0)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'a choice needs its options' });
    if (f.options !== undefined && new Set(f.options).size !== f.options.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'an option is listed twice' });
    if (f.unique && !UNIQUE_TYPES.includes(f.type))
      ctx.addIssue({
        code: 'custom',
        path: ['unique'],
        message: `a ${f.type} field cannot be unique: only a text, a number or a choice`,
      });
  });
export type FieldSpec = z.output<typeof fieldSpec>;

/** A collection's config: its schema (D155). */
export const collectionConfig = z
  .object({
    fields: z
      .array(fieldSpec)
      .min(1)
      .describe('Its records’ fields, in the order the forms show them'),
    title: z
      .string()
      .optional()
      .describe('The text field that names a record in lists; the first text field if unset'),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.fields.forEach((f, i) => {
      if (seen.has(f.name))
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'name'],
          message: `${f.name} is named twice`,
        });
      seen.add(f.name);
    });
    if (c.title !== undefined && c.fields.find((f) => f.name === c.title)?.type !== 'text')
      ctx.addIssue({ code: 'custom', path: ['title'], message: `${c.title} is no text field` });
  });
export type CollectionConfig = z.output<typeof collectionConfig>;

/** A media field's value as a record holds it (D155): its bytes are the store's file. */
export interface MediaRef {
  /** `sha256:<hex>`, its bytes' SHA-256. */
  id: string;
  mime: string;
  width?: number;
  height?: number;
}

/** A field's value, as a record holds it. */
export type FieldValue = string | number | boolean | string[] | MediaRef;

/** A record as the collection answers it. */
export interface CollectionRecord {
  /** Its id, stable: `r1`, `r2`, … never reused. */
  id: string;
  /** Its place in the order, from 0. */
  position: number;
  /** Its values, by field: those its fields take now. */
  values: Record<string, FieldValue>;
  /**
   * Why it is incomplete, when it is (D155): a required field missing, a value its field no longer
   * takes (left out of `values`), a unique value another record has first.
   */
  incomplete?: string[];
}

/** What its `schema` read answers: its fields, their defaults filled in, and its title field. */
export interface CollectionSchema {
  fields: FieldSpec[];
  title?: string;
}

/** What `<node>.changed` says (D155). */
export interface CollectionChange {
  change: 'added' | 'updated' | 'removed' | 'reordered';
  /** The record's id. */
  id: string;
}

/** A record as the store keeps it. */
interface StoredRecord {
  id: string;
  values: Record<string, unknown>;
}

/** The store's document of records. */
interface RecordsDoc {
  /** The next record's number. */
  next: number;
  records: StoredRecord[];
}

/** Where the records are kept, in its instance's store. */
export const RECORDS_DOC = 'records';
/** A media's file, by its hash: `sha256-<hex>` (a file's name takes no colon). */
export const mediaFileName = (id: string): string => id.replace(':', '-');
const MEDIA_FILE = /^sha256-[0-9a-f]{64}$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fields of a config as written (each that reads), for a node whose config is refused. */
function fieldsOf(config: Readonly<Record<string, unknown>>): FieldSpec[] {
  const raw = Array.isArray(config['fields']) ? (config['fields'] as unknown[]) : [];
  const out: FieldSpec[] = [];
  for (const f of raw) {
    const r = fieldSpec.safeParse(f);
    if (r.success && !out.some((o) => o.name === r.data.name)) out.push(r.data);
  }
  return out;
}

/** The field that names a record: `title`, or the first text field. */
function titleOf(fields: readonly FieldSpec[], title: unknown): string | undefined {
  if (typeof title === 'string' && fields.some((f) => f.name === title && f.type === 'text'))
    return title;
  return fields.find((f) => f.type === 'text')?.name;
}

const limitsOf = (f: FieldSpec) => ({
  ...(f.kinds === undefined ? {} : { kinds: f.kinds }),
  ...(f.mimes === undefined ? {} : { mimes: f.mimes }),
  ...(f.maxBytes === undefined ? {} : { maxBytes: f.maxBytes }),
});

/** A field's value as an action takes it: its schema, for the form and the check. */
function inputOf(f: FieldSpec): z.ZodType {
  let s: z.ZodType;
  switch (f.type) {
    case 'text':
      s = z.string().trim().min(1, 'expected a text');
      if (f.long) s = s.meta({ long: true });
      break;
    case 'number':
      s = z.number();
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'choice':
      s = z.enum((f.options ?? []) as [string, ...string[]]);
      break;
    case 'list':
      s = z.array(z.string().trim().min(1));
      break;
    case 'media':
      s = mediaField(limitsOf(f));
      break;
  }
  return f.help === undefined ? s : s.describe(f.help);
}

/** The values of a record, as an action takes them: every field, required ones as such or not. */
function valuesSchema(fields: readonly FieldSpec[], partial: boolean): z.ZodObject {
  return z.strictObject(
    Object.fromEntries(
      fields.map((f) => [f.name, partial || !f.required ? inputOf(f).optional() : inputOf(f)])
    )
  );
}

const recordId = z.string().regex(RECORD_ID, 'expected a record’s id, as r1');

const mediaRef = z.object({
  id: z.string().regex(MEDIA_ID),
  mime: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/** A record's schema, as the reads answer it. */
const recordSchema = z.object({
  id: z.string().describe('Its id, stable'),
  position: z.number().int().describe('Its place in the order, from 0'),
  values: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), mediaRef])
    )
    .describe('Its values, by field; a media’s as { id: "sha256:…", mime, width?, height? }'),
  incomplete: z.array(z.string()).optional().describe('Why it is incomplete, when it is'),
});

const changeSchema = z
  .object({
    change: z.enum(['added', 'updated', 'removed', 'reordered']),
    id: z.string(),
  })
  .describe('A record was added, updated, removed or moved: its id');

const BASE = {
  id: COLLECTION,
  version: '0.1.0',
  kinds: ['stats'],
  description: 'Records of a schema its config gives, media included, edited in its panel',
  config: collectionConfig,
} satisfies ManifestInput;

/**
 * A collection node's own manifest (D74), from its config (as written, when its schema refuses it)
 * and its id: its reads, its actions with their inputs made from its fields, and its event type,
 * `<id>.changed`.
 */
export function collectionManifest(
  config: Readonly<Record<string, unknown>>,
  id: string
): ManifestInput {
  const fields = fieldsOf(config);
  return {
    ...BASE,
    games: { registers: [id] },
    events: { [`${id}.changed`]: changeSchema },
    interface: {
      state: {
        list: { help: 'Its records, in order', output: z.array(recordSchema) },
        get: {
          help: 'One record, by its id; null for none',
          input: z.object({ id: z.string().describe('The record’s id') }),
          output: recordSchema.nullable(),
        },
        schema: {
          help: 'Its fields, as its config gives them, and the field that names a record',
          output: z.object({ fields: z.array(z.unknown()), title: z.string().optional() }),
        },
        media: {
          help: 'A media of its records, by its id (sha256:…): its bytes; null for none',
          input: z.object({ id: z.string().describe('The media’s id, sha256:…') }),
          output: mediaResultSchema,
        },
      },
      actions: {
        add: {
          help: 'Adds a record, last or at a position',
          input: z.object({
            values: valuesSchema(fields, false).describe('Its values'),
            position: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe('Its place, from 0; last if unset'),
          }),
          output: recordSchema,
        },
        update: {
          help: 'Changes a record: the values given, and those unset',
          input: z.object({
            id: recordId.describe('The record’s id'),
            values: valuesSchema(fields, true).default({}).describe('The values it changes'),
            unset: z.array(z.string()).optional().describe('The fields it clears'),
          }),
          output: recordSchema,
        },
        remove: {
          help: 'Removes a record',
          input: z.object({ id: recordId.describe('The record’s id') }),
          output: recordSchema,
        },
        reorder: {
          help: 'Moves a record to a place in the order',
          input: z.object({
            id: recordId.describe('The record’s id'),
            position: z.number().int().min(0).describe('Its new place, from 0'),
          }),
          output: z.array(recordSchema),
        },
      },
    },
  };
}

const sha256 = (data: Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex');

/** A media's reference, for bytes kept as their file (`mediaFileName`). */
const refOf = (m: Media): MediaRef => ({
  id: `sha256:${sha256(m.data)}`,
  mime: m.mime,
  ...(m.width === undefined ? {} : { width: m.width }),
  ...(m.height === undefined ? {} : { height: m.height }),
});

/** A text compared for uniqueness: trimmed, case ignored. */
const key = (v: unknown): string =>
  typeof v === 'string' ? `s:${v.trim().toLowerCase()}` : `${typeof v}:${String(v)}`;

/**
 * Why a value kept is not one its field takes now, or undefined (D155): the check of a value read
 * back, after a schema changed. `size` gives a media file's size, undefined when it is gone.
 */
export function keptValueProblem(
  f: FieldSpec,
  v: unknown,
  size: (name: string) => number | undefined
): string | undefined {
  switch (f.type) {
    case 'text':
      return typeof v === 'string' && v.trim() !== '' ? undefined : 'not a text';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? undefined : 'not a number';
    case 'boolean':
      return typeof v === 'boolean' ? undefined : 'not yes or no';
    case 'choice':
      return typeof v === 'string' && (f.options ?? []).includes(v)
        ? undefined
        : `${JSON.stringify(v)} is not one of ${(f.options ?? []).join(', ')}`;
    case 'list':
      return Array.isArray(v) && v.every((x) => typeof x === 'string')
        ? undefined
        : 'not a list of texts';
    case 'media': {
      const r = mediaRef.safeParse(v);
      if (!r.success) return 'not a media';
      const n = size(mediaFileName(r.data.id));
      if (n === undefined) return 'its file is gone';
      // Its limits, as for a media of its type and size (its bytes were checked when sent).
      return limitProblem(f, r.data.mime, n);
    }
  }
}

/** Why a media of `mime` and `n` bytes is past a field's limits, or undefined. */
function limitProblem(f: FieldSpec, mime: string, n: number): string | undefined {
  const kind = mediaKind(mime);
  if (f.kinds !== undefined && !f.kinds.includes(kind))
    return `${mime} is not ${f.kinds.join(' or ')}`;
  if (f.mimes !== undefined && !f.mimes.includes(mime))
    return `${mime} is not a type taken (${f.mimes.join(', ')})`;
  if (f.maxBytes !== undefined && n > f.maxBytes)
    return `${n} bytes, more than the ${f.maxBytes} taken`;
  return undefined;
}

/**
 * Records and their media for a dev kit's run (D155): `records`, each its values by field, a media
 * field's a `Media`, as the collection's store keeps them, for `DevKit`'s `documents` and `files`
 * of the collection's node (`{ documents: { cast: seed.documents }, files: { cast: seed.files } }`).
 * Their ids are `r1`, `r2`, … in order. Nothing is checked: a test may seed what a schema changed
 * since would refuse.
 */
export function collectionSeed(records: readonly Record<string, unknown>[]): {
  documents: Record<string, unknown>;
  files: Record<string, Media>;
} {
  const files: Record<string, Media> = {};
  const stored = records.map((values, i): StoredRecord => ({
    id: `r${i + 1}`,
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => {
        if (!(v instanceof Object) || !((v as Media).data instanceof Uint8Array)) return [k, v];
        const ref = refOf(v as Media);
        files[mediaFileName(ref.id)] = { data: (v as Media).data, mime: (v as Media).mime };
        return [k, ref];
      })
    ),
  }));
  const doc: RecordsDoc = { next: records.length + 1, records: stored };
  return { documents: { [RECORDS_DOC]: doc }, files };
}

/** A collection's instance: its records, kept in its store, and the checks of each change. */
function collection(ctx: PluginContext): Instance {
  const c = ctx.config as CollectionConfig;
  const fields = c.fields;
  const byName = new Map(fields.map((f) => [f.name, f]));
  const title = titleOf(fields, c.title);
  const files = ctx.store.files;
  const read = (): RecordsDoc => {
    const doc = ctx.store.read<RecordsDoc>(RECORDS_DOC);
    return isRecord(doc) && Array.isArray(doc.records)
      ? {
          next: typeof doc.next === 'number' ? doc.next : doc.records.length + 1,
          records: doc.records,
        }
      : { next: 1, records: [] };
  };
  let doc = read();
  const sizes = (): Map<string, number> => new Map(files.list().map((f) => [f.name, f.size]));

  /** The records as answered: each value its field takes, and why it is incomplete. */
  const answered = (): CollectionRecord[] => {
    const size = sizes();
    const seen = new Map<string, Set<string>>();
    return doc.records.map((r, position) => {
      const values: Record<string, FieldValue> = {};
      const why: string[] = [];
      for (const f of fields) {
        const v = r.values[f.name];
        if (v === undefined) {
          if (f.required) why.push(`${f.name} is required`);
          continue;
        }
        const problem = keptValueProblem(f, v, (n) => size.get(n));
        if (problem !== undefined) {
          why.push(`${f.name}: ${problem}`);
          continue;
        }
        if (f.unique) {
          const taken = seen.get(f.name) ?? new Set<string>();
          seen.set(f.name, taken);
          if (taken.has(key(v))) why.push(`${f.name}: ${String(v)} is an earlier record’s`);
          taken.add(key(v));
        }
        values[f.name] = v as FieldValue;
      }
      return { id: r.id, position, values, ...(why.length === 0 ? {} : { incomplete: why }) };
    });
  };
  const one = (id: string): CollectionRecord | undefined => answered().find((r) => r.id === id);

  /** Deletes the media files no record refers to (D155). */
  const clean = (): void => {
    const used = new Set<string>();
    for (const r of doc.records)
      for (const v of Object.values(r.values)) {
        const m = mediaRef.safeParse(v);
        if (m.success) used.add(mediaFileName(m.data.id));
      }
    for (const f of files.list())
      if (MEDIA_FILE.test(f.name) && !used.has(f.name)) {
        files.delete(f.name);
        ctx.log.info(`media ${f.name} deleted: no record refers to it`);
      }
  };
  const save = (change: CollectionChange['change'], id: string): void => {
    ctx.store.write(RECORDS_DOC, doc);
    clean();
    ctx.log.info(`record ${id} ${change}`);
    const payload: CollectionChange = { change, id };
    ctx.bus.publish(`${ctx.id}.changed`, { ...payload });
  };

  /**
   * A record's values with `given` put in and `unset` taken away, each checked against its field
   * (D155), media written as their files; throws with why.
   */
  const merged = (
    id: string | undefined,
    base: Record<string, unknown>,
    given: unknown,
    unset: readonly string[]
  ): Record<string, unknown> => {
    if (!isRecord(given)) throw new Error('values: expected an object of values by field');
    const next = { ...base };
    for (const name of unset) {
      const f = byName.get(name);
      if (f === undefined) throw new Error(`${name}: no such field`);
      if (f.required) throw new Error(`${name} is required: it cannot be cleared`);
      delete next[name];
    }
    const media: Media[] = [];
    for (const [name, v] of Object.entries(given)) {
      const f = byName.get(name);
      if (f === undefined) throw new Error(`${name}: no such field`);
      if (v === undefined) continue;
      const r = inputOf(f).safeParse(v);
      if (!r.success) throw new Error(`${name}: ${r.error.issues[0]?.message ?? 'refused'}`);
      if (f.type === 'media') {
        const m = r.data as Media;
        media.push(m);
        next[name] = refOf(m);
      } else next[name] = r.data;
    }
    // A unique value given is checked; one kept is the record's own problem (`incomplete`).
    for (const f of fields) {
      const v = next[f.name];
      if (v === undefined || !f.unique || !Object.hasOwn(given, f.name)) continue;
      const other = doc.records.find((o) => o.id !== id && key(o.values[f.name]) === key(v));
      if (other !== undefined)
        throw new Error(`${f.name}: ${String(v)} is record ${other.id}’s already`);
    }
    // The bytes first: a record never refers to a file not written.
    for (const m of media) {
      const name = mediaFileName(refOf(m).id);
      if (files.read(name) === undefined) files.write(name, m.data, { type: m.mime });
    }
    return next;
  };
  const find = (id: unknown): number => {
    const i = doc.records.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`no record ${String(id)}`);
    return i;
  };
  const at = (position: unknown, length: number): number =>
    typeof position === 'number' && Number.isInteger(position) && position >= 0
      ? Math.min(position, length)
      : length;

  return {
    start() {
      // A field gone from the schema is dropped from every record, kept so (D155).
      let dropped = 0;
      const records = doc.records.map((r) => {
        const values = Object.fromEntries(
          Object.entries(isRecord(r.values) ? r.values : {}).filter(([k]) => byName.has(k))
        );
        dropped += Object.keys(r.values ?? {}).length - Object.keys(values).length;
        return { id: r.id, values };
      });
      doc = { next: doc.next, records };
      if (dropped > 0) {
        ctx.store.write(RECORDS_DOC, doc);
        ctx.log.warn(`${dropped} value(s) of fields no longer in its schema dropped`);
      }
      clean();
      const incomplete = answered().filter((r) => r.incomplete !== undefined).length;
      ctx.log.info(
        `${doc.records.length} record(s)${incomplete === 0 ? '' : `, ${incomplete} incomplete`}`
      );
    },
    interface: {
      state: {
        list: () => answered(),
        get: ({ id }: { id: string }) => one(id) ?? null,
        schema: (): CollectionSchema => ({
          fields,
          ...(title === undefined ? {} : { title }),
        }),
        media: ({ id }: { id: string }): MediaResult => {
          if (!MEDIA_ID.test(id)) return { ok: false, error: `${id} is no media id (sha256:…)` };
          let ref: MediaRef | undefined;
          for (const r of doc.records)
            for (const v of Object.values(r.values)) {
              const m = mediaRef.safeParse(v);
              if (m.success && m.data.id === id) ref = m.data as MediaRef;
            }
          if (ref === undefined) return { ok: true, media: null };
          const media = mediaOfFile(files, mediaFileName(id));
          if (media === undefined) return { ok: false, error: `the file of ${id} is gone` };
          return {
            ok: true,
            media: {
              ...media,
              mime: ref.mime,
              ...(ref.width === undefined ? {} : { width: ref.width }),
              ...(ref.height === undefined ? {} : { height: ref.height }),
            },
          };
        },
      },
      actions: {
        add: (input: { values?: unknown; position?: number }) => {
          const values = merged(undefined, {}, input.values ?? {}, []);
          const missing = fields.filter((f) => f.required && values[f.name] === undefined);
          if (missing.length > 0)
            throw new Error(`${missing.map((f) => f.name).join(', ')}: required`);
          const id = `r${doc.next}`;
          const records = [...doc.records];
          records.splice(at(input.position, records.length), 0, { id, values });
          doc = { next: doc.next + 1, records };
          save('added', id);
          return one(id);
        },
        update: (input: { id: string; values?: unknown; unset?: string[] }) => {
          const i = find(input.id);
          const r = doc.records[i] as StoredRecord;
          const values = merged(r.id, r.values, input.values ?? {}, input.unset ?? []);
          const records = [...doc.records];
          records[i] = { id: r.id, values };
          doc = { next: doc.next, records };
          save('updated', r.id);
          return one(r.id);
        },
        remove: (input: { id: string }) => {
          const i = find(input.id);
          const gone = answered()[i];
          doc = { next: doc.next, records: doc.records.filter((_, j) => j !== i) };
          save('removed', input.id);
          return gone;
        },
        reorder: (input: { id: string; position: number }) => {
          const i = find(input.id);
          const records = [...doc.records];
          const [r] = records.splice(i, 1);
          records.splice(at(input.position, records.length), 0, r as StoredRecord);
          doc = { next: doc.next, records };
          save('reordered', input.id);
          return answered();
        },
      },
    },
  };
}

/** The collection plugin: one node per collection, each with its schema in its config. */
export function collectionPlugin(): Plugin {
  return definePlugin({
    manifest: { ...BASE, node: collectionManifest },
    create: (ctx) => collection(ctx),
  });
}
