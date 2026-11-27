/**
 * A view's own leaves (docs/bot-os.md D170): a stat tile, and a form, which sets several fields at
 * once, an action's input or the node's live settings, and says how its sending went.
 */
import { useEffect, useState } from 'react';
import type { JsonSchema, MemberView, Tone, ViewForm, ViewLeaf } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import { deref } from '#src/ui/graph/MediaField.tsx';
import { SchemaForm } from '#src/ui/graph/SchemaForm.tsx';
import { ownerFields } from '#src/ui/graph/TableRow.tsx';
import { at, countOf, words } from '#src/ui/graph/widget-text.ts';
import { formatted, toneOf } from './cells.tsx';

type StatLeaf = ViewLeaf & { show: 'stat' };

/** A stat tile: its value, large and formatted, its label under it, a total beside it. */
export function StatTile(props: {
  leaf: StatLeaf;
  label: string;
  value: unknown;
  output: unknown;
}) {
  const { leaf } = props;
  const tone: Tone =
    leaf.tone ?? (leaf.tones === undefined ? 'neutral' : toneOf(props.value, leaf.tones));
  const total = typeof leaf.of === 'string' ? at(props.output, leaf.of) : leaf.of;
  // A list or a map: how many it holds.
  const value =
    typeof props.value === 'object' && props.value !== null ? countOf(props.value) : props.value;
  return (
    <div className={`stat tone-${tone}`}>
      <span className="stat-value">{formatted(value, leaf.format ?? 'text', leaf.unit)}</span>
      {total === undefined ? null : (
        <span className="stat-of muted">
          {' '}
          / {formatted(total, leaf.format ?? 'text', leaf.unit)}
        </span>
      )}
      <span className="stat-label">{props.label}</span>
    </div>
  );
}

/** How a form's sending went: not yet, under way, done (with its answer), or refused (why). */
type Sent =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; text: string }
  | { state: 'failed'; text: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Fields with every value changed from `was` to `now`. */
const changed = (was: Record<string, unknown>, now: Record<string, unknown>): string[] =>
  Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(was[k]));

/** A form that runs an action of its node: the fields it leaves the owner, preset from a read. */
export function ActionForm(props: {
  leaf: ViewForm;
  label: string;
  node: string;
  members: readonly MemberView[];
  /** Its input, `'$selector'` and `'$row.<path>'` filled in. */
  input: Record<string, unknown>;
  /** The values `current` reads, once read. */
  current: unknown;
  done: () => void;
}) {
  const { leaf } = props;
  const member = props.members.find((m) => m.name === leaf.action);
  const left = ownerFields(member?.input, Object.keys(props.input));
  const schema: JsonSchema | undefined =
    left === undefined || leaf.fields === undefined
      ? left
      : {
          ...left,
          properties: Object.fromEntries(
            Object.entries((left['properties'] ?? {}) as Record<string, JsonSchema>).filter(([k]) =>
              leaf.fields?.includes(k)
            )
          ),
        };
  const preset = (): Record<string, unknown> => {
    const v = props.current;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? { ...(v as Record<string, unknown>) }
      : {};
  };
  const [values, setValues] = useState<Record<string, unknown>>(preset);
  const [touched, setTouched] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: 'idle' });
  // The read it is preset from answers later: its values, until the owner changes one.
  const currentText = JSON.stringify(props.current) ?? '';
  useEffect(() => {
    if (!touched) setValues(preset());
  }, [currentText]);
  const send = (): void => {
    if (leaf.confirm !== undefined && !window.confirm(leaf.confirm)) return;
    setSent({ state: 'busy' });
    api<unknown>(
      `/plugins/${encodeURIComponent(props.node)}/actions/${encodeURIComponent(leaf.action ?? '')}`,
      {
        ...values,
        ...props.input,
      }
    ).then(
      (out) => {
        setSent({ state: 'done', text: out === null || out === undefined ? 'Done.' : words(out) });
        setTouched(false);
        props.done();
      },
      (e: unknown) => setSent({ state: 'failed', text: message(e) })
    );
  };
  return (
    <form
      className="view-form"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {schema === undefined ? null : (
        <SchemaForm
          legend={props.label}
          schema={schema}
          {...(member?.input === undefined ? {} : { root: deref(member.input, member.input) })}
          value={values}
          onChange={(v) => {
            setTouched(true);
            setValues(v);
          }}
          node={props.node}
        />
      )}
      <FormFoot submit={leaf.submit ?? 'Send'} sent={sent} />
    </form>
  );
}

/** A form that sets its node's live settings: each one changed, by its name. */
export function SettingsForm(props: {
  leaf: ViewForm;
  label: string;
  node: string;
  /** The node's settings' JSON Schema. */
  schema: JsonSchema | undefined;
  loggedOut: () => void;
}) {
  const keys = props.leaf.settings ?? [];
  const [names, setNames] = useState<Record<string, string>>({});
  const [was, setWas] = useState<Record<string, unknown>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [sent, setSent] = useState<Sent>({ state: 'idle' });
  const load = (): void => {
    api<Record<string, unknown>>('/settings').then(
      (all) => {
        const named: Record<string, string> = {};
        const now: Record<string, unknown> = {};
        for (const k of keys) {
          const name = Object.hasOwn(all, `${props.node}.${k}`) ? `${props.node}.${k}` : k;
          named[k] = name;
          now[k] = all[name];
        }
        setNames(named);
        setWas(now);
        setValues(now);
      },
      (e: unknown) => setSent({ state: 'failed', text: message(e) })
    );
  };
  useEffect(load, [props.node, keys.join('\n')]);
  const properties = (props.schema?.['properties'] ?? {}) as Record<string, JsonSchema>;
  const schema: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(
      keys.flatMap((k) => (properties[k] === undefined ? [] : [[k, properties[k]]]))
    ),
  };
  const send = (): void => {
    if (props.leaf.confirm !== undefined && !window.confirm(props.leaf.confirm)) return;
    const todo = changed(was, values);
    if (todo.length === 0) {
      setSent({ state: 'done', text: 'Nothing changed.' });
      return;
    }
    setSent({ state: 'busy' });
    todo
      .reduce<Promise<unknown>>(
        (p, k) => p.then(() => api('/settings', { key: names[k] ?? k, value: values[k] })),
        Promise.resolve()
      )
      .then(
        () => {
          setSent({ state: 'done', text: `Set ${todo.join(', ')}.` });
          load();
        },
        (e: unknown) => {
          setSent({ state: 'failed', text: message(e) });
          load();
        }
      );
  };
  return (
    <form
      className="view-form"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <SchemaForm
        legend={props.label}
        schema={schema}
        value={values}
        onChange={setValues}
        node={props.node}
      />
      <FormFoot submit={props.leaf.submit ?? 'Save'} sent={sent} />
    </form>
  );
}

/** A form's button, and how its sending went. */
function FormFoot(props: { submit: string; sent: Sent }) {
  const { sent } = props;
  return (
    <p className="form-foot">
      <button type="submit" aria-busy={sent.state === 'busy'} disabled={sent.state === 'busy'}>
        {sent.state === 'busy' ? `${props.submit}…` : props.submit}
      </button>{' '}
      {sent.state === 'done' ? (
        <span className="ok small" role="status">
          {sent.text}
        </span>
      ) : sent.state === 'failed' ? (
        <span className="error small" role="alert">
          {sent.text}
        </span>
      ) : null}
    </p>
  );
}
