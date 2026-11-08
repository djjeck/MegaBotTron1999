// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
