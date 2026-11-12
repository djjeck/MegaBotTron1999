/**
 * The modules installed in the data volume (docs/bot-os-api.md §7, bot-os.md D49), as the owner
 * changes them: install one (from a directory, a tarball uploaded, or its files uploaded one by one),
 * roll one back, and list them.
 * Installing replaces `<modules>/<id>/` and keeps the version it replaces as
 * `<modules>/.previous/<id>/`; a rollback swaps the two, so a second one goes forward again. A
 * change takes effect at the next start (P8). Only the owner reaches this, through the control API;
 * no agent does (P1, P11).
 * Each install installs only the module's files that module-files.ts selects (its tests left out,
 * or its `files` globs), and records where it came from and when, in `<modules>/.sources.json`
 * (bot-os.md D67), never in the module's own files; a rollback swaps those records too.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  findModules,
  type ModuleCandidate,
  selectFiles,
  type TreeListing,
} from './module-files.ts';
import { type ModulesLoad } from './module-loader.ts';
import {
  installedIds,
  MODULE_FILE,
  ModuleError,
  type ModuleFailure,
  type ModuleManifest,
  PREVIOUS_DIR,
  readModuleManifest,
} from './modules.ts';
import { extractTar, insidePath } from './tar.ts';

/** Where an install or a rollback is staged, under the modules' directory. */
const STAGING_DIR = '.staging';
/** Where each module's source is recorded, under the modules' directory. */
export const SOURCES_FILE = '.sources.json';

/** A file of a module uploaded one by one: its path from the module's root, and its bytes. */
export interface ModuleFile {
  path: string;
  content: Uint8Array;
}

/**
 * What an install is made from: a directory of the container's, a tarball's bytes, or the files of
 * a directory uploaded one by one (the web UI's folder picker).
 */
export type ModuleSource =
  { dir: string } | { tarball: Uint8Array; name?: string } | { files: ModuleFile[]; name?: string };

/**
 * Where a module installed came from: a directory of the container's, a tarball, a folder the
 * owner uploaded, or a GitHub repository at a commit (bot-os.md D67).
 */
export type ModuleOrigin =
  | { kind: 'directory'; path: string }
  | { kind: 'tarball'; name?: string }
  | { kind: 'folder'; name?: string }
  | {
      kind: 'github';
      /** `<owner>/<repo>`. */
      repo: string;
      /** The branch, tag or commit the link named. */
      ref: string;
      refType: 'branch' | 'tag' | 'commit';
      /** The module's directory in the repository, '' for its root. */
      path: string;
      /** The commit installed, in full. */
      commit: string;
      /** Its committer's date, ISO 8601. */
      commitDate?: string;
    };

/** A module's source as recorded: where it came from, and when it was installed (ISO 8601). */
export type ModuleSourceRecord = ModuleOrigin & { installedAt: string };

/** The record of each module's sources: the version installed, and the one kept for a rollback. */
type SourcesFile = Record<string, { current?: ModuleSourceRecord; previous?: ModuleSourceRecord }>;

export interface InstalledModule {
  id: string;
  /** Its version, once its manifest reads. */
  version?: string;
  description?: string;
  provides?: string;
  imports?: Record<string, string>;
  plugins?: string[];
  /** Why its manifest does not read. */
  error?: string;
  /** The version kept for a rollback. */
  previous?: string;
  /** The version the running instance loaded, if it loaded it. */
  loaded?: string;
  /** Where it came from, and when it was installed; none for a module installed before D67. */
  source?: ModuleSourceRecord;
  /** For a module from GitHub, a newer commit or tag found by the last check (module-github.ts). */
  update?: ModuleUpdate;
}

/** A newer commit of a module's GitHub source: the one the module's ref now names. */
export interface ModuleUpdate {
  /** The ref to install: the branch, or a newer tag. */
  ref: string;
  commit: string;
  commitDate?: string;
  /** GitHub's comparison of the commit installed and this one. */
  compare: string;
}

/** The last check of the GitHub sources for updates. */
export interface UpdateCheck {
  /** When it ran, ISO 8601; none before the first. */
  checkedAt?: string;
  /** Why it failed, in part or whole (GitHub's rate limit, the network). */
  error?: string;
  /** Whether one runs now. */
  checking?: boolean;
}

export interface ModulesReport {
  installed: InstalledModule[];
  /** The modules the running instance refused at its start, with why. */
  failures: ModuleFailure[];
  /** Whether the installed modules differ from those loaded: a restart takes them up. */
  restart: boolean;
  /** The last check for updates of the modules from GitHub, when the wiring makes them. */
  updates?: UpdateCheck;
}

/** What is never copied from a directory: a repository's own and its dependencies. */
const SKIPPED = new Set(['.git', 'node_modules']);

export class ModuleStore {
  /** The modules' directory: `<data>/modules`. */
  readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  /** Each module's sources, as recorded. */
  sources(): SourcesFile {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, SOURCES_FILE), 'utf8')) as unknown;
      return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as SourcesFile)
        : {};
    } catch {
      return {};
    }
  }

  private writeSources(sources: SourcesFile): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, SOURCES_FILE);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(sources, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  }

  /** The versions installed, by id, of the modules whose manifests read. */
  versions(): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of installedIds(this.dir)) {
      const v = readVersion(path.join(this.dir, id));
      if (v !== undefined) out.set(id, v);
    }
    return out;
  }

  /**
   * The modules in a tree (a folder's listing, or a repository's files), each compared with the one
   * of its id installed, with the files it would install (module-files.ts).
   */
  plan(listing: TreeListing, within = ''): ModuleCandidate[] {
    return findModules(listing, this.versions(), within);
  }

  /** The module's version kept for a rollback, if any. */
  private previousOf(id: string): string | undefined {
    return readVersion(path.join(this.dir, PREVIOUS_DIR, id));
  }

  /** A fresh directory to stage in. */
  private stage(): string {
    const staging = path.join(this.dir, STAGING_DIR);
    fs.mkdirSync(staging, { recursive: true });
    return path.join(staging, randomBytes(6).toString('hex'));
  }

  /** The modules installed, with what the running instance loaded and refused (`load`). */
  report(load?: ModulesLoad): ModulesReport {
    const loaded = new Map((load?.modules ?? []).map((m) => [m.id, m.version]));
    const sources = this.sources();
    const installed = installedIds(this.dir).map((id): InstalledModule => {
      const kept = this.previousOf(id);
      const ran = loaded.get(id);
      const source = sources[id]?.current;
      const extra = {
        ...(kept === undefined ? {} : { previous: kept }),
        ...(ran === undefined ? {} : { loaded: ran }),
        ...(source === undefined ? {} : { source }),
      };
      try {
        const m = readModuleManifest(path.join(this.dir, id));
        return {
          id,
          version: m.version,
          ...(m.description === undefined ? {} : { description: m.description }),
          provides: m.provides,
          imports: m.imports,
          plugins: m.plugins,
          ...extra,
        };
      } catch (e) {
        return { id, error: (e as Error).message, ...extra };
      }
    });
    const failed = new Set((load?.failures ?? []).map((f) => f.id));
    const restart =
      installed.some((m) => !failed.has(m.id) && m.version !== m.loaded) ||
      [...loaded.keys()].some((id) => !installed.some((m) => m.id === id));
    return { installed, failures: load?.failures ?? [], restart };
  }

  /**
   * Installs a module, replacing the one of its id and keeping that as the previous version, and
   * records where it came from (`origin`; by default the kind of `source`): only the files
   * module-files.ts selects are kept, and its plugin entries must be among them. Throws a
   * `ModuleError` with why for a source that is not a module.
   */
  install(
    source: ModuleSource,
    origin?: ModuleOrigin
  ): { id: string; version: string; previous?: string; left?: number } {
    const staged = this.stage();
    try {
      if ('dir' in source) {
        if (!fs.statSync(source.dir, { throwIfNoEntry: false })?.isDirectory())
          throw new ModuleError(`${source.dir} is not a directory`);
        fs.cpSync(source.dir, staged, {
          recursive: true,
          filter: (src) => !SKIPPED.has(path.basename(src)),
        });
      } else if ('tarball' in source) extractTar(source.tarball, staged);
      else writeFiles(source.files, staged);
      const root = moduleRoot(staged);
      const manifest: ModuleManifest = readModuleManifest(root);
      const { left } = selectFiles(listFiles(root), manifest.files);
      for (const rel of left) fs.rmSync(path.join(root, ...rel.split('/')), { force: true });
      removeEmpty(root);
      for (const entry of manifest.plugins)
        if (!fs.existsSync(path.join(root, entry)))
          throw new ModuleError(`its plugin entry ${entry} is not there`);
      const target = path.join(this.dir, manifest.id);
      const keep = path.join(this.dir, PREVIOUS_DIR, manifest.id);
      const previous = fs.existsSync(target) ? readVersion(target) : undefined;
      if (fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(keep), { recursive: true });
        fs.rmSync(keep, { recursive: true, force: true });
        fs.renameSync(target, keep);
      }
      fs.renameSync(root, target);
      const sources = this.sources();
      const was = sources[manifest.id]?.current;
      const from: ModuleOrigin =
        origin ??
        ('dir' in source
          ? { kind: 'directory', path: source.dir }
          : {
              kind: 'tarball' in source ? 'tarball' : 'folder',
              ...(source.name === undefined ? {} : { name: source.name }),
            });
      sources[manifest.id] = {
        current: { ...from, installedAt: new Date(this.now()).toISOString() },
        ...(previous === undefined || was === undefined ? {} : { previous: was }),
      };
      this.writeSources(sources);
      return {
        id: manifest.id,
        version: manifest.version,
        ...(previous === undefined ? {} : { previous }),
        ...(left.length === 0 ? {} : { left: left.length }),
      };
    } catch (e) {
      if (e instanceof ModuleError) throw e;
      throw new ModuleError((e as Error).message);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
  }

  /**
   * Puts the previous version of a module back, keeping the one it replaces as the previous: a
   * second rollback goes forward again. Throws a `ModuleError` when there is none.
   */
  rollback(id: string): { id: string; version: string; previous?: string } {
    const keep = path.join(this.dir, PREVIOUS_DIR, id);
    const target = path.join(this.dir, id);
    if (path.basename(id) !== id || id.startsWith('.') || !fs.existsSync(keep))
      throw new ModuleError(`${id} has no previous version`);
    const version = readVersion(keep) ?? '(unknown)';
    const current = fs.existsSync(target) ? readVersion(target) : undefined;
    const aside = this.stage();
    if (fs.existsSync(target)) fs.renameSync(target, aside);
    fs.renameSync(keep, target);
    if (fs.existsSync(aside)) fs.renameSync(aside, keep);
    const sources = this.sources();
    const was = sources[id];
    if (was !== undefined) {
      sources[id] = {
        ...(was.previous === undefined ? {} : { current: was.previous }),
        ...(was.current === undefined ? {} : { previous: was.current }),
      };
      this.writeSources(sources);
    }
    return { id, version, ...(current === undefined ? {} : { previous: current }) };
  }
}

/**
 * Writes a module's files uploaded one by one into `dest`: each path relative to the module's root
 * (or to its one directory, as a folder picked in a browser gives them), never leaving it. What is
 * under `.git` or `node_modules` is left behind, as from a directory.
 */
function writeFiles(files: readonly ModuleFile[], dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) {
    const rel = insidePath(file.path);
    if (rel === undefined) throw new ModuleError(`${file.path} leaves the module's directory`);
    if (rel === '') throw new ModuleError(`a file has no path`);
    const parts = rel.split('/');
    if (parts.some((p) => SKIPPED.has(p))) continue;
    const target = path.join(dest, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
}

/** The files under a directory, by their paths from it with `/` between parts. */
function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : [rel];
  });
}

/** Removes the directories left empty under `dir` (by the files left out). */
function removeEmpty(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) {
      const sub = path.join(dir, e.name);
      removeEmpty(sub);
      if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
    }
}

/** A module's version, or undefined when its manifest does not read. */
function readVersion(dir: string): string | undefined {
  try {
    return readModuleManifest(dir).version;
  } catch {
    return undefined;
  }
}

/**
 * Where the module is in what was unpacked: its root, or the one directory it holds (an archive
 * made with a prefix, as `git archive --prefix` and GitHub's tarballs are).
 */
function moduleRoot(dir: string): string {
  if (fs.existsSync(path.join(dir, MODULE_FILE))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only?.isDirectory() === true && fs.existsSync(path.join(dir, only.name, MODULE_FILE)))
    return path.join(dir, only.name);
  throw new ModuleError(`no ${MODULE_FILE} at the root, nor in a single directory`);
}
