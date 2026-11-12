import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { manifestOf, tarOf, tempDir, writeModule } from '#test/modules.ts';
import { type ModulesLoad } from './module-loader.ts';
import { type GraphNodeRef, ModuleInUse, ModuleStore } from './module-store.ts';
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

  it('writes files uploaded one by one, from the root or from their one directory', () => {
    const store = new ModuleStore(tempDir());
    const file = (p: string, text: string) => ({ path: p, content: Buffer.from(text) });
    const manifest = (v: string) => JSON.stringify(manifestOf('dice', { version: v }));
    expect(
      store.install({
        files: [
          file('module.json', manifest('0.1.0')),
          file('./src/roll.ts', 'export {};'),
          file('src\\deep\\er.ts', 'export {};'),
          file('.git/HEAD', 'ref'),
          file('node_modules/x/index.js', ''),
          file('src/node_modules/y.js', ''),
        ],
      })
    ).toEqual({ id: 'dice', version: '0.1.0' });
    const at = path.join(store.dir, 'dice');
    expect(fs.readFileSync(path.join(at, 'src/roll.ts'), 'utf8')).toBe('export {};');
    expect(fs.existsSync(path.join(at, 'src/deep/er.ts'))).toBe(true);
    expect(fs.existsSync(path.join(at, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(at, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(at, 'src/node_modules'))).toBe(false);
    // A folder picked in a browser: every path under its one directory, which is stripped.
    expect(
      store.install({
        files: [
          file('dice-main/module.json', manifest('0.2.0')),
          file('dice-main/src/roll.ts', 'export const v = 2;'),
          file('dice-main/.git/config', ''),
        ],
      })
    ).toEqual({ id: 'dice', version: '0.2.0', previous: '0.1.0' });
    expect(fs.readFileSync(path.join(at, 'src/roll.ts'), 'utf8')).toBe('export const v = 2;');
    expect(fs.existsSync(path.join(at, 'dice-main'))).toBe(false);
    expect(version(path.join(store.dir, '.previous', 'dice'))).toBe('0.1.0');
  });

  it('refuses files that leave the module’s directory, or are not a module', () => {
    const store = new ModuleStore(tempDir());
    const file = (p: string) => ({ path: p, content: Buffer.from('{}') });
    const ok = file('module.json');
    for (const bad of ['../evil', 'src/../../evil', '/etc/passwd', '\\evil', 'C:/evil', 'c:evil'])
      expect(() => store.install({ files: [ok, file(bad)] })).toThrow(
        `${bad} leaves the module's directory`
      );
    expect(() => store.install({ files: [file('./')] })).toThrow('a file has no path');
    expect(() => store.install({ files: [] })).toThrow(
      'no module.json at the root, nor in a single directory'
    );
    expect(() => store.install({ files: [file('a/module.json'), file('b/module.json')] })).toThrow(
      'no module.json at the root, nor in a single directory'
    );
    expect(() => store.install({ files: [file('a/module.json')] })).toThrow(/^module\.json: /u);
    expect(fs.readdirSync(path.join(store.dir, '.staging'))).toEqual([]);
    expect(fs.existsSync(path.join(store.dir, '..', 'evil'))).toBe(false);
    expect(store.report().installed).toEqual([]);
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
        source: expect.objectContaining({ kind: 'directory' }) as unknown,
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

describe('what an install keeps', () => {
  it('leaves out the tests, or keeps what the files globs name, and says how many', () => {
    const store = new ModuleStore(tempDir());
    const from = source('dice', '0.1.0', {
      'src/roll.ts': '',
      'src/roll.test.ts': '',
      'test/helpers.ts': '',
      'README.md': '',
    });
    expect(store.install({ dir: from })).toEqual({ id: 'dice', version: '0.1.0', left: 2 });
    expect(fs.readdirSync(path.join(store.dir, 'dice')).sort()).toEqual([
      'README.md',
      'module.json',
      'src',
    ]);
    const globbed = writeModule(
      tempDir(),
      'cards',
      manifestOf('cards', { files: ['src/**/*.ts'] }),
      {
        'src/a.ts': '',
        'src/a.test.ts': '',
        'notes.md': '',
      }
    );
    expect(store.install({ dir: globbed })).toMatchObject({ left: 1 });
    expect(fs.existsSync(path.join(store.dir, 'cards', 'src', 'a.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(store.dir, 'cards', 'notes.md'))).toBe(false);
  });

  it('refuses a module whose plugin entry is not among its files', () => {
    const store = new ModuleStore(tempDir());
    const from = writeModule(
      tempDir(),
      'dice',
      manifestOf('dice', { plugins: ['src/p.test.ts'] }),
      {
        'src/p.test.ts': '',
      }
    );
    expect(() => store.install({ dir: from })).toThrow(
      'its plugin entry src/p.test.ts is not there'
    );
    expect(fs.existsSync(path.join(store.dir, 'dice'))).toBe(false);
  });
});

describe('a module’s source', () => {
  it('is recorded at each install, with its time, and swapped by a rollback', () => {
    let now = Date.parse('2026-11-12T10:00:00Z');
    const store = new ModuleStore(tempDir(), () => now);
    const tarball = (v: string) =>
      zlib.gzipSync(
        tarOf([{ name: 'module.json', data: JSON.stringify(manifestOf('dice', { version: v })) }])
      );
    store.install({ tarball: tarball('0.1.0'), name: 'dice.tar.gz' });
    now += 60_000;
    store.install({
      files: [
        {
          path: 'module.json',
          content: Buffer.from(JSON.stringify(manifestOf('dice', { version: '0.2.0' }))),
        },
      ],
      name: 'games/dice',
    });
    const first = { kind: 'tarball', name: 'dice.tar.gz', installedAt: '2026-11-12T10:00:00.000Z' };
    const second = { kind: 'folder', name: 'games/dice', installedAt: '2026-11-12T10:01:00.000Z' };
    expect(store.sources()).toEqual({ dice: { current: second, previous: first } });
    expect(store.report().installed[0]?.source).toEqual(second);
    store.rollback('dice');
    expect(store.sources()).toEqual({ dice: { current: first, previous: second } });
    // A module with no record, as before D67: none shown, and a rollback leaves the file alone.
    writeModule(store.dir, 'old', manifestOf('old'));
    writeModule(path.join(store.dir, '.previous'), 'old', manifestOf('old', { version: '0.0.1' }));
    store.rollback('old');
    expect(store.report().installed.find((m) => m.id === 'old')).not.toHaveProperty('source');
    // An install that replaces nothing (a module removed by hand) keeps the previous version, and
    // so its record.
    fs.rmSync(path.join(store.dir, 'dice'), { recursive: true });
    store.install({ tarball: tarball('0.3.0') });
    expect(store.sources()['dice']).toEqual({
      current: { kind: 'tarball', installedAt: '2026-11-12T10:01:00.000Z' },
      previous: second,
    });
  });

  it('reads as none from a file that is not a record', () => {
    const store = new ModuleStore(tempDir());
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, '.sources.json'), '[1]');
    expect(store.sources()).toEqual({});
    fs.writeFileSync(path.join(store.dir, '.sources.json'), '{ not json');
    expect(store.sources()).toEqual({});
    store.install({ dir: source('dice', '0.1.0') });
    expect(Object.keys(store.sources())).toEqual(['dice']);
  });
});

describe('a tree’s modules', () => {
  it('are compared with those installed', () => {
    const store = new ModuleStore(tempDir());
    store.install({ dir: source('dice', '0.2.0') });
    writeModule(store.dir, 'broken', '{');
    const m = (id: string, v: string) => JSON.stringify(manifestOf(id, { version: v }));
    expect(
      store
        .plan({
          paths: ['repo/a/module.json', 'repo/b/module.json', 'repo/c/module.json'],
          manifests: {
            'repo/a/module.json': m('dice', '0.1.0'),
            'repo/b/module.json': m('broken', '1.0.0'),
            'repo/c/module.json': m('cards', '1.0.0'),
          },
        })
        .map((c) => [c.id, c.status, c.installed])
    ).toEqual([
      ['dice', 'older', '0.2.0'],
      ['broken', 'new', undefined],
      ['cards', 'new', undefined],
    ]);
  });
});

/** What the running instance loaded: each module given, with the plugins it offers. */
function loadOf(store: ModuleStore, plugins: Record<string, string[]>): ModulesLoad {
  return {
    modules: Object.entries(plugins).map(([id, ids]) => ({
      id,
      version: '0.1.0',
      dir: path.join(store.dir, id),
      manifest: moduleManifestSchema.parse(manifestOf(id)),
      plugins: ids,
    })),
    failures: [],
    plugins: [],
  };
}

describe('removing a module', () => {
  it('keeps it as the previous version, its record too, lists it removed, and restores it', () => {
    let now = Date.parse('2026-11-12T10:00:00Z');
    const store = new ModuleStore(tempDir(), () => now);
    store.install({ dir: source('dice', '0.1.0') });
    now += 60_000;
    store.install({ dir: source('dice', '0.2.0', { 'src/p.ts': '' }) });
    const second = store.sources()['dice']?.current;
    const load = loadOf(store, { dice: ['dice-roll'] });
    expect(store.remove('dice', load)).toEqual({ id: 'dice', version: '0.2.0' });
    // The version removed replaced the older previous one, and its record followed it.
    expect(fs.existsSync(path.join(store.dir, 'dice'))).toBe(false);
    expect(version(path.join(store.dir, '.previous', 'dice'))).toBe('0.2.0');
    expect(store.sources()).toEqual({ dice: { previous: second } });
    const report = store.report(load);
    expect(report.installed).toEqual([]);
    expect(report.removed).toEqual([
      { id: 'dice', version: '0.2.0', loaded: '0.1.0', source: second },
    ]);
    // dice is loaded and removed: a restart applies it. Not loaded, nothing to apply.
    expect(report.restart).toBe(true);
    expect(store.report().restart).toBe(false);
    expect(() => store.remove('dice')).toThrow('dice is not installed');
    // Restore is the rollback.
    expect(store.rollback('dice')).toEqual({ id: 'dice', version: '0.2.0' });
    expect(store.sources()).toEqual({ dice: { current: second } });
    expect(store.report().removed).toBeUndefined();
  });

  it('is replaced by an install of its id, which keeps the version removed as its previous', () => {
    const store = new ModuleStore(tempDir());
    store.install({ dir: source('dice', '0.2.0') });
    store.remove('dice');
    expect(store.install({ dir: source('dice', '0.3.0') })).toEqual({
      id: 'dice',
      version: '0.3.0',
    });
    const report = store.report();
    expect(report.removed).toBeUndefined();
    expect(report.installed).toMatchObject([{ id: 'dice', version: '0.3.0', previous: '0.2.0' }]);
    expect(store.sources()['dice']).toMatchObject({
      current: { kind: 'directory' },
      previous: { kind: 'directory' },
    });
    expect(store.rollback('dice')).toMatchObject({ version: '0.2.0', previous: '0.3.0' });
  });

  it('removes one with no record, or whose manifest does not read, and lists it so', () => {
    const store = new ModuleStore(tempDir());
    writeModule(store.dir, 'old', manifestOf('old'));
    writeModule(store.dir, 'broken', '{');
    writeModule(store.dir, 'dice', manifestOf('dice'));
    // dice: no current record, but a previous one, dropped as its version is replaced.
    fs.writeFileSync(
      path.join(store.dir, '.sources.json'),
      JSON.stringify({ dice: { previous: { kind: 'tarball', installedAt: '2026-11-12' } } })
    );
    store.remove('dice');
    expect(store.sources()).toEqual({});
    expect(store.remove('old')).toEqual({ id: 'old', version: '0.1.0' });
    expect(store.remove('broken')).toEqual({ id: 'broken' });
    expect(store.report().removed).toEqual([
      { id: 'broken', error: expect.stringMatching(/^module\.json: /u) as unknown },
      { id: 'dice', version: '0.1.0' },
      { id: 'old', version: '0.1.0' },
    ]);
    expect(() => store.remove('../etc')).toThrow('../etc is not installed');
    expect(() => store.remove('.previous')).toThrow('.previous is not installed');
  });

  it('is refused while the saved graph’s nodes use its plugins, or another module imports it', () => {
    const store = new ModuleStore(tempDir());
    store.install({ dir: source('dice', '0.1.0') });
    writeModule(
      store.dir,
      'cards',
      manifestOf('cards', { imports: { '@example/dice': '^0.1.0' } })
    );
    writeModule(
      store.dir,
      'poker',
      manifestOf('poker', { imports: { '@example/dice': '*', '@example/cards': '*' } })
    );
    writeModule(store.dir, 'broken', '{');
    const load = loadOf(store, { dice: ['dice-roll', 'dice-score'], cards: ['cards'] });
    const nodes: GraphNodeRef[] = [
      { id: 'roller', plugin: 'dice-roll' },
      { id: 'scorer', plugin: 'dice-score' },
      { id: 'dealer', plugin: 'cards' },
      { id: 'irc', plugin: 'irc' },
    ];
    const why = (id: string) => store.report(load, nodes).installed.find((m) => m.id === id)?.inUse;
    expect(why('dice')).toBe(
      "the saved graph's nodes roller (dice-roll) and scorer (dice-score) use it: delete or " +
        'replace them first; modules cards and poker import it (@example/dice)'
    );
    expect(why('cards')).toBe(
      "the saved graph's node dealer (cards) uses it: delete or replace it first; module poker " +
        'imports it (@example/cards)'
    );
    expect(why('poker')).toBeUndefined();
    expect(why('broken')).toBeUndefined();
    expect(() => store.remove('dice', load, nodes)).toThrow(ModuleInUse);
    expect(() => store.remove('cards', load, nodes)).toThrow(
      "cards cannot be removed: the saved graph's node dealer (cards) uses it"
    );
    expect(fs.existsSync(path.join(store.dir, 'dice'))).toBe(true);
    // Without its importers, a module not loaded uses no node: its plugins are not known.
    expect(store.remove('poker', load, nodes)).toEqual({ id: 'poker', version: '0.1.0' });
    expect(() => store.remove('cards', load, nodes)).toThrow('uses it');
    expect(store.remove('cards', load, [])).toEqual({ id: 'cards', version: '0.1.0' });
    expect(store.remove('dice', undefined, nodes)).toEqual({ id: 'dice', version: '0.1.0' });
  });
});
