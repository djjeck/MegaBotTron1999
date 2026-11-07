/**
 * A form made from a JSON Schema (P11): the schemas a plugin declares in zod, as the core writes
 * them (`GET /graph/view`). One field per property, by its type: a check box, a number, a text, a
 * choice of the enum's values, a nested group for an object; anything else as JSON. Each field
 * shows its value, or the schema's default, marked as such.
 *
 * Read-only for now: the editor makes the same fields editable. Nothing here depends on
 * the node's state, so a killed node's form is as any other's (D44).
 */
import type { JsonSchema } from '#src/ui/api.ts';

const show = (v: unknown): string => JSON.stringify(v, null, 2) ?? '';

/** The schema of a value that may be null: its other branch. */
function plain(schema: JsonSchema): JsonSchema {
  const options = (schema['anyOf'] ?? schema['oneOf']) as JsonSchema[] | undefined;
  return options?.find((o) => o['type'] !== 'null') ?? schema;
}

function Field(props: { name: string; schema: JsonSchema; value: unknown; required: boolean }) {
  const schema = plain(props.schema);
  const type = schema['type'];
  const enumOf = schema['enum'] as unknown[] | undefined;
  const fallback = props.schema['default'] ?? schema['default'];
  const given = props.value !== undefined;
  const value = given ? props.value : fallback;
  const description = (props.schema['description'] ?? schema['description']) as string | undefined;
  if (type === 'object' && schema['properties'] !== undefined)
    return (
      <SchemaForm
        legend={props.name}
        schema={schema}
        value={value as Record<string, unknown> | undefined}
      />
    );
  let control;
  if (enumOf !== undefined)
    control = (
      <select aria-label={props.name} value={String(value ?? '')} disabled>
        <option value="" />
        {enumOf.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  else if (type === 'boolean')
    control = <input type="checkbox" aria-label={props.name} checked={value === true} disabled />;
  else if (type === 'string' || type === 'number' || type === 'integer')
    control = (
      <input
        aria-label={props.name}
        type={type === 'string' ? 'text' : 'number'}
        value={value === undefined ? '' : String(value)}
        readOnly
      />
    );
  else
    control = (
      <textarea aria-label={props.name} value={value === undefined ? '' : show(value)} readOnly />
    );
  return (
    <div className="field">
      <label>
        <code>{props.name}</code>
        {props.required ? null : <span className="muted"> (optional)</span>}
        {control}
      </label>
      {!given && fallback !== undefined ? <span className="muted">default</span> : null}
      {description === undefined ? null : <small className="muted">{description}</small>}
    </div>
  );
}

/** The fields of an object schema, with the values given (none: the defaults). */
export function SchemaForm(props: {
  legend: string;
  schema: JsonSchema;
  value?: Record<string, unknown> | undefined;
}) {
  const properties = (props.schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (props.schema['required'] ?? []) as string[];
  const entries = Object.entries(properties);
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
          />
        ))
      )}
    </fieldset>
  );
}
