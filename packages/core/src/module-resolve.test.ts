import { describe, expect, it } from 'vitest';
import { initialize, resolve } from './module-hooks.ts';
import { type ResolveTable, route } from './module-resolve.ts';

const HOST = 'file:///app/src/main.ts';
const table: ResolveTable = {
  host: HOST,
  modules: [
    { id: 'dice', provides: '@example/dice', dir: 'file:///data/modules/dice/', imports: [] },
    {
      id: 'tactics',
      provides: '@example/dice-tactics',
      dir: 'file:///data/modules/tactics',
      imports: ['@example/dice'],
    },
  ],
};
const IN_TACTICS = 'file:///data/modules/tactics/src/plugins/p.ts';
const IN_DICE = 'file:///data/modules/dice/src/roll.ts';

describe('where a module’s import goes', () => {
  it('leaves what is imported from outside the modules to Node', () => {
    expect(route(table, 'zod', HOST)).toBe(undefined);
    expect(route(table, '@example/dice', undefined)).toBe(undefined);
    expect(route(table, 'zod', 'file:///data/modules/dice-other/a.ts')).toBe(undefined);
  });

  it('leaves relative paths, # imports, URLs and built-ins to Node', () => {
    for (const s of ['./a.ts', '../b.ts', '/abs.ts', '#src/a.ts', 'node:fs', 'fs', 'file:///x.ts'])
      expect(route(table, s, IN_DICE)).toBe(undefined);
  });

  it('resolves the host’s packages as from the host', () => {
    for (const s of ['zod', 'zod/v4', '@megabottron1999/core', '@megabottron1999/turns/a.ts'])
      expect(route(table, s, IN_TACTICS)).toEqual({ parent: HOST });
  });

  it('maps a provided name to its directory’s src, and itself to src/index.ts', () => {
    expect(route(table, '@example/dice/state/game.ts', IN_TACTICS)).toEqual({
      url: 'file:///data/modules/dice/src/state/game.ts',
    });
    expect(route(table, '@example/dice', IN_TACTICS)).toEqual({
      url: 'file:///data/modules/dice/src/index.ts',
    });
    expect(route(table, '@example/dice-tactics/x.ts', IN_TACTICS)).toEqual({
      url: 'file:///data/modules/tactics/src/x.ts',
    });
  });

  it('refuses a module not imported, and any npm package', () => {
    expect(route(table, '@example/dice-tactics/x.ts', IN_DICE)).toEqual({
      error:
        'module dice imports @example/dice-tactics/x.ts, and its module.json does not import @example/dice-tactics',
    });
    expect(route(table, 'left-pad', IN_DICE)).toMatchObject({
      error: expect.stringContaining(
        'module dice imports left-pad: a module has no npm dependencies'
      ) as unknown,
    });
  });
});

describe('the resolve hook', () => {
  const next = (specifier: string, context?: { parentURL?: string | undefined }) => ({
    url: `resolved:${specifier}@${context?.parentURL ?? ''}`,
  });

  it('routes each import as the table it was given says', async () => {
    initialize(table);
    const context = { conditions: [], importAttributes: {}, parentURL: IN_TACTICS };
    expect(await resolve('./a.ts', context, next)).toEqual({
      url: `resolved:./a.ts@${IN_TACTICS}`,
    });
    expect(await resolve('zod', context, next)).toEqual({ url: `resolved:zod@${HOST}` });
    expect(await resolve('@example/dice/roll.ts', context, next)).toEqual({
      url: 'file:///data/modules/dice/src/roll.ts',
      shortCircuit: true,
    });
    expect(() => resolve('left-pad', context, next)).toThrow(
      expect.objectContaining({ code: 'ERR_MODULE_NOT_FOUND' })
    );
  });
});
