// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '#test/fake-api.ts';
import { AdminPage } from './AdminPage.tsx';
import { DriftPage } from './DriftPage.tsx';
import { EventsPage } from './EventsPage.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loggedOut = vi.fn();

describe('AdminPage', () => {
  it('shows what has no node: the graph history (D111)', async () => {
    fakeApi({
      'GET /graph/history': [200, { versions: [], keep: { days: 7, latest: 5 } }],
    });
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    render(<AdminPage loggedOut={loggedOut} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'History',
    ]);
    expect(await screen.findByText('No graph has been applied yet.')).toBeDefined();
    expect(scrolled).not.toHaveBeenCalled();
    scrolled.mockRestore();
  });

  it('scrolls to the section that the route names', () => {
    fakeApi({});
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    render(<AdminPage loggedOut={loggedOut} section="graph-history" />);
    expect(scrolled).toHaveBeenCalledOnce();
    expect(scrolled.mock.contexts[0]).toBe(document.getElementById('graph-history'));
    scrolled.mockRestore();
  });
});

describe('DriftPage', () => {
  it('shows each parser’s counts and the latest reports', async () => {
    fakeApi({
      'GET /drift': [
        200,
        [
          { parser: 'p', read: 10, unread: 2, recent: 1, tripped: false },
          { parser: 'q', read: 0, unread: 6, recent: 6, tripped: true },
        ],
      ],
      'GET /events?type=core.drift&limit=50&hours=168': [
        200,
        [
          {
            type: 'core.drift',
            t: 2000,
            plugin: 'q',
            event: 'pause',
            reason: '6 unread',
            paused: ['a'],
          },
          {
            type: 'core.drift',
            t: 1000,
            plugin: 'q',
            event: 'pause',
            reason: '6 unread',
            paused: [],
          },
          { type: 'core.drift', t: 500, plugin: 'p', event: 'unread', text: 'what is this' },
          { type: 'core.drift', t: 100 },
        ],
      ],
    });
    render(<DriftPage loggedOut={loggedOut} />);
    expect(await screen.findByText('tripped')).toBeDefined();
    expect(await screen.findByText('what is this')).toBeDefined();
    expect(screen.getByText('; paused a')).toBeDefined();
    expect(screen.getAllByText(': 6 unread')).toHaveLength(2);
  });

  it('folds a parser’s reports of its earlier versions under one line', async () => {
    fakeApi({
      'GET /drift': [200, []],
      'GET /status': [
        200,
        {
          off: false,
          plugins: [
            { id: 'p', version: '1.1.0' },
            { id: 'q', version: '2.0.0' },
          ],
        },
      ],
      'GET /events?type=core.drift&limit=50&hours=168': [
        200,
        [
          {
            type: 'core.drift',
            t: 400,
            plugin: 'p',
            version: '1.1.0',
            event: 'unread',
            text: 'new',
          },
          {
            type: 'core.drift',
            t: 300,
            plugin: 'p',
            version: '1.0.0',
            event: 'unread',
            text: 'old',
          },
          {
            type: 'core.drift',
            t: 250,
            plugin: 'p',
            version: '1.0.0',
            event: 'unread',
            text: 'older',
          },
          // Written before the reports had a version: shown as current.
          { type: 'core.drift', t: 200, plugin: 'p', event: 'unread', text: 'unversioned' },
          {
            type: 'core.drift',
            t: 100,
            plugin: 'q',
            version: '1.9.0',
            event: 'unread',
            text: 'q old',
          },
        ],
      ],
    });
    render(<DriftPage loggedOut={loggedOut} />);
    expect(await screen.findByText('2 from earlier versions')).toBeDefined();
    expect(screen.getByText('1 from earlier versions')).toBeDefined();
    const shown = (text: string) => screen.getByText(text).closest('details') === null;
    expect(shown('new')).toBe(true);
    expect(shown('unversioned')).toBe(true);
    expect(shown('old')).toBe(false);
    expect(shown('older')).toBe(false);
    expect(shown('q old')).toBe(false);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'p 1.1.0',
      'q 2.0.0',
    ]);
  });

  it('says when there is nothing, or why not', async () => {
    fakeApi({
      'GET /drift': [200, []],
      'GET /events?type=core.drift&limit=50&hours=168': [200, []],
    });
    render(<DriftPage loggedOut={loggedOut} />);
    expect(await screen.findByText('No parser has reported since the start.')).toBeDefined();
    expect(await screen.findByText('None.')).toBeDefined();
    cleanup();
    fakeApi({});
    render(<DriftPage loggedOut={loggedOut} />);
    await waitFor(() => expect(screen.getAllByText('not found')).toHaveLength(2));
  });
});

describe('EventsPage', () => {
  it('shows the latest records, filtered by type and count', async () => {
    const api = fakeApi({
      'GET /events?limit=100&type=': [
        200,
        [
          { type: 'core.power', t: 2000, off: true },
          { type: 'game.tick', t: 1000 },
        ],
      ],
      'GET /events?limit=100&type=core.': [200, [{ type: 'core.power', t: 2000, off: true }]],
      'GET /events?limit=500&type=core.': [200, []],
    });
    render(<EventsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('{"off":true}')).toBeDefined();
    expect(screen.getByText('game.tick')).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText('core.'), { target: { value: ' core. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(screen.queryByText('game.tick')).toBeNull());
    expect(screen.getByText('core.power')).toBeDefined();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '500' } });
    expect(await screen.findByText('No record in the last 24 hours.')).toBeDefined();
    expect(api.calls.at(-1)).toBe('GET /events?limit=500&type=core.');
    cleanup();
    fakeApi({});
    render(<EventsPage loggedOut={loggedOut} />);
    expect(await screen.findByText('not found')).toBeDefined();
    expect(within(document.body).queryByText('core.power')).toBeNull();
  });
});
