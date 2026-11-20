/**
 * A node's files (bot-os.md D149), in its node's panel: those its plugin keeps in its instance's
 * store (`ctx.store.files`), from `GET /plugins/<id>/files`, read once as the panel opens: each
 * with its size, type and when it was written, a link to download it, and a raster image shown.
 * What they take together, against the instance's limit. Read only: deleting one stays the
 * plugin's. A node that keeps none shows nothing.
 */
import { useEffect, useState } from 'react';
import type { FilesView } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';

/** The types the control API serves inline (raster images), shown here. */
const SHOWN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A size in words: `1.5 MB`, `300 B`. */
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 2 ** 20) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 2 ** 20).toFixed(1)} MB`;
}

const when = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

export function NodeFiles(props: { id: string }) {
  const [view, setView] = useState<FilesView>();
  useEffect(() => {
    let live = true;
    setView(undefined);
    api<FilesView>(`/plugins/${seg(props.id)}/files`).then(
      (r) => {
        // An answer with no list (another route's, a server before files): nothing to show.
        if (live && Array.isArray(r.files)) setView(r);
      },
      () => {
        // No node, or not now: nothing to show.
      }
    );
    return () => {
      live = false;
    };
  }, [props.id]);
  if (view === undefined || view.files.length === 0) return null;
  const href = (name: string): string => `api/plugins/${seg(props.id)}/files/${seg(name)}`;
  return (
    <section aria-label={`files of ${props.id}`}>
      <h3>Files</h3>
      <p className="muted small">
        {view.files.length} {view.files.length === 1 ? 'file' : 'files'}, {sizeText(view.used)} of
        the {sizeText(view.limits.total)} it may keep.
      </p>
      <ul className="files">
        {view.files.map((f) => (
          <li key={f.name}>
            <a href={href(f.name)} download={f.name}>
              <code>{f.name}</code>
            </a>{' '}
            <span className="muted small">
              {sizeText(f.size)} · {f.type} · {when(f.written)} UTC
            </span>
            {SHOWN.has(f.type) ? (
              <div>
                <img src={href(f.name)} alt={f.name} loading="lazy" />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
