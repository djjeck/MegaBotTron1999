/**
 * The modules' resolve hook (docs/bot-os-api.md §7), registered by the loader with
 * `module.register` and run on Node's hooks thread: `initialize` receives the table of modules,
 * `resolve` applies `route` (module-resolve.ts) to every import.
 */
import { type InitializeHook, type ResolveHook } from 'node:module';
import { type ResolveTable, route } from './module-resolve.ts';

let table: ResolveTable = { host: '', modules: [] };

export const initialize: InitializeHook<ResolveTable> = (data) => {
  table = data;
};

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  const r = route(table, specifier, context.parentURL);
  if (r === undefined) return nextResolve(specifier, context);
  if ('url' in r) return { url: r.url, shortCircuit: true };
  if ('parent' in r) return nextResolve(specifier, { ...context, parentURL: r.parent });
  throw Object.assign(new Error(r.error), { code: 'ERR_MODULE_NOT_FOUND' });
};
