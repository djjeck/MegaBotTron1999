/**
 * The instance's start in the background (bot-os.md D143): the wiring serves first (the control
 * API, the health endpoint, the web UI), then calls `bootstrap`, which loads the image's plugin
 * packages and the installed modules, each on its own, and starts the graph's nodes.
 *
 * - A package whose import throws (a SyntaxError of Node's type stripping, a top-level error),
 *   whose import does not settle in time, or whose factory throws, is a failure of that package
 *   alone; a module's, of that module alone (module-loader.ts). Each is told to the core
 *   (`Core.failedToLoad`): printed, logged, raised as a notice, and the nodes of its plugins held
 *   out of the graph, with why, rather than the whole graph refused.
 * - The packages load at once, side by side; then the modules, which may not take a plugin id of
 *   the image's; then the core loads the graph and starts its nodes, each bounded in time.
 * - Nothing here throws: a fault of the load or the start is printed and raised, and the process
 *   goes on serving, for the owner to fix it from the web UI.
 * - `guard` keeps the process up through an error nothing caught (an unhandled rejection, an
 *   uncaught exception), naming the module or package it came from when its stack tells.
 */
import { type Core, type LoadFailure, StartError } from './core.ts';
import { parseManifest } from './manifest.ts';
import { IMPORT_TIMEOUT_MS, type ModulesLoad, settleWithin } from './module-loader.ts';
import { type Plugin } from './plugin.ts';

/** One of the image's plugin packages: its specifier, and how to import it and make its plugins. */
export interface PackageSpec {
  name: string;
  load: () => Promise<readonly Plugin[]>;
}

/** The packages that loaded, with their plugins, and those that failed, with why. */
export interface PackagesLoad {
  loaded: { name: string; plugins: readonly Plugin[] }[];
  failures: LoadFailure[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Loads each package on its own, side by side; never throws for a package's fault. */
export async function loadPackages(
  specs: readonly PackageSpec[],
  timeoutMs = IMPORT_TIMEOUT_MS
): Promise<PackagesLoad> {
  const settled = await Promise.all(
    specs.map(async (spec) => {
      try {
        const plugins = await settleWithin(
          Promise.resolve().then(() => spec.load()),
          timeoutMs
        );
        return { name: spec.name, plugins };
      } catch (e) {
        return { name: spec.name, error: message(e) };
      }
    })
  );
  const out: PackagesLoad = { loaded: [], failures: [] };
  for (const s of settled)
    if ('error' in s) out.failures.push({ source: `package ${s.name}`, error: s.error });
    else out.loaded.push(s);
  return out;
}

export interface BootstrapOptions {
  core: Core;
  /** The image's plugin packages. */
  packages: readonly PackageSpec[];
  /** Loads the installed modules, given the plugin ids the image offers (`loadModules`). */
  modules?: (reserved: readonly string[]) => Promise<ModulesLoad>;
  /** Once the core has loaded the graph, before its nodes start: the graph's history. */
  loaded?: () => void;
  /** Where lines go (stdout). */
  print?: (line: string) => void;
  /** How long one import may take. */
  timeoutMs?: number;
}

/** What the start loaded: the modules (for the Modules page), and what failed to load. */
export interface Bootstrapped {
  modules?: ModulesLoad;
  failures: LoadFailure[];
}

/**
 * Loads the plugins, then loads and starts the core (D143). Never throws: what goes wrong is
 * printed, and raised by the core where it can be.
 */
export async function bootstrap(o: BootstrapOptions): Promise<Bootstrapped> {
  const print = o.print ?? (() => {});
  const { core } = o;
  core.booting();
  const packages = await loadPackages(o.packages, o.timeoutMs);
  const failures = [...packages.failures];
  const reserved: string[] = [];
  for (const p of packages.loaded) {
    core.registerPackage(p.name, p.plugins);
    for (const plugin of p.plugins) {
      try {
        reserved.push(parseManifest(plugin.manifest).id);
      } catch {
        // Its manifest does not read: the load says why.
      }
    }
  }
  let modules: ModulesLoad | undefined;
  if (o.modules !== undefined) {
    try {
      modules = await o.modules(reserved);
      for (const m of modules.modules) {
        print(
          `megabottron1999: module ${m.id} ${m.version}: ${m.plugins.join(', ') || 'no plugins'}`
        );
        core.registerModule(
          m.id,
          modules.plugins.filter((p) => p.module === m.id).map((p) => p.plugin),
          m.version,
          m.styles
        );
      }
      failures.push(
        ...modules.failures.map((f) => ({
          source: `module ${f.id}`,
          module: f.id,
          error: f.reason,
        }))
      );
    } catch (e) {
      failures.push({ source: 'the modules', error: message(e) });
    }
  }
  core.failedToLoad(...failures);
  try {
    core.load();
  } catch (e) {
    // A graph given by the wiring, refused: no node runs; the process serves on.
    print(`megabottron1999: ${e instanceof StartError ? '' : 'the load failed: '}${message(e)}`);
    return { ...(modules === undefined ? {} : { modules }), failures };
  }
  try {
    o.loaded?.();
  } catch (e) {
    print(`megabottron1999: ${message(e)}`);
  }
  try {
    await core.start();
  } catch (e) {
    print(`megabottron1999: the start failed: ${message(e)}`);
  }
  return { ...(modules === undefined ? {} : { modules }), failures };
}

/** Where an error came from, by its stack: a module's directory, or one of the image's packages. */
export function blame(
  error: unknown,
  modules: readonly { id: string; dir: string }[] = []
): string | undefined {
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  for (const line of stack.split('\n').slice(1)) {
    const module = modules.find((m) => line.includes(m.dir));
    if (module !== undefined) return `module ${module.id}`;
    const pkg = /\/packages\/([a-z0-9-]+)\/src\//u.exec(line)?.[1];
    if (pkg !== undefined && pkg !== 'core') return `package @megabottron1999/${pkg}`;
  }
  return undefined;
}

/** What `guard` listens on: the process. */
export interface Guarded {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (e: unknown) => void): unknown;
}

/**
 * Keeps the process up through an error nothing caught (D143): each told to the core
 * (`Core.uncaught`), with where it came from when its stack tells.
 */
export function guard(
  core: Pick<Core, 'uncaught'>,
  process: Guarded,
  modules: () => readonly { id: string; dir: string }[] = () => []
): void {
  const tell = (e: unknown): void => core.uncaught(e, blame(e, modules()));
  process.on('unhandledRejection', tell);
  process.on('uncaughtException', tell);
}
