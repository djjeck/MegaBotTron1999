// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { droppedFiles, manifestFile, readFolder } from '#src/ui/module-folder.ts';
import { fakeApi } from '#test/fake-api.ts';
import { ImportPage } from './ImportPage.tsx';
import { base64, ModulesPage } from './ModulesPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const slow = { timeout: 5000 };

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
        return (body as { tarball: string }).tarball === base64(new Uint8Array([1, 2, 3]))
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
    const broken = screen.getByText('module.json is not JSON').closest('tr') as HTMLElement;
    expect(within(broken).getByText('not loaded')).toBeDefined();
    expect(
      within(screen.getByLabelText('modules refused')).getByText(': its manifest does not read', {
        exact: false,
      })
    ).toBeDefined();
    // Installed from a file, sent as base64.
    const input = screen.getByLabelText('module tarball');
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'dice.tar.gz')] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(
      await screen.findByText(
        'dice 0.3.0 installed (0.2.0 kept for a rollback): restart to load it',
        {},
        slow
      )
    ).toBeDefined();
    fireEvent.change(input, { target: { files: [new File(['x'], 'other.tar.gz')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByText('not installed: not a module', {}, slow)).toBeDefined();
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

const manifest = (more: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'quest', version: '1.2.0', description: 'A quest game', ...more });

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

describe('ModulesPage: a module’s folder', () => {
  const routes = (post: (body: unknown) => [number, unknown]) =>
    fakeApi({
      'GET /modules': [200, { installed: [], failures: [], restart: false }],
      'POST /modules': post,
    });

  it('shows the module picked, installs its files once confirmed, and says why it is refused', async () => {
    let sent: { path: string; content: string }[] = [];
    let refuse = false;
    routes((body) => {
      sent = (body as { files: typeof sent }).files;
      return refuse
        ? [400, { error: 'module.json: api: expected 1' }]
        : [200, { id: 'quest', version: '1.2.0', previous: '1.1.0' }];
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    expect(await screen.findByText('No module is installed.')).toBeDefined();
    const input = screen.getByLabelText('module folder');
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(click).toHaveBeenCalled();
    const files = [
      picked('quest/module.json', manifest()),
      picked('quest/src/game.ts', 'export {};'),
      picked('quest/.git/HEAD', 'ref'),
      picked('quest/node_modules/x/index.js', ''),
    ];
    fireEvent.change(input, { target: { files } });
    const box = await screen.findByLabelText('module picked');
    expect(within(box).getByText('quest')).toBeDefined();
    expect(within(box).getByText('A quest game')).toBeDefined();
    expect(within(box).getByText(/^2 from quest\/, /u)).toBeDefined();
    fireEvent.click(within(box).getByRole('button', { name: 'Install quest 1.2.0' }));
    expect(
      await screen.findByText(
        'quest 1.2.0 installed (1.1.0 kept for a rollback): restart to load it',
        {},
        slow
      )
    ).toBeDefined();
    expect(sent).toEqual([
      { path: 'quest/module.json', content: btoa(manifest()) },
      { path: 'quest/src/game.ts', content: btoa('export {};') },
    ]);
    expect(screen.queryByLabelText('module picked')).toBeNull();
    // Refused: the server's reason, and the module still there to try again or cancel.
    refuse = true;
    fireEvent.change(input, { target: { files: [picked('quest/module.json', manifest())] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Install quest 1.2.0' }));
    expect(
      await screen.findByText('not installed: module.json: api: expected 1', {}, slow)
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('module picked')).toBeNull();
    // A choice of nothing changes nothing.
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.queryByLabelText('module picked')).toBeNull();
  });

  it('takes a folder dropped, walking its directories, and a tarball dropped', async () => {
    let sent: { path: string }[] = [];
    routes((body) => {
      sent = (body as { files: typeof sent }).files;
      return [200, { id: 'quest', version: '1.2.0' }];
    });
    render(<ModulesPage loggedOut={vi.fn()} />);
    const zone = await screen.findByRole('region', { name: 'install a module' });
    fireEvent.dragOver(zone);
    expect(zone.className).toBe('drop dragging');
    fireEvent.dragLeave(zone);
    expect(zone.className).toBe('drop');
    const folder = entry('/quest', [
      entry('/quest/module.json', manifest({ description: undefined })),
      entry('/quest/src', [
        entry('/quest/src/game.ts', 'export {};'),
        entry('/quest/src/rules.ts', 'export {};'),
      ]),
      entry('/quest/node_modules', [entry('/quest/node_modules/x.js', '')]),
      entry('/quest/.git', []),
    ]);
    fireEvent.drop(zone, items(folder, null));
    const box = await screen.findByLabelText('module picked');
    expect(within(box).queryByText('Description')).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'Install quest 1.2.0' }));
    expect(
      await screen.findByText('quest 1.2.0 installed: restart to load it', {}, slow)
    ).toBeDefined();
    expect(sent.map((f) => f.path)).toEqual([
      'quest/module.json',
      'quest/src/game.ts',
      'quest/src/rules.ts',
    ]);
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

  it('says why a folder is not a module’s, before anything is sent', async () => {
    const f = (path: string, text = '') => ({ path, file: new File([text], 'x') });
    expect(await readFolder([])).toMatchObject({ error: 'the folder is empty' });
    expect(await readFolder([f('repo/README.md')])).toMatchObject({
      error:
        "no module.json in repo: choose the module's own folder, the one that holds its module.json",
    });
    expect(
      await readFolder([f('repo/modules/quest/module.json'), f('repo/modules/dice/module.json')])
    ).toMatchObject({
      error:
        "repo is not a module's folder, but holds modules: choose one of repo/modules/quest, repo/modules/dice",
    });
    expect((await readFolder([f('quest/module.json', '{')])).error).toMatch(
      /^quest\/module\.json is not JSON: /u
    );
    expect(await readFolder([f('quest/module.json', '[1]')])).toMatchObject({
      error: 'quest/module.json has no id or version',
    });
    expect(await readFolder([f('quest/module.json', 'null')])).toMatchObject({
      error: 'quest/module.json has no id or version',
    });
    const big = { path: 'quest/big.bin', file: new File(['x'], 'big.bin') };
    Object.defineProperty(big.file, 'size', { value: 64 * 2 ** 20 });
    expect(await readFolder([f('quest/module.json', manifest()), big])).toMatchObject({
      manifest: { id: 'quest', version: '1.2.0' },
      error: `the folder is over ${64 * 2 ** 20} bytes`,
    });
    // module.json at the root, as a tarball may have it; none where the files are in two directories.
    expect(manifestFile([f('module.json'), f('src/a.ts')])?.path).toBe('module.json');
    expect(manifestFile([f('a/module.json'), f('b/x.ts')])).toBeUndefined();
    expect(await droppedFiles([entry('/a.ts', 'x')])).toMatchObject([{ path: 'a.ts' }]);

    // Shown on the page, with no install offered.
    routes(() => [500, {}]);
    render(<ModulesPage loggedOut={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('module folder'), {
      target: { files: [picked('repo/README.md', 'hi')] },
    });
    const box = await screen.findByLabelText('module picked');
    expect(within(box).getByRole('alert').textContent).toMatch(/^no module\.json in repo/u);
    expect(within(box).queryByRole('button', { name: /^Install/u })).toBeNull();
  });
});

describe('ImportPage', () => {
  it('imports the old event log with the renames the core suggests, and says what it skipped', async () => {
    const api = fakeApi({
      'GET /legacy': [
        200,
        {
          dir: '/legacy',
          stores: [
            {
              id: 'dice',
              documents: ['state', 'log'],
              version: 2,
              timers: [],
              settings: true,
              mode: 'live',
            },
          ],
          events: { days: 3, first: '2026-01-01', last: '2026-01-03' },
        },
      ],
      'GET /legacy/events': [
        200,
        {
          types: {
            message: { count: 40, suggest: ['dice.message'] },
            roll: { count: 2, suggest: ['dice.roll', 'quest.roll'] },
            line: { count: 1, suggest: [] },
          },
        },
      ],
      'POST /legacy/events/import': (body) => {
        const types = (body as { types: Record<string, string> }).types;
        return types['line'] === 'bad'
          ? [400, { error: 'types: line → bad: expected <namespace>.<name>' }]
          : [
              200,
              {
                days: 3,
                imported: 40,
                present: 0,
                skipped: types['roll'] === undefined ? { roll: 2, line: 1 } : {},
              },
            ];
      },
    });
    render(<ImportPage loggedOut={vi.fn()} />);
    expect(await screen.findByText('dice')).toBeDefined();
    expect(screen.getByText(/2 documents, version 2, settings, was live/u)).toBeDefined();
    expect(screen.getByText(/3 days, 2026-01-01 to 2026-01-03/u)).toBeDefined();
    // The one suggestion fills its row; the others are the owner's to type.
    await waitFor(() =>
      expect((screen.getByLabelText('rename message') as HTMLInputElement).value).toBe(
        'dice.message'
      )
    );
    expect((screen.getByLabelText('rename roll') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Import the event log' }));
    expect(
      await screen.findByText(
        '40 records imported, 0 there already, over 3 days; skipped, not namespaced: roll (2), line (1).'
      )
    ).toBeDefined();
    expect(api.calls).toContain('POST /legacy/events/import {"types":{"message":"dice.message"}}');
    fireEvent.change(screen.getByLabelText('rename roll'), { target: { value: 'dice.roll' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import the event log' }));
    expect(
      await screen.findByText('40 records imported, 0 there already, over 3 days.')
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText('rename line'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import the event log' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'types: line → bad: expected <namespace>.<name>'
    );
  });

  it('says when nothing is mounted, there is nothing to rename, or no log', async () => {
    fakeApi({ 'GET /legacy': [404, { error: 'not found' }] });
    render(<ImportPage loggedOut={vi.fn()} />);
    expect(
      await screen.findByText(/This instance has no import from an older data directory/u)
    ).toBeDefined();
    cleanup();
    fakeApi({ 'GET /legacy': [404, { error: 'no older data directory is mounted at /legacy' }] });
    render(<ImportPage loggedOut={vi.fn()} />);
    expect(
      await screen.findByText(/no older data directory is mounted at \/legacy/u)
    ).toBeDefined();
    cleanup();
    fakeApi({
      'GET /legacy': [
        200,
        { dir: '/legacy', stores: [], events: { days: 1, first: 'a', last: 'a' } },
      ],
      'GET /legacy/events': [200, { types: {} }],
    });
    render(<ImportPage loggedOut={vi.fn()} />);
    expect(
      await screen.findByText('Every type is namespaced already: nothing to rename.')
    ).toBeDefined();
    expect(screen.getByText('No store.')).toBeDefined();
    cleanup();
    fakeApi({ 'GET /legacy': [200, { dir: '/legacy', stores: [], events: { days: 0 } }] });
    render(<ImportPage loggedOut={vi.fn()} />);
    expect(await screen.findByText('No event log.')).toBeDefined();
  });
});
