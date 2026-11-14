/**
 * Dotted paths into an event's payload, as reactions (`react.ts`), queued sends' cancels (bot-os.md
 * D73) and command answers (`answers.ts`, D98) read them. Imports nothing, so that any module of the
 * core may use it.
 */

/** The value at a dotted path of a payload; undefined where a step is missing. */
export function valueAt(payload: unknown, path: string): unknown {
  let at: unknown = payload;
  for (const key of path.split('.')) {
    if (typeof at !== 'object' || at === null || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Whether every field of `when` is equal (`===`) to the payload's at its path. */
export function matches(payload: unknown, when: Readonly<Record<string, unknown>> = {}): boolean {
  return Object.entries(when).every(([path, value]) => valueAt(payload, path) === value);
}

/**
 * Whether every field of `when` holds of the payload (a queued send's cancel, bot-os.md D73): equal
 * to the value at its path, as `matches` asks, or, for a list there, among its items (a state's
 * `changed.sections` holding `inventory`).
 */
export function holds(payload: unknown, when: Readonly<Record<string, unknown>> = {}): boolean {
  return Object.entries(when).every(([path, value]) => {
    const at = valueAt(payload, path);
    return at === value || (Array.isArray(at) && at.includes(value));
  });
}
