/**
 * The web UI (docs/bot-os.md P16, D43, D55): the owner's login, then the graph editor, the home
 * page and the main UI, where what belongs to a node is shown on it and the instance's switches
 * are on the map's bar (D111), beside the modules, the History page (`#/admin`, D59, D111: the
 * graph's history, which has no node), drift and events. The whole app is the owner's console,
 * in one menu.
 *
 * Its shell: a top bar whose tabs are the pages (the tab selected is the page's title), the page
 * between, which alone scrolls, and a bottom bar for small print, such as diagnostics: the release
 * the instance runs and its commit, how long it has run and its memory (`GET /instance`, read every
 * minute and after a restart). The bars stay where they are. Read with it, whether the instance
 * now serves another app than the page runs (`stale.ts`, an upgrade while the page stayed open):
 * a banner then says so, with a button that reloads the page (#74).
 * Every page is reached by the URL's hash (`#/admin`); a page added here is a line of `PAGES`. A
 * node's own page (D112), declared by its plugin, is `#/node/<id>`, in no menu, opened from its
 * node's panel; its widget is on its card. Old routes keep leading somewhere: an admin section's (`#/graph-history`) to
 * it, scrolled to the section; one whose features moved into the editor (`#/plugins`,
 * `#/resources`) to the editor, the side sheet it names open.
 */
import type { ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { InstanceHealth } from './api.ts';
import { api } from './api.ts';
import type { Sheet } from './graph/GraphPage.tsx';
import { GraphPage } from './graph/GraphPage.tsx';
import { duration, useRoute } from './hooks.ts';
import { Login } from './Login.tsx';
import { ADMIN_SECTIONS, AdminPage } from './pages/AdminPage.tsx';
import { DriftPage } from './pages/DriftPage.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { ModulesPage } from './pages/ModulesPage.tsx';
import { NodePage } from './pages/NodePage.tsx';
import { ViewPage } from './pages/ViewPage.tsx';
import { appChanged } from './stale.ts';

/**
 * What every page gets: the way to say the session is gone, and why (the login says it), and the
 * way to say the instance restarted, the session kept: the app loads the page afresh and says so.
 */
export interface PageProps {
  loggedOut: (note?: string) => void;
  restarted?: (note: string) => void;
  /** The section of the page that the route names: the admin page's, or an editor's side sheet. */
  section?: string | undefined;
}

/**
 * A page: its route, its title, whether it takes the window's whole width, and whether it fills the
 * area between the bars, edge to edge, with no scroll of its own (the graph's map).
 */
export interface Page {
  route: string;
  title: string;
  wide: boolean;
  fill?: boolean;
  page: (p: PageProps) => ReactNode;
}

/** How long a restart's note stays before it goes by itself; dismiss takes it away sooner. */
export const NOTICE_MS = 30_000;

/** The pages, in the menus' order; the first is the home page. */
export const PAGES: Page[] = [
  { route: 'graph', title: 'Graph', wide: true, fill: true, page: (p) => <GraphPage {...p} /> },
  { route: 'modules', title: 'Modules', wide: true, page: (p) => <ModulesPage {...p} /> },
  { route: 'admin', title: 'History', wide: false, page: (p) => <AdminPage {...p} /> },
  { route: 'drift', title: 'Drift', wide: false, page: (p) => <DriftPage {...p} /> },
  { route: 'events', title: 'Events', wide: false, page: (p) => <EventsPage {...p} /> },
];

/**
 * A node's full page (D112), at `#/node/<id>`: in no menu, opened from its node's panel; the
 * node's id is the route's section.
 */
export const NODE_PAGE: Page = {
  route: 'node',
  title: 'Node page',
  wide: false,
  page: (p) => <NodePage {...p} />,
};

/**
 * The old routes of what moved into the editor (D111), and the side sheet each opens, if one: the
 * instance's switches are on the map's bar, an account and a plugin on its node.
 */
export const MOVED: Readonly<Record<string, Sheet | undefined>> = {
  instance: undefined,
  accounts: undefined,
  plugins: undefined,
  resources: 'costs',
  'graph-text': 'text',
};

/**
 * The page a route leads to, and its section: a node's page (`node/<id>`) to it, its id the
 * section; an admin section's old route to it, and one whose features moved into the editor to the
 * editor.
 */
export function resolve(path: string): { page: Page; section?: string } {
  const [route = '', ...rest] = path.split('/');
  if (route === NODE_PAGE.route && rest.length > 0)
    return { page: NODE_PAGE, section: decodeURIComponent(rest.join('/')) };
  // A node of the graph, opened in the editor (`graph/<id>`): a view's links to its nodes (D170).
  if (route === 'graph' && rest.length > 0)
    return { page: PAGES[0] as Page, section: `node/${decodeURIComponent(rest.join('/'))}` };
  const page = PAGES.find((p) => p.route === route);
  if (page !== undefined) return { page };
  if (ADMIN_SECTIONS.some((s) => s.id === route))
    return { page: PAGES.find((p) => p.route === 'admin') as Page, section: route };
  const home = PAGES[0] as Page;
  if (route in MOVED) {
    const sheet = MOVED[route];
    return sheet === undefined ? { page: home } : { page: home, section: sheet };
  }
  return { page: home };
}

/**
 * A view's page (D170), at `/v/<path>/`: in no menu; its path is its section. The app is the same
 * under that address, whose links lead back to the root's routes.
 */
export const VIEW_PAGE: Page = {
  route: 'v',
  title: 'View',
  wide: true,
  page: (p) => <ViewPage {...p} />,
};

/** A view's path, when the page is a view's (D170): its address ends in `/v/<path>/`. */
export function viewPathOf(pathname: string): string | undefined {
  return /\/v\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/$/u.exec(pathname)?.[1];
}

/** How the instance is, in the bottom bar: how long it has run and its memory. */
export function health(h: InstanceHealth): string {
  return `up ${duration(h.uptimeS)} · ${h.memoryMb.rss} MB`;
}

/** The release an instance runs, and its commit's start when known; undefined from an older one. */
export function release(h: InstanceHealth): string | undefined {
  if (h.version === undefined) return undefined;
  return h.commit === undefined ? `v${h.version}` : `v${h.version} (${h.commit.slice(0, 7)})`;
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
  // The note goes after NOTICE_MS, counted again from each restart (the generation), even one that
  // says the same.
  useEffect(() => {
    if (notice === undefined) return undefined;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, generation]);
  const loggedOut = useCallback((why?: string) => {
    setNote(why);
    setSession('out');
  }, []);
  // The instance as the bottom bar says it: read once logged in, after a restart, and every minute.
  const [instance, setInstance] = useState<InstanceHealth>();
  // Whether the instance serves a newer app than this page runs (#74): read with it.
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (session !== 'in') return undefined;
    const read = (): void => {
      api<InstanceHealth>('/instance').then(setInstance, () => setInstance(undefined));
      void appChanged().then(setStale);
    };
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [session, generation]);
  const build = instance === undefined ? undefined : release(instance);
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
  // A view's page (D170) is its own, under its address; its menu leads back to the root's pages.
  const viewAt = viewPathOf(window.location.pathname);
  const { page: current, section } =
    viewAt === undefined ? resolve(route) : { page: VIEW_PAGE, section: viewAt };
  const root = viewAt === undefined ? '' : '../../';
  const link = (p: Page) => (
    <a key={p.route} href={`${root}#/${p.route}`} aria-current={p === current ? 'page' : undefined}>
      {p.title}
    </a>
  );
  const logout = (): void => {
    api('/logout', {}).finally(() => loggedOut());
  };
  return (
    <div className="shell">
      <header>
        <strong className="brand">MegaBotTron1999</strong>
        <nav aria-label="main">{PAGES.map(link)}</nav>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
      <main
        className={
          [current.wide ? 'wide' : '', current.fill === true ? 'fill' : ''].join(' ').trim() ||
          undefined
        }
      >
        {/* The tab selected is the page's title on screen; this heading names it to a screen reader. */}
        <h1 className="visually-hidden">{current.title}</h1>
        {stale ? (
          <p role="alert" className="banner warn">
            The instance was upgraded: this page still runs the app it loaded before, which may draw
            what the instance sends wrongly.{' '}
            <button type="button" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </p>
        ) : null}
        {notice === undefined ? null : (
          <p role="status" className="banner good">
            {notice}{' '}
            <button type="button" className="link" onClick={() => setNotice(undefined)}>
              dismiss
            </button>
          </p>
        )}
        <div className="page">
          <Fragment key={generation}>{current.page({ loggedOut, restarted, section })}</Fragment>
        </div>
      </main>
      {/* The bottom bar: small print, such as diagnostics, in its slot. */}
      <footer className="status-bar">
        <div className="status-bar-slot">
          {build === undefined ? null : <span title="the release the instance runs">{build}</span>}
          {instance === undefined ? null : (
            <span
              title={`Node ${instance.node}; ${instance.memoryMb.heap} MB of JavaScript heap, of ${instance.memoryMb.rss} MB in all`}
            >
              {health(instance)}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
