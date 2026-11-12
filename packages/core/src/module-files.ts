/**
 * Which modules a tree of files holds, and which of each module's files are installed
 * (docs/bot-os-api.md §7.4, bot-os.md D67): a folder the owner picks, or a repository's tarball
 * fetched from GitHub, may be a repository's root with several modules, vendored copies of others
 * and each module's tests. One implementation, the server's, for both: the web UI sends a folder's
 * paths and its `module.json` files (`POST /modules/plan`), and sends only the files it is told.
 *
 * - **Discovery:** every `module.json`, at any depth, but under `.git`, `node_modules`, a `vendor`
 *   directory (vendored copies of other repositories, not the owner's modules) or a test directory
 *   (fixtures).
 * - **A module's files:** those under its directory, but `.git`, `node_modules` and another module's
 *   directory nested in it; of those, the ones its `module.json`'s `files` globs match, or by
 *   default all but its tests (`*.test.ts`, `*.spec.ts`, `test/`, `tests/`, `__tests__/`,
 *   `__snapshots__/`) and its own `vendor/`. Its `module.json` is always kept.
 */
import { MODULE_FILE, moduleManifestSchema } from './modules.ts';
import { compare, parseVersion } from './semver.ts';
import { insidePath } from './tar.ts';

/** What is never taken from a tree: a repository's own, and its dependencies. */
export const NEVER = new Set(['.git', 'node_modules']);
/** The directories of tests, left out of a module by default and never searched for modules. */
export const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__snapshots__']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/** How a module found compares with the one of its id installed. */
export type ModuleStatus = 'new' | 'update' | 'same' | 'older';

/** A module found in a tree: what its `module.json` says, and the files it would install. */
export interface ModuleCandidate {
  /** Its directory in the tree, `/` between parts; '' for the tree's root. */
  path: string;
  id?: string;
  version?: string;
  description?: string;
  /** Why it cannot be installed: its manifest does not read, its id is found twice, … */
  error?: string;
  /** Compared with the one of its id installed (`installed`), once its manifest reads. */
  status?: ModuleStatus;
  /** The version of its id installed, if any. */
  installed?: string;
  /** The files it installs, by their paths in the tree, its `module.json` first. */
  files: string[];
  /** Its files left out (its tests, or what its `files` globs do not name), by their paths. */
  left: string[];
}

/** A tree's listing, as the web UI sends a folder: its paths, and its `module.json` files' text. */
export interface TreeListing {
  paths: string[];
  manifests: Record<string, string>;
}

/** A glob of `module.json`'s `files`, as a test of a path from the module's directory. */
export function globTest(glob: string): (rel: string) => boolean {
  const g = glob.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === '*' && g.charAt(i + 1) === '*') {
      i++;
      if (g.charAt(i + 1) === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  // A directory named is all that is under it.
  const r = new RegExp(`^${re}(?:/.*)?$`, 'u');
  return (rel) => r.test(rel);
}

/** Whether a module's file (its path from the module's directory) is left out by default. */
export function leftOutByDefault(rel: string): boolean {
  const parts = rel.split('/');
  const name = parts.pop() ?? '';
  return parts[0] === 'vendor' || parts.some((p) => TEST_DIRS.has(p)) || TEST_FILE.test(name);
}

/**
 * A module's files (paths from its directory) split into those it installs and those left out:
 * by its `files` globs when it has them, else by `leftOutByDefault`. Its `module.json` is kept, and
 * `.git` and `node_modules` are in neither.
 */
export function selectFiles(
  rels: readonly string[],
  globs?: readonly string[]
): { kept: string[]; left: string[] } {
  const tests = globs?.map(globTest);
  const kept: string[] = [];
  const left: string[] = [];
  for (const rel of rels) {
    if (rel.split('/').some((p) => NEVER.has(p))) continue;
    const keep =
      rel === MODULE_FILE ||
      (tests === undefined ? !leftOutByDefault(rel) : tests.some((t) => t(rel)));
    (keep ? kept : left).push(rel);
  }
  return { kept, left };
}

/** How a version compares with the one installed. */
export function statusOf(version: string, installed: string | undefined): ModuleStatus {
  if (installed === undefined) return 'new';
  const a = parseVersion(version);
  const b = parseVersion(installed);
  const order = a === undefined || b === undefined ? 0 : compare(a, b);
  return order > 0 ? 'update' : order < 0 ? 'older' : 'same';
}

/** The directory of a tree path, '' for one at the root. */
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const under = (root: string, p: string): boolean => root === '' || p.startsWith(`${root}/`);
const fromRoot = (root: string, p: string): string => (root === '' ? p : p.slice(root.length + 1));

/** Whether a `module.json` at this path is a module of the owner's (not vendored, not a fixture). */
function discoverable(p: string): boolean {
  const dirs = p.split('/').slice(0, -1);
  return (
    p.split('/').pop() === MODULE_FILE &&
    !dirs.some((d) => NEVER.has(d) || d === 'vendor' || TEST_DIRS.has(d))
  );
}

/**
 * The modules in a tree, by their directories' paths, each with its manifest read and checked,
 * how it compares with the version of its id installed (`installed`, by id), and the files it would
 * install. `within` keeps only those at or under a directory of the tree (a GitHub link's path).
 */
export function findModules(
  listing: TreeListing,
  installed: ReadonlyMap<string, string> = new Map(),
  within = ''
): ModuleCandidate[] {
  const paths = [
    ...new Set(
      listing.paths
        .map((p) => insidePath(p))
        .filter((p): p is string => p !== undefined && p !== '')
    ),
  ];
  const scope = insidePath(within) ?? '';
  const roots = paths
    .filter(discoverable)
    .map(dirOf)
    .filter((r) => under(scope, r) || r === scope)
    .sort();
  const seen = new Map<string, string>();
  return roots.map((root): ModuleCandidate => {
    const nested = roots.filter((r) => r !== root && under(root, r));
    const mine = paths.filter((p) => under(root, p) && !nested.some((r) => under(r, p)));
    const manifestPath = root === '' ? MODULE_FILE : `${root}/${MODULE_FILE}`;
    const base = { path: root, files: [] as string[], left: [] as string[] };
    let raw: unknown;
    try {
      raw = JSON.parse(listing.manifests[manifestPath] ?? '');
    } catch (e) {
      return { ...base, error: `${MODULE_FILE}: ${(e as Error).message}` };
    }
    const parsed = moduleManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      return {
        ...base,
        ...(typeof o['id'] === 'string' ? { id: o['id'] } : {}),
        ...(typeof o['version'] === 'string' ? { version: o['version'] } : {}),
        error: `${MODULE_FILE}: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(all)'}: ${i.message}`)
          .join('; ')}`,
      };
    }
    const m = parsed.data;
    const { kept, left } = selectFiles(
      mine.map((p) => fromRoot(root, p)),
      m.files
    );
    const at = (rel: string): string => (root === '' ? rel : `${root}/${rel}`);
    const missing = m.plugins.find((entry) => !kept.includes(insidePath(entry) ?? entry));
    const twice = seen.get(m.id);
    seen.set(m.id, root);
    const have = installed.get(m.id);
    const error =
      twice !== undefined
        ? `${m.id} is found twice, here and at ${twice || '.'}: choose one's folder`
        : missing === undefined
          ? undefined
          : `its plugin entry ${missing} is ${mine.includes(at(insidePath(missing) ?? missing)) ? 'left out by its files' : 'not there'}`;
    return {
      path: root,
      id: m.id,
      version: m.version,
      ...(m.description === undefined ? {} : { description: m.description }),
      ...(error === undefined ? {} : { error }),
      status: statusOf(m.version, have),
      ...(have === undefined ? {} : { installed: have }),
      files: [MODULE_FILE, ...kept.filter((k) => k !== MODULE_FILE)].map(at),
      left: left.map(at),
    };
  });
}
