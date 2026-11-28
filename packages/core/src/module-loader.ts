/**
 * The module loader (docs/bot-os-api.md §7, bot-os.md D49): at start, the modules installed in
 * `<data>/modules/` are read and checked (modules.ts), the resolve hook is registered with the
 * table of those that load (module-hooks.ts), and each module's plugin entries are imported, in the
 * order of their imports. What they export is checked: each entry exports `plugins`, an array of
 * plugins (`definePlugin`), whose manifests must be valid and whose ids must be new. A module that
 * fails is refused, by name and with why, and so are the modules that import it; the others load.
 * A module fails as well when an entry's import throws (a SyntaxError of Node's type stripping, a
 * top-level error) or does not settle within `timeoutMs` (bot-os.md D143). The plugins loaded are
 * what the instance offers beside the image's (`Core.registerModule`); the wiring loads them in
 * the background, once its servers are up (`boot.ts`).
 */
import fs from 'node:fs';
import { register as registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseManifest } from './manifest.ts';
import { dirUrl, type ResolveTable } from './module-resolve.ts';
import {
  discoverModules,
  type ModuleFailure,
  type ModuleManifest,
  planModules,
  PLUGIN_API,
} from './modules.ts';
import { type Plugin } from './plugin.ts';
import { checkViewSheet, type ViewStyle } from './view-style.ts';

/**
 * A view plugin's stylesheet (D175), read from its module's directory and checked; thrown with why.
 * Its pictures are files beside it, within the module's directory.
 */
export function moduleSheet(dir: string, sheet: string): ViewStyle {
  const root = fs.realpathSync(dir);
  const inside = (file: string): string | undefined => {
    try {
      const real = fs.realpathSync(file);
      return real.startsWith(`${root}${path.sep}`) && fs.statSync(real).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  };
  const file = inside(path.join(root, sheet));
  if (file === undefined) throw new Error(`its stylesheet ${sheet} is not in the module`);
  const here = path.dirname(file);
  return checkViewSheet(fs.readFileSync(file, 'utf8'), {
    name: sheet,
    picture: (ref) => inside(path.join(here, ref)),
  });
}

export interface LoadModulesOptions {
  /** The modules' directory: `<data>/modules`. */
  dir: string;
  /** A file URL of the host's (its entry point's `import.meta.url`), whose packages modules get. */
  host: string;
  /** The plugin ids the image offers already: a module's plugin of one of them is refused. */
  reserved?: readonly string[];
  /** The plugin API the modules must target. */
  api?: string;
  /** Registers the resolve hook with the table: `module.register` by default. */
  register?: (table: ResolveTable) => void;
  /** Imports a plugin entry by its file URL: `import()` by default. */
  importer?: (url: string) => Promise<unknown>;
  /** How long an entry's import may take before its module is refused (D143): 30 s by default. */
  timeoutMs?: number;
}

/** How long a module's entry may take to import by default (D143). */
export const IMPORT_TIMEOUT_MS = 30_000;

/**
 * What `work` settles to, or a rejection saying it did not settle within `ms` (D143); the timer
 * keeps no process alive.
 */
export function settleWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it did not load within ${ms / 1000} s`)), ms);
    timer.unref?.();
  });
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface LoadedModule {
  id: string;
  version: string;
  dir: string;
  manifest: ModuleManifest;
  /** The ids of the plugins it offers. */
  plugins: string[];
  /** Its view plugins' stylesheets (D175), checked, by plugin id; none, none. */
  styles?: Record<string, ViewStyle>;
}

export interface ModulesLoad {
  /** The modules loaded, in load order. */
  modules: LoadedModule[];
  /** The modules refused, with why. */
  failures: ModuleFailure[];
  /** Every plugin loaded, with its module's id. */
  plugins: { module: string; plugin: Plugin }[];
}

const HOOKS = new URL('module-hooks.ts', import.meta.url).href;

/** The table the resolve hook gets. */
export function resolveTable(
  host: string,
  modules: readonly { id: string; dir: string; manifest: ModuleManifest }[]
): ResolveTable {
  return {
    host,
    modules: modules.map((m) => ({
      id: m.id,
      provides: m.manifest.provides,
      // Node names the files it loads by their real path.
      dir: dirUrl(pathToFileURL(fs.realpathSync(m.dir)).href),
      imports: Object.keys(m.manifest.imports),
    })),
  };
}

/** The plugins an entry file exports, checked; throws with why. */
function pluginsOf(exported: unknown, entry: string): Plugin[] {
  const plugins = (exported as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) throw new Error(`${entry} exports no plugins array`);
  return plugins.map((p: unknown, i) => {
    const plugin = p as Partial<Plugin> | null;
    if (typeof plugin !== 'object' || plugin === null || typeof plugin.create !== 'function')
      throw new Error(`${entry}: plugins[${i}] is not a plugin (a manifest and a create function)`);
    return plugin as Plugin;
  });
}

/** Loads the modules installed in `o.dir`; never throws for a module's fault. */
export async function loadModules(o: LoadModulesOptions): Promise<ModulesLoad> {
  const { found, failures } = discoverModules(o.dir);
  const { ordered, failures: refused } = planModules(found, o.api ?? PLUGIN_API);
  failures.push(...refused);
  const out: ModulesLoad = { modules: [], failures, plugins: [] };
  if (ordered.length === 0) return out;
  const table = resolveTable(o.host, ordered);
  (o.register ?? ((t) => registerHooks(HOOKS, { data: t })))(table);
  const importer = o.importer ?? ((url: string) => import(url));
  const taken = new Map<string, string>((o.reserved ?? []).map((id) => [id, 'the image']));
  const down = new Set<string>();
  for (const m of ordered) {
    const { manifest } = m;
    const lost = Object.keys(manifest.imports).find((name) =>
      ordered.some((d) => d.manifest.provides === name && down.has(d.id))
    );
    try {
      if (lost !== undefined) throw new Error(`it imports ${lost}, which is refused`);
      const plugins: Plugin[] = [];
      for (const entry of manifest.plugins) {
        const url = pathToFileURL(path.join(m.dir, entry)).href;
        let exported: unknown;
        try {
          exported = await settleWithin(importer(url), o.timeoutMs ?? IMPORT_TIMEOUT_MS);
        } catch (e) {
          throw new Error(`${entry} failed to load: ${(e as Error).message}`, { cause: e });
        }
        plugins.push(...pluginsOf(exported, entry));
      }
      const ids: string[] = [];
      const styles: Record<string, ViewStyle> = {};
      for (const plugin of plugins) {
        const { id, view } = parseManifest(plugin.manifest);
        if (view?.stylesheet !== undefined) styles[id] = moduleSheet(m.dir, view.stylesheet);
        const other = taken.get(id) ?? (ids.includes(id) ? `module ${m.id}` : undefined);
        if (other !== undefined) throw new Error(`its plugin ${id} is offered by ${other} already`);
        ids.push(id);
      }
      for (const id of ids) taken.set(id, `module ${m.id}`);
      out.modules.push({
        id: m.id,
        version: manifest.version,
        dir: m.dir,
        manifest,
        plugins: ids,
        styles,
      });
      out.plugins.push(...plugins.map((plugin) => ({ module: m.id, plugin })));
    } catch (e) {
      down.add(m.id);
      failures.push({ id: m.id, reason: (e as Error).message });
    }
  }
  return out;
}
