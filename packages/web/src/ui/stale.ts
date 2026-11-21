/**
 * Whether this page runs an older app than the instance serves now (#74). A page stays open across
 * an upgrade: the instance restarts on a new image, the page reconnects and keeps the app it loaded,
 * which may not know what the new instance sends (a 0.1.55 page drew a 0.1.56 collection's media
 * field as its four properties). The app the instance serves is its `index.html`'s entry script,
 * named by its content's hash (`./assets/index-<hash>.js`); this page's is the one it loaded.
 * Read, not reloaded: an unsaved draft would be lost, so the owner is told and reloads.
 */

/** The entry script a page of the app names (its module script's `src`), or undefined. */
export function entryOf(html: string): string | undefined {
  for (const tag of html.match(/<script\b[^>]*>/giu) ?? []) {
    if (!/\btype=["']?module\b/iu.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/iu.exec(tag)?.[1];
    if (src !== undefined) return src;
  }
  return undefined;
}

/** The entry script this page loaded; undefined when it has none (the tests, Vite's dev server). */
export function ownEntry(doc: Document = document): string | undefined {
  return doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? undefined;
}

/**
 * Whether the instance serves another app than this page's: its `index.html` (never cached),
 * read again. False when either is unknown, or the read fails: no news is no change.
 */
export async function appChanged(own: string | undefined = ownEntry()): Promise<boolean> {
  if (own === undefined) return false;
  try {
    const res = await fetch('./', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    const served = entryOf(await res.text());
    return served !== undefined && served !== own;
  } catch {
    return false;
  }
}
