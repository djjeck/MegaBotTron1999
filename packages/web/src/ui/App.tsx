/**
 * The web UI (docs/bot-os.md P16, D43, D55): the owner's login, then the graph editor, the home
 * page and the main UI, beside the modules, the import from an older data directory, the admin
 * page (D59: the instance, its accounts and its plugins), drift and events; the other pages'
 * features move into the editor over time. The whole app is the owner's console, in one menu.
 * Every page is reached by the URL's hash (`#/admin`); a page added here is a line of `PAGES`, as
 * the widgets will be. The admin page's sections keep their old routes (`#/plugins`), which lead to
 * it, scrolled to the section.
 */
import type { ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { GraphPage } from './graph/GraphPage.tsx';
import { useRoute } from './hooks.ts';
import { Login } from './Login.tsx';
import { ADMIN_SECTIONS, AdminPage } from './pages/AdminPage.tsx';
import { DriftPage } from './pages/DriftPage.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { ImportPage } from './pages/ImportPage.tsx';
import { ModulesPage } from './pages/ModulesPage.tsx';

/**
 * What every page gets: the way to say the session is gone, and why (the login says it), and the
 * way to say the instance restarted, the session kept: the app loads the page afresh and says so.
 */
export interface PageProps {
  loggedOut: (note?: string) => void;
  restarted?: (note: string) => void;
  /** The section of the page that the route names, to scroll to (the admin page's). */
  section?: string | undefined;
}

/** A page: its route, its title, and whether it takes the window's whole width. */
export interface Page {
  route: string;
  title: string;
  wide: boolean;
  page: (p: PageProps) => ReactNode;
}

/** The pages, in the menus' order; the first is the home page. */
export const PAGES: Page[] = [
  { route: 'graph', title: 'Graph', wide: true, page: (p) => <GraphPage {...p} /> },
  { route: 'modules', title: 'Modules', wide: true, page: (p) => <ModulesPage {...p} /> },
  { route: 'import', title: 'Import', wide: true, page: (p) => <ImportPage {...p} /> },
  { route: 'admin', title: 'Admin', wide: false, page: (p) => <AdminPage {...p} /> },
  { route: 'drift', title: 'Drift', wide: false, page: (p) => <DriftPage {...p} /> },
  { route: 'events', title: 'Events', wide: false, page: (p) => <EventsPage {...p} /> },
];

/** The page a route leads to, and its section: an admin section's old route leads to it. */
export function resolve(route: string): { page: Page; section?: string } {
  const page = PAGES.find((p) => p.route === route);
  if (page !== undefined) return { page };
  if (ADMIN_SECTIONS.some((s) => s.id === route))
    return { page: PAGES.find((p) => p.route === 'admin') as Page, section: route };
  return { page: PAGES[0] as Page };
}

export function App() {
  const [session, setSession] = useState<'unknown' | 'in' | 'out'>('unknown');
  const [note, setNote] = useState<string>();
  const route = useRoute();
  // A restart's note, and the page's generation, bumped by a restart so that it loads afresh.
  const [notice, setNotice] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const restarted = useCallback((why: string) => {
    setNotice(why);
    setGeneration((g) => g + 1);
  }, []);
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
  const { page: current, section } = resolve(route);
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
        <nav aria-label="main">{PAGES.map(link)}</nav>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
      <main className={current.wide ? 'wide' : undefined}>
        <h1>{current.title}</h1>
        {notice === undefined ? null : (
          <p role="status" className="banner good">
            {notice}{' '}
            <button type="button" className="link" onClick={() => setNotice(undefined)}>
              dismiss
            </button>
          </p>
        )}
        <Fragment key={generation}>{current.page({ loggedOut, restarted, section })}</Fragment>
      </main>
    </>
  );
}
