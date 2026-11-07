// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '#test/fake-api.ts';
import { fakeApi } from '#test/fake-api.ts';
import { DRIFT, status, VIEW } from '#test/graph-view.ts';
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

const GRAPH: Record<string, Answer> = {
  'GET /graph/view': [200, VIEW],
  'GET /status': [200, status()],
  'GET /drift': [200, DRIFT],
};

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
      'GET /session': [200, { authenticated: false }],
      'POST /login': (body) =>
        (body as { password: string }).password === 'right password'
          ? [200, { authenticated: true }]
          : [401, { error: 'wrong password' }],
      ...GRAPH,
    });
    render(<App />);
    const field = await screen.findByLabelText('Password');
    fireEvent.change(field, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'wrong password');
    fireEvent.change(field, { target: { value: 'right password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeDefined();
    expect(await screen.findByLabelText('node actor-a')).toBeDefined();
    expect(api.calls).toContain('POST /login {"password":"right password"}');
  });

  it('shows the login when the session cannot be read', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    render(<App />);
    expect(await screen.findByLabelText('Password')).toBeDefined();
  });

  it('goes to each page by the hash, marks it in its menu, and logs out', async () => {
    const api = fakeApi({
      ...GRAPH,
      'GET /session': [200, { authenticated: true }],
      'GET /instance': [200, HEALTH],
      'GET /accounts': [200, []],
      'GET /drift': [200, []],
      'GET /events?type=core.drift&limit=50&hours=168': [200, []],
      'GET /events?limit=100&type=': [200, []],
      'POST /logout': [200, { authenticated: false }],
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Graph' });
    // The graph is the main menu's; the admin pages are a menu of their own.
    expect(
      within(screen.getByRole('navigation', { name: 'main' })).getAllByRole('link')
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('navigation', { name: 'admin' })).getAllByRole('link')
    ).toHaveLength(5);
    for (const page of PAGES) {
      window.location.hash = `#/${page.route}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      expect(await screen.findByRole('heading', { name: page.title, level: 1 })).toBeDefined();
      expect(screen.getByRole('link', { name: page.title }).getAttribute('aria-current')).toBe(
        'page'
      );
    }
    window.location.hash = '#/nowhere';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Password')).toBeDefined();
    expect(api.calls).toContain('POST /logout {}');
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
