import { describe, expect, it } from 'vitest';
import {
  findModules,
  gitignored,
  globTest,
  ignoreRules,
  leftOutByDefault,
  selectFiles,
  statusOf,
  type TreeListing,
} from './module-files.ts';

const manifest = (id: string, more: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, version: '0.2.0', api: '1', provides: `@example/${id}`, ...more });

/** A tree from its files: every path, and the text of its `module.json` files. */
function tree(files: Record<string, string>): TreeListing {
  return {
    paths: Object.keys(files),
    manifests: Object.fromEntries(
      Object.entries(files).filter(([p]) => p === 'module.json' || p.endsWith('/module.json'))
    ),
  };
}

describe('a module’s files', () => {
  it('match globs: a segment, any depth, one character, a directory and all under it', () => {
    expect(globTest('src/*.ts')('src/a.ts')).toBe(true);
    expect(globTest('src/*.ts')('src/x/a.ts')).toBe(false);
    expect(globTest('src/**/*.ts')('src/a.ts')).toBe(true);
    expect(globTest('src/**/*.ts')('src/x/y/a.ts')).toBe(true);
    expect(globTest('./src/')('src/x/y/a.ts')).toBe(true);
    expect(globTest('a?.json')('ab.json')).toBe(true);
    expect(globTest('a?.json')('a/.json')).toBe(false);
    expect(globTest('**')('anything/at/all')).toBe(true);
    expect(globTest('data\\fonts')('data/fonts/f.ttf')).toBe(true);
    expect(globTest('a+b(c).ts')('a+b(c).ts')).toBe(true);
  });

  it('leave out tests, snapshots and the module’s own vendor by default', () => {
    for (const p of [
      'src/a.test.ts',
      'src/a.spec.tsx',
      'src/b.test.mjs',
      'test/helpers.ts',
      'src/tests/x.ts',
      'src/__tests__/x.ts',
      'src/map/__snapshots__/map.test.ts.snap',
      'vendor/lib/x.ts',
    ])
      expect(leftOutByDefault(p), p).toBe(true);
    for (const p of ['src/a.ts', 'src/vendor/x.ts', 'src/testing.ts', 'README.md', 'test.ts'])
      expect(leftOutByDefault(p), p).toBe(false);
  });

  it('are those its globs name when it has them, always with its module.json', () => {
    const rels = [
      'module.json',
      'src/a.ts',
      'src/a.test.ts',
      'docs/x.md',
      '.git/HEAD',
      'node_modules/z/i.js',
    ];
    expect(selectFiles(rels)).toEqual({
      kept: ['module.json', 'src/a.ts', 'docs/x.md'],
      left: ['src/a.test.ts'],
    });
    expect(selectFiles(rels, ['src'])).toEqual({
      kept: ['module.json', 'src/a.ts', 'src/a.test.ts'],
      left: ['docs/x.md'],
    });
  });

  it('compare a version with the one installed', () => {
    expect(statusOf('1.0.0', undefined)).toBe('new');
    expect(statusOf('1.1.0', '1.0.0')).toBe('update');
    expect(statusOf('1.0.0', '1.0.0')).toBe('same');
    expect(statusOf('1.0.0-alpha.1', '1.0.0')).toBe('older');
    expect(statusOf('1.0.0', 'nonsense')).toBe('same');
  });
});

describe('the modules in a tree', () => {
  const repo = tree({
    'README.md': '',
    'package.json': '{}',
    'modules/dice/module.json': manifest('dice', { plugins: ['src/plugins/roll.ts'] }),
    'modules/dice/src/plugins/roll.ts': '',
    'modules/dice/src/plugins/roll.test.ts': '',
    'modules/dice/test/helpers.ts': '',
    'modules/cards/module.json': manifest('cards', { version: '1.0.0', files: ['src/**/*.ts'] }),
    'modules/cards/src/deck.ts': '',
    'modules/cards/src/deck.test.ts': '',
    'modules/cards/notes.md': '',
    'modules/quest/module.json': manifest('quest', { version: '0.1.0' }),
    'modules/quest/src/index.ts': '',
    // Vendored, a fixture and the repository's own: never modules of the owner's.
    'vendor/Other/modules/dice/module.json': manifest('dice'),
    'vendor/Other/modules/dice/src/x.ts': '',
    'modules/dice/test/fixture/module.json': manifest('fixture'),
    'node_modules/pkg/module.json': manifest('pkg'),
    '.git/module.json': manifest('git'),
  });

  it('are found at any depth, but under vendor, tests, .git and node_modules, with their status', () => {
    const installed = new Map([
      ['dice', '0.1.0'],
      ['cards', '1.0.0'],
      ['quest', '0.3.0'],
    ]);
    expect(findModules(repo, installed)).toEqual([
      {
        path: 'modules/cards',
        id: 'cards',
        version: '1.0.0',
        status: 'same',
        installed: '1.0.0',
        // Its globs alone decide: its test is kept, its notes are not.
        files: [
          'modules/cards/module.json',
          'modules/cards/src/deck.ts',
          'modules/cards/src/deck.test.ts',
        ],
        left: ['modules/cards/notes.md'],
      },
      {
        path: 'modules/dice',
        id: 'dice',
        version: '0.2.0',
        status: 'update',
        installed: '0.1.0',
        files: ['modules/dice/module.json', 'modules/dice/src/plugins/roll.ts'],
        left: [
          'modules/dice/src/plugins/roll.test.ts',
          'modules/dice/test/helpers.ts',
          'modules/dice/test/fixture/module.json',
        ],
      },
      {
        path: 'modules/quest',
        id: 'quest',
        version: '0.1.0',
        status: 'older',
        installed: '0.3.0',
        files: ['modules/quest/module.json', 'modules/quest/src/index.ts'],
        left: [],
      },
    ]);
  });

  it('are those under a path, when one is given', () => {
    expect(findModules(repo, new Map(), 'modules/quest').map((m) => [m.path, m.status])).toEqual([
      ['modules/quest', 'new'],
    ]);
    expect(findModules(repo, new Map(), 'docs')).toEqual([]);
  });

  it('is the tree itself, for a module’s own folder, its nested modules apart', () => {
    const one = tree({
      'dice/module.json': manifest('dice'),
      'dice/src/a.ts': '',
      'dice/extra/module.json': manifest('dice-extra'),
      'dice/extra/src/b.ts': '',
      '/../evil': '',
    });
    expect(findModules(one).map((m) => [m.path, m.files])).toEqual([
      ['dice', ['dice/module.json', 'dice/src/a.ts']],
      ['dice/extra', ['dice/extra/module.json', 'dice/extra/src/b.ts']],
    ]);
    const root = tree({ 'module.json': manifest('dice'), 'src/a.ts': '' });
    expect(findModules(root)).toMatchObject([{ path: '', files: ['module.json', 'src/a.ts'] }]);
  });

  it('say why one cannot be installed: its manifest, its plugin entries, an id found twice', () => {
    const bad = tree({
      'a/module.json': '{ nope',
      'b/module.json': JSON.stringify({ id: 'b', version: '1.0.0', extra: true }),
      'c/module.json': JSON.stringify([]),
      'd/module.json': manifest('d', { plugins: ['src/p.ts'] }),
      'e/module.json': manifest('e', { plugins: ['src/p.ts'], files: ['lib'] }),
      'e/src/p.ts': '',
      'f/module.json': manifest('twin'),
      'g/module.json': manifest('twin'),
    });
    const found = findModules(bad);
    expect(found.map((m) => [m.path, m.id, m.error])).toEqual([
      ['a', undefined, expect.stringMatching(/^module\.json: /u)],
      ['b', 'b', expect.stringContaining('api')],
      ['c', undefined, expect.stringMatching(/^module\.json: \(all\)/u)],
      ['d', 'd', 'its plugin entry src/p.ts is not there'],
      ['e', 'e', 'its plugin entry src/p.ts is left out by its files'],
      ['f', 'twin', undefined],
      ['g', 'twin', "twin is found twice, here and at f: choose one's folder"],
    ]);
    expect(found[1]).toMatchObject({ version: '1.0.0' });
  });
});

describe('.gitignore files', () => {
  const ignored = (text: string, more: Record<string, string> = {}) =>
    gitignored({ '.gitignore': text, ...more });

  it('ignore by a name at any depth, a path from their directory, or a directory', () => {
    const i = ignored(
      [
        '# a comment',
        '',
        '*.log',
        '/build',
        'out/',
        'docs/*.html',
        'cache?',
        '\\#notes',
        'trailing   ',
        'lit\\ ',
        '[abc].tmp',
        '[!x]y.bak',
        'a\\*b',
        '[unclosed',
        '!keep.log',
      ].join('\n')
    );
    expect(i('x.log')).toBe(true);
    expect(i('deep/er/x.log')).toBe(true);
    expect(i('keep.log')).toBe(false);
    expect(i('build/a.js')).toBe(true);
    expect(i('src/build/a.js')).toBe(false); // anchored to the root
    expect(i('src/out/a.js')).toBe(true); // a directory at any depth
    expect(i('src/out')).toBe(false); // `out/`: a directory only, not a file named so
    expect(i('docs/a.html')).toBe(true);
    expect(i('docs/x/a.html')).toBe(false);
    expect(i('cache1/a')).toBe(true);
    expect(i('#notes')).toBe(true);
    expect(i('trailing')).toBe(true);
    expect(i('lit ')).toBe(true);
    expect(i('b.tmp')).toBe(true);
    expect(i('d.tmp')).toBe(false);
    expect(i('zy.bak')).toBe(true);
    expect(i('xy.bak')).toBe(false);
    expect(i('a*b')).toBe(true);
    expect(i('axb')).toBe(false);
    expect(i('[unclosed')).toBe(true);
    expect(i('src/a.ts')).toBe(false);
  });

  it('read `**` as any directories, and apply a deeper file after a shallower one', () => {
    const i = ignored('**/gen/**\nlogs/**\na/**/z\nsecret.txt\n**/*.map\nfoo**bar', {
      'pkg/.gitignore': '!secret.txt\n/local\n',
    });
    expect(i('gen/x')).toBe(true);
    expect(i('a/b/gen/c/d')).toBe(true);
    expect(i('logs/x/y')).toBe(true);
    expect(i('a/z')).toBe(true);
    expect(i('a/b/c/z')).toBe(true);
    expect(i('x/y.js.map')).toBe(true);
    expect(i('fooxbar')).toBe(true);
    expect(i('secret.txt')).toBe(true);
    expect(i('pkg/secret.txt')).toBe(false); // re-included below
    expect(i('pkg/local/a')).toBe(true);
    expect(i('local/a')).toBe(false); // anchored to pkg/
  });

  it('never re-include what is under an ignored directory', () => {
    const i = ignored('dist/\n!dist/keep.js\n');
    expect(i('dist/keep.js')).toBe(true);
    expect(gitignored({})('anything')).toBe(false);
    expect(gitignored({ '.gitignore': '# only a comment\n!\n/\n' })('x')).toBe(false);
    expect(ignoreRules('a\r\nb/\r\n')).toHaveLength(2);
  });

  it('leave out of a module what they ignore, unless its files name it, and hide modules ignored', () => {
    const listing: TreeListing = {
      ...tree({
        '.gitignore': '',
        'modules/dice/module.json': manifest('dice', { plugins: ['src/p.ts'] }),
        'modules/dice/src/p.ts': '',
        'modules/dice/.env': '',
        'modules/dice/dist/p.js': '',
        'modules/cards/module.json': manifest('cards', { files: ['dist/**'], plugins: [] }),
        'modules/cards/dist/c.js': '',
        'build/copy/module.json': manifest('copy'),
      }),
      ignores: { '.gitignore': 'dist/\n/build\n', 'modules/dice/.gitignore': '.env\n' },
    };
    const found = findModules(listing);
    expect(found.map((m) => [m.path, m.files, m.left])).toEqual([
      ['modules/cards', ['modules/cards/module.json', 'modules/cards/dist/c.js'], []],
      [
        'modules/dice',
        ['modules/dice/module.json', 'modules/dice/src/p.ts'],
        ['modules/dice/.env', 'modules/dice/dist/p.js'],
      ],
    ]);
  });
});
