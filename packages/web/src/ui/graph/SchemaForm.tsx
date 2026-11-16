/**
 * A form made from a JSON Schema (P11): the schemas a plugin declares in zod, as the core writes
 * them (`GET /available`, `GET /graph/view`). One field per property, by its type: a check box, a
 * number, a text, a choice of the enum's values, a nested group for an object, a list of strings or
 * numbers as rows with add and remove buttons, a record of plain values as rows of a key and a value
 * (`ListFields.tsx`, #9); anything else as JSON. An enum whose schema labels its values (`choices`,
 * a plugin's zod `.meta({ choices: { value: 'label' } })`, bot-os.md D127) is a radio button per
 * value, each by its label; a field whose schema says when it applies (`shownWhen: { key: value }`,
 * a sibling key's value, its default counted) is shown only then, and taken away from the value as
 * soon as a change makes it not apply, so that a list of a mode not chosen never lingers hidden. Each field shows its value, or the schema's default, unmarked (the editor fills a node's
 * config with its defaults, `defaults.ts`); its description, the schema's, is its help.
 *
 * Editable when given `onChange` (the editor's draft, D55): a field emptied (once left) is taken
 * away, so that its default holds; a key of `secretKeys` (a connector's `configSecrets`, bot-os-api.md §4.9) is a
 * choice of the secrets' names, never a value; `errors` are the check's, by key. Read-only without
 * it (an action's input). A key of `custom` is drawn by its own control (a chat, picked in the chat
 * picker, D96). Nothing here depends on the node's state, so a stopped node's form is as any other's
 * (D44).
 */
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import type { JsonSchema } from '#src/ui/api.ts';
import { plain } from './defaults.ts';
import type { Scalar } from './ListFields.tsx';
import { ListField, listItems, RecordField, recordValues } from './ListFields.tsx';

const show = (v: unknown): string => JSON.stringify(v, null, 2) ?? '';

/** An enum's labels, by value (`choices`), when its schema gives them. */
function choicesOf(schema: JsonSchema): Readonly<Record<string, string>> | undefined {
  const c = schema['choices'] ?? plain(schema)['choices'];
  return typeof c === 'object' && c !== null && !Array.isArray(c)
    ? (c as Record<string, string>)
    : undefined;
}

/**
 * Whether a property applies given its siblings' values (`shownWhen`), each sibling unset taken at
 * its default; always, when its schema does not say.
 */
function applies(
  schema: JsonSchema,
  value: Readonly<Record<string, unknown>> | undefined,
  properties: Readonly<Record<string, JsonSchema>>
): boolean {
  const when = schema['shownWhen'] ?? plain(schema)['shownWhen'];
  if (typeof when !== 'object' || when === null) return true;
  return Object.entries(when as Record<string, unknown>).every(([key, wanted]) => {
    const sibling = properties[key];
    const v =
      value?.[key] ??
      (sibling === undefined ? undefined : (sibling['default'] ?? plain(sibling)['default']));
    return v === wanted;
  });
}

/** One radio button per value of an enum, each by its label (`choices`). */
function Choices(props: {
  name: string;
  values: readonly unknown[];
  labels: Readonly<Record<string, string>>;
  value: unknown;
  set: ((v: unknown) => void) | undefined;
}) {
  const group = useId();
  return (
    <span className="choices" role="radiogroup" aria-label={props.name}>
      {props.values.map((o) => (
        <label key={String(o)} className="choice">
          <input
            type="radio"
            name={group}
            checked={props.value === o}
            disabled={props.set === undefined}
            onChange={(e) => {
              if (e.target.checked) props.set?.(o);
            }}
          />{' '}
          {props.labels[String(o)] ?? String(o)}
        </label>
      ))}
    </span>
  );
}

/** What a form needs to be edited, passed down to its nested groups. */
interface Editing {
  onChange: (value: Record<string, unknown>) => void;
  secretKeys: readonly string[];
  secretNames: readonly string[];
  errors: Record<string, string[]>;
  custom: Readonly<Record<string, CustomControl>>;
}

/** A field's own control, given its value and the way to set it (undefined: taken away). */
export type CustomControl = (value: unknown, set: (v: unknown) => void) => ReactNode;

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
  const custom = editing?.custom[name];
  const labels = choicesOf(props.schema);
  if (custom !== undefined && set !== undefined) control = custom(props.value, set);
  else if (enumOf !== undefined && labels !== undefined)
    control = <Choices name={name} values={enumOf} labels={labels} value={value} set={set} />;
  else if (editing?.secretKeys.includes(name) === true && set !== undefined) {
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
  else if (listItems(schema) !== undefined)
    control = (
      <ListField
        name={name}
        items={listItems(schema) as JsonSchema}
        value={value}
        fallback={fallback}
        set={set}
      />
    );
  else if (recordValues(schema) !== undefined)
    control = (
      <RecordField
        name={name}
        types={recordValues(schema) as Scalar[]}
        value={value}
        fallback={fallback}
        set={set}
      />
    );
  else control = <JsonField name={name} value={value} set={set} />;
  // A list's or a record's rows hold their own inputs, each labelled: no label around them all.
  const rows =
    listItems(schema) !== undefined ||
    recordValues(schema) !== undefined ||
    (enumOf !== undefined && labels !== undefined);
  return (
    <div className={`field${errors.length > 0 ? ' refused' : ''}`}>
      {(custom !== undefined && set !== undefined) || rows ? (
        // Its own control holds its inputs, each labelled: no label around them all.
        <div className="custom-field">
          <code>{name}</code>
          {props.required ? null : <span className="muted"> (optional)</span>}
          {control}
        </div>
      ) : (
        <label>
          <code>{name}</code>
          {props.required ? null : <span className="muted"> (optional)</span>}
          {control}
        </label>
      )}
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
  custom?: Readonly<Record<string, CustomControl>>;
  /** Keys drawn last, folded under "Tuning": fields a first setup leaves at their defaults. */
  folded?: readonly string[];
}) {
  const properties = (props.schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (props.schema['required'] ?? []) as string[];
  // A field that does not apply now (`shownWhen`) is not drawn.
  const all = Object.entries(properties).filter(([, s]) => applies(s, props.value, properties));
  const folded = all.filter(([name]) => props.folded?.includes(name) === true);
  const entries = all.filter(([name]) => props.folded?.includes(name) !== true);
  const onChange = props.onChange;
  const editing: Editing | undefined =
    onChange === undefined
      ? undefined
      : {
          onChange,
          secretKeys: props.secretKeys ?? [],
          secretNames: props.secretNames ?? [],
          errors: props.errors ?? {},
          custom: props.custom ?? {},
        };
  const setter = (name: string) =>
    onChange === undefined
      ? undefined
      : (v: unknown) => {
          const next: Record<string, unknown> = { ...props.value };
          if (v === undefined) delete next[name];
          else next[name] = v;
          // A field the change makes not apply goes: its value would hold unseen.
          for (const [key, s] of Object.entries(properties))
            if (key !== name && next[key] !== undefined && !applies(s, next, properties))
              delete next[key];
          onChange(next);
        };
  return (
    <fieldset className="schema">
      <legend>{props.legend}</legend>
      {entries.length === 0 && folded.length === 0 ? <p className="muted">nothing to set</p> : null}
      {entries.map(([name, schema]) => (
        <Field
          key={name}
          name={name}
          schema={schema}
          value={props.value?.[name]}
          required={required.includes(name)}
          set={setter(name)}
          editing={editing}
        />
      ))}
      {folded.length === 0 ? null : (
        <details className="tuning" aria-label={`${props.legend} tuning`}>
          <summary>Tuning</summary>
          {folded.map(([name, schema]) => (
            <Field
              key={name}
              name={name}
              schema={schema}
              value={props.value?.[name]}
              required={required.includes(name)}
              set={setter(name)}
              editing={editing}
            />
          ))}
        </details>
      )}
    </fieldset>
  );
}
