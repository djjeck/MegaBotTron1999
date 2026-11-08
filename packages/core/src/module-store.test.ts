import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { manifestOf, tarOf, tempDir, writeModule } from '#test/modules.ts';
import { type ModulesLoad } from './module-loader.ts';
import { ModuleStore } from './module-store.ts';
import { moduleManifestSchema } from './modules.ts';

const version = (dir: string): unknown =>
  (JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')) as { version: string })
    .version;

/** A module's source directory, of the version given. */
function source(id: string, v: string, files: Record<string, string> = {}): string {
  return writeModule(tempDir('source-'), id, manifestOf(id, { version: v }), files);
}

describe('installing a module', () => {
  it('copies a directory, leaving its repository and dependencies behind', () => {
    const store = new ModuleStore(path.join(tempDir(), 'modules'));
    const from = source('dice', '0.1.0', {
      'src/roll.ts': 'export {};',
      'node_modules/x/index.js': '',
      '.git/HEAD': '',
    });
    expect(store.install({ dir: from })).toEqual({ id: 'dice', version: '0.1.0' });
    const at = path.join(store.dir, 'dice');
    expect(fs.readFileSync(path.join(at, 'src/roll.ts'), 'utf8')).toBe('export {};');
    expect(fs.existsSync(path.join(at, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(at, '.git'))).toBe(false);
  });

  it('keeps the version it replaces, and rolls back and forward', () => {
    const store = new ModuleStore(tempDir());
    store.install({ dir: source('dice', '0.1.0') });
    expect(store.install({ dir: source('dice', '0.2.0') })).toEqual({
      id: 'dice',
      version: '0.2.0',
      previous: '0.1.0',
    });
    expect(store.install({ dir: source('dice', '0.3.0') })).toMatchObject({ previous: '0.2.0' });
    const at = path.join(store.dir, 'dice');
    const kept = path.join(store.dir, '.previous', 'dice');
    expect([version(at), version(kept)]).toEqual(['0.3.0', '0.2.0']);
    expect(store.rollback('dice')).toEqual({ id: 'dice', version: '0.2.0', previous: '0.3.0' });
    expect([version(at), version(kept)]).toEqual(['0.2.0', '0.3.0']);
    expect(store.rollback('dice')).toEqual({ id: 'dice', version: '0.3.0', previous: '0.2.0' });
    expect(fs.readdirSync(path.join(store.dir, '.staging'))).toEqual([]);
  });

  it('rolls back a module removed by hand, and refuses one with no previous version', () => {
    const store = new ModuleStore(tempDir());
    store.install({ dir: source('dice', '0.1.0') });
    store.install({ dir: source('dice', '0.2.0') });
    fs.rmSync(path.join(store.dir, 'dice'), { recursive: true });
    expect(store.rollback('dice')).toEqual({ id: 'dice', version: '0.1.0' });
    expect(fs.existsSync(path.join(store.dir, '.previous', 'dice'))).toBe(false);
    expect(() => store.rollback('dice')).toThrow('dice has no previous version');
    expect(() => store.rollback('../etc')).toThrow('has no previous version');
    expect(() => store.rollback('.staging')).toThrow('has no previous version');
  });

  it('unpacks a tarball, at its root or in its one directory, gzipped or not', () => {
    const store = new ModuleStore(tempDir());
    const manifest = JSON.stringify(manifestOf('dice', { version: '1.0.0' }));
    store.install({
      tarball: tarOf([
        { name: 'module.json', data: manifest },
        { name: 'src/roll.ts', data: 'export {};' },
      ]),
    });
    expect(fs.existsSync(path.join(store.dir, 'dice/src/roll.ts'))).toBe(true);
    const prefixed = tarOf([
      { name: 'dice-1.0.1/' },
      {
        name: 'dice-1.0.1/module.json',
        data: JSON.stringify(manifestOf('dice', { version: '1.0.1' })),
      },
    ]);
    expect(store.install({ tarball: zlib.gzipSync(prefixed) })).toEqual({
      id: 'dice',
      version: '1.0.1',
      previous: '1.0.0',
    });
  });

  it('unpacks what the system’s tar makes', () => {
    const store = new ModuleStore(tempDir());
    const from = source('dice', '0.4.0', { 'src/deep/er/roll.ts': 'export {};' });
    const archive = path.join(tempDir('tar-'), 'dice.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(from), 'dice'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    expect(store.install({ tarball: fs.readFileSync(archive) })).toEqual({
      id: 'dice',
      version: '0.4.0',
    });
    expect(fs.existsSync(path.join(store.dir, 'dice/src/deep/er/roll.ts'))).toBe(true);
  });

  it('refuses what is not a module, and leaves nothing behind', () => {
    const store = new ModuleStore(tempDir());
    expect(() => store.install({ dir: path.join(store.dir, 'none') })).toThrow(
      'is not a directory'
    );
    expect(() => store.install({ dir: tempDir() })).toThrow(
      'no module.json at the root, nor in a single directory'
    );
    expect(() => store.install({ dir: writeModule(tempDir(), 'x', '{"id": 1}') })).toThrow(
      /^module\.json: /u
    );
    expect(() => store.install({ tarball: tarOf([{ name: '../evil', data: '' }]) })).toThrow(
      "tar: ../evil leaves the archive's directory"
    );
    expect(fs.readdirSync(path.join(store.dir, '.staging'))).toEqual([]);
    expect(store.report().installed).toEqual([]);
  });
});

describe('the modules’ report', () => {
  it('lists each installed, with its previous and loaded versions, and the start’s failures', () => {
    const store = new ModuleStore(tempDir());
    store.install({ dir: source('dice', '0.1.0') });
    store.install({ dir: source('dice', '0.2.0') });
    writeModule(
      store.dir,
      'cards',
      manifestOf('cards', { description: 'Cards', plugins: ['src/p.ts'] })
    );
    writeModule(store.dir, 'broken', '{');
    const load: ModulesLoad = {
      modules: [
        {
          id: 'cards',
          version: '0.1.0',
          dir: path.join(store.dir, 'cards'),
          manifest: moduleManifestSchema.parse(manifestOf('cards')),
          plugins: [],
        },
      ],
      failures: [{ id: 'broken', reason: 'module.json: bad' }],
      plugins: [],
    };
    const report = store.report(load);
    expect(report.installed).toEqual([
      { id: 'broken', error: expect.stringMatching(/^module\.json: /u) as unknown },
      {
        id: 'cards',
        version: '0.1.0',
        description: 'Cards',
        provides: '@example/cards',
        imports: {},
        plugins: ['src/p.ts'],
        loaded: '0.1.0',
      },
      {
        id: 'dice',
        version: '0.2.0',
        provides: '@example/dice',
        imports: {},
        plugins: [],
        previous: '0.1.0',
      },
    ]);
    expect(report.failures).toEqual(load.failures);
    // dice is installed and not loaded: a restart takes it up.
    expect(report.restart).toBe(true);
    fs.rmSync(path.join(store.dir, 'dice'), { recursive: true });
    expect(store.report(load).restart).toBe(false);
    fs.rmSync(path.join(store.dir, 'cards'), { recursive: true });
    expect(store.report(load).restart).toBe(true);
  });
});
