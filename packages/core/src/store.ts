/**
 * Each plugin's state, in its own namespace (docs/bot-os-api.md §4.2, P6, P8): JSON documents by
 * name under `<data>/plugins/<id>/`, written atomically (a temporary file, flushed, then renamed),
 * so that a crash leaves the old document or the new one, never half of one. A name is a plain file
 * name, so no plugin reaches outside its directory.
 *
 * The schema version of a plugin's documents is kept with them (`_meta.json`). At start the core
 * migrates them from the kept version to the manifest's (the number of its migrations), on a staged
 * copy that replaces the store only once every step has succeeded: a failed migration leaves the
 * store as it was. `adopt` is for migrations only, to bring in a file of the data volume that
 * something kept before the plugin had a store (`/data/old-state.json`, `/data/img/chart.png`),
 * never one of the stores;
 * once the migration has succeeded, the file is renamed `<file>.migrated`, kept rather than deleted.
 *
 * Without a data directory the documents live in memory, for tests.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Store {
  /** A document, or undefined if there is none. */
  read<T = unknown>(name: string): T | undefined;
  write(name: string, value: unknown): void;
  remove(name: string): void;
  /** The documents' names, sorted; the core's own (`_…`) left out. */
  names(): string[];
}

export interface MigrationStore extends Store {
  /**
   * Brings `file`, a path relative to the data volume (`old-state.json`, `img/data.json`),
   * in as the document `name`; false if there is none. It is read as JSON, or by `read` from its
   * bytes (a PNG into a document).
   */
  adopt(file: string, name: string, read?: (bytes: Buffer) => unknown): boolean;
}

/** One step, from the version before it to the next. */
export type Migration = (store: MigrationStore) => void | Promise<void>;

/** A plugin's own documents, or the core's (`_meta`, `_restore`). */
const NAME = /^_?[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const META = '_meta';

function checkName(name: string, own = false): void {
  if (!NAME.test(name) || name.includes('..') || (!own && name.startsWith('_')))
    throw new Error(`not a document name: ${JSON.stringify(name)}`);
}

/** Where a set of documents lives: a directory, or memory. */
interface Backend {
  get(name: string): string | undefined;
  set(name: string, text: string): void;
  delete(name: string): void;
  list(): string[];
}

class DirBackend implements Backend {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private file(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }
  get(name: string): string | undefined {
    try {
      return fs.readFileSync(this.file(name), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  set(name: string, text: string): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(name);
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }
  delete(name: string): void {
    fs.rmSync(this.file(name), { force: true });
  }
  list(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }
}

class MemoryBackend implements Backend {
  readonly docs: Map<string, string>;
  constructor(docs = new Map<string, string>()) {
    this.docs = docs;
  }
  get(name: string): string | undefined {
    return this.docs.get(name);
  }
  set(name: string, text: string): void {
    this.docs.set(name, text);
  }
  delete(name: string): void {
    this.docs.delete(name);
  }
  list(): string[] {
    return [...this.docs.keys()];
  }
}

class BackendStore implements Store {
  readonly backend: Backend;
  constructor(backend: Backend) {
    this.backend = backend;
  }
  read<T = unknown>(name: string): T | undefined {
    checkName(name);
    return this.get(name) as T | undefined;
  }
  write(name: string, value: unknown): void {
    checkName(name);
    this.put(name, value);
  }
  remove(name: string): void {
    checkName(name);
    this.backend.delete(name);
  }
  names(): string[] {
    return this.backend
      .list()
      .filter((n) => !n.startsWith('_'))
      .sort();
  }
  /** Any document, the core's own included. */
  get(name: string): unknown {
    const text = this.backend.get(name);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`document ${name} is not JSON`);
    }
  }
  put(name: string, value: unknown): void {
    checkName(name, true);
    this.backend.set(name, `${JSON.stringify(value)}\n`);
  }
}

/** The stores of every plugin, under one data directory (or in memory). */
export class Stores {
  private readonly dataDir: string | undefined;
  private readonly memory = new Map<string, Map<string, string>>();

  constructor(dataDir?: string) {
    this.dataDir = dataDir;
  }

  /** Where a plugin's documents are, on disk. */
  dirOf(id: string): string | undefined {
    return this.dataDir === undefined ? undefined : path.join(this.dataDir, 'plugins', id);
  }

  /** A plugin's store. */
  open(id: string): Store {
    return this.internal(id);
  }

  /** The core's documents of a plugin (`_restore`), beside the plugin's own. */
  internal(id: string): BackendStore {
    const dir = this.dirOf(id);
    if (dir !== undefined) return new BackendStore(new DirBackend(dir));
    let docs = this.memory.get(id);
    if (docs === undefined) {
      docs = new Map();
      this.memory.set(id, docs);
    }
    return new BackendStore(new MemoryBackend(docs));
  }

  /** The version a plugin's documents are at: 0 for none. */
  version(id: string): number {
    const meta = this.internal(id).get(META) as { version?: unknown } | undefined;
    return typeof meta?.version === 'number' ? meta.version : 0;
  }

  /**
   * Runs the migrations from the version kept to the last, on a staged copy that replaces the store
   * once every one has succeeded. Throws, the store as it was, if one fails, or if the store is at
   * a version newer than the plugin knows.
   */
  async migrate(id: string, migrations: readonly Migration[]): Promise<void> {
    this.recover(id);
    const from = this.version(id);
    if (from === migrations.length) return;
    if (from > migrations.length)
      throw new Error(
        `its store is at version ${from}, newer than the ${migrations.length} it knows`
      );
    const dir = this.dirOf(id);
    const adopted: string[] = [];
    const staged = this.stage(id, dir);
    const store: MigrationStore = {
      read: <T>(name: string) => staged.read<T>(name),
      write: (name, value) => staged.write(name, value),
      remove: (name) => staged.remove(name),
      names: () => staged.names(),
      adopt: (file, name, read) => {
        if (this.dataDir === undefined) return false;
        if (
          path.isAbsolute(file) ||
          path.normalize(file) !== file ||
          file.split(/[\\/]/u).some((part) => part === '' || part.startsWith('.')) ||
          file.split(/[\\/]/u)[0] === 'plugins'
        )
          // Nothing outside the volume, and nothing of the stores: no plugin's state but its own.
          throw new Error(`not a file of the app of before the core: ${JSON.stringify(file)}`);
        const source = path.join(this.dataDir, file);
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(source);
        } catch {
          return false;
        }
        staged.write(
          name,
          read === undefined ? (JSON.parse(bytes.toString('utf8')) as unknown) : read(bytes)
        );
        adopted.push(source);
        return true;
      },
    };
    try {
      for (let v = from; v < migrations.length; v++) {
        const step = migrations[v] as Migration;
        try {
          await step(store);
        } catch (e) {
          throw new Error(
            `migration ${v} → ${v + 1} failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      staged.put(META, { version: migrations.length });
    } catch (e) {
      if (dir !== undefined) fs.rmSync(`${dir}.migrating`, { recursive: true, force: true });
      throw e;
    }
    this.commit(id, dir, staged);
    for (const source of adopted) fs.renameSync(source, `${source}.migrated`);
  }

  /**
   * A commit cut short by a crash, between moving the store aside and moving the staged copy in:
   * the store aside comes back, and the migration runs again from it.
   */
  private recover(id: string): void {
    const dir = this.dirOf(id);
    if (dir === undefined || fs.existsSync(dir) || !fs.existsSync(`${dir}.old`)) return;
    fs.renameSync(`${dir}.old`, dir);
  }

  /** A copy of a plugin's documents to migrate. */
  private stage(id: string, dir: string | undefined): BackendStore {
    if (dir === undefined) return new BackendStore(new MemoryBackend(new Map(this.memory.get(id))));
    const staging = `${dir}.migrating`;
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.cpSync(dir, staging, { recursive: true });
    else fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    return new BackendStore(new DirBackend(staging));
  }

  /** The staged copy in place of the store. */
  private commit(id: string, dir: string | undefined, staged: BackendStore): void {
    if (dir === undefined) {
      // In place: the stores opened before the migration (the settings') see what it made.
      const docs = this.memory.get(id) ?? new Map<string, string>();
      docs.clear();
      for (const [name, value] of (staged.backend as MemoryBackend).docs) docs.set(name, value);
      this.memory.set(id, docs);
      return;
    }
    const old = `${dir}.old`;
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, old);
    fs.renameSync(`${dir}.migrating`, dir);
    fs.rmSync(old, { recursive: true, force: true });
  }
}
