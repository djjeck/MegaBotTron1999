/**
 * The web UI (docs/bot-os.md P16, D43): the owner's login, then the graph view, the home
 * page, which is to become the main UI (once the editor is live, the other pages'
 * features move into it). Until then the admin pages, one per area, are a secondary
 * menu. Every page is reached by the URL's hash (`#/plugins`); a page added here is a line of
 * `PAGES`, as the widgets will be.
 */
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { GraphPage } from './graph/GraphPage.tsx';
import { useRoute } from './hooks.ts';
import { Login } from './Login.tsx';
import { AccountsPage } from './pages/AccountsPage.tsx';
import { DriftPage } from './pages/DriftPage.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { InstancePage } from './pages/InstancePage.tsx';
import { PluginsPage } from './pages/PluginsPage.tsx';

/** What every page gets: the way to say the session is gone. */
export interface PageProps {
  loggedOut: () => void;
}

/** A page: its route, its title, and whether it is the main menu's or the admin pages'. */
export interface Page {
  route: string;
  title: string;
  admin: boolean;
  page: (p: PageProps) => ReactNode;
}

/** The pages, in the menus' order; the first is the home page. */
export const PAGES: Page[] = [
  { route: 'graph', title: 'Graph', admin: false, page: (p) => <GraphPage {...p} /> },
  { route: 'instance', admin: true, title: 'Instance', page: (p) => <InstancePage {...p} /> },
  { route: 'accounts', admin: true, title: 'Accounts', page: (p) => <AccountsPage {...p} /> },
  { route: 'plugins', admin: true, title: 'Plugins', page: (p) => <PluginsPage {...p} /> },
  { route: 'drift', admin: true, title: 'Drift', page: (p) => <DriftPage {...p} /> },
  { route: 'events', admin: true, title: 'Events', page: (p) => <EventsPage {...p} /> },
];

export function App() {
  const [session, setSession] = useState<'unknown' | 'in' | 'out'>('unknown');
  const route = useRoute();
  const loggedOut = useCallback(() => setSession('out'), []);
  useEffect(() => {
    api<{ authenticated: boolean }>('/session').then(
      (s) => setSession(s.authenticated ? 'in' : 'out'),
      () => setSession('out')
    );
  }, []);

  if (session === 'unknown') return <p className="muted">Loading…</p>;
  if (session === 'out') return <Login onLogin={() => setSession('in')} />;
  const current = PAGES.find((p) => p.route === route) ?? (PAGES[0] as Page);
  const link = (p: Page) => (
    <a key={p.route} href={`#/${p.route}`} aria-current={p === current ? 'page' : undefined}>
      {p.title}
    </a>
  );
  const logout = (): void => {
    api('/logout', {}).finally(loggedOut);
  };
  return (
    <>
      <header>
        <strong>MegaBotTron1999</strong>
        <nav aria-label="main">{PAGES.filter((p) => !p.admin).map(link)}</nav>
        <nav aria-label="admin" className="secondary">
          <span className="muted">Admin:</span>
          {PAGES.filter((p) => p.admin).map(link)}
        </nav>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
      <main className={current.admin ? undefined : 'wide'}>
        <h1>{current.title}</h1>
        {current.page({ loggedOut })}
      </main>
    </>
  );
}
