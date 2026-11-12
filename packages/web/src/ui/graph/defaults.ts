/**
 * A config filled with its schema's defaults (D55): each property left unset that has a `default`
 * takes it, as if the owner had typed it, so that a form shows every value in force and the graph
 * says it. An object property is filled within, from its own default (`{}` included) and its
 * children's: when it is given, has a default, or is required; an optional object with no default
 * is left out, not made. A value given is never changed.
 */
import type { JsonSchema } from '#src/ui/api.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const copy = <T>(v: T): T => structuredClone(v);

/** The schema of a value that may be null: its other branch. */
export function plain(schema: JsonSchema): JsonSchema {
  const options = (schema['anyOf'] ?? schema['oneOf']) as JsonSchema[] | undefined;
  return options?.find((o) => o['type'] !== 'null') ?? schema;
}

/** `value` with the defaults of `schema` (an object's) filled in where it leaves them unset. */
export function withDefaults(
  schema: JsonSchema | undefined,
  value: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  if (schema === undefined) return out;
  const object = plain(schema);
  const properties = (object['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (object['required'] ?? []) as string[];
  for (const [key, property] of Object.entries(properties)) {
    const given = out[key];
    const fallback = property['default'] ?? plain(property)['default'];
    const inner = plain(property);
    if (inner['type'] === 'object' && inner['properties'] !== undefined) {
      if (given !== undefined && !isRecord(given)) continue;
      const base = given ?? (isRecord(fallback) ? fallback : undefined);
      if (base === undefined && !required.includes(key)) continue;
      out[key] = withDefaults(inner, base === undefined ? undefined : copy(base));
    } else if (given === undefined && fallback !== undefined) out[key] = copy(fallback);
  }
  return out;
}
