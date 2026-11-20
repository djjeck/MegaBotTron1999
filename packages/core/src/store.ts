/**
 * Each plugin instance's state, in its own namespace (docs/bot-os-api.md §4.2, P6, P8): JSON
 * documents by name under `<data>/instances/<instance>/` (the core's own under `<data>/core/`),
 * written atomically (a temporary file, flushed, then renamed),
 * so that a crash leaves the old document or the new one, never half of one. A name is a plain file
 * name, so no plugin reaches outside its directory.
 *
 * The schema version of a plugin's documents is kept with them (`_meta.json`). At start the core
 * migrates them from the kept version to the manifest's (the number of its migrations), on a staged
 * copy that replaces the store only once every step has succeeded: a failed migration leaves the
 * store as it was.
 *
 * Beside its documents, a plugin keeps files (`files`, bot-os.md D149): bytes by name under
 * `<instance>/files/`, each written atomically as a document is, mode 600, its media type and when
 * it was written kept beside it (`files/.meta/<name>.json`). A file over the size a file may have,
 * or that would take the instance's files past their total, is refused with why. A migration's
 * staged copy hard-links the files rather than copying them: every write replaces a file by a
 * rename, never in place, so the store's own files stay as they were whatever the migration does.
 *
 * Without a data directory the documents and the files live in memory, for tests.
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
  /** Its files: bytes by name, beside the documents (D149). */
  readonly files: StoreFiles;
}

/** A file a plugin keeps, as `files.list()` describes it. */
export interface StoreFileInfo {
  name: string;
  /** Its size, in bytes. */
  size: number;
  /** Its media type: the one written with it, or guessed from its name's extension. */
  type: string;
  /** When it was written, in milliseconds on the core's clock. */
  written: number;
}

/** A plugin's files (bot-os-api.md §4.2, D149). */
export interface StoreFiles {
  /**
   * Keeps `bytes` as `name` (a document's rules: no path), replacing a file of that name,
   * atomically. `type` is its media type (`image/png`); none, guessed from the name's extension.
   * Throws, with why, past the limits (`FileLimitError`), or for a bad name or type.
   */
  write(name: string, bytes: Uint8Array, options?: { type?: string }): void;
  /** A file's bytes, or undefined if there is none. */
  read(name: string): Uint8Array | undefined;
  /** Each file, by name. */
  list(): StoreFileInfo[];
  delete(name: string): void;
}

/** How much a plugin instance's files may take, in bytes. */
export interface FileLimits {
  /** A file. */
  file: number;
  /** All of an instance's files together. */
  total: number;
}

const MB = 2 ** 20;

/** The core's limits (D149): 16 MB a file, 256 MB an instance; a deployment sets its own. */
export const DEFAULT_FILE_LIMITS: FileLimits = { file: 16 * MB, total: 256 * MB };

/** A file refused for its size. */
export class FileLimitError extends Error {}

/** The directory of an instance's files, in its store. */
export const FILES_DIR = 'files';

/** What a migration works on: a staged copy of the plugin's store. */
export type MigrationStore = Store;

/** One step, from the version before it to the next. */
export type Migration = (store: MigrationStore) => void | Promise<void>;

/** A plugin's own documents, or the core's (`_meta`, `_restore`). */
const NAME = /^_?[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const META = '_meta';

function checkName(name: string, own = false): void {
  if (!NAME.test(name) || name.includes('..') || (!own && name.startsWith('_')))
    throw new Error(`not a document name: ${JSON.stringify(name)}`);
}

/** The longest name of a file: room left in a file system's 255 for what the core adds to it. */
const MAX_FILE_NAME = 200;

function checkFileName(name: string): void {
  if (
    !NAME.test(name) ||
    name.includes('..') ||
    name.startsWith('_') ||
    name.length > MAX_FILE_NAME
  )
    throw new Error(`not a file name: ${JSON.stringify(name)}`);
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;

const OCTETS = 'application/octet-stream';

/** The media types guessed from a name's extension; any other, `application/octet-stream`. */
const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
};

/** A file's media type, guessed from its name's extension. */
export function guessType(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot < 0 ? undefined : BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) ?? OCTETS;
}

/** A size in words: `1.5 MB`, `300 B`. */
function sized(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

/** Writes `data` to `file` atomically: to `tmp`, flushed, then renamed; mode 600. */
function writeAtomic(file: string, tmp: string, data: string | Uint8Array): void {
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    // All of it: one write may take only part of a large file.
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** What the core keeps of a file beside its bytes. */
interface FileMeta {
  type: string;
  written: number;
}

/** Where a set of files lives: a directory, or memory. */
interface FileBackend {
  get(name: string): Uint8Array | undefined;
  info(name: string): StoreFileInfo | undefined;
  set(name: string, bytes: Uint8Array, meta: FileMeta): void;
  delete(name: string): void;
  list(): StoreFileInfo[];
}

/** An instance's files on disk: `<dir>/<name>`, and what is kept of each in `<dir>/.meta/`. */
class DirFiles implements FileBackend {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private meta(name: string): string {
    return path.join(this.dir, '.meta', `${name}.json`);
  }
  get(name: string): Uint8Array | undefined {
    try {
      return fs.readFileSync(path.join(this.dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  info(name: string): StoreFileInfo | undefined {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(this.dir, name));
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    let meta: Partial<FileMeta> = {};
    try {
      meta = JSON.parse(fs.readFileSync(this.meta(name), 'utf8')) as Partial<FileMeta>;
    } catch {
      // None kept (a file put back by hand): its type from its name, its time from the disk.
    }
    return {
      name,
      size: stat.size,
      type: typeof meta.type === 'string' ? meta.type : guessType(name),
      written: typeof meta.written === 'number' ? meta.written : Math.round(stat.mtimeMs),
    };
  }
  set(name: string, bytes: Uint8Array, meta: FileMeta): void {
    fs.mkdirSync(path.join(this.dir, '.meta'), { recursive: true, mode: 0o700 });
    // The temporary's name starts with a dot, which no file's name does.
    writeAtomic(path.join(this.dir, name), path.join(this.dir, `.${name}.tmp`), bytes);
    const file = this.meta(name);
    writeAtomic(file, `${file}.tmp`, `${JSON.stringify(meta)}\n`);
  }
  delete(name: string): void {
    fs.rmSync(path.join(this.dir, name), { force: true });
    fs.rmSync(this.meta(name), { force: true });
  }
  list(): StoreFileInfo[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => !n.startsWith('.'))
      .map((n) => this.info(n))
      .filter((f) => f !== undefined);
  }
}

interface MemoryFile extends FileMeta {
  bytes: Uint8Array;
}

class MemoryFiles implements FileBackend {
  readonly files: Map<string, MemoryFile>;
  constructor(files = new Map<string, MemoryFile>()) {
    this.files = files;
  }
  get(name: string): Uint8Array | undefined {
    const f = this.files.get(name);
    // A copy: what the plugin changes of what it read is not kept.
    return f === undefined ? undefined : Uint8Array.from(f.bytes);
  }
  info(name: string): StoreFileInfo | undefined {
    const f = this.files.get(name);
    return f === undefined
      ? undefined
      : { name, size: f.bytes.byteLength, type: f.type, written: f.written };
  }
  set(name: string, bytes: Uint8Array, meta: FileMeta): void {
    this.files.set(name, { ...meta, bytes: Uint8Array.from(bytes) });
  }
  delete(name: string): void {
    this.files.delete(name);
  }
  list(): StoreFileInfo[] {
    return [...this.files.keys()].map((n) => this.info(n) as StoreFileInfo);
  }
}

/** A plugin's files, its names and sizes checked, on a backend. */
class BackendFiles implements StoreFiles {
  readonly backend: FileBackend;
  private readonly limits: FileLimits;
  private readonly now: () => number;
  constructor(backend: FileBackend, limits: FileLimits, now: () => number) {
    this.backend = backend;
    this.limits = limits;
    this.now = now;
  }
  write(name: string, bytes: Uint8Array, options: { type?: string } = {}): void {
    checkFileName(name);
    if (!(bytes instanceof Uint8Array)) throw new Error(`file ${name}: not bytes`);
    const { type } = options;
    if (type !== undefined && (type.length > 127 || !MEDIA_TYPE.test(type)))
      throw new Error(`file ${name}: not a media type: ${JSON.stringify(type)}`);
    const size = bytes.byteLength;
    const { file, total } = this.limits;
    if (size > file)
      throw new FileLimitError(
        `file ${name} is ${sized(size)}, over the ${sized(file)} a file may be`
      );
    const kept = this.backend
      .list()
      .filter((f) => f.name !== name)
      .reduce((sum, f) => sum + f.size, 0);
    if (kept + size > total)
      throw new FileLimitError(
        `file ${name} (${sized(size)}) would take the files to ${sized(kept + size)}, ` +
          `over the ${sized(total)} an instance may keep`
      );
    this.backend.set(name, bytes, {
      type: type?.toLowerCase() ?? guessType(name),
      written: this.now(),
    });
  }
  read(name: string): Uint8Array | undefined {
    checkFileName(name);
    return this.backend.get(name);
  }
  /** A file's name, size, type and time, or undefined if there is none. */
  info(name: string): StoreFileInfo | undefined {
    checkFileName(name);
    return this.backend.info(name);
  }
  list(): StoreFileInfo[] {
    return this.backend.list().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  delete(name: string): void {
    checkFileName(name);
    this.backend.delete(name);
  }
  /** What every file takes together, in bytes. */
  used(): number {
    return this.backend.list().reduce((sum, f) => sum + f.size, 0);
  }
  /** The limits it keeps to. */
  get limit(): FileLimits {
    return { ...this.limits };
  }
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
    writeAtomic(file, `${file}.tmp`, text);
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
  readonly files: BackendFiles;
  constructor(backend: Backend, files: BackendFiles) {
    this.backend = backend;
    this.files = files;
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

/** The directory of the instances' stores, in the data volume. */
export const INSTANCES_DIR = 'instances';
/** The core's own store, beside the instances': `<data>/core/`. */
export const CORE_STORE = 'core';
/** An instance's id: lower-case words and dashes, as a plugin's. */
const INSTANCE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** How the stores keep their files. */
export interface StoresOptions {
  /** The time now, for when a file was written (the core's clock). */
  now?: () => number;
  /** How much an instance's files may take: the core's defaults (`DEFAULT_FILE_LIMITS`) else. */
  fileLimits?: Partial<FileLimits>;
}

/** The stores of every plugin instance, under one data directory (or in memory). */
export class Stores {
  private readonly dataDir: string | undefined;
  private readonly memory = new Map<string, Map<string, string>>();
  private readonly memoryFiles = new Map<string, Map<string, MemoryFile>>();
  private readonly now: () => number;
  /** How much an instance's files may take. */
  readonly fileLimits: FileLimits;

  constructor(dataDir?: string, o: StoresOptions = {}) {
    this.dataDir = dataDir;
    this.now = o.now ?? Date.now;
    this.fileLimits = { ...DEFAULT_FILE_LIMITS, ...o.fileLimits };
  }

  private filesOn(backend: FileBackend): BackendFiles {
    return new BackendFiles(backend, this.fileLimits, this.now);
  }

  /** Where an instance's documents are, on disk: the core's in `core/`, the others' in `instances/`. */
  dirOf(id: string): string | undefined {
    if (this.dataDir === undefined) return undefined;
    return id === CORE_STORE
      ? path.join(this.dataDir, CORE_STORE)
      : path.join(this.dataDir, INSTANCES_DIR, id);
  }

  /** The instances that keep a store, sorted (the core's left out). */
  ids(): string[] {
    if (this.dataDir === undefined)
      return [...this.memory.keys()].filter((id) => id !== CORE_STORE).sort();
    try {
      return fs
        .readdirSync(path.join(this.dataDir, INSTANCES_DIR), { withFileTypes: true })
        .filter((d) => d.isDirectory() && INSTANCE_ID.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Deletes an instance's store, every document and file of it. */
  delete(id: string): void {
    const dir = this.dirOf(id);
    if (dir === undefined) {
      this.memory.delete(id);
      this.memoryFiles.delete(id);
    } else fs.rmSync(dir, { recursive: true, force: true });
  }

  /** A plugin's store. */
  open(id: string): Store {
    return this.internal(id);
  }

  /** The core's documents of a plugin (`_restore`), beside the plugin's own. */
  internal(id: string): BackendStore {
    const dir = this.dirOf(id);
    if (dir !== undefined)
      return new BackendStore(
        new DirBackend(dir),
        this.filesOn(new DirFiles(path.join(dir, FILES_DIR)))
      );
    let docs = this.memory.get(id);
    if (docs === undefined) {
      docs = new Map();
      this.memory.set(id, docs);
    }
    let files = this.memoryFiles.get(id);
    if (files === undefined) {
      files = new Map();
      this.memoryFiles.set(id, files);
    }
    return new BackendStore(new MemoryBackend(docs), this.filesOn(new MemoryFiles(files)));
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
    const staged = this.stage(id, dir);
    const store: Store = {
      read: <T>(name: string) => staged.read<T>(name),
      write: (name, value) => staged.write(name, value),
      remove: (name) => staged.remove(name),
      names: () => staged.names(),
      files: staged.files,
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

  /**
   * A copy of a plugin's documents to migrate, and of its files: hard links to them on disk, not
   * copies, as they may be large. A write replaces a file by a rename and a delete unlinks it, so
   * nothing the migration does reaches the store's own until the commit.
   */
  private stage(id: string, dir: string | undefined): BackendStore {
    if (dir === undefined)
      return new BackendStore(
        new MemoryBackend(new Map(this.memory.get(id))),
        this.filesOn(new MemoryFiles(new Map(this.memoryFiles.get(id))))
      );
    const staging = `${dir}.migrating`;
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(dir)) {
      const files = path.join(dir, FILES_DIR);
      fs.cpSync(dir, staging, { recursive: true, filter: (src) => src !== files });
      if (fs.existsSync(files)) linkTree(files, path.join(staging, FILES_DIR));
    } else fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    return new BackendStore(
      new DirBackend(staging),
      this.filesOn(new DirFiles(path.join(staging, FILES_DIR)))
    );
  }

  /** The staged copy in place of the store. */
  private commit(id: string, dir: string | undefined, staged: BackendStore): void {
    if (dir === undefined) {
      // In place: the stores opened before the migration (the settings') see what it made.
      const docs = this.memory.get(id) ?? new Map<string, string>();
      docs.clear();
      for (const [name, value] of (staged.backend as MemoryBackend).docs) docs.set(name, value);
      this.memory.set(id, docs);
      const files = this.memoryFiles.get(id) ?? new Map<string, MemoryFile>();
      files.clear();
      for (const [name, f] of (staged.files.backend as MemoryFiles).files) files.set(name, f);
      this.memoryFiles.set(id, files);
      return;
    }
    const old = `${dir}.old`;
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, old);
    fs.renameSync(`${dir}.migrating`, dir);
    fs.rmSync(old, { recursive: true, force: true });
  }
}

/** `from`'s tree again at `to`, each file a hard link to its own (a copy where a link fails). */
function linkTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    if (e.isDirectory()) linkTree(src, dest);
    else if (e.isFile())
      try {
        fs.linkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
      }
  }
}
