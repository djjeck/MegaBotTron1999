/**
 * The History page (docs/bot-os.md D59, D111), still at `#/admin`: what has no node, and so no
 * place in the graph editor: the graph's history (D61), whose name it takes. Its section's id is a route (`#/graph-history`), which leads
 * here, scrolled to it. What it held before moved into the editor (D111): the instance's switches
 * to the map's bar, its health to the bottom bar, each account, plugin and cost to its node's panel
 * and card, the costs' table and the graph as text to the editor's side sheets.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { PageProps } from '#src/ui/App.tsx';
import { GraphHistoryPage } from '#src/ui/pages/GraphHistoryPage.tsx';

/** The sections, in the page's order: each one's id (its route), title and content. */
export const ADMIN_SECTIONS: { id: string; title: string; content: (p: PageProps) => ReactNode }[] =
  [
    {
      id: 'graph-history',
      title: 'History',
      content: (p) => <GraphHistoryPage {...p} />,
    },
  ];

export function AdminPage(props: PageProps) {
  const { section } = props;
  useEffect(() => {
    if (section !== undefined) document.getElementById(section)?.scrollIntoView();
  }, [section]);
  return (
    <>
      {ADMIN_SECTIONS.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`}>
          <h2 id={`${s.id}-title`}>{s.title}</h2>
          {s.content(props)}
        </section>
      ))}
    </>
  );
}
