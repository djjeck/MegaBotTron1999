/**
 * Importing from an older MegaBotTron1999 data directory (docs/bot-os-api.md §8, bot-os.md D54):
 * the volume of a deployment from before the graph lived in the volume, mounted read-only
 * (`LEGACY_DIR`, `/legacy` by default). Nothing here ever writes to it.
 *
 * Its layout: each plugin's store in `plugins/<id>/` (documents `<name>.json`, beside the core's
 * `_meta.json`, `_timers.json`, `_settings.json` and `_restore.json`), the core's own in
 * `plugins/core/` (`modes.json`, every plugin's mode; `power.json`; `secrets/`), and the event log
 * at its root, a file per UTC day (`events-<day>.jsonl`).
 *
 * - A store is imported into a fresh instance (`instances/<id>/`, §2.2), of the plugin a node will
 *   run on it, copied whole, so that its documents, version, timers and settings come with it. Its
 *   mode is not: the instance starts `read-only`, or in its node's `mode` (P10).
 * - The event log is merged into this instance's, day by day, a record already there not added
 *   twice; a table of type names renames the records written before types were namespaced
 *   (`{"message": "dice.message"}`), and a record whose type is still not namespaced is left out,
 *   counted by type.
 *
 * Nothing in here knows of any game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { InstanceRegistry } from './instance-registry.ts';
import { PLUGIN_ID } from './manifest.ts';
import { isMode, type Mode } from './outbox.ts';
import { INSTANCES_DIR, Stores } from './store.ts';

/** Where an older data directory is mounted, by default. */
export const LEGACY_DIR = '/legacy';

const DAY_FILE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const DOCUMENT = /^_?[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
const NAMESPACED = /^[a-z][a-z0-9-]*\.[A-Za-z0-9._-]+$/u;

/** An import refused, with why. */
export class LegacyError extends Error {
  /** The HTTP status that says it: 404 with no directory, 409 for a clash, 400 otherwise. */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A store of the older directory, as offered for import. */
export interface LegacyStore {
  /** Its plugin's id there (its directory's name). */
  id: string;
  /** Its documents, the core's own (`_…`) left out. */
  documents: string[];
  /** Its schema version, its timers' names, and whether it keeps settings. */
  version: number;
  timers: string[];
  settings: boolean;
  /** The mode it had there, for the owner to set again; never imported. */
  mode?: Mode;
}

/** What the older directory offers. */
export interface LegacyReport {
  dir: string;
  stores: LegacyStore[];
  /** Its event log: how many days, from which to which. */
  events: { days: number; first?: string; last?: string };
}

export interface LegacyOptions {
  /** The older directory, read only. */
  dir: string;
  /** This instance's data directory: its instances, and its event log. */
  dataDir: string;
  /** The time now, for a new instance's record. */
  now: () => number;
  /** The plugins this instance offers, by id: an import is for one of them. */
  plugins: () => readonly string[];
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/** An older directory's stores and event log, imported into this instance. */
export class LegacyImport {
  private readonly o: LegacyOptions;
  private readonly stores: Stores;
  private readonly registry: InstanceRegistry;

  constructor(o: LegacyOptions) {
    this.o = o;
    this.stores = new Stores(o.dataDir);
    this.registry = new InstanceRegistry(this.stores, o.now);
  }

  /** Whether an older directory is mounted there. */
  mounted(): boolean {
    try {
      return fs.statSync(this.o.dir).isDirectory();
    } catch {
      return false;
    }
  }

  private need(): void {
    if (!this.mounted())
      throw new LegacyError(`no older data directory is mounted at ${this.o.dir}`, 404);
  }

  /** The stores and the event log the older directory offers. */
  report(): LegacyReport {
    this.need();
    const plugins = path.join(this.o.dir, 'plugins');
    const modes = readJson(path.join(plugins, 'core', 'modes.json')) as
      Record<string, unknown> | undefined;
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(plugins, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    const stores = dirs
      .filter((d) => d.isDirectory() && d.name !== 'core' && PLUGIN_ID.test(d.name))
      .map((d) => d.name)
      .sort()
      .map((id): LegacyStore => {
        const files = this.files(id);
        const meta = readJson(path.join(plugins, id, '_meta.json')) as { version?: unknown };
        const timers = readJson(path.join(plugins, id, '_timers.json'));
        const mode = modes?.[id];
        return {
          id,
          documents: files
            .filter((f) => !f.startsWith('_'))
            .map((f) => f.slice(0, -'.json'.length)),
          version: typeof meta?.version === 'number' ? meta.version : 0,
          timers: typeof timers === 'object' && timers !== null ? Object.keys(timers).sort() : [],
          settings: files.includes('_settings.json'),
          ...(isMode(mode) ? { mode } : {}),
        };
      });
    const days = this.days();
    return {
      dir: this.o.dir,
      stores,
      events: {
        days: days.length,
        ...(days.length === 0 ? {} : { first: days[0] as string, last: days.at(-1) as string }),
      },
    };
  }

  /** A store's files to copy: its JSON documents, plain files only, sorted. */
  private files(id: string): string[] {
    const dir = path.join(this.o.dir, 'plugins', id);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && DOCUMENT.test(d.name))
      .map((d) => d.name)
      .sort();
  }

  /** The days of its event log, sorted. */
  private days(): string[] {
    return fs
      .readdirSync(this.o.dir)
      .map((f) => DAY_FILE.exec(f)?.[1])
      .filter((d) => d !== undefined)
      .sort();
  }

  /**
   * Copies the store `from` into a fresh instance (`instance`, `from` by default) of `plugin`
   * (`from` by default), which a node then names. Refused for a store not there, an instance kept
   * already, or a plugin this instance does not offer.
   */
  importStore(request: unknown): { instance: string; plugin: string; documents: string[] } {
    this.need();
    const r = (typeof request === 'object' && request !== null ? request : {}) as Record<
      string,
      unknown
    >;
    const from = r['from'];
    if (typeof from !== 'string' || !PLUGIN_ID.test(from) || from === 'core')
      throw new LegacyError('give the store to import: {"from": "<its id>"}');
    const instance = r['instance'] ?? from;
    const plugin = r['plugin'] ?? from;
    if (typeof instance !== 'string' || !PLUGIN_ID.test(instance) || instance === 'core')
      throw new LegacyError('an instance is named in lower-case words and dashes');
    if (typeof plugin !== 'string' || !this.o.plugins().includes(plugin))
      throw new LegacyError(`this instance offers no plugin ${String(plugin)}`);
    const source = path.join(this.o.dir, 'plugins', from);
    let isDir = false;
    try {
      isDir = fs.lstatSync(source).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new LegacyError(`${this.o.dir} has no store ${from}`, 404);
    if (this.stores.ids().includes(instance))
      throw new LegacyError(`the instance ${instance} exists already`, 409);
    const target = this.stores.dirOf(instance) as string;
    const staging = path.join(this.o.dataDir, INSTANCES_DIR, `.importing-${instance}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const files = this.files(from);
    for (const f of files) {
      fs.copyFileSync(path.join(source, f), path.join(staging, f));
      fs.chmodSync(path.join(staging, f), 0o600);
    }
    fs.renameSync(staging, target);
    this.registry.touch(instance, plugin);
    return {
      instance,
      plugin,
      documents: files.filter((f) => !f.startsWith('_')).map((f) => f.slice(0, -'.json'.length)),
    };
  }

  /**
   * Merges the older event log into this instance's, day by day: each record once, its type
   * renamed by `types` (old → namespaced), from the day of `since` (ms) on. A record whose type is
   * not namespaced, renamed or not, is left out and counted by its type.
   */
  importEvents(request: unknown): {
    days: number;
    imported: number;
    present: number;
    skipped: Record<string, number>;
  } {
    this.need();
    const r = (typeof request === 'object' && request !== null ? request : {}) as Record<
      string,
      unknown
    >;
    const types = (r['types'] ?? {}) as Record<string, unknown>;
    if (typeof types !== 'object' || Array.isArray(types))
      throw new LegacyError('types is a table of old names to new ones');
    for (const [old, renamed] of Object.entries(types))
      if (typeof renamed !== 'string' || !NAMESPACED.test(renamed))
        throw new LegacyError(`types: ${old} → ${String(renamed)}: expected <namespace>.<name>`);
    const since = r['since'];
    if (since !== undefined && typeof since !== 'number')
      throw new LegacyError('since is a time, in ms');
    const fromDay = since === undefined ? '' : new Date(since).toISOString().slice(0, 10);
    const out = { days: 0, imported: 0, present: 0, skipped: {} as Record<string, number> };
    fs.mkdirSync(this.o.dataDir, { recursive: true });
    for (const day of this.days().filter((d) => d >= fromDay)) {
      const name = `events-${day}.jsonl`;
      const target = path.join(this.o.dataDir, name);
      let mine: string[] = [];
      try {
        mine = fs
          .readFileSync(target, 'utf8')
          .split('\n')
          .filter((l) => l !== '');
      } catch {
        mine = [];
      }
      const known = new Set(mine);
      const added: string[] = [];
      for (const line of fs.readFileSync(path.join(this.o.dir, name), 'utf8').split('\n')) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof record !== 'object' || record === null || typeof record['t'] !== 'number')
          continue;
        const old = String(record['type']);
        const type = Object.hasOwn(types, old) ? (types[old] as string) : old;
        if (!NAMESPACED.test(type)) {
          out.skipped[old] = (out.skipped[old] ?? 0) + 1;
          continue;
        }
        const text = JSON.stringify({ ...record, type });
        if (known.has(text)) {
          out.present++;
          continue;
        }
        known.add(text);
        added.push(text);
      }
      out.days++;
      if (added.length === 0) continue;
      out.imported += added.length;
      const time = (l: string): number => {
        try {
          return (JSON.parse(l) as { t?: number }).t ?? 0;
        } catch {
          return 0;
        }
      };
      const merged = [...mine, ...added].sort((a, b) => time(a) - time(b));
      fs.writeFileSync(`${target}.tmp`, `${merged.join('\n')}\n`);
      fs.renameSync(`${target}.tmp`, target);
    }
    return out;
  }
}
