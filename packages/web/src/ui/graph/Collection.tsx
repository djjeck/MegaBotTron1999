/**
 * A collection's records (docs/bot-os.md D155), in its node's panel while it runs: each in its
 * order, named by its title field, its other values in one line and its pictures as thumbnails
 * (its media files, `GET /plugins/<id>/files/sha256-<hex>`), and why it is incomplete when it is;
 * each edited, moved up or down, or removed (asking first), and new ones added. A record is edited
 * in a form made from its node's `add` action's input (`values`), the panel's own form builder
 * (`SchemaForm.tsx`), its media fields picked, previewed, replaced or removed (`MediaField.tsx`).
 * Each change is the node's action (`add`, `update` with the values changed and those unset,
 * `reorder`, `remove`), checked by the collection, its refusal shown; nothing waits for Apply.
 */
import { useCallback, useEffect, useState } from 'react';
import type { JsonSchema, MemberView } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import { deref } from './MediaField.tsx';
import type { MediaSrc } from './SchemaForm.tsx';
import { SchemaForm } from './SchemaForm.tsx';

/** The plugin whose nodes are collections. */
export const COLLECTION = 'collection';

/** A record as its collection answers it (`list`). */
export interface RecordView {
  id: string;
  position: number;
  values: Record<string, unknown>;
  incomplete?: string[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A media's reference (`{ id: "sha256:…", mime }`), or undefined for any other value. */
function refOf(v: unknown): { id: string; mime: string } | undefined {
  const r = v as { id?: unknown; mime?: unknown } | null;
  return typeof r?.id === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(r.id) &&
    typeof r.mime === 'string'
    ? { id: r.id, mime: r.mime }
    : undefined;
}

/** A value in a line: a list joined, a media by its type, a yes or no in words. */
function valueText(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const ref = refOf(v);
  if (ref !== undefined) return ref.mime;
  return String(v);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The values that changed between `base` and `edited`, and the fields cleared: an update's. */
export function changes(
  base: Readonly<Record<string, unknown>>,
  edited: Readonly<Record<string, unknown>>
): { values: Record<string, unknown>; unset: string[] } {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edited)) if (!same(base[k], v)) values[k] = v;
  const unset = Object.keys(base).filter((k) => edited[k] === undefined);
  return { values, unset };
}

/** A record's form: new (no id) or editing one. */
interface Editing {
  id?: string;
  base: Record<string, unknown>;
  values: Record<string, unknown>;
}

export function CollectionRecords(props: { node: string; actions: readonly MemberView[] }) {
  const { node } = props;
  const add = props.actions.find((a) => a.name === 'add');
  // Its form: the `values` of `add`'s input, behind a `$ref` into its definitions if it is one (#74).
  const root = add?.input;
  const given = (root?.['properties'] as Record<string, JsonSchema> | undefined)?.['values'];
  const schema = given === undefined ? undefined : deref(given, root);
  const [records, setRecords] = useState<RecordView[]>();
  const [title, setTitle] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const load = useCallback((): void => {
    api<RecordView[]>(`/plugins/${seg(node)}/state/list`).then(
      (r) => setRecords(Array.isArray(r) ? r : []),
      (e: unknown) => setSaid({ ok: false, text: message(e) })
    );
    api<{ title?: string }>(`/plugins/${seg(node)}/state/schema`).then(
      (s) => setTitle(s.title),
      () => setTitle(undefined)
    );
  }, [node]);
  useEffect(() => {
    setEditing(undefined);
    setSaid(undefined);
    load();
  }, [load]);
  const fileOf = (id: string): string =>
    `api/plugins/${seg(node)}/files/${seg(id.replace(':', '-'))}`;
  const mediaSrc: MediaSrc = (v) => {
    const ref = refOf(v);
    return ref?.mime.startsWith('image/') === true ? fileOf(ref.id) : undefined;
  };
  const act = (name: string, input: unknown, done: string): void => {
    api<unknown>(`/plugins/${seg(node)}/actions/${seg(name)}`, input).then(
      () => {
        setSaid({ ok: true, text: done });
        if (name === 'add' || name === 'update') setEditing(undefined);
        load();
      },
      (e: unknown) => setSaid({ ok: false, text: message(e) })
    );
  };
  const save = (): void => {
    if (editing === undefined) return;
    if (editing.id === undefined) act('add', { values: editing.values }, 'record added');
    else {
      const c = changes(editing.base, editing.values);
      act(
        'update',
        { id: editing.id, values: c.values, ...(c.unset.length === 0 ? {} : { unset: c.unset }) },
        `${editing.id} saved`
      );
    }
  };
  const name = (r: RecordView): string => {
    const t = title === undefined ? undefined : r.values[title];
    return typeof t === 'string' ? t : r.id;
  };
  const list = records ?? [];
  return (
    <section aria-label={`records of ${node}`}>
      <h3>Records</h3>
      {records === undefined ? (
        <p className="muted small">Reading its records…</p>
      ) : (
        <p className="muted small">
          {list.length === 0
            ? 'No record yet.'
            : `${list.length} ${list.length === 1 ? 'record' : 'records'}`}
          {list.some((r) => r.incomplete !== undefined)
            ? `, ${list.filter((r) => r.incomplete !== undefined).length} incomplete`
            : ''}
        </p>
      )}
      <ol className="records">
        {list.map((r, i) => (
          <li key={r.id} aria-label={`record ${r.id}`}>
            <strong>{name(r)}</strong> <code className="muted small">{r.id}</code>
            <div className="small">
              {Object.entries(r.values)
                .filter(([k]) => k !== title && refOf(r.values[k]) === undefined)
                .map(([k, v]) => `${k}: ${valueText(v)}`)
                .join(' · ')}
            </div>
            <div className="thumbs">
              {Object.entries(r.values).map(([k, v]) => {
                const src = mediaSrc(v);
                return src === undefined ? null : (
                  <img key={k} className="thumb" src={src} alt={`${r.id} ${k}`} loading="lazy" />
                );
              })}
            </div>
            {r.incomplete === undefined ? null : (
              <small className="error">incomplete: {r.incomplete.join('; ')}</small>
            )}
            <span className="row-buttons">
              <button
                type="button"
                className="link"
                onClick={() => {
                  setSaid(undefined);
                  setEditing({ id: r.id, base: r.values, values: { ...r.values } });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="link"
                aria-label={`move ${r.id} up`}
                disabled={i === 0}
                onClick={() => act('reorder', { id: r.id, position: i - 1 }, `${r.id} moved up`)}
              >
                ↑
              </button>
              <button
                type="button"
                className="link"
                aria-label={`move ${r.id} down`}
                disabled={i === list.length - 1}
                onClick={() => act('reorder', { id: r.id, position: i + 1 }, `${r.id} moved down`)}
              >
                ↓
              </button>
              <button
                type="button"
                className="link danger"
                aria-label={`remove ${r.id}`}
                onClick={() => {
                  if (window.confirm(`Remove ${name(r)} (${r.id})? It cannot be undone.`))
                    act('remove', { id: r.id }, `${r.id} removed`);
                }}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      {schema === undefined ? null : editing === undefined ? (
        <button
          type="button"
          onClick={() => {
            setSaid(undefined);
            setEditing({ base: {}, values: {} });
          }}
        >
          Add a record
        </button>
      ) : (
        <div className="record-form">
          <SchemaForm
            legend={editing.id === undefined ? 'New record' : `Record ${editing.id}`}
            schema={schema}
            root={root}
            value={editing.values}
            onChange={(values) => setEditing({ ...editing, values })}
            mediaSrc={mediaSrc}
          />
          <button type="button" onClick={save}>
            {editing.id === undefined ? 'Add' : 'Save'}
          </button>{' '}
          <button type="button" className="link" onClick={() => setEditing(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {said === undefined ? null : (
        <p role="status" className={said.ok ? 'said' : 'said error'}>
          {said.text}
        </p>
      )}
    </section>
  );
}
