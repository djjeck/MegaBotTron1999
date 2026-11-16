/**
 * Sensitive config fields (docs/bot-os-api.md §2.1, bot-os.md D124): the keys of a node's config its
 * plugin's manifest marks `configSensitive` hold a value never shown back. In the graph's file (and
 * every version of its history) such a value is sealed (`Sealer`, under `bot_os_key`); the running
 * node gets it opened, in memory only; and every view of a graph that leaves the core (its JSON, its
 * text, its diffs, its check, its history, the editor's node views) shows it as `HIDDEN`, through one
 * function, `hideSensitive`. The editor sends `HIDDEN` back for a value it did not change, which the
 * core takes from the saved file (`openSensitive`'s `previous`).
 */
import { isSealed, type Sealer, SealError } from './secrets.ts';

/** What every view shows of a sensitive value that is set: never the value. */
export const HIDDEN = Object.freeze({ $sensitive: 'set' });
/** How a graph's text prints a sensitive value. */
export const SENSITIVE_TEXT = '[sensitive]';

/** Whether a value is `HIDDEN`, as the editor sends back a value it left as it was. */
export const isHidden = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>)['$sensitive'] === 'set';

/** A sensitive value in any form (hidden, sealed): what a graph's text prints as `[sensitive]`. */
export const isSensitiveForm = (v: unknown): boolean => isHidden(v) || isSealed(v);

/** The sensitive config keys of a node of a plugin, by its id; none for a plugin not offered. */
export type SensitiveKeys = (plugin: string) => readonly string[];

/** What a sealed sensitive value is bound to: its config key, so that a node renamed keeps it. */
const contextOf = (key: string): string => `config.${key}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Each node's sensitive config values changed as `f` says (undefined: the key taken out); the
 * graph otherwise as it is, whatever its shape (a graph the check would refuse too).
 */
function mapSensitive(
  raw: unknown,
  keysOf: SensitiveKeys,
  f: (value: unknown, key: string, node: Record<string, unknown>) => unknown
): unknown {
  if (!isRecord(raw) || !Array.isArray(raw['nodes'])) return raw;
  let changed = false;
  const nodes = (raw['nodes'] as unknown[]).map((n) => {
    if (!isRecord(n) || typeof n['plugin'] !== 'string' || !isRecord(n['config'])) return n;
    const keys = keysOf(n['plugin']).filter(
      (k) => (n['config'] as object)[k as never] !== undefined
    );
    if (keys.length === 0) return n;
    const config: Record<string, unknown> = { ...n['config'] };
    for (const key of keys) {
      const v = f(config[key], key, n);
      if (v === undefined) delete config[key];
      else config[key] = v;
    }
    changed = true;
    return { ...n, config };
  });
  return changed ? { ...raw, nodes } : raw;
}

/**
 * The shared redaction (D124): a graph with every sensitive config value, in clear, sealed or
 * hidden, shown as `HIDDEN`. Every view of a graph that leaves the core goes through it.
 */
export function hideSensitive<T>(raw: T, keysOf: SensitiveKeys): T {
  return mapSensitive(raw, keysOf, () => ({ ...HIDDEN })) as T;
}

/** A graph to write to the file: each sensitive value in clear sealed (none without the key). */
export function sealSensitive<T>(raw: T, keysOf: SensitiveKeys, sealer: Sealer | undefined): T {
  if (sealer?.available !== true) return raw;
  return mapSensitive(raw, keysOf, (v, key) =>
    isSealed(v) || isHidden(v) ? v : sealer.seal(v, contextOf(key))
  ) as T;
}

/**
 * A graph as the core runs it: each sealed value opened, each `HIDDEN` one taken from `previous`
 * (the saved graph, by node id and key), each in clear kept; every value remembered as a secret.
 * One that does not open, or a `HIDDEN` one with nothing behind it, is taken out, with why.
 */
export function openSensitive(
  raw: unknown,
  keysOf: SensitiveKeys,
  sealer: Sealer | undefined,
  previous?: unknown
): { raw: unknown; warnings: string[] } {
  const warnings: string[] = [];
  const before = new Map<unknown, Record<string, unknown>>();
  if (isRecord(previous) && Array.isArray(previous['nodes']))
    for (const n of previous['nodes'] as unknown[])
      if (isRecord(n) && isRecord(n['config'])) before.set(n['id'], n['config']);
  const open = (v: unknown, key: string, id: unknown): unknown => {
    if (!isSealed(v)) {
      sealer?.rememberAll(v);
      return v;
    }
    try {
      if (sealer === undefined) throw new SealError('there is no key to open it');
      return sealer.open(v, contextOf(key));
    } catch (e) {
      if (!(e instanceof SealError)) throw e;
      warnings.push(
        `node ${String(id)}: config ${key}: its sealed value does not open (${e.message})`
      );
      return undefined;
    }
  };
  const out = mapSensitive(raw, keysOf, (v, key, node) => {
    if (!isHidden(v)) return open(v, key, node['id']);
    const kept = before.get(node['id'])?.[key];
    if (kept === undefined || isHidden(kept)) {
      warnings.push(
        `node ${String(node['id'])}: config ${key}: no value saved to keep: set it again`
      );
      return undefined;
    }
    return open(kept, key, node['id']);
  });
  return { raw: out, warnings };
}
