import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { entrySource, manifestOf, tempDir, writeModule } from '#test/modules.ts';
import { loadModules } from './module-loader.ts';
import { type ResolveTable } from './module-resolve.ts';

const HOST = 'file:///app/src/main.ts';

/** Loads `dir` in place, with the hook's table kept rather than registered. */
async function load(dir: string, reserved: string[] = []) {
  const tables: ResolveTable[] = [];
  const result = await loadModules({ dir, host: HOST, reserved, register: (t) => tables.push(t) });
  return { ...result, tables };
}

describe('loading modules', () => {
  it('imports each module’s plugin entries in the order of their imports', async () => {
    const root = tempDir();
    writeModule(
      root,
      'tactics',
      manifestOf('tactics', { imports: { '@example/dice': '^0.1.0' }, plugins: ['src/p.ts'] }),
      { 'src/p.ts': entrySource('dice-tactics') }
    );
    writeModule(root, 'dice', manifestOf('dice', { plugins: ['src/a.ts', 'src/b.ts'] }), {
      'src/a.ts': entrySource('dice-parser'),
      'src/b.ts': entrySource('dice-stats', 'dice-roller'),
    });
    const r = await load(root);
    expect(r.failures).toEqual([]);
    expect(r.modules.map((m) => [m.id, m.version, m.plugins])).toEqual([
      ['dice', '0.1.0', ['dice-parser', 'dice-stats', 'dice-roller']],
      ['tactics', '0.1.0', ['dice-tactics']],
    ]);
    expect(r.plugins.map((p) => `${p.module}:${p.plugin.manifest.id}`)).toEqual([
      'dice:dice-parser',
      'dice:dice-stats',
      'dice:dice-roller',
      'tactics:dice-tactics',
    ]);
    expect(r.tables).toEqual([
      {
        host: HOST,
        modules: [
          {
            id: 'dice',
            provides: '@example/dice',
            dir: `${pathToFileURL(fs.realpathSync(path.join(root, 'dice'))).href}/`,
            imports: [],
          },
          {
            id: 'tactics',
            provides: '@example/tactics',
            dir: `${pathToFileURL(fs.realpathSync(path.join(root, 'tactics'))).href}/`,
            imports: ['@example/dice'],
          },
        ],
      },
    ]);
  });

  it('registers no hook when no module loads', async () => {
    const root = tempDir();
    writeModule(root, 'bad', '{');
    const r = await load(root);
    expect(r.tables).toEqual([]);
    expect(r.failures).toEqual([
      { id: 'bad', reason: expect.stringMatching(/^module\.json: /u) as unknown },
    ]);
    expect((await load(path.join(root, 'absent'))).modules).toEqual([]);
  });

  it('refuses a module whose entries fail, and the modules that import it', async () => {
    const root = tempDir();
    const entry = (id: string, source: string, more: Record<string, unknown> = {}) =>
      writeModule(root, id, manifestOf(id, { plugins: ['src/p.ts'], ...more }), {
        'src/p.ts': source,
      });
    entry('throws', "throw new Error('broken at import');");
    entry('user', entrySource('user-plugin'), { imports: { '@example/throws': '*' } });
    entry('empty', 'export const other = 1;');
    entry('odd', 'export const plugins = [{ manifest: {} }];');
    entry('invalid', "export const plugins = [{ manifest: { id: 'x' }, create: () => ({}) }];");
    entry('clash', entrySource('irc'));
    entry('twice', entrySource('same', 'same'));
    entry('first', entrySource('shared'));
    entry('second', entrySource('shared'));
    entry('good', entrySource('good-plugin'));
    const r = await load(root, ['irc']);
    expect(r.modules.map((m) => m.id)).toEqual(['first', 'good']);
    expect(Object.fromEntries(r.failures.map((f) => [f.id, f.reason]))).toEqual({
      throws: 'src/p.ts failed to load: broken at import',
      user: 'it imports @example/throws, which is refused',
      empty: 'src/p.ts exports no plugins array',
      odd: 'src/p.ts: plugins[0] is not a plugin (a manifest and a create function)',
      invalid: expect.stringMatching(/^plugin x: bad manifest: /u) as unknown,
      clash: 'its plugin irc is offered by the image already',
      twice: 'its plugin same is offered by module twice already',
      second: 'its plugin shared is offered by module first already',
    });
  });
});

describe('loading modules through the resolve hook, in a process of their own', () => {
  it('resolves the host’s packages, the modules imported, and refuses the others', () => {
    const root = tempDir();
    const modules = path.join(root, 'modules');
    writeModule(modules, 'dice', manifestOf('dice'), {
      'src/roll.ts': 'export const faces: number = 6;\n',
      'src/index.ts': "export { faces } from './roll.ts';\n",
    });
    writeModule(
      modules,
      'dice-stats',
      manifestOf('dice-stats', {
        imports: { '@example/dice': '^0.1.0' },
        plugins: ['src/plugins/stats.ts'],
      }),
      {
        // Its workspace's package.json, for its # imports.
        'package.json': JSON.stringify({ type: 'module', imports: { '#src/*': './src/*' } }),
        'src/plugins/stats.ts': [
          "import { definePlugin, type Plugin } from '@megabottron1999/core';",
          "import { z } from 'zod';",
          "import { faces } from '@example/dice/roll.ts';",
          "import { faces as again } from '@example/dice';",
          "import { label } from '#src/label.ts';",
          'export const plugins: Plugin[] = [definePlugin({',
          "  manifest: { id: 'dice-stats', version: '0.1.0', kinds: ['stats'], description: label(faces + again),",
          '    settings: z.object({ every: z.number().default(1) }) },',
          '  create: () => ({}),',
          '})];',
        ].join('\n'),
        'src/label.ts': 'export const label = (n: number): string => `${n} faces`;\n',
      }
    );
    writeModule(modules, 'sneaky', manifestOf('sneaky', { plugins: ['src/p.ts'] }), {
      'src/p.ts': "import '@example/dice';\nexport const plugins = [];\n",
    });
    writeModule(modules, 'npm-user', manifestOf('npm-user', { plugins: ['src/p.ts'] }), {
      'src/p.ts': "import 'left-pad';\nexport const plugins = [];\n",
    });
    const loader = new URL('module-loader.ts', import.meta.url).href;
    const host = new URL('index.ts', import.meta.url).href;
    const script = path.join(root, 'run.ts');
    fs.writeFileSync(
      script,
      [
        `const { loadModules } = await import(${JSON.stringify(loader)});`,
        `const r = await loadModules({ dir: ${JSON.stringify(modules)}, host: ${JSON.stringify(host)} });`,
        'console.log(JSON.stringify({',
        '  plugins: r.plugins.map((p) => [p.module, p.plugin.manifest.id, p.plugin.manifest.description]),',
        '  failures: r.failures,',
        '}));',
      ].join('\n')
    );
    const out = JSON.parse(
      execFileSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8' })
    ) as { plugins: string[][]; failures: { id: string; reason: string }[] };
    expect(out.plugins).toEqual([['dice-stats', 'dice-stats', '12 faces']]);
    expect(Object.fromEntries(out.failures.map((f) => [f.id, f.reason]))).toEqual({
      sneaky: expect.stringContaining(
        'module sneaky imports @example/dice, and its module.json does not import @example/dice'
      ) as unknown,
      'npm-user': expect.stringContaining(
        'module npm-user imports left-pad: a module has no npm dependencies'
      ) as unknown,
    });
  });
});
