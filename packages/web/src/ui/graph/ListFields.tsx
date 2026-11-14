/**
 * A list and a record of a form (`SchemaForm.tsx`, #9) as controls rather than JSON: a list of
 * strings or numbers as rows, each a plain field (no quotes) with its remove button, and an add
 * button below; a record of plain values (the reactor's `when`) as rows of a key and a value, the
 * value's type picked when the schema allows several (a text, a number, true or false, null).
 *
 * A row added starts empty and is kept as typed while the owner types; what the config holds is the
 * rows that say something (a list's non-empty items, a record's rows with a key), so that an empty
 * row is never written, and a row that says nothing yet changes nothing. A list or record emptied is taken away, so that its default holds, unless
 * it has a non-empty default, in which case it is kept empty. Read-only without `set`: the rows,
 * with no buttons.
 */
import { useState } from 'react';
import type { JsonSchema } from '#src/ui/api.ts';

/** A plain value's type, as a JSON Schema names it. */
export type Scalar = 'string' | 'number' | 'integer' | 'boolean' | 'null';
const SCALARS: readonly string[] = ['string', 'number', 'integer', 'boolean', 'null'];

/**
 * The plain types a schema allows (`{ type }`, `{ type: [...] }` or an `anyOf` of them), in its
 * order; undefined when it allows anything else (an object, a list) or says nothing.
 */
export function scalarTypes(schema: JsonSchema | undefined): Scalar[] | undefined {
  if (schema === undefined) return undefined;
  const t = schema['type'];
  const options = (schema['anyOf'] ?? schema['oneOf']) as JsonSchema[] | undefined;
  const types: unknown[] =
    typeof t === 'string'
      ? [t]
      : Array.isArray(t)
        ? t
        : options !== undefined
          ? options.flatMap((o) => scalarTypes(o) ?? ['object'])
          : [];
  if (types.length === 0 || !types.every((x) => typeof x === 'string' && SCALARS.includes(x)))
    return undefined;
  return [...new Set(types as Scalar[])];
}

/** The items' schema of a list a form draws as rows: strings or numbers; undefined: as JSON. */
export function listItems(schema: JsonSchema): JsonSchema | undefined {
  if (schema['type'] !== 'array') return undefined;
  const items = schema['items'] as JsonSchema | undefined;
  const types = scalarTypes(items);
  return types !== undefined &&
    types.length === 1 &&
    (types[0] === 'string' || types[0] === 'number' || types[0] === 'integer')
    ? items
    : undefined;
}

/** The values' types of a record a form draws as rows: plain ones; undefined: as JSON. */
export function recordValues(schema: JsonSchema): Scalar[] | undefined {
  if (schema['type'] !== 'object' || schema['properties'] !== undefined) return undefined;
  const values = schema['additionalProperties'];
  if (typeof values !== 'object' || values === null) return undefined;
  return scalarTypes(values as JsonSchema);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Rows kept as typed while what they say (`said`) is what the value given says; else the value's
 * own rows (a value changed from outside: a revert, another panel).
 */
function useRows<R>(
  value: unknown,
  rowsOf: (v: unknown) => R[],
  said: (rows: R[]) => unknown
): [R[], (rows: R[]) => R[]] {
  const [typed, setTyped] = useState<R[]>();
  const own = rowsOf(value);
  const rows = typed !== undefined && sameJson(said(typed), said(own)) ? typed : own;
  return [
    rows,
    (next) => {
      setTyped(next);
      return next;
    },
  ];
}

/** The value emptied: taken away (its default holds), or kept empty over a non-empty default. */
const emptied = (fallback: unknown, empty: unknown): unknown =>
  fallback === undefined || sameJson(fallback, empty) ? undefined : empty;

export function ListField(props: {
  name: string;
  items: JsonSchema;
  value: unknown;
  fallback: unknown;
  set: ((v: unknown) => void) | undefined;
}) {
  const { name, set } = props;
  const numeric = props.items['type'] !== 'string';
  const choices = props.items['enum'] as unknown[] | undefined;
  const said = (rows: string[]): unknown[] =>
    rows.filter((r) => r.trim() !== '').map((r) => (numeric ? Number(r) : r));
  const valueOf = (rows: string[]): unknown => {
    const items = said(rows);
    return items.length === 0 ? emptied(props.fallback, []) : items;
  };
  const rowsOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
  const [rows, keep] = useRows(props.value, rowsOf, said);
  const write = (next: string[]): void => {
    // A row that says nothing yet changes nothing: the draft stays as it is.
    if (!sameJson(said(keep(next)), said(rows))) set?.(valueOf(next));
  };
  return (
    <div className="list-field" role="group" aria-label={name}>
      {rows.length === 0 ? <span className="muted small">none</span> : null}
      <ul>
        {rows.map((r, i) => (
          <li key={i}>
            {choices === undefined ? (
              <input
                aria-label={`${name} ${i + 1}`}
                type={numeric ? 'number' : 'text'}
                value={r}
                readOnly={set === undefined}
                onChange={(e) => write(rows.map((x, j) => (j === i ? e.target.value : x)))}
              />
            ) : (
              <select
                aria-label={`${name} ${i + 1}`}
                value={r}
                disabled={set === undefined}
                onChange={(e) => write(rows.map((x, j) => (j === i ? e.target.value : x)))}
              >
                <option value="" />
                {choices.map((c) => (
                  <option key={String(c)} value={String(c)}>
                    {String(c)}
                  </option>
                ))}
              </select>
            )}
            {set === undefined ? null : (
              <button
                type="button"
                className="link"
                aria-label={`remove ${name} ${i + 1}`}
                title="Remove"
                onClick={() => write(rows.filter((_, j) => j !== i))}
              >
                −
              </button>
            )}
          </li>
        ))}
      </ul>
      {set === undefined ? null : (
        <button
          type="button"
          aria-label={`add to ${name}`}
          title="Add"
          onClick={() => keep([...rows, ''])}
        >
          +
        </button>
      )}
    </div>
  );
}

/** A record's row: its key, its value's type, and its value as typed. */
interface Entry {
  key: string;
  type: Scalar;
  text: string;
}

/** A value's type among those allowed: its own, else the first allowed. */
function typeOf(v: unknown, allowed: readonly Scalar[]): Scalar {
  const own: Scalar =
    v === null
      ? 'null'
      : typeof v === 'boolean'
        ? 'boolean'
        : typeof v === 'number'
          ? Number.isInteger(v) && allowed.includes('integer') && !allowed.includes('number')
            ? 'integer'
            : 'number'
          : 'string';
  return allowed.includes(own) ? own : (allowed[0] ?? 'string');
}

/** A row's value as the config holds it; undefined: it says nothing yet (a number not typed). */
function entryValue(e: Entry): unknown {
  if (e.type === 'null') return null;
  if (e.type === 'boolean') return e.text === 'true';
  if (e.type === 'string') return e.text;
  return e.text.trim() === '' || Number.isNaN(Number(e.text)) ? undefined : Number(e.text);
}

const TYPE_NAMES: Record<Scalar, string> = {
  string: 'text',
  number: 'number',
  integer: 'whole number',
  boolean: 'true or false',
  null: 'null',
};

export function RecordField(props: {
  name: string;
  types: readonly Scalar[];
  value: unknown;
  fallback: unknown;
  set: ((v: unknown) => void) | undefined;
}) {
  const { name, set, types } = props;
  const said = (rows: Entry[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      const v = entryValue(r);
      if (r.key.trim() !== '' && v !== undefined) out[r.key.trim()] = v;
    }
    return out;
  };
  const valueOf = (rows: Entry[]): unknown => {
    const out = said(rows);
    return Object.keys(out).length === 0 ? emptied(props.fallback, {}) : out;
  };
  const rowsOf = (v: unknown): Entry[] =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.entries(v).map(([key, x]) => ({
          key,
          type: typeOf(x, types),
          text: x === null ? '' : String(x),
        }))
      : [];
  const [rows, keep] = useRows(props.value, rowsOf, said);
  const write = (next: Entry[]): void => {
    if (!sameJson(said(keep(next)), said(rows))) set?.(valueOf(next));
  };
  const edit = (i: number, change: Partial<Entry>): void =>
    write(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const keys = rows.map((r) => r.key.trim());
  return (
    <div className="record-field" role="group" aria-label={name}>
      {rows.length === 0 ? <span className="muted small">none</span> : null}
      <ul>
        {rows.map((r, i) => {
          const twice = r.key.trim() !== '' && keys.indexOf(r.key.trim()) !== i;
          return (
            <li key={i}>
              <input
                aria-label={`${name} ${i + 1} key`}
                placeholder="key"
                value={r.key}
                readOnly={set === undefined}
                onChange={(e) => edit(i, { key: e.target.value })}
              />
              {types.length > 1 ? (
                <select
                  aria-label={`${name} ${i + 1} type`}
                  value={r.type}
                  disabled={set === undefined}
                  onChange={(e) => {
                    const type = e.target.value as Scalar;
                    edit(i, {
                      type,
                      text: type === 'boolean' ? (r.text === 'true' ? 'true' : 'false') : r.text,
                    });
                  }}
                >
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_NAMES[t]}
                    </option>
                  ))}
                </select>
              ) : null}
              {r.type === 'null' ? null : r.type === 'boolean' ? (
                <input
                  type="checkbox"
                  aria-label={`${name} ${i + 1} value`}
                  checked={r.text === 'true'}
                  disabled={set === undefined}
                  onChange={(e) => edit(i, { text: e.target.checked ? 'true' : 'false' })}
                />
              ) : (
                <input
                  aria-label={`${name} ${i + 1} value`}
                  placeholder="value"
                  type={r.type === 'string' ? 'text' : 'number'}
                  value={r.text}
                  readOnly={set === undefined}
                  onChange={(e) => edit(i, { text: e.target.value })}
                />
              )}
              {set === undefined ? null : (
                <button
                  type="button"
                  className="link"
                  aria-label={`remove ${name} ${i + 1}`}
                  title="Remove"
                  onClick={() => write(rows.filter((_, j) => j !== i))}
                >
                  −
                </button>
              )}
              {twice ? (
                <small className="error">
                  {r.key.trim()} is set above: this row is the one kept
                </small>
              ) : null}
            </li>
          );
        })}
      </ul>
      {set === undefined ? null : (
        <button
          type="button"
          aria-label={`add to ${name}`}
          title="Add"
          onClick={() =>
            keep([
              ...rows,
              { key: '', type: types[0] ?? 'string', text: types[0] === 'boolean' ? 'false' : '' },
            ])
          }
        >
          +
        </button>
      )}
    </div>
  );
}
