/**
 * A node's state, drawn from its schema alone (bot-os.md D72): the node panel's **State** section
 * for any node that keeps one (a game's player state, made with the state plugins' base), from
 * `GET /plugins/<id>/view`, with no renderer of any game's. Its pinned paths first, then each
 * section (a top-level key of its schema) with its freshness. By what the schema says of a value:
 *
 * - a list of objects: a table, its columns the items' properties, sortable by a click on a
 *   column's head and searched by a text across its cells;
 * - a map (a record): a table of its keys and values;
 * - an object: a section that folds, its fields within;
 * - a list of plain values: the values, in a line;
 * - a plain value: a line, labelled by its schema's description (its key without one).
 *
 * Read only: nothing here changes the state.
 */
import { useEffect, useState } from 'react';
import type { JsonSchema, SectionFreshness, StateView } from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';

/** How often the panel reads the state again while it is open. */
const EVERY_MS = 5000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A schema without its wrappers: an optional or nullable value's real branch, its labels kept. */
export function plainOf(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined) return {};
  const choices = (schema['anyOf'] ?? schema['oneOf']) as JsonSchema[] | undefined;
  if (Array.isArray(choices)) {
    const real = choices.filter((c) => c['type'] !== 'null');
    if (real.length === 1) {
      const labels = Object.fromEntries(
        ['description', 'title'].filter((k) => k in schema).map((k) => [k, schema[k]])
      );
      return { ...plainOf(real[0]), ...labels };
    }
  }
  return schema;
}

/** The schema at a dotted path: through objects' properties, maps' values and lists' items. */
export function schemaAt(schema: JsonSchema, path: string): JsonSchema | undefined {
  let s: JsonSchema | undefined = plainOf(schema);
  for (const key of path === '' ? [] : path.split('.')) {
    const props = s['properties'] as Record<string, JsonSchema> | undefined;
    if (props?.[key] !== undefined) s = plainOf(props[key]);
    else if (s['type'] === 'array') s = plainOf(s['items'] as JsonSchema | undefined);
    else if (isObject(s['additionalProperties'])) s = plainOf(s['additionalProperties']);
    else return undefined;
  }
  return s;
}

/** The value at a dotted path. */
export function valueAt(value: unknown, path: string): unknown {
  let v = value;
  for (const key of path === '' ? [] : path.split('.')) {
    if (typeof v !== 'object' || v === null) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** A value's label: its schema's description, else its key. */
const labelOf = (schema: JsonSchema | undefined, key: string): string => {
  const d = schema?.['description'];
  return typeof d === 'string' && d !== '' ? d : key;
};

/** A plain value as text; anything else as compact JSON. */
export function text(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

const when = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/** A section's freshness in words: "snapshot 2026-11-10 12:00 (quest.inventory) · 3 changes since, 1 uncertain". */
export function freshnessText(f: SectionFreshness | undefined): string | undefined {
  if (f === undefined) return undefined;
  const parts: string[] = [];
  if (f.snapshot !== undefined) {
    parts.push(`snapshot ${when(f.snapshot.t)} (${f.snapshot.event})`);
    parts.push(
      `${f.deltas} change${f.deltas === 1 ? '' : 's'} since${f.uncertain > 0 ? `, ${f.uncertain} uncertain` : ''}`
    );
  } else {
    parts.push('no snapshot');
    parts.push(
      `${f.deltas} change${f.deltas === 1 ? '' : 's'}${f.uncertain > 0 ? `, ${f.uncertain} uncertain` : ''}`
    );
  }
  if (f.updated !== undefined) parts.push(`updated ${when(f.updated.t)} (${f.updated.event})`);
  return parts.join(' · ');
}

/** A list of objects: a table, sortable by a column, searched across its cells. */
function ItemTable(props: { label: string; items: unknown[]; schema: JsonSchema }) {
  const [sort, setSort] = useState<{ key: string; down: boolean }>();
  const [search, setSearch] = useState('');
  const props_ = (props.schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const declared = Object.keys(props_);
  const columns = [
    ...declared,
    ...[...new Set(props.items.flatMap((i) => (isObject(i) ? Object.keys(i) : [])))].filter(
      (k) => !declared.includes(k)
    ),
  ];
  const wanted = search.trim().toLowerCase();
  const rows = props.items
    .filter(isObject)
    .filter(
      (row) => wanted === '' || columns.some((c) => text(row[c]).toLowerCase().includes(wanted))
    );
  if (sort !== undefined)
    rows.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      const order =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : text(x).localeCompare(text(y), undefined, { numeric: true });
      return sort.down ? -order : order;
    });
  return (
    <div className="state-table">
      <input
        type="search"
        aria-label={`search ${props.label}`}
        placeholder={`Search ${props.items.length} ${props.items.length === 1 ? 'row' : 'rows'}`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="table-scroll">
        <table aria-label={props.label}>
          <thead>
            <tr>
              {columns.map((c) => {
                const on = sort?.key === c;
                return (
                  <th
                    key={c}
                    scope="col"
                    aria-sort={on ? (sort.down ? 'descending' : 'ascending') : 'none'}
                  >
                    <button
                      type="button"
                      className="link"
                      onClick={() => setSort({ key: c, down: on && !sort.down })}
                    >
                      {labelOf(props_[c], c)}
                      {on ? (sort.down ? ' ▾' : ' ▴') : ''}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>{text(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">{wanted === '' ? 'empty' : 'nothing matches'}</p>
      ) : null}
    </div>
  );
}

/** A map: a table of its keys and values. */
function MapTable(props: { label: string; value: Record<string, unknown>; schema: JsonSchema }) {
  const inner = plainOf(props.schema['additionalProperties'] as JsonSchema | undefined);
  const entries = Object.entries(props.value);
  if (entries.length === 0) return <p className="muted small">empty</p>;
  return (
    <div className="table-scroll">
      <table aria-label={props.label} className="state-map">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>
                {isObject(v) || Array.isArray(v) ? (
                  <Value name={k} value={v} schema={inner} path="" nested />
                ) : (
                  text(v)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One value, drawn by what its schema (or, where it says nothing, the value) is. */
function Value(props: {
  name: string;
  value: unknown;
  schema: JsonSchema | undefined;
  path: string;
  /** Inside a table's cell: no label of its own. */
  nested?: boolean;
  freshness?: SectionFreshness | undefined;
  open?: boolean;
}) {
  const schema = plainOf(props.schema);
  const label = labelOf(schema, props.name);
  const { value } = props;
  const fresh = freshnessText(props.freshness);
  /** Its label, its path, how many it holds (a list's or a map's), and its freshness. */
  const head = (count?: number) => (
    <>
      <strong>{label}</strong>
      {label === props.name || props.path === '' ? null : (
        <code className="muted small"> {props.path}</code>
      )}
      {count === undefined ? null : <span className="muted small"> ({count})</span>}
      {fresh === undefined ? null : (
        <span className="freshness small" title="freshness">
          {fresh}
        </span>
      )}
    </>
  );
  if (Array.isArray(value)) {
    const items = plainOf(schema['items'] as JsonSchema | undefined);
    const ofObjects =
      items['type'] === 'object' || (value.length > 0 && value.every((v) => isObject(v)));
    const body = ofObjects ? (
      <ItemTable label={label} items={value} schema={items} />
    ) : value.length === 0 ? (
      <p className="muted small">empty</p>
    ) : (
      <p>{value.map(text).join(', ')}</p>
    );
    if (props.nested === true) return body;
    return (
      <details className="state-node" open={props.open ?? true}>
        <summary>{head(value.length)}</summary>
        {body}
      </details>
    );
  }
  if (isObject(value)) {
    const fields = (schema['properties'] ?? undefined) as Record<string, JsonSchema> | undefined;
    const body =
      fields === undefined ? (
        <MapTable label={label} value={value} schema={schema} />
      ) : (
        <div className="state-fields">
          {[
            ...Object.keys(fields),
            ...Object.keys(value).filter((k) => !Object.hasOwn(fields, k)),
          ].map((k) => (
            <Value
              key={k}
              name={k}
              value={value[k]}
              schema={fields[k]}
              path={props.path === '' ? k : `${props.path}.${k}`}
            />
          ))}
        </div>
      );
    if (props.nested === true) return body;
    return (
      <details className="state-node" open={props.open ?? true}>
        <summary>{head(fields === undefined ? Object.keys(value).length : undefined)}</summary>
        {body}
      </details>
    );
  }
  return (
    <div className="state-line">
      <span className="state-label">{label}</span>{' '}
      <span className="state-value">{text(value)}</span>
      {fresh === undefined ? null : <span className="freshness small"> {fresh}</span>}
    </div>
  );
}

/** A state, its pins first, then its sections, each with its freshness. */
export function StateViewer(props: { view: StateView }) {
  const { view } = props;
  const schema = plainOf(view.schema);
  const sections = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const state = isObject(view.state) ? view.state : {};
  const pins = view.pin ?? [];
  const keys = [
    ...Object.keys(sections),
    ...Object.keys(state).filter((k) => !Object.hasOwn(sections, k)),
  ];
  return (
    <div className="state-view">
      <p className="muted small">
        {view.updatedAt === undefined ? 'Never changed' : `Updated ${when(view.updatedAt)} UTC`}
      </p>
      {pins.length === 0 ? null : (
        <div className="state-pins" aria-label="pinned">
          {pins.map((p) => (
            <Value
              key={p}
              name={p.split('.').at(-1) ?? p}
              value={valueAt(state, p)}
              schema={schemaAt(view.schema, p)}
              path={p}
              freshness={p.includes('.') ? undefined : view.freshness?.[p]}
            />
          ))}
        </div>
      )}
      {keys.map((k) => (
        <Value
          key={k}
          name={k}
          value={state[k]}
          schema={sections[k]}
          path={k}
          freshness={view.freshness?.[k]}
          // A section pinned is drawn above already: folded here.
          open={!pins.includes(k)}
        />
      ))}
    </div>
  );
}

/**
 * The panel's State section of a node: its view read now and every few seconds while the panel is
 * open; nothing for a node that keeps no state, and a word for one not running.
 */
export function NodeState(props: { id: string }) {
  const [view, setView] = useState<StateView | null | string>();
  useEffect(() => {
    let live = true;
    const load = (): void => {
      api<StateView>(`/plugins/${seg(props.id)}/view`).then(
        (v) => {
          if (live) setView(v);
        },
        (e: unknown) => {
          if (!live) return;
          if (e instanceof ApiError && e.status === 404) setView(null);
          else setView(e instanceof Error ? e.message : String(e));
        }
      );
    };
    load();
    const timer = setInterval(load, EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [props.id]);
  if (view === undefined || view === null) return null;
  return (
    <section aria-label={`state of ${props.id}`}>
      <h3>State</h3>
      {typeof view === 'string' ? <p className="muted">{view}</p> : <StateViewer view={view} />}
    </section>
  );
}
