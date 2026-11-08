/**
 * The web UI (docs/bot-os.md P16, D43, D55): the owner's login, then the graph editor, the home
 * page and the main UI, beside the modules and the import from an older data directory; the other
 * pages' features move into the editor over time. Until then the admin pages, one per area, are a
 * secondary menu. Every page is reached by the URL's hash (`#/plugins`); a page added here is a
 * line of `PAGES`, as the widgets will be.
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
import { ImportPage } from './pages/ImportPage.tsx';
import { InstancePage } from './pages/InstancePage.tsx';
import { ModulesPage } from './pages/ModulesPage.tsx';
import { PluginsPage } from './pages/PluginsPage.tsx';

/** What every page gets: the way to say the session is gone, and why (the login says it). */
export interface PageProps {
  loggedOut: (note?: string) => void;
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
  { route: 'modules', title: 'Modules', admin: false, page: (p) => <ModulesPage {...p} /> },
  { route: 'import', title: 'Import', admin: false, page: (p) => <ImportPage {...p} /> },
  { route: 'instance', admin: true, title: 'Instance', page: (p) => <InstancePage {...p} /> },
  { route: 'accounts', admin: true, title: 'Accounts', page: (p) => <AccountsPage {...p} /> },
  { route: 'plugins', admin: true, title: 'Plugins', page: (p) => <PluginsPage {...p} /> },
  { route: 'drift', admin: true, title: 'Drift', page: (p) => <DriftPage {...p} /> },
  { route: 'events', admin: true, title: 'Events', page: (p) => <EventsPage {...p} /> },
];

export function App() {
  const [session, setSession] = useState<'unknown' | 'in' | 'out'>('unknown');
  const [note, setNote] = useState<string>();
  const route = useRoute();
  const loggedOut = useCallback((why?: string) => {
    setNote(why);
    setSession('out');
  }, []);
  useEffect(() => {
    api<{ authenticated: boolean }>('/session').then(
      (s) => setSession(s.authenticated ? 'in' : 'out'),
      () => setSession('out')
    );
  }, []);

  if (session === 'unknown') return <p className="muted">Loading…</p>;
  if (session === 'out')
    return (
      <Login
        note={note}
        onLogin={() => {
          setNote(undefined);
          setSession('in');
        }}
      />
    );
  const current = PAGES.find((p) => p.route === route) ?? (PAGES[0] as Page);
  const link = (p: Page) => (
    <a key={p.route} href={`#/${p.route}`} aria-current={p === current ? 'page' : undefined}>
      {p.title}
    </a>
  );
  const logout = (): void => {
    api('/logout', {}).finally(() => loggedOut());
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
