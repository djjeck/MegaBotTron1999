// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '#test/fake-api.ts';
import { ImportPage } from './ImportPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
