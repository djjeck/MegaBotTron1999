// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleCandidate, ModulesReport } from '#src/ui/api.ts';
import {
  droppedFiles,
  folderName,
  listing,
  moduleFiles,
  pickedFiles,
  shownPath,
} from '#src/ui/module-folder.ts';
import { fakeApi } from '#test/fake-api.ts';
import { size, statusText } from './ModuleChecklist.tsx';
import { base64, ModulesPage, when } from './ModulesPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const slow = { timeout: 5000 };
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEWER = 'f0e1d2c3b4a5968778695a4b3c2d1e0f12345678';

describe('ModulesPage', () => {
  it('lists the modules, installs a tarball as base64, rolls back, and offers the restart', async () => {
    let restart = false;
    const api = fakeApi({
      'GET /modules': () => [
        200,
        {
          installed: [
            {
              id: 'dice',
              version: '0.2.0',
              description: 'a dice game',
              loaded: '0.1.0',
              previous: '0.1.0',
            },
            { id: 'broken', error: 'module.json is not JSON' },
          ],
          failures: [{ id: 'broken', reason: 'its manifest does not read' }],
          restart,
        },
      ],
      'POST /modules': (body) => {
        restart = true;
        const b = body as { tarball: string; name: string };
        return b.tarball === base64(new Uint8Array([1, 2, 3])) && b.name === 'dice.tar.gz'
          ? [200, { id: 'dice', version: '0.3.0', previous: '0.2.0' }]
          : [400, { error: 'not a module' }];
      },
      'POST /modules/dice/rollback': [200, { id: 'dice', version: '0.1.0' }],
      'POST /restart': [500, { error: 'not now' }],
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<ModulesPage loggedOut={vi.fn()} />);
    const dice = (await screen.findByText('dice')).closest('tr') as HTMLElement;
    expect(within(dice).getByText('a dice game')).toBeDefined();
    // Installed before sources were recorded: unknown.
    expect(within(dice).getByText('unknown')).toBeDefined();
    const broken = screen.getByText('module.json is not JSON').closest('tr') as HTMLElement;
    expect(within(broken).getByText('not loaded')).toBeDefined();
    expect(
      within(screen.getByLabelText('modules refused')).getByText(': its manifest does not read', {
        exact: false,
      })
    ).toBeDefined();
    // No module from GitHub: no updates' bar.
    expect(screen.queryByLabelText('updates')).toBeNull();
    // Installed from a file, sent as base64 with its name.
    const input = screen.getByLabelText('module tarball');
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'dice.tar.gz')] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(
      await screen.findByText('dice 0.3.0 installed (0.2.0 kept for a rollback)', {}, slow)
    ).toBeDefined();
    fireEvent.change(input, { target: { files: [new File(['x'], 'other.tar.gz')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(
      await screen.findByText('other.tar.gz: not installed: not a module', {}, slow)
    ).toBeDefined();
    // Rolled back, once confirmed.
    fireEvent.click(within(dice).getByRole('button', { name: 'Roll back to 0.1.0' }));
    expect(api.calls).not.toContain('POST /modules/dice/rollback {}');
    confirm.mockReturnValue(true);
    fireEvent.click(within(dice).getByRole('button', { name: 'Roll back to 0.1.0' }));
    expect(await screen.findByText('dice rolled back to 0.1.0: restart to load it')).toBeDefined();
    // A restart is needed: offered, and its refusal said.
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (restart)' }, slow));
    expect(await screen.findByText('restart: not now')).toBeDefined();
  });

  it('restarts to load a module, and comes back to the page, still logged in', async () => {
    let restarted = false;
    fakeApi({
      'GET /modules': [200, { installed: [], failures: [], restart: true }],
      'POST /restart': () => {
        restarted = true;
        return [200, { restarting: true }];
      },
      'GET /session': () => [200, { authenticated: true, boot: restarted ? 'b2' : 'b1' }],
    });
    const back = vi.fn();
    render(<ModulesPage loggedOut={vi.fn()} restarted={back} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (restart)' }, slow));
    await waitFor(
      () =>
        expect(back).toHaveBeenCalledWith(
          'The instance restarted: it runs the saved graph and the modules installed.'
        ),
      slow
    );
    cleanup();
    // Without the app's way back, the page says it itself.
    restarted = false;
    render(<ModulesPage loggedOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (restart)' }, slow));
    expect(
      await screen.findByText(
        'The instance restarted: it runs the saved graph and the modules installed.',
        {},
        slow
      )
    ).toBeDefined();
  });

  it('says when no module is installed, or the list cannot be read', async () => {
    fakeApi({ 'GET /modules': [200, { installed: [], failures: [], restart: false }] });
    render(<ModulesPage loggedOut={vi.fn()} />);
    expect(await screen.findByText('No module is installed.')).toBeDefined();
    cleanup();
    fakeApi({ 'GET /modules': [500, { error: 'no modules here' }] });
    render(<ModulesPage loggedOut={vi.fn()} />);
    expect(await screen.findByText('no modules here')).toBeDefined();
    expect(base64(new TextEncoder().encode('hi'))).toBe('aGk=');
  });
});

/** A file of a folder picked, at its path from the folder (its name first). */
function picked(path: string, text: string): File {
  const file = new File([text], path.split('/').pop() ?? path);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

const manifest = (id: string, version = '0.2.0') =>
  JSON.stringify({ id, version, api: '1', provides: `@example/${id}` });

/** A dropped entry, as `webkitGetAsEntry` gives one: a file, or a directory of entries. */
function entry(fullPath: string, content: string | FileSystemEntry[]): FileSystemEntry {
  const name = fullPath.split('/').pop() ?? '';
  if (typeof content === 'string')
    return {
      name,
      fullPath,
      isFile: true,
      isDirectory: false,
      file: (ok: (f: File) => void) => ok(new File([content], name)),
    } as unknown as FileSystemEntry;
  return {
    name,
    fullPath,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      // Two batches, then the empty one that ends them.
      const batches = [content.slice(0, 1), content.slice(1), []];
      return { readEntries: (ok: (e: FileSystemEntry[]) => void) => ok(batches.shift() ?? []) };
    },
  } as unknown as FileSystemEntry;
}

const items = (...entries: (FileSystemEntry | null)[]) => ({
  dataTransfer: { items: entries.map((e) => ({ webkitGetAsEntry: () => e })) },
});

/** The plan the server makes of the repository below: four modules, one refused. */
const plan: ModuleCandidate[] = [
  {
    path: 'games/modules/cards',
    id: 'cards',
    version: '1.0.0',
    status: 'same',
    installed: '1.0.0',
    files: ['games/modules/cards/module.json'],
    left: [],
  },
  {
    path: 'games/modules/dice',
    id: 'dice',
    version: '0.2.0',
    description: 'Dice, rolled',
    status: 'update',
    installed: '0.1.0',
    files: ['games/modules/dice/module.json', 'games/modules/dice/src/roll.ts'],
    left: ['games/modules/dice/src/roll.test.ts', 'games/modules/dice/test/helpers.ts'],
  },
  {
    path: 'games/modules/old',
    id: 'old',
    version: '0.1.0',
    status: 'older',
    installed: '0.3.0',
    files: ['games/modules/old/module.json'],
    left: [],
  },
  {
    path: 'games/modules/quest',
    id: 'quest',
    version: '0.1.0',
    status: 'new',
    files: ['games/modules/quest/module.json'],
    left: [],
  },
  {
    path: 'games/modules/bad',
    files: [],
    left: [],
    error: 'module.json: Unexpected token',
  },
];

describe('ModulesPage: a folder of modules', () => {
  const files = () => [
    picked('games/README.md', '# Games'),
    picked('games/modules/cards/module.json', manifest('cards', '1.0.0')),
    picked('games/modules/dice/module.json', manifest('dice')),
    picked('games/modules/dice/src/roll.ts', 'export {};'),
    picked('games/modules/dice/src/roll.test.ts', 'test'),
    picked('games/modules/old/module.json', manifest('old', '0.1.0')),
    picked('games/modules/quest/module.json', manifest('quest', '0.1.0')),
    picked('games/modules/bad/module.json', '{'),
    picked('games/vendor/Shell/modules/x/module.json', manifest('x')),
    picked('games/.git/HEAD', 'ref'),
    picked('games/node_modules/x/index.js', ''),
  ];

  it('lists the modules found, checks all but downgrades, and installs each on its own', async () => {
    const sent: { files: { path: string; content: string }[]; name: string }[] = [];
    const api = fakeApi({
      'GET /modules': [200, { installed: [], failures: [], restart: false }],
      'POST /modules/plan': (body) => {
        const b = body as { paths: string[]; manifests: Record<string, string> };
        // The vendored module.json is not read; .git and node_modules are not listed.
        expect(Object.keys(b.manifests)).toHaveLength(5);
        expect(b.paths.some((p) => p.includes('.git') || p.includes('node_modules'))).toBe(false);
        return [200, plan];
      },
      'POST /modules': (body) => {
        const b = body as (typeof sent)[number];
        sent.push(b);
        return b.name.endsWith('quest')
          ? [400, { error: 'disk full' }]
          : [200, { id: b.name.split('/').pop(), version: '0.2.0', previous: '0.1.0' }];
      },
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    const input = await screen.findByLabelText('module folder');
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: files() } });
    const box = await screen.findByLabelText('modules picked', {}, slow);
    expect(within(box).getByText('5 modules in', { exact: false })).toBeDefined();
    const row = (id: string) => within(box).getByText(id).closest('tr') as HTMLElement;
    const box_ = (id: string) => within(row(id)).getByRole('checkbox') as HTMLInputElement;
    expect(within(row('cards')).getByText('same version')).toBeDefined();
    expect(within(row('dice')).getByText('update 0.1.0 → 0.2.0')).toBeDefined();
    expect(within(row('dice')).getByText('modules/dice')).toBeDefined();
    expect(within(row('dice')).getByText('Dice, rolled')).toBeDefined();
    expect(within(row('dice')).getByText('2 left out')).toBeDefined();
    expect(within(row('dice')).getByText('src/roll.test.ts')).toBeDefined();
    expect(within(row('dice')).getByText(/^2 files, \d+ B$/u)).toBeDefined();
    expect(within(row('old')).getByText('older 0.3.0 → 0.1.0')).toBeDefined();
    expect(within(row('quest')).getByText('new')).toBeDefined();
    expect(within(box).getByText('module.json: Unexpected token')).toBeDefined();
    expect(
      [
        box_('cards'),
        box_('dice'),
        box_('old'),
        box_('quest'),
        within(box).getByRole('checkbox', { name: 'install modules/bad' }) as HTMLInputElement,
      ].map((c) => [c.checked, c.disabled])
    ).toEqual([
      [true, false],
      [true, false],
      [false, false],
      [true, false],
      [false, true],
    ]);
    // The owner leaves cards out.
    fireEvent.click(box_('cards'));
    fireEvent.click(box_('old'));
    fireEvent.click(box_('old'));
    fireEvent.click(within(box).getByRole('button', { name: 'Install 2 modules' }));
    expect(
      await screen.findByText(
        'dice 0.2.0 installed (0.1.0 kept for a rollback), 2 files left out',
        {},
        slow
      )
    ).toBeDefined();
    expect(screen.getByText('quest: not installed: disk full')).toBeDefined();
    // Only the checked modules' files, from each module's directory.
    expect(sent.map((b) => [b.name, b.files.map((f) => f.path)])).toEqual([
      ['games/modules/dice', ['module.json', 'src/roll.ts']],
      ['games/modules/quest', ['module.json']],
    ]);
    expect(sent[0]?.files[1]?.content).toBe(btoa('export {};'));
    expect(screen.queryByLabelText('modules picked')).toBeNull();
    expect(api.calls.filter((c) => c.startsWith('POST /modules '))).toHaveLength(2);
  });

  it('is cancelled, says a folder empty or with no module, and refuses one too large', async () => {
    let answer: ModuleCandidate[] = plan;
    fakeApi({
      'GET /modules': [200, { installed: [], failures: [], restart: false }],
      'POST /modules/plan': () => [200, answer],
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    const input = await screen.findByLabelText('module folder');
    fireEvent.change(input, { target: { files: files() } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }, slow));
    expect(screen.queryByLabelText('modules picked')).toBeNull();
    // A choice of nothing changes nothing.
    fireEvent.change(input, { target: { files: [] } });
    // Nothing in it but .git.
    fireEvent.change(input, { target: { files: [picked('games/.git/HEAD', '')] } });
    expect(await screen.findByText('the folder does not read: the folder is empty')).toBeDefined();
    answer = [];
    fireEvent.change(input, { target: { files: [picked('games/README.md', '')] } });
    expect(
      await screen.findByText(
        "no module.json in games: choose a module's folder, or a repository's that holds modules"
      )
    ).toBeDefined();
    // One module, as a module's own folder gives it: one row; too large, refused.
    const big = picked('dice/src/big.bin', 'x');
    Object.defineProperty(big, 'size', { value: 64 * 2 ** 20 + 1 });
    answer = [
      {
        path: 'dice',
        id: 'dice',
        version: '0.1.0',
        status: 'new',
        files: ['dice/module.json', 'dice/src/big.bin'],
        left: [],
      },
    ];
    fireEvent.change(input, {
      target: { files: [picked('dice/module.json', manifest('dice')), big] },
    });
    const box = await screen.findByLabelText('modules picked');
    expect(within(box).getByText('1 module in', { exact: false })).toBeDefined();
    expect(within(box).getByText('.')).toBeDefined();
    expect(
      within(box).getByText("over 64 MiB: list what it ships in its module.json's files")
    ).toBeDefined();
    expect(
      within(box).getByRole('button', { name: 'Install 0 modules' }).hasAttribute('disabled')
    ).toBe(true);
  });

  it('takes a folder dropped, walking its directories, and a tarball dropped', async () => {
    let paths: string[] = [];
    fakeApi({
      'GET /modules': [200, { installed: [], failures: [], restart: false }],
      'POST /modules/plan': (body) => {
        paths = (body as { paths: string[] }).paths;
        return [200, [plan[3]]];
      },
      'POST /modules': [200, { id: 'quest', version: '0.1.0' }],
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    const zone = await screen.findByRole('region', { name: 'install modules' });
    fireEvent.dragOver(zone);
    expect(zone.className).toBe('drop dragging');
    fireEvent.dragLeave(zone);
    expect(zone.className).toBe('drop');
    const folder = entry('/games', [
      entry('/games/modules', [
        entry('/games/modules/quest', [
          entry('/games/modules/quest/module.json', manifest('quest', '0.1.0')),
          entry('/games/modules/quest/src', [entry('/games/modules/quest/src/a.ts', '')]),
        ]),
      ]),
      entry('/games/node_modules', [entry('/games/node_modules/x.js', '')]),
      entry('/games/.git', []),
    ]);
    fireEvent.drop(zone, items(folder, null));
    const box = await screen.findByLabelText('modules picked', {}, slow);
    expect(paths).toEqual(['games/modules/quest/module.json', 'games/modules/quest/src/a.ts']);
    fireEvent.click(within(box).getByRole('button', { name: 'Install 1 module' }));
    expect(await screen.findByText('quest 0.1.0 installed', {}, slow)).toBeDefined();
    // Nothing usable dropped: nothing happens.
    fireEvent.drop(zone, items(null));
    // A tarball dropped goes to the tarball's form.
    fireEvent.drop(zone, items(entry('/quest.tar.gz', 'x')));
    expect(await screen.findByText('quest.tar.gz: install it below, from a .tar.gz')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(false);
    // A folder that does not read says so.
    const broken = {
      name: 'quest',
      fullPath: '/quest',
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (_: unknown, fail: (e: Error) => void) => fail(new Error('not allowed')),
      }),
    } as unknown as FileSystemEntry;
    fireEvent.drop(zone, items(broken));
    expect(await screen.findByText('the folder does not read: not allowed')).toBeDefined();
  });

  it('reads a folder’s listing and a module’s files in the browser', async () => {
    const f = (path: string, text = '') => ({ path, file: new File([text], 'x') });
    const all = [
      f('games/modules/dice/module.json', '{"id":"dice"}'),
      f('games/modules/dice/src/a.ts', 'abc'),
      f('games/vendor/x/module.json', '{}'),
    ];
    expect(await listing(all)).toEqual({
      paths: all.map((x) => x.path),
      manifests: { 'games/modules/dice/module.json': '{"id":"dice"}' },
    });
    expect(folderName(all)).toBe('games');
    expect(folderName([f('a/x'), f('b/y')])).toBe('');
    expect(
      moduleFiles(
        { path: 'games/modules/dice', files: ['games/modules/dice/src/a.ts', 'gone'], left: [] },
        all
      )
    ).toMatchObject({ files: [{ path: 'games/modules/dice/src/a.ts' }], bytes: 3 });
    expect(shownPath('games/modules/dice', 'games')).toBe('modules/dice');
    expect(shownPath('games', 'games')).toBe('.');
    expect(shownPath('gamesx/dice', 'games')).toBe('gamesx/dice');
    expect(shownPath('', '')).toBe('.');
    expect(pickedFiles([new File([''], 'loose.ts')])).toMatchObject([{ path: 'loose.ts' }]);
    expect(await droppedFiles([entry('/a.ts', 'x')])).toMatchObject([{ path: 'a.ts' }]);
    expect(statusText({ path: '', files: [], left: [] })).toBe('new');
    expect(statusText({ path: '', files: [], left: [], status: 'update' })).toBe('update ? → ?');
    expect(statusText({ path: '', files: [], left: [], status: 'older' })).toBe('older ? → ?');
    expect([size(10), size(2048), size(3 * 2 ** 20)]).toEqual(['10 B', '2.0 KiB', '3.0 MiB']);
    expect(when('2026-11-12T14:05:33.000Z')).toBe('2026-11-12 14:05 UTC');
  });
});

describe('ModulesPage: GitHub', () => {
  const source = {
    kind: 'github' as const,
    repo: 'example/games',
    ref: 'main',
    refType: 'branch' as const,
    path: '',
    commit: COMMIT,
    commitDate: '2026-11-01T10:00:00Z',
  };

  it('looks a link up, lists its modules, and installs those checked from their source', async () => {
    const sent: unknown[] = [];
    fakeApi({
      'GET /modules': [200, { installed: [], failures: [], restart: false }],
      'POST /modules/github': (body) =>
        (body as { url: string }).url === 'https://github.com/example/games'
          ? [
              200,
              {
                source,
                modules: [
                  { ...plan[1], path: 'modules/dice', files: ['modules/dice/module.json'] },
                  { ...plan[3], path: 'modules/quest' },
                ],
              },
            ]
          : (body as { url: string }).url.endsWith('empty')
            ? [200, { source: { ...source, path: 'modules' }, modules: [] }]
            : [429, { error: "GitHub's rate limit is reached until 13:00 UTC" }],
      'POST /modules': (body) => {
        sent.push(body);
        return [200, { id: 'dice', version: '0.2.0' }];
      },
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    const link = await screen.findByLabelText('GitHub link');
    const lookUp = screen.getByRole('button', { name: 'Look up' });
    expect(lookUp.hasAttribute('disabled')).toBe(true);
    fireEvent.change(link, { target: { value: '  https://github.com/example/games ' } });
    fireEvent.click(lookUp);
    const box = await screen.findByLabelText('modules picked', {}, slow);
    expect(within(box).getByText('example/games').getAttribute('href')).toBe(
      `https://github.com/example/games/tree/${COMMIT}`
    );
    expect(within(box).getByText('a1b2c3d')).toBeDefined();
    expect(within(box).getByText('modules/quest')).toBeDefined();
    // Its files are not at hand: counted, with no size.
    const quest = within(box).getByText('quest').closest('tr') as HTMLElement;
    expect(within(quest).getByText(/^1 file$/u)).toBeDefined();
    fireEvent.click(within(box).getByRole('checkbox', { name: 'install quest' }));
    fireEvent.click(within(box).getByRole('button', { name: 'Install 1 module' }));
    expect(
      await screen.findByText('dice 0.2.0 installed, 2 files left out', {}, slow)
    ).toBeDefined();
    expect(sent).toEqual([
      {
        github: {
          repo: 'example/games',
          ref: 'main',
          refType: 'branch',
          path: 'modules/dice',
          commit: COMMIT,
          commitDate: '2026-11-01T10:00:00Z',
        },
      },
    ]);
    fireEvent.change(link, { target: { value: 'https://github.com/example/empty' } });
    fireEvent.submit(link);
    expect(
      await screen.findByText(
        'no module.json under example/games/modules (vendor/ and tests aside)'
      )
    ).toBeDefined();
    fireEvent.change(link, { target: { value: 'https://github.com/example/other' } });
    fireEvent.submit(link);
    expect(
      await screen.findByText("the link: GitHub's rate limit is reached until 13:00 UTC")
    ).toBeDefined();
    fireEvent.change(link, { target: { value: ' ' } });
    fireEvent.submit(link);
  });

  it('shows each module’s source, its update, and updates one or all once asked', async () => {
    let checked = false;
    const sent: unknown[] = [];
    const report = (): ModulesReport => ({
      installed: [
        {
          id: 'cards',
          version: '1.0.0',
          source: {
            ...source,
            kind: 'github',
            refType: 'tag',
            ref: 'v1.0.0',
            path: 'modules/cards',
            installedAt: '2026-11-10T09:00:00.000Z',
          },
          ...(checked
            ? {
                update: {
                  ref: 'v1.1.0',
                  commit: NEWER,
                  compare: 'https://github.com/example/games/compare/x...y',
                },
              }
            : {}),
        },
        {
          id: 'dice',
          version: '0.1.0',
          source: {
            ...source,
            kind: 'github',
            path: 'modules/dice',
            installedAt: '2026-11-10T09:00:00.000Z',
          },
          ...(checked
            ? {
                update: {
                  ref: 'main',
                  commit: NEWER,
                  commitDate: '2026-11-11T08:00:00Z',
                  compare: `https://github.com/example/games/compare/${COMMIT}...${NEWER}`,
                },
              }
            : {}),
        },
        {
          id: 'pinned',
          version: '0.1.0',
          source: {
            ...source,
            kind: 'github',
            refType: 'commit',
            ref: COMMIT,
            installedAt: '2026-11-10T09:00:00.000Z',
          },
        },
        {
          id: 'quest',
          version: '0.1.0',
          source: {
            kind: 'folder',
            name: 'games/modules/quest',
            installedAt: '2026-11-11T10:00:00.000Z',
          },
        },
        {
          id: 'tar',
          version: '0.1.0',
          source: { kind: 'tarball', installedAt: '2026-11-11T10:00:00.000Z' },
        },
        {
          id: 'dir',
          version: '0.1.0',
          source: { kind: 'directory', path: '/tmp/dir', installedAt: '2026-11-11T10:00:00.000Z' },
        },
      ],
      failures: [],
      restart: false,
      updates: checked
        ? { checkedAt: '2026-11-12T12:00:00.000Z', error: 'example/other main: not found' }
        : {},
    });
    fakeApi({
      'GET /modules': () => [200, report()],
      'POST /modules/updates': () => {
        const was = checked;
        checked = true;
        return was ? [500, { error: 'busy' }] : [200, report()];
      },
      'POST /modules': (body) => {
        sent.push(body);
        return [200, { id: 'dice', version: '0.2.0', previous: '0.1.0' }];
      },
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    const row = async (id: string) => (await screen.findByText(id)).closest('tr') as HTMLElement;
    const dice = await row('dice');
    expect(within(dice).getByText('example/games/modules/dice').getAttribute('href')).toBe(
      `https://github.com/example/games/tree/${COMMIT}/modules/dice`
    );
    expect(within(dice).getByText('installed 2026-11-10 09:00 UTC')).toBeDefined();
    expect(within(await row('pinned')).getByText('example/games')).toBeDefined();
    expect(within(await row('quest')).getByText('folder upload games/modules/quest')).toBeDefined();
    expect(within(await row('tar')).getByText('tarball')).toBeDefined();
    expect(within(await row('dir')).getByText('directory /tmp/dir')).toBeDefined();
    expect(screen.getByText('not checked yet')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Update all/u })).toBeNull();
    // Checked: two updates, the check's partial failure said.
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByRole('button', { name: 'Update all (2)' }, slow)).toBeDefined();
    expect(screen.getByText('example/other main: not found')).toBeDefined();
    expect(
      screen.getByText('checked 2026-11-12 12:00 UTC; the shell checks every 6 hours')
    ).toBeDefined();
    const updated = await row('dice');
    expect(within(updated).getByText('update available:', { exact: false })).toBeDefined();
    expect(within(updated).getByText('f0e1d2c').closest('a')?.getAttribute('href')).toBe(
      `https://github.com/example/games/compare/${COMMIT}...${NEWER}`
    );
    expect(within(updated).getByText('(2026-11-11)', { exact: false })).toBeDefined();
    expect(within(await row('cards')).getByText('v1.1.0', { exact: false })).toBeDefined();
    fireEvent.click(within(updated).getByRole('button', { name: 'Update' }));
    expect(
      await screen.findByText('dice 0.2.0 installed (0.1.0 kept for a rollback)', {}, slow)
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Update all (2)' }));
    await waitFor(() => expect(sent).toHaveLength(3), slow);
    expect(sent).toEqual([
      {
        github: {
          repo: 'example/games',
          ref: 'main',
          refType: 'branch',
          path: 'modules/dice',
          commit: NEWER,
          commitDate: '2026-11-11T08:00:00Z',
        },
      },
      {
        github: {
          repo: 'example/games',
          ref: 'v1.1.0',
          refType: 'tag',
          path: 'modules/cards',
          commit: NEWER,
        },
      },
      expect.objectContaining({ github: expect.objectContaining({ path: 'modules/dice' }) }),
    ]);
    // A check that fails says so.
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('the check: busy', {}, slow)).toBeDefined();
  });

  it('says when a check finds nothing, or how many', async () => {
    let installed: ModulesReport['installed'] = [
      {
        id: 'dice',
        version: '0.1.0',
        source: {
          ...source,
          kind: 'github',
          refType: 'branch',
          installedAt: '2026-11-10T09:00:00.000Z',
        },
      },
    ];
    fakeApi({
      'GET /modules': () => [200, { installed, failures: [], restart: false }],
      'POST /modules/updates': () => [
        200,
        {
          installed,
          failures: [],
          restart: false,
          updates: { checkedAt: '2026-11-12T12:00:00.000Z' },
        },
      ],
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));
    expect(
      await screen.findByText(
        'No update: every module from GitHub is at its newest commit.',
        {},
        slow
      )
    ).toBeDefined();
    installed = [{ ...installed[0]!, update: { ref: 'main', commit: NEWER, compare: 'x' } }];
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('1 update available.', {}, slow)).toBeDefined();
    installed = [installed[0]!, { ...installed[0]!, id: 'two' }];
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('2 updates available.', {}, slow)).toBeDefined();
  });
});
