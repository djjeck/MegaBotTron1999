/**
 * A form made from a JSON Schema (P11): the schemas a plugin declares in zod, as the core writes
 * them (`GET /available`, `GET /graph/view`). One field per property, by its type: a check box, a
 * number, a text, a choice of the enum's values, a nested group for an object; anything else as
 * JSON. Each field shows its value, or the schema's default, unmarked (the editor fills a node's
 * config with its defaults, `defaults.ts`); its description, the schema's, is its help.
 *
 * Editable when given `onChange` (the editor's draft, D55): a field emptied (once left) is taken
 * away, so that its default holds; a key of `secretKeys` (a connector's `configSecrets`, bot-os-api.md §4.9) is a
 * choice of the secrets' names, never a value; `errors` are the check's, by key. Read-only without
 * it (an action's input). Nothing here depends on the node's state, so a killed node's form is as
 * any other's (D44).
 */
import { useState } from 'react';
import type { JsonSchema } from '#src/ui/api.ts';
import { plain } from './defaults.ts';

const show = (v: unknown): string => JSON.stringify(v, null, 2) ?? '';

/** What a form needs to be edited, passed down to its nested groups. */
interface Editing {
  onChange: (value: Record<string, unknown>) => void;
  secretKeys: readonly string[];
  secretNames: readonly string[];
  errors: Record<string, string[]>;
}

/** A value typed as JSON, kept as typed until it reads. */
function JsonField(props: {
  name: string;
  value: unknown;
  set: ((v: unknown) => void) | undefined;
}) {
  const [text, setText] = useState<string>();
  const [bad, setBad] = useState(false);
  const shown = text ?? (props.value === undefined ? '' : show(props.value));
  const set = props.set;
  if (set === undefined) return <textarea aria-label={props.name} value={shown} readOnly />;
  return (
    <>
      <textarea
        aria-label={props.name}
        value={shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text === undefined) return;
          if (text.trim() === '') {
            setBad(false);
            setText(undefined);
            set(undefined);
            return;
          }
          try {
            set(JSON.parse(text) as unknown);
            setBad(false);
            setText(undefined);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? <span className="error">not JSON: unchanged</span> : null}
    </>
  );
}

/**
 * A text or a number. Emptied, it stays empty while the owner types, and is taken away once left,
 * so that a default, filled back in, does not come back under their cursor.
 */
function TextField(props: {
  name: string;
  number: boolean;
  value: string;
  set: ((v: unknown) => void) | undefined;
}) {
  const [emptied, setEmptied] = useState(false);
  const { set } = props;
  return (
    <input
      aria-label={props.name}
      type={props.number ? 'number' : 'text'}
      value={emptied ? '' : props.value}
      readOnly={set === undefined}
      onChange={(e) => {
        const raw = e.target.value;
        setEmptied(raw === '');
        if (raw !== '') set?.(props.number ? Number(raw) : raw);
      }}
      onBlur={() => {
        if (!emptied) return;
        setEmptied(false);
        set?.(undefined);
      }}
    />
  );
}

function Field(props: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  set: ((v: unknown) => void) | undefined;
  editing: Editing | undefined;
}) {
  const { name, set, editing } = props;
  const schema = plain(props.schema);
  const type = schema['type'];
  const enumOf = schema['enum'] as unknown[] | undefined;
  const fallback = props.schema['default'] ?? schema['default'];
  const value = props.value !== undefined ? props.value : fallback;
  const description = (props.schema['description'] ?? schema['description']) as string | undefined;
  const errors = editing?.errors[name] ?? [];
  if (type === 'object' && schema['properties'] !== undefined)
    return (
      <div className="field">
        <SchemaForm
          legend={name}
          schema={schema}
          value={props.value as Record<string, unknown> | undefined}
          {...(set === undefined ? {} : { onChange: (v) => set(v) })}
        />
        {description === undefined ? null : <small className="muted">{description}</small>}
      </div>
    );
  let control;
  if (editing?.secretKeys.includes(name) === true && set !== undefined) {
    const names = [...editing.secretNames];
    if (typeof props.value === 'string' && !names.includes(props.value)) names.push(props.value);
    control = (
      <select
        aria-label={name}
        value={typeof props.value === 'string' ? props.value : ''}
        onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
      >
        <option value="">(no secret)</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    );
  } else if (enumOf !== undefined)
    control = (
      <select
        aria-label={name}
        value={String(value ?? '')}
        disabled={set === undefined}
        onChange={(e) =>
          set?.(e.target.value === '' ? undefined : enumOf[e.target.selectedIndex - 1])
        }
      >
        <option value="" />
        {enumOf.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  else if (type === 'boolean')
    control = (
      <input
        type="checkbox"
        aria-label={name}
        checked={value === true}
        disabled={set === undefined}
        onChange={(e) => set?.(e.target.checked)}
      />
    );
  else if (type === 'string' || type === 'number' || type === 'integer')
    control = (
      <TextField
        name={name}
        number={type !== 'string'}
        value={value === undefined ? '' : String(value)}
        set={set}
      />
    );
  else control = <JsonField name={name} value={value} set={set} />;
  return (
    <div className={`field${errors.length > 0 ? ' refused' : ''}`}>
      <label>
        <code>{name}</code>
        {props.required ? null : <span className="muted"> (optional)</span>}
        {control}
      </label>
      {description === undefined ? null : <small className="muted">{description}</small>}
      {errors.map((e) => (
        <small key={e} className="error">
          {e}
        </small>
      ))}
    </div>
  );
}

/** The fields of an object schema, with the values given (none: the defaults). */
export function SchemaForm(props: {
  legend: string;
  schema: JsonSchema;
  value?: Record<string, unknown> | undefined;
  onChange?: (value: Record<string, unknown>) => void;
  secretKeys?: readonly string[];
  secretNames?: readonly string[];
  errors?: Record<string, string[]>;
}) {
  const properties = (props.schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (props.schema['required'] ?? []) as string[];
  const entries = Object.entries(properties);
  const onChange = props.onChange;
  const editing: Editing | undefined =
    onChange === undefined
      ? undefined
      : {
          onChange,
          secretKeys: props.secretKeys ?? [],
          secretNames: props.secretNames ?? [],
          errors: props.errors ?? {},
        };
  const setter = (name: string) =>
    onChange === undefined
      ? undefined
      : (v: unknown) => {
          const next: Record<string, unknown> = { ...props.value };
          if (v === undefined) delete next[name];
          else next[name] = v;
          onChange(next);
        };
  return (
    <fieldset className="schema">
      <legend>{props.legend}</legend>
      {entries.length === 0 ? (
        <p className="muted">nothing to set</p>
      ) : (
        entries.map(([name, schema]) => (
          <Field
            key={name}
            name={name}
            schema={schema}
            value={props.value?.[name]}
            required={required.includes(name)}
            set={setter(name)}
            editing={editing}
          />
        ))
      )}
    </fieldset>
  );
}
