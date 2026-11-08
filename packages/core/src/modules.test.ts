import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestOf, tempDir, writeModule } from '#test/modules.ts';
import {
  discoverModules,
  type FoundModule,
  installedIds,
  moduleManifestSchema,
  planModules,
  readModuleManifest,
} from './modules.ts';

const found = (id: string, more: Record<string, unknown> = {}): FoundModule => ({
  id,
  dir: `/data/modules/${id}`,
  manifest: moduleManifestSchema.parse(manifestOf(id, more)),
});

describe('a module’s manifest', () => {
  it('reads the essentials, with no imports and no plugins by default', () => {
    const dir = writeModule(tempDir(), 'dice', manifestOf('dice'));
    expect(readModuleManifest(dir)).toEqual({
      id: 'dice',
      version: '0.1.0',
      api: '1',
      provides: '@example/dice',
      imports: {},
      plugins: [],
    });
  });

  it('says what is wrong with a bad one', () => {
    const root = tempDir();
    expect(() => readModuleManifest(path.join(root, 'none'))).toThrow('no module.json');
    expect(() => readModuleManifest(writeModule(root, 'a', '{'))).toThrow(/^module\.json: /u);
    const bad = writeModule(
      root,
      'b',
      manifestOf('B', {
        version: '1',
        provides: 'zod',
        imports: { '@example/x': 'latest' },
        plugins: ['../outside.ts', 'src/a.js'],
        extra: true,
      })
    );
    const error = (() => {
      try {
        readModuleManifest(bad);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    for (const part of [
      'id: lower-case words and dashes',
      'version: a version',
      'provides: a name the host offers',
      'imports.@example/x: a version range',
      'plugins.0: a .ts file inside the module',
      'plugins.1: a .ts file inside the module',
      'Unrecognized key',
    ])
      expect(error).toContain(part);
    expect(() =>
      readModuleManifest(
        writeModule(root, 'c', manifestOf('c', { provides: '@megabottron1999/x' }))
      )
    ).toThrow('a name the host offers');
  });
});

describe('discovering modules', () => {
  it('reads each directory but the hidden ones, refusing those that do not read', () => {
    const root = tempDir();
    writeModule(root, 'dice', manifestOf('dice', { plugins: ['src/p.ts'] }), {
      'src/p.ts': '',
    });
    writeModule(root, 'cards', manifestOf('other'));
    writeModule(root, 'coins', manifestOf('coins', { plugins: ['src/missing.ts'] }));
    writeModule(root, '.previous', manifestOf('previous'));
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    const { found: ok, failures } = discoverModules(root);
    expect(ok.map((m) => m.id)).toEqual(['dice']);
    expect(failures).toEqual([
      { id: 'cards', reason: 'its id is other, and its directory cards' },
      { id: 'coins', reason: 'its plugin entry src/missing.ts is not there' },
    ]);
    expect(installedIds(path.join(root, 'absent'))).toEqual([]);
  });
});

describe('planning the modules', () => {
  it('orders them after what they import, in range', () => {
    const { ordered, failures } = planModules([
      found('tactics', { imports: { '@example/dice': '^0.1.0', '@example/tools': '>=0.1.0' } }),
      found('tools', { imports: { '@example/dice': '0.1.0' } }),
      found('dice'),
    ]);
    expect(failures).toEqual([]);
    expect(ordered.map((m) => m.id)).toEqual(['dice', 'tools', 'tactics']);
  });

  it('refuses another API, a missing import and one out of range, and those that import them', () => {
    const { ordered, failures } = planModules([
      found('old', { api: '0' }),
      found('lonely', { imports: { '@example/nowhere': '^1.0.0' } }),
      found('picky', { imports: { '@example/dice': '^0.2.0' } }),
      found('dice'),
      found('user', { imports: { '@example/old': '*' } }),
      found('fine', { imports: { '@example/dice': '~0.1.0' } }),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['dice', 'fine']);
    expect(failures).toEqual([
      { id: 'old', reason: 'it targets plugin API 0, and this shell offers 1' },
      { id: 'lonely', reason: 'it imports @example/nowhere, which no module provides' },
      { id: 'picky', reason: 'it imports @example/dice ^0.2.0, and dice 0.1.0 is installed' },
      { id: 'user', reason: 'it imports @example/old, which is refused' },
    ]);
  });

  it('refuses a name provided twice', () => {
    const { ordered, failures } = planModules([
      found('a', { provides: '@example/same' }),
      found('b', { provides: '@example/same' }),
      found('c', { imports: { '@example/same': '*' } }),
    ]);
    expect(ordered).toEqual([]);
    expect(failures).toEqual([
      { id: 'a', reason: '@example/same is provided by a and b' },
      { id: 'b', reason: '@example/same is provided by a and b' },
      { id: 'c', reason: 'it imports @example/same, which is refused' },
    ]);
  });

  it('refuses a cycle, and what is behind it, and loads the rest', () => {
    const { ordered, failures } = planModules([
      found('a', { imports: { '@example/b': '*' } }),
      found('b', { imports: { '@example/c': '*' } }),
      found('c', { imports: { '@example/a': '*' } }),
      found('d', { imports: { '@example/a': '*' } }),
      found('self', { imports: { '@example/self': '*' } }),
      found('e'),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['e']);
    expect(failures).toEqual([
      { id: 'a', reason: 'its imports form a cycle: a → b → c → a' },
      { id: 'b', reason: 'its imports form a cycle: b → c → a → b' },
      { id: 'c', reason: 'its imports form a cycle: c → a → b → c' },
      { id: 'd', reason: 'it imports a module in a cycle of imports' },
      { id: 'self', reason: 'its imports form a cycle: self → self' },
    ]);
  });
});
