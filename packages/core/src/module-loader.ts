/**
 * The module loader (docs/bot-os-api.md §7, bot-os.md D49): at start, the modules installed in
 * `<data>/modules/` are read and checked (modules.ts), the resolve hook is registered with the
 * table of those that load (module-hooks.ts), and each module's plugin entries are imported, in the
 * order of their imports. What they export is checked: each entry exports `plugins`, an array of
 * plugins (`definePlugin`), whose manifests must be valid and whose ids must be new. A module that
 * fails is refused, by name and with why, and so are the modules that import it; the others load.
 * The plugins loaded are what the instance offers beside the image's (`Core.registerModule`).
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
}

export interface LoadedModule {
  id: string;
  version: string;
  dir: string;
  manifest: ModuleManifest;
  /** The ids of the plugins it offers. */
  plugins: string[];
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
          exported = await importer(url);
        } catch (e) {
          throw new Error(`${entry} failed to load: ${(e as Error).message}`, { cause: e });
        }
        plugins.push(...pluginsOf(exported, entry));
      }
      const ids: string[] = [];
      for (const plugin of plugins) {
        const { id } = parseManifest(plugin.manifest);
        const other = taken.get(id) ?? (ids.includes(id) ? `module ${m.id}` : undefined);
        if (other !== undefined) throw new Error(`its plugin ${id} is offered by ${other} already`);
        ids.push(id);
      }
      for (const id of ids) taken.set(id, `module ${m.id}`);
      out.modules.push({ id: m.id, version: manifest.version, dir: m.dir, manifest, plugins: ids });
      out.plugins.push(...plugins.map((plugin) => ({ module: m.id, plugin })));
    } catch (e) {
      down.add(m.id);
      failures.push({ id: m.id, reason: (e as Error).message });
    }
  }
  return out;
}
