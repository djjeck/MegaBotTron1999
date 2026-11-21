/**
 * What a node page's table draws in a row beyond text (docs/bot-os.md D157): a picture, and a
 * button per row action.
 *
 * - **A picture** (a column `show: 'image'`): a file of the node's own (`from: 'files'`, served as
 *   `GET /plugins/<id>/files/<name>`), or a media (`from: 'media'`: one as JSON carries it, its
 *   bytes shown as they are, or a kept one's reference `{ id: 'sha256:<hex>', mime }`, its file
 *   `sha256-<hex>`), as a thumbnail that opens it whole; an empty value, an empty cell.
 * - **A row action**: a button that runs an action of the node's interface with the input its
 *   section builds from the row (`'$row.<path>'`) and constants. When the action's input has other
 *   fields, the button opens a small form of them under the row, drawn by the shared form builder
 *   (`SchemaForm`, a field whose options a read gives among them, `OptionsField.tsx`), those of
 *   `current` preselected with the row's values; **Run** then runs it. `confirm`, asked first.
 *   While it runs the button is busy; then its answer, or why not, is said under it, and the
 *   page's reads are asked again.
 */
import { useState } from 'react';
import type { JsonSchema, MemberView, RowAction } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import { deref } from './MediaField.tsx';
import { SchemaForm } from './SchemaForm.tsx';
import { at, words } from './widget-text.ts';

/** A row's value: `$row` or `$row.<path>` (the core's `ROW_REF`). */
const ROW_REF = /^\$row(?:\.[A-Za-z0-9_$-]+)*$/u;

/** A value a row action names: a row's (`$row.<path>`), else the constant as it is. */
export function fromRow(v: unknown, row: unknown): unknown {
  if (typeof v !== 'string' || !ROW_REF.test(v)) return v;
  return v === '$row' ? row : at(row, v.slice('$row.'.length));
}

/** The input a row action builds from its row: its constants and the row's values. */
export function rowInput(a: RowAction, row: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(a.input ?? {}).map(([k, v]) => [k, fromRow(v, row)] as const)
  );
}

/** The address of a picture a cell shows, or undefined for none. */
export function pictureSrc(
  node: string,
  from: 'files' | 'media',
  value: unknown
): string | undefined {
  if (from === 'files')
    return typeof value === 'string' && value !== ''
      ? `api/plugins/${seg(node)}/files/${seg(value)}`
      : undefined;
  const m = value as { data?: { $bytes?: unknown }; mime?: unknown; id?: unknown } | null;
  if (typeof m?.mime !== 'string') return undefined;
  if (typeof m.data?.$bytes === 'string') return `data:${m.mime};base64,${m.data.$bytes}`;
  return typeof m.id === 'string' && /^sha256:[0-9a-f]{64}$/u.test(m.id)
    ? `api/plugins/${seg(node)}/files/${seg(m.id.replace(':', '-'))}`
    : undefined;
}

/** A cell's picture, as a thumbnail that opens it whole; nothing for no picture. */
export function PictureCell(props: { src: string | undefined; alt: string }) {
  if (props.src === undefined) return null;
  return (
    <a href={props.src} target="_blank" rel="noreferrer">
      <img className="thumb" src={props.src} alt={props.alt} loading="lazy" />
    </a>
  );
}

/** The fields of an action's input the owner picks: those its row action does not give. */
export function ownerFields(
  input: JsonSchema | undefined,
  given: readonly string[]
): JsonSchema | undefined {
  if (input === undefined) return undefined;
  const object = deref(input, input);
  const props = object['properties'] as Record<string, JsonSchema> | undefined;
  if (props === undefined) return undefined;
  const left = Object.entries(props).filter(([k]) => !given.includes(k));
  if (left.length === 0) return undefined;
  const required = ((object['required'] ?? []) as string[]).filter((k) => !given.includes(k));
  return { type: 'object', properties: Object.fromEntries(left), required };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function RowActionButton(props: {
  node: string;
  action: RowAction;
  row: unknown;
  /** The row's name, for the button's label to a screen reader. */
  rowName: string;
  /** The node's actions, as the graph view describes them: the input's schema. */
  members: readonly MemberView[];
  /** Asks the page's reads again, after a run. */
  done?: (() => void) | undefined;
}) {
  const { node, action: a, row } = props;
  const member = props.members.find((m) => m.name === a.action);
  const owner = ownerFields(member?.input, Object.keys(a.input ?? {}));
  const preset = (): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(a.current ?? {}).flatMap(([k, ref]) => {
        const v = fromRow(ref, row);
        return v === undefined || v === null ? [] : [[k, v] as const];
      })
    );
  const [values, setValues] = useState<Record<string, unknown>>();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const run = (picked: Record<string, unknown>): void => {
    if (a.confirm !== undefined && !window.confirm(a.confirm)) return;
    setBusy(true);
    setSaid(undefined);
    api<unknown>(`/plugins/${seg(node)}/actions/${seg(a.action)}`, {
      ...picked,
      ...rowInput(a, row),
    })
      .then(
        (out) => {
          setSaid({ ok: true, text: out === null || out === undefined ? 'done' : words(out) });
          setValues(undefined);
          props.done?.();
        },
        (e: unknown) => setSaid({ ok: false, text: message(e) })
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="row-action">
      <button
        type="button"
        aria-label={`${a.label} ${props.rowName}`}
        aria-busy={busy}
        disabled={busy}
        onClick={() => {
          if (owner === undefined) run({});
          else setValues(values === undefined ? preset() : undefined);
        }}
      >
        {busy ? `${a.label}…` : a.label}
      </button>
      {owner === undefined || values === undefined ? null : (
        <div className="row-action-form">
          <SchemaForm
            legend={`${a.label} ${props.rowName}`}
            schema={owner}
            {...(member?.input === undefined ? {} : { root: member.input })}
            value={values}
            onChange={setValues}
            node={node}
          />
          <button type="button" disabled={busy} onClick={() => run(values)}>
            Run
          </button>{' '}
          <button type="button" className="link" onClick={() => setValues(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {said === undefined ? null : (
        <small role="status" className={said.ok ? 'said' : 'said error'}>
          {said.text}
        </small>
      )}
    </div>
  );
}
