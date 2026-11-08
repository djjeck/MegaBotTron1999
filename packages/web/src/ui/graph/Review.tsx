/**
 * "Review changes" (D55): what the draft changes from the saved file, as `POST /graph/check` says
 * it (nodes and edges added, removed, changed), with every problem the check finds; then "Save"
 * (`PUT /graph/file`), and, once saved, "Apply (restart)". A graph the check refuses is not saved.
 */
import type { GraphCheckView } from '#src/ui/api.ts';

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

export function Review(props: {
  check: GraphCheckView | undefined;
  /** Whether the draft differs from the saved file. */
  dirty: boolean;
  /** What the last save answered. */
  saved?: { restart: boolean } | undefined;
  busy: boolean;
  save: () => void;
  apply: () => void;
  close: () => void;
}) {
  const { check } = props;
  const d = check?.diff;
  const none =
    d !== undefined &&
    [
      d.nodes.added,
      d.nodes.removed,
      d.nodes.changed,
      d.edges.added,
      d.edges.removed,
      d.edges.changed,
    ].every((l) => l.length === 0);
  return (
    <aside className="details" aria-label="review changes">
      <h2>
        Review changes{' '}
        <button type="button" className="link" onClick={props.close}>
          close
        </button>
      </h2>
      {d === undefined ? (
        <p className="muted">Checking…</p>
      ) : none ? (
        <p className="muted">Nothing differs from the saved graph.</p>
      ) : (
        <>
          <Items title="Nodes added" items={d.nodes.added} />
          <Items title="Nodes removed (their instances kept)" items={d.nodes.removed} />
          <Items
            title="Nodes changed"
            items={d.nodes.changed.map((c) => `${c.id}: ${c.fields.join(', ')}`)}
          />
          <Items title="Edges added" items={d.edges.added.map(ends)} />
          <Items title="Edges removed" items={d.edges.removed.map(ends)} />
          <Items title="Edges changed" items={d.edges.changed.map(ends)} />
        </>
      )}
      {check === undefined || check.ok ? null : (
        <>
          <h4 className="error">The check refuses it</h4>
          <ul className="problems" aria-label="problems">
            {check.problems.map((p) => (
              <li key={p.text}>{p.text}</li>
            ))}
          </ul>
        </>
      )}
      <p>
        <button
          type="button"
          disabled={!props.dirty || check?.ok !== true || props.busy}
          onClick={props.save}
        >
          Save
        </button>
        {props.saved === undefined ? null : props.saved.restart ? (
          <>
            {' '}
            Saved: it runs once the instance restarts.{' '}
            <button type="button" onClick={props.apply}>
              Apply (restart)
            </button>
          </>
        ) : (
          <span> Saved: it is what runs already.</span>
        )}
      </p>
    </aside>
  );
}
