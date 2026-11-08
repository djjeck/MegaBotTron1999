/**
 * Where a module's import goes (docs/bot-os-api.md §7, bot-os.md D49): the rule of the resolve hook
 * (`module-hooks.ts`), apart from Node's hooks so that it is tested in place.
 *
 * For a file inside a module's directory:
 * - `@megabottron1999/*` and `zod` resolve as from the host (its own copies, one of each in the
 *   process);
 * - a module's `provides` name maps to its directory as the packages' `exports` do: `<provides>/<path>`
 *   is `<dir>/src/<path>`, and `<provides>` alone `<dir>/src/index.ts`; a module may import only
 *   itself and the modules its manifest imports;
 * - relative paths, `#` imports (its own `package.json`'s), URLs and Node's built-ins resolve as Node
 *   resolves them;
 * - any other name is refused: a module has no npm dependencies.
 *
 * Anything imported from outside the modules' directories is Node's, untouched.
 */
import { builtinModules } from 'node:module';
import { HOST_PACKAGES } from './modules.ts';

/** The modules as the hook sees them: plain data, handed to the hooks' thread. */
export interface ResolveTable {
  /** A file URL of the host's, from which its packages are resolved. */
  host: string;
  modules: { id: string; provides: string; dir: string; imports: string[] }[];
}

export type Route =
  | { url: string } // this file
  | { parent: string } // as if imported from this parent
  | { error: string }; // refused

const BUILTINS = new Set(builtinModules);

/** A directory's file URL, with its trailing slash. */
export const dirUrl = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

/** Where `specifier`, imported by `parent`, goes; undefined for Node's own resolution. */
export function route(
  table: ResolveTable,
  specifier: string,
  parent: string | undefined
): Route | undefined {
  const from =
    parent === undefined ? undefined : table.modules.find((m) => parent.startsWith(dirUrl(m.dir)));
  if (from === undefined) return undefined;
  if (
    /^(?:\.{1,2}\/|\/|#)/u.test(specifier) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(specifier) ||
    BUILTINS.has(specifier)
  )
    return undefined;
  if (HOST_PACKAGES.test(specifier)) return { parent: table.host };
  const to = table.modules.find(
    (m) => specifier === m.provides || specifier.startsWith(`${m.provides}/`)
  );
  if (to === undefined)
    return {
      error: `module ${from.id} imports ${specifier}: a module has no npm dependencies (the host offers zod and @megabottron1999/*; other modules by the name they provide, declared in imports)`,
    };
  if (to !== from && !from.imports.includes(to.provides))
    return {
      error: `module ${from.id} imports ${specifier}, and its module.json does not import ${to.provides}`,
    };
  const rest = specifier.slice(to.provides.length + 1);
  return { url: new URL(rest === '' ? 'src/index.ts' : `src/${rest}`, dirUrl(to.dir)).href };
}
