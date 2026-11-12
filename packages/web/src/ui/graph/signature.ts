/**
 * An interface member's signature in words, for the node panel's list of what an interface output
 * offers (bot-os.md D71): its JSON Schemas (as the core writes its zod schemas) as a TypeScript-like
 * type, `actions.sent({ chat: string, id?: string, t: number })` or `state.rest() → { until: number,
 * why: string }`. What a schema leaves open is `unknown`; nesting past a few levels is `{…}`.
 */
import type { JsonSchema, MemberView } from '#src/ui/api.ts';

const DEPTH = 3;

/** A JSON Schema as a type: `string`, `{ a: number, b?: string }`, `"x" | "y"`, `number[]`. */
export function typeText(schema: JsonSchema | undefined, depth = 0): string {
  if (schema === undefined) return 'unknown';
  if ('const' in schema) return JSON.stringify(schema['const']);
  const choices = (schema['anyOf'] ?? schema['oneOf']) as unknown[] | undefined;
  if (Array.isArray(schema['enum']))
    return (schema['enum'] as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(choices))
    return choices.map((c) => typeText(c as JsonSchema, depth)).join(' | ');
  const type = schema['type'];
  if (type === 'array') return `${typeText(schema['items'] as JsonSchema | undefined, depth)}[]`;
  if (type === 'object') {
    const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    const keys = Object.keys(props);
    if (keys.length === 0) return 'object';
    if (depth >= DEPTH) return '{…}';
    const required = (schema['required'] ?? []) as string[];
    const fields = keys.map(
      (k) => `${k}${required.includes(k) ? '' : '?'}: ${typeText(props[k], depth + 1)}`
    );
    return `{ ${fields.join(', ')} }`;
  }
  if (type === 'integer') return 'number';
  return typeof type === 'string' ? type : 'unknown';
}

/**
 * A member as called: a read `state.<name>() → <output>`, an action `actions.<name>(<input>)`, with
 * `→ <output>` when it returns something.
 */
export function signature(qualified: string, m: MemberView): string {
  const input = m.input === undefined ? '' : typeText(m.input);
  return `${qualified}(${input})${m.output === undefined ? '' : ` → ${typeText(m.output)}`}`;
}
