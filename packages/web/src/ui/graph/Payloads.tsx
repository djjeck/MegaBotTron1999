/**
 * What an events edge carries (#3): each event type with its payload's fields, by dotted path and
 * type (`outcome.item: string`), from the JSON Schema the core gives with it (`types[].schema`,
 * bot-os.md D74), so that a reactor's `when` and `send` paths (`{outcome.item}`) are written against
 * it. Shown in an events edge's panel, in the panel of the node it enters, and, in one line each, in
 * the title of the edge's rhombus (`payloadLine`).
 */
import type { EventTypeView, JsonSchema, PortView } from '#src/ui/api.ts';
import { typeText } from './signature.ts';

/** How deep a payload's objects are opened into paths; deeper ones are shown as their type. */
const DEPTH = 3;

/** A payload's field: its dotted path, its type in words, and whether it may be missing. */
export interface PayloadField {
  path: string;
  type: string;
  optional: boolean;
}

/** A payload schema's fields by dotted path: an object's opened into its own, a list's not. */
export function payloadFields(
  schema: JsonSchema | undefined,
  prefix = '',
  depth = 0
): PayloadField[] {
  const props = (schema?.['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (schema?.['required'] ?? []) as string[];
  return Object.entries(props).flatMap(([key, s]) => {
    const path = `${prefix}${key}`;
    const optional = !required.includes(key);
    const inner = s['properties'] as Record<string, JsonSchema> | undefined;
    if (
      s['type'] === 'object' &&
      inner !== undefined &&
      Object.keys(inner).length > 0 &&
      depth < DEPTH
    )
      return payloadFields(s, `${path}.`, depth + 1).map((f) => ({
        ...f,
        optional: f.optional || optional,
      }));
    return [{ path, type: typeText(s), optional }];
  });
}

/** An event type and its payload in one line: `dice.roll { value: number, who: string }`. */
export const payloadLine = (t: EventTypeView): string =>
  `${t.type} ${t.schema === undefined ? '(payload not described)' : typeText(t.schema)}`;

/** The event types given, each with its payload's fields. */
export function Payloads(props: { types: readonly EventTypeView[] }) {
  if (props.types.length === 0) return <p className="muted">no event type</p>;
  return (
    <ul className="payloads">
      {props.types.map((t) => {
        const fields = payloadFields(t.schema);
        return (
          <li key={t.type}>
            <code>{t.type}</code>
            {t.help === undefined ? null : <span className="muted"> — {t.help}</span>}
            {t.schema === undefined ? (
              <span className="muted"> (payload not described)</span>
            ) : fields.length === 0 ? (
              <span className="muted"> (no field)</span>
            ) : (
              <ul aria-label={`payload of ${t.type}`}>
                {fields.map((f) => (
                  <li key={f.path}>
                    <code>
                      {f.path}
                      {f.optional ? '?' : ''}: {f.type}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The event types an events input hears of those its edges carry: all of them, or the one its
 * node's config names when the key its namespace comes from names a type (the reactor's `on`,
 * `dice.roll`, rather than a namespace).
 */
export function heardTypes(
  types: readonly EventTypeView[],
  input: PortView | undefined,
  config: Readonly<Record<string, unknown>> | undefined
): EventTypeView[] {
  const key = input?.type === 'events' ? input.config : undefined;
  const named = key === undefined ? undefined : config?.[key];
  return typeof named === 'string' && named.includes('.')
    ? types.filter((t) => t.type === named)
    : [...types];
}
