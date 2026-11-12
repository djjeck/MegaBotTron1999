/**
 * The graph's history and the graph as text, two sections of the admin page (bot-os.md D61,
 * bot-os-api.md §2.3):
 *
 * - **Graph history** (`GET /graph/history`): every version of the saved graph kept, newest first,
 *   with its time, what changed from the one before, and how the instance started on it (it ran,
 *   it was refused, or it never started); the newest that ran is marked "last good". A version
 *   opened (`GET /graph/history/<id>`) shows, in two tabs, what rolling back to it would change in
 *   the current graph: **Changes**, the structured diff of the review (`DiffView`), and **As text**,
 *   the line diff of the two printouts. **Roll back to this** asks first, repeating the diff, then
 *   writes it as the current graph (`POST /graph/history/<id>/rollback`, itself a new version, so
 *   it can be undone) and restarts the instance on it, with the reconnect overlay.
 * - **Graph as text**: the saved graph printed (`GET /graph/file`'s `text`), with a copy button.
 */
import { useEffect, useState } from 'react';
import type {
  GraphFileView,
  GraphHistoryView,
  GraphVersionMeta,
  GraphVersionView,
} from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { LineDiffView, TextView } from '#src/ui/graph/GraphText.tsx';
import { DiffView, noChange } from '#src/ui/graph/Review.tsx';
import { useLoad } from '#src/ui/hooks.ts';
import { Restart } from '#src/ui/Restart.tsx';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A version's time, as the owner's browser writes it. */
const when = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
};

/** Where a version comes from, when not a save. */
const ORIGIN: Record<GraphVersionMeta['source'], string | undefined> = {
  save: undefined,
  rollback: 'rollback',
  found: 'written outside the UI',
  migrated: 'from before the history',
};

/** How the instance last started on a version. */
function StartStatus({ v }: { v: GraphVersionMeta }) {
  if (v.start === undefined) return <span className="muted">never started</span>;
  if (v.start.result === 'ran') return <span className="badge running">ran</span>;
  return (
    <span className="badge failed" title={(v.start.problems ?? []).join('\n')}>
      refused
    </span>
  );
}

/** The versions, newest first: a row each, with its time, its summary and its start. */
function Versions(props: {
  history: GraphHistoryView;
  open: string | undefined;
  choose: (id: string) => void;
}) {
  const { versions, current, lastGood } = props.history;
  const byId = new Map(versions.map((v) => [v.id, v]));
  return (
    <table className="history">
      <thead>
        <tr>
          <th>Time</th>
          <th>What changed</th>
          <th>Start</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => {
          const origin = ORIGIN[v.source];
          const restored = v.restores === undefined ? undefined : byId.get(v.restores);
          return (
            <tr key={v.id} className={v.id === props.open ? 'open' : undefined}>
              <td>
                <time dateTime={v.time}>{when(v.time)}</time>
                {v.id === current ? <span className="badge mode">current</span> : null}
                {v.id === lastGood ? <span className="badge running">last good</span> : null}
              </td>
              <td>
                {origin === undefined ? null : (
                  <span className="muted small">
                    {origin}
                    {v.restores === undefined
                      ? ''
                      : ` to ${restored === undefined ? v.restores : when(restored.time)}`}
                    :{' '}
                  </span>
                )}
                <code>{v.summary}</code>
              </td>
              <td>
                <StartStatus v={v} />
              </td>
              <td>
                <button
                  type="button"
                  aria-pressed={v.id === props.open}
                  aria-label={`Open the version of ${when(v.time)}`}
                  onClick={() => props.choose(v.id)}
                >
                  Open
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** What rolling back to a version would change: the structured diff, or nothing. */
function Changes({ v }: { v: GraphVersionView }) {
  if (noChange(v.diff))
    return <p className="muted">This version is the same as the current graph.</p>;
  return (
    <>
      <p className="muted small">Rolling back to it changes the current graph so:</p>
      <DiffView diff={v.diff} />
    </>
  );
}

/** Why the check refuses a version now, if it does. */
function Refused({ v }: { v: GraphVersionView }) {
  if (v.problems === undefined || v.problems.length === 0) return null;
  return (
    <div role="alert" className="banner warn">
      The check refuses this version now: the instance would start on it with no nodes.
      <ul className="problems">
        {v.problems.map((p) => (
          <li key={p.text}>{p.text}</li>
        ))}
      </ul>
    </div>
  );
}

/** A version opened: two tabs, and its rollback. */
function Version(props: { v: GraphVersionView; rollback: () => void; close: () => void }) {
  const { v } = props;
  const [tab, setTab] = useState<'changes' | 'text'>('changes');
  const tabs = [
    ['changes', 'Changes'],
    ['text', 'As text'],
  ] as const;
  return (
    <section className="version" aria-label={`version of ${when(v.time)}`}>
      <h3>
        The version of {when(v.time)}{' '}
        <button type="button" className="link" onClick={props.close}>
          close
        </button>
      </h3>
      <p>
        <code>{v.summary}</code>
      </p>
      <div role="tablist" aria-label="how it differs">
        {tabs.map(([id, title]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`version-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`version-panel-${id}`}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`version-panel-${tab}`} aria-labelledby={`version-tab-${tab}`}>
        {tab === 'changes' ? (
          <Changes v={v} />
        ) : (
          <>
            <p className="muted small">
              The current graph printed, then this version: <code>−</code> a line only the current
              graph has, <code>+</code> one only this version has.
            </p>
            <LineDiffView lines={v.lines} label="line diff" />
            <details>
              <summary>This version in full</summary>
              <TextView text={v.text} label="this version as text" />
            </details>
          </>
        )}
      </div>
      <Refused v={v} />
      <p className="actions">
        <button type="button" className="primary" disabled={v.current} onClick={props.rollback}>
          Roll back to this
        </button>{' '}
        {v.current ? <span className="muted small">It is the current graph.</span> : null}
      </p>
    </section>
  );
}

/** The confirmation of a rollback, repeating what it changes. */
function ConfirmRollback(props: {
  v: GraphVersionView;
  busy: boolean;
  confirm: () => void;
  cancel: () => void;
}) {
  const { v } = props;
  return (
    <div className="overlay">
      <div className="card review" role="dialog" aria-modal="true" aria-label="roll back">
        <h2>Roll back to the version of {when(v.time)}?</h2>
        <Changes v={v} />
        <Refused v={v} />
        <p className="muted small">
          The current graph is kept in the history, and the rollback is a version of its own, so it
          can be undone. The instance restarts on it: each plugin keeps its state, and this page
          comes back by itself.
        </p>
        <p className="actions">
          <button type="button" className="primary" disabled={props.busy} onClick={props.confirm}>
            {props.busy ? 'Rolling back…' : 'Roll back and restart'}
          </button>
          <button type="button" disabled={props.busy} onClick={props.cancel}>
            Cancel
          </button>
        </p>
      </div>
    </div>
  );
}

export function GraphHistoryPage({ loggedOut, restarted }: PageProps) {
  const history = useLoad(() => api<GraphHistoryView>('/graph/history'), loggedOut, 30_000);
  const [open, setOpen] = useState<string>();
  const [version, setVersion] = useState<GraphVersionView>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [said, setSaid] = useState<string>();

  useEffect(() => {
    setVersion(undefined);
    if (open === undefined) return;
    let live = true;
    api<GraphVersionView>(`/graph/history/${seg(open)}`).then(
      (v) => {
        if (live) setVersion(v);
      },
      (e: unknown) => {
        if (live) setSaid(`${open}: ${message(e)}`);
      }
    );
    return () => {
      live = false;
    };
  }, [open]);

  const rollback = (v: GraphVersionView): void => {
    setBusy(true);
    api(`/graph/history/${seg(v.id)}/rollback`, {}).then(
      () => {
        setBusy(false);
        setConfirming(false);
        setRestarting(true);
      },
      (e: unknown) => {
        setBusy(false);
        setConfirming(false);
        setSaid(`Not rolled back: ${message(e)}`);
        history.reload();
      }
    );
  };

  const h = history.data;
  if (h === undefined) return <p className="muted">{history.error ?? 'Loading…'}</p>;
  return (
    <>
      <p className="muted small">
        Every graph applied is kept {h.keep.days} days, and never fewer than the {h.keep.latest}{' '}
        latest. A version opened shows what rolling back to it would change.
      </p>
      {said === undefined ? null : <p role="status">{said}</p>}
      {h.versions.length === 0 ? (
        <p className="muted">No graph has been applied yet.</p>
      ) : (
        <Versions
          history={h}
          open={open}
          choose={(id) => {
            setSaid(undefined);
            setOpen(id === open ? undefined : id);
          }}
        />
      )}
      {open === undefined ? null : version === undefined ? (
        <p className="muted">Loading the version…</p>
      ) : (
        <Version
          key={version.id}
          v={version}
          rollback={() => setConfirming(true)}
          close={() => setOpen(undefined)}
        />
      )}
      {confirming && version !== undefined ? (
        <ConfirmRollback
          v={version}
          busy={busy}
          confirm={() => rollback(version)}
          cancel={() => setConfirming(false)}
        />
      ) : null}
      {restarting ? (
        <Restart
          done={(note) => {
            setRestarting(false);
            setOpen(undefined);
            if (restarted === undefined) {
              setSaid(note);
              history.reload();
            } else restarted(note);
          }}
          loggedOut={(note) => loggedOut(note)}
          failed={(why) => {
            setRestarting(false);
            setSaid(`Rolled back, but not restarted: ${why}. Apply it from the graph editor.`);
            history.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** The saved graph printed, to read or to copy. */
export function GraphTextPage({ loggedOut }: PageProps) {
  const file = useLoad(() => api<GraphFileView>('/graph/file'), loggedOut, 60_000);
  const f = file.data;
  if (f === undefined) return <p className="muted">{file.error ?? 'Loading…'}</p>;
  if (!f.exists) return <p className="muted">No graph is saved yet.</p>;
  if (f.error !== undefined) return <p role="alert">{f.error}</p>;
  return <TextView text={f.text} label="the saved graph as text" />;
}
