/**
 * The admin page (docs/bot-os.md D59): the instance, its accounts and its plugins, one section each,
 * in this order. A section's id is the route it once had (`#/plugins`), which still leads here,
 * scrolled to it.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { PageProps } from '#src/ui/App.tsx';
import { AccountsPage } from '#src/ui/pages/AccountsPage.tsx';
import { InstancePage } from '#src/ui/pages/InstancePage.tsx';
import { PluginsPage } from '#src/ui/pages/PluginsPage.tsx';

/** The sections, in the page's order: each one's id (its old route), title and content. */
export const ADMIN_SECTIONS: { id: string; title: string; content: (p: PageProps) => ReactNode }[] =
  [
    { id: 'instance', title: 'Instance', content: (p) => <InstancePage {...p} /> },
    { id: 'accounts', title: 'Accounts', content: (p) => <AccountsPage {...p} /> },
    { id: 'plugins', title: 'Plugins', content: (p) => <PluginsPage {...p} /> },
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
