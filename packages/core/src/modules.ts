/**
 * Modules (docs/bot-os-api.md §7, bot-os.md D49): a directory of plain `.ts` files and a
 * `module.json`, installed in the data volume (`<data>/modules/<id>/`) and loaded at start. This
 * file reads the manifests and settles which modules load, in which order: a module refused (a bad
 * manifest, another plugin API, an import missing, out of range or refused, a cycle) is refused by
 * name, with why, and so are the modules that import it; the others load.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { satisfies, validRange } from './semver.ts';

/** The plugin API this shell offers; a module's `api` must be it. */
export const PLUGIN_API = '1';
/** The manifest's file, at the root of the module's directory. */
export const MODULE_FILE = 'module.json';
/** Where the version before the installed one is kept, under the modules' directory. */
export const PREVIOUS_DIR = '.previous';

/** The names the host offers modules (bot-os.md D49): no module may provide them. */
export const HOST_PACKAGES = /^(?:zod(?:\/|$)|@megabottron1999\/)/u;

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

export const moduleManifestSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 'lower-case words and dashes, such as dice-games'),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, 'a version, MAJOR.MINOR.PATCH'),
  description: z.string().optional(),
  /** The plugin API it targets (`PLUGIN_API`). */
  api: z.string(),
  /** Its import name: `<provides>/<path>` is `<its directory>/src/<path>`. */
  provides: z
    .string()
    .regex(PACKAGE_NAME, 'an npm package name, such as @example/dice')
    .refine((p) => !HOST_PACKAGES.test(p), 'a name the host offers (zod, @megabottron1999/*)'),
  /** The modules it imports, by the name each provides, with the versions it accepts. */
  imports: z.record(z.string(), z.string().refine(validRange, 'a version range')).default({}),
  /** Its plugin entry files, relative to its directory. */
  plugins: z
    .array(
      z
        .string()
        .refine(
          (p) => !path.isAbsolute(p) && !p.split(/[\\/]/u).includes('..') && p.endsWith('.ts'),
          'a .ts file inside the module'
        )
    )
    .default([]),
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

/** A module whose manifest was read, in its directory. */
export interface FoundModule {
  id: string;
  dir: string;
  manifest: ModuleManifest;
}

/** A module refused, by its directory's name, with why. */
export interface ModuleFailure {
  id: string;
  reason: string;
}

export class ModuleError extends Error {}

/** Reads and checks a module's manifest in `dir`; throws a `ModuleError` saying what is wrong. */
export function readModuleManifest(dir: string): ModuleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MODULE_FILE), 'utf8'));
  } catch (e) {
    throw new ModuleError(
      (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `no ${MODULE_FILE}`
        : `${MODULE_FILE}: ${(e as Error).message}`
    );
  }
  const parsed = moduleManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new ModuleError(
      `${MODULE_FILE}: ${parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || '(all)'}: ${i.message}`)
        .join('; ')}`
    );
  return parsed.data;
}

/** The names of the modules installed in `modulesDir`: its directories, but the hidden ones. */
export function installedIds(modulesDir: string): string[] {
  if (!fs.existsSync(modulesDir)) return [];
  // A link to a directory counts (a module mounted, or linked in development).
  return fs
    .readdirSync(modulesDir)
    .filter(
      (name) =>
        !name.startsWith('.') &&
        fs.statSync(path.join(modulesDir, name), { throwIfNoEntry: false })?.isDirectory() === true
    )
    .sort();
}

/** The modules installed, each read, or refused with why. */
export function discoverModules(modulesDir: string): {
  found: FoundModule[];
  failures: ModuleFailure[];
} {
  const found: FoundModule[] = [];
  const failures: ModuleFailure[] = [];
  for (const id of installedIds(modulesDir)) {
    const dir = path.join(modulesDir, id);
    try {
      const manifest = readModuleManifest(dir);
      if (manifest.id !== id)
        throw new ModuleError(`its id is ${manifest.id}, and its directory ${id}`);
      for (const entry of manifest.plugins)
        if (!fs.existsSync(path.join(dir, entry)))
          throw new ModuleError(`its plugin entry ${entry} is not there`);
      found.push({ id, dir, manifest });
    } catch (e) {
      failures.push({ id, reason: e instanceof ModuleError ? e.message : String(e) });
    }
  }
  return { found, failures };
}

/**
 * The modules that load, in the order their imports make (each after those it imports), and those
 * refused, with why: another plugin API, a name provided twice, an import that no module provides,
 * whose version is out of range or which is refused, or a cycle of imports.
 */
export function planModules(
  modules: readonly FoundModule[],
  api = PLUGIN_API
): { ordered: FoundModule[]; failures: ModuleFailure[] } {
  const failures: ModuleFailure[] = [];
  const refused = new Map<string, string>();
  const refuse = (m: FoundModule, reason: string): void => {
    if (refused.has(m.id)) return;
    refused.set(m.id, reason);
    failures.push({ id: m.id, reason });
  };
  const providers = new Map<string, FoundModule[]>();
  for (const m of modules)
    providers.set(m.manifest.provides, [...(providers.get(m.manifest.provides) ?? []), m]);
  for (const m of modules) {
    if (m.manifest.api !== api)
      refuse(m, `it targets plugin API ${m.manifest.api}, and this shell offers ${api}`);
    const twice = (providers.get(m.manifest.provides) ?? []).filter((o) => o !== m);
    if (twice.length > 0)
      refuse(
        m,
        `${m.manifest.provides} is provided by ${[m, ...twice]
          .map((o) => o.id)
          .sort()
          .join(' and ')}`
      );
  }
  const unique = (name: string): FoundModule | undefined => {
    const p = providers.get(name);
    return p?.length === 1 ? p[0] : undefined;
  };
  for (const m of modules)
    for (const [name, range] of Object.entries(m.manifest.imports)) {
      const p = providers.get(name);
      if (p === undefined || p.length === 0)
        refuse(m, `it imports ${name}, which no module provides`);
      else if (p.length === 1 && satisfies(p[0]?.manifest.version ?? '', range) !== true)
        refuse(
          m,
          `it imports ${name} ${range}, and ${p[0]?.id} ${p[0]?.manifest.version} is installed`
        );
    }
  // Kahn's order; a module waits for those it imports, and fails with any of them.
  const ordered: FoundModule[] = [];
  const pending = new Set(modules);
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const m of [...pending]) {
      const deps = Object.keys(m.manifest.imports).map((n) => [n, unique(n)] as const);
      const down = deps.find(([, d]) => d === undefined || refused.has(d.id));
      if (refused.has(m.id) || down !== undefined) {
        if (down !== undefined && !refused.has(m.id))
          refuse(m, `it imports ${down[0]}, which is refused`);
        pending.delete(m);
        progressed = true;
        continue;
      }
      if (deps.every(([, d]) => d !== undefined && !pending.has(d))) {
        ordered.push(m);
        pending.delete(m);
        progressed = true;
      }
    }
  }
  // What is left waits on itself: a cycle, or a module behind one.
  for (const m of pending) {
    const cycle = cycleFrom(m, unique);
    refuse(
      m,
      cycle === undefined
        ? 'it imports a module in a cycle of imports'
        : `its imports form a cycle: ${cycle.join(' → ')}`
    );
  }
  return { ordered, failures };
}

/** The cycle of imports through `start`, by id, if it is in one. */
function cycleFrom(
  start: FoundModule,
  unique: (name: string) => FoundModule | undefined
): string[] | undefined {
  const walk = (m: FoundModule, trail: FoundModule[]): string[] | undefined => {
    for (const name of Object.keys(m.manifest.imports)) {
      const next = unique(name);
      if (next === undefined) continue;
      if (next === start) return [...trail, m, start].map((x) => x.id);
      if (trail.includes(next) || next === m) continue;
      const found = walk(next, [...trail, m]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(start, []);
}
