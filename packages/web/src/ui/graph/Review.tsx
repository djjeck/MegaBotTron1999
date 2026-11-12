/**
 * "Review changes" (D55), a dialog: what the draft changes from the saved graph, as
 * `POST /graph/check` says it (nodes and edges added, removed, changed), with every problem the
 * check finds, the stops cleared (D64), and two actions:
 *
 * - **Apply**: the draft saved (`PUT /graph/file`), each stop cleared
 *   (`POST /plugins/<id>/clear-stop`), then the instance restarted on it, with the reconnect
 *   overlay. A graph the check refuses is neither saved nor applied, and the dialog says why.
 * - **Revert**: the draft discarded, back to the saved graph (asked first).
 *
 * Its close button (×), or Escape, only closes it: the draft is kept.
 *
 * The diff's lists (`DiffView`) are the graph history's too (Admin → Graph history, D61).
 */
import { useEffect, useRef } from 'react';
import type { GraphCheckView, GraphDiff, GraphProblem } from '#src/ui/api.ts';

const ends = (e: { from: string; to: string }): string => `${e.from} → ${e.to}`;

function Items(props: { title: string; items: string[] }) {
  if (props.items.length === 0) return null;
  return (
    <>
      <h4>{props.title}</h4>
      <ul>
        {props.items.map((i) => (
          <li key={i}>
            <code>{i}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Whether a diff changes nothing. */
export const noChange = (d: GraphDiff): boolean =>
  [
    d.nodes.added,
    d.nodes.removed,
    d.nodes.changed,
    d.edges.added,
    d.edges.removed,
    d.edges.changed,
  ].every((l) => l.length === 0);

/** A diff's nodes and edges added, removed and changed, a list each (none for an empty one). */
export function DiffView({ diff: d }: { diff: GraphDiff }) {
  return (
    <>
      <Items title="Nodes added" items={d.nodes.added} />
      <Items title="Nodes removed (their instances kept)" items={d.nodes.removed} />
      <Items
        title="Nodes changed"
        items={d.nodes.changed.map((c) => `${c.id}: ${c.fields.join(', ')}`)}
      />
      <Items title="Edges added" items={d.edges.added.map(ends)} />
      <Items title="Edges removed" items={d.edges.removed.map(ends)} />
      <Items
        title="Edges changed"
        items={d.edges.changed.map((e) =>
          e.fields.length === 0 ? ends(e) : `${ends(e)}: ${e.fields.join(', ')}`
        )}
      />
    </>
  );
}

export function Review(props: {
  check: GraphCheckView | undefined;
  /** Whether the draft differs from the saved graph, or clears a stop. */
  dirty: boolean;
  /** The nodes whose stop the draft clears (D64). */
  clears?: readonly string[];
  /** Applying: the save or the restart under way. */
  busy: boolean;
  /** Why the last Apply was refused, with the problems named. */
  refused?: { error: string; problems: GraphProblem[] } | undefined;
  apply: () => void;
  revert: () => void;
  close: () => void;
}) {
  const { check, refused } = props;
  const d = check?.diff;
  const clears = props.clears ?? [];
  const none = d !== undefined && noChange(d) && clears.length === 0;
  const ok = check?.ok === true;
  const first = useRef<HTMLButtonElement>(null);
  const { close } = props;
  useEffect(() => {
    first.current?.focus();
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  return (
    <div className="overlay">
      <div className="card review" role="dialog" aria-modal="true" aria-label="review changes">
        <h2>
          Review changes
          <button
            type="button"
            className="close"
            aria-label="Close, keeping the changes"
            title="Close, keeping the changes"
            onClick={close}
            ref={first}
          >
            ×
          </button>
        </h2>
        {d === undefined ? (
          <p className="muted">Checking…</p>
        ) : none ? (
          <p className="muted">Nothing differs from the saved graph.</p>
        ) : (
          <>
            <DiffView diff={d} />
            <Items title="Stops cleared (started again)" items={[...clears]} />
          </>
        )}
        {check === undefined || ok ? null : (
          <>
            <h4 className="error">The check refuses it: fix these first</h4>
            <ul className="problems" aria-label="problems">
              {check.problems.map((p) => (
                <li key={p.text}>{p.text}</li>
              ))}
            </ul>
          </>
        )}
        {refused === undefined ? null : (
          <div role="alert" className="banner bad">
            Not applied: {refused.error}.
            {refused.problems.length === 0 ? null : (
              <ul className="problems" aria-label="why it was not applied">
                {refused.problems.map((p) => (
                  <li key={p.text}>{p.text}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="muted small">
          <strong>Apply</strong> saves the graph and restarts the instance on it: each plugin keeps
          its state, and this page comes back by itself. <strong>Revert</strong> drops these
          changes, back to the graph saved.
        </p>
        <p className="actions">
          <button
            type="button"
            className="primary"
            disabled={!props.dirty || !ok || props.busy}
            onClick={props.apply}
          >
            {props.busy ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" disabled={props.busy} onClick={props.revert}>
            Revert
          </button>
        </p>
      </div>
    </div>
  );
}
