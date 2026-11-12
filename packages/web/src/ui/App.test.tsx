// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '#test/fake-api.ts';
import { fakeApi } from '#test/fake-api.ts';
import { fakeCore } from '#test/fake-core.ts';
import { stubReactFlow } from '#test/react-flow.ts';
import { App, PAGES } from './App.tsx';

const HEALTH = {
  off: false,
  uptimeS: 90_061,
  node: 'v24.0.0',
  memoryMb: { rss: 80, heap: 30 },
  plugins: { running: 3, paused: 1 },
  accounts: { connected: 1 },
};

/** The graph editor's routes, as the fake core answers them. */
const GRAPH = (): Record<string, Answer> => fakeCore().api.routes;

let restore: () => void;
beforeEach(() => {
  window.location.hash = '';
  restore = stubReactFlow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restore();
});

describe('App', () => {
  it('asks for the password, says why a login failed, then shows the graph', async () => {
    const api = fakeApi({
      ...GRAPH(),
      'GET /session': [200, { authenticated: false }],
      'POST /login': (body) =>
        (body as { password: string }).password === 'right password'
          ? [200, { authenticated: true }]
          : [401, { error: 'wrong password' }],
    });
    render(<App />);
    const field = await screen.findByLabelText('Password');
    fireEvent.change(field, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'wrong password');
    fireEvent.change(field, { target: { value: 'right password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeDefined();
    expect(await screen.findByLabelText('node actor-a', {}, { timeout: 5000 })).toBeDefined();
    expect(api.calls).toContain('POST /login {"password":"right password"}');
  });

  it('shows the login when the session cannot be read', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeDefined();
  });

  it('goes to each page by the hash, marks it in its menu, and logs out', async () => {
    const api = fakeApi({
      ...GRAPH(),
      'GET /session': [200, { authenticated: true }],
      'GET /modules': [200, { installed: [], failures: [], restart: false }],
      'GET /legacy/events': [200, { types: {} }],
      'GET /instance': [200, HEALTH],
      'GET /accounts': [200, []],
      'GET /drift': [200, []],
      'GET /events?type=core.drift&limit=50&hours=168': [200, []],
      'GET /events?limit=100&type=': [200, []],
      'POST /logout': [200, { authenticated: false }],
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Graph' });
    // One menu, every page in it: the whole app is the owner's console.
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(
      within(screen.getByRole('navigation', { name: 'main' }))
        .getAllByRole('link')
        .map((l) => l.textContent)
    ).toEqual(['Graph', 'Modules', 'Import', 'Admin', 'Drift', 'Events']);
    // The bottom bar, for small print, stays on every page.
    expect(screen.getByRole('contentinfo')).toBeDefined();
    for (const page of PAGES) {
      window.location.hash = `#/${page.route}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(await screen.findByRole('heading', { name: page.title, level: 1 })).toBeDefined();
      expect(screen.getByRole('link', { name: page.title }).getAttribute('aria-current')).toBe(
        'page'
      );
    }
    // The admin page's sections keep their old routes, which lead to it, scrolled to the section.
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    for (const old of ['instance', 'accounts', 'plugins']) {
      window.location.hash = `#/${old}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await waitFor(() => expect(scrolled.mock.contexts.at(-1)).toBe(document.getElementById(old)));
      expect(screen.getByRole('heading', { name: 'Admin', level: 1 })).toBeDefined();
      expect(screen.getByRole('link', { name: 'Admin' }).getAttribute('aria-current')).toBe('page');
    }
    scrolled.mockRestore();
    window.location.hash = '#/nowhere';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Password')).toBeDefined();
    expect(api.calls).toContain('POST /logout {}');
  });

  it('comes back to the page after a restart, still logged in, and says so', async () => {
    const core = fakeCore();
    core.running = { version: 2, nodes: [], edges: [] };
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply (restart)' }, { timeout: 5000 })
    );
    const said = await screen.findByText(
      /^The instance restarted: it runs the saved graph/u,
      {},
      { timeout: 5000 }
    );
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(core.api.calls).toContain('POST /restart {}');
    fireEvent.click(within(said).getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByText(/^The instance restarted/u)).toBeNull();
  });

  it('shows the login with why, when the session did not survive the restart', async () => {
    const api = fakeApi({ ...GRAPH(), 'GET /session': [200, { authenticated: true }] });
    let restarted = false;
    api.routes['POST /restart'] = () => {
      restarted = true;
      return [200, { restarting: true }];
    };
    api.routes['GET /session'] = () => [200, { authenticated: !restarted, boot: 'boot-1' }];
    api.routes['GET /graph/file'] = [
      200,
      { exists: true, graph: { version: 1, nodes: [], edges: [] }, differs: true },
    ];
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply (restart)' }, { timeout: 5000 })
    );
    expect(
      await screen.findByText(
        'The instance restarted, but this session ended (the password changed?): log in again.',
        {},
        { timeout: 5000 }
      )
    ).toBeDefined();
    expect(screen.getByLabelText('Password')).toBeDefined();
  });

  it('shows the login again when the session expires', async () => {
    fakeApi({
      'GET /session': [200, { authenticated: true }],
      'GET /graph/view': [401, { error: 'log in first' }],
    });
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeDefined();
  });
});
