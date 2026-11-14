/**
 * The edge selected in the graph editor (D55): its two ends, its type, why the check refuses it,
 * and, for a chat, what it carries (bot-os-api.md §2.1, D60–D63), picked from its connector's
 * monitored chats (`Surfaces.tsx`): a chat-in edge, the chats it `reads` (or all of them, `'*'`)
 * and the `senders` it hears (anyone, or a list with `me`), any chat from anyone flagged as broad;
 * a chat-out edge, those it `sends` to and the `commands` sent (their first words), as rows, and
 * each command's spacing for the queued sends (D73: the least seconds between two of it in one
 * chat; empty, the connector's default), and
 * whether it is a dry run (D64): **Dry-run** logs what it would send, as sent, and sends nothing;
 * **Send for real** sends. Then its removal. The edges are the permissions (P6): a plugin reads and
 * sends only what its edge says.
 */
import type { GraphEdge, GraphNode } from '#src/ui/api.ts';
import type { EdgeChange } from './draft.ts';
import { CHATS_KEY, EdgeChats, RowsField, Senders } from './Surfaces.tsx';

/** The connector's monitored chats, as its config lists them; undefined: every chat. */
function monitoredOf(node: GraphNode | undefined): string[] | undefined {
  const chats = node?.config?.[CHATS_KEY];
  return Array.isArray(chats) ? chats.filter((c): c is string => typeof c === 'string') : undefined;
}

/**
 * Each command's spacing (D73): the least seconds between two queued sends of it in one chat, the
 * window in which a node can still cancel one; empty, the connector's default.
 */
function Spacing(props: {
  commands: readonly string[];
  value: Readonly<Record<string, number>>;
  set: (v: Record<string, number> | undefined) => void;
}) {
  if (props.commands.length === 0) return null;
  const put = (command: string, raw: string): void => {
    const next: Record<string, number> = { ...props.value };
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) delete next[command];
    else next[command] = n;
    props.set(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <div className="field spacing" role="group" aria-label="spacing">
      <code>minIntervalS</code>
      <ul className="rows">
        {props.commands.map((c) => (
          <li key={c}>
            <label>
              <code>{c}</code>{' '}
              <input
                type="number"
                min={0}
                aria-label={`seconds between two ${c}`}
                placeholder="default"
                value={props.value[c] ?? ''}
                onChange={(e) => put(c, e.target.value)}
              />{' '}
              s
            </label>
          </li>
        ))}
      </ul>
      <small className="muted">
        The least seconds between two queued sends of each command in one chat, the time a node has
        to cancel one; empty: the connector’s default. Applied with Apply.
      </small>
    </div>
  );
}

export function EdgeDetails(props: {
  edge: GraphEdge;
  problems: string[];
  /** The check's warnings on it (D89): they refuse nothing. */
  warnings?: string[];
  /** The connector node at its chat end, if it is a chat edge. */
  connector?: GraphNode | undefined;
  change: (change: EdgeChange) => void;
  remove: () => void;
}) {
  const { edge } = props;
  const reads = edge.type === 'chat-in';
  const sends = edge.type === 'chat-out';
  const name = `${edge.from} → ${edge.to}`;
  const connector = props.connector?.id;
  const monitored = monitoredOf(props.connector);
  return (
    <aside className="details" aria-label={`details of edge ${name}`} key={name}>
      <h2>Edge</h2>
      <p>
        <code>{name}</code> <span className="muted">({edge.type ?? 'type to be found'})</span>
      </p>
      {props.problems.length === 0 ? null : (
        <ul className="problems" aria-label="problems of the edge">
          {props.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {(props.warnings ?? []).length === 0 ? null : (
        <ul className="warnings" aria-label="warnings of the edge">
          {(props.warnings ?? []).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {reads ? (
        <section>
          <h3>What it reads</h3>
          {edge.reads === '*' && edge.senders === undefined ? (
            <p className="warning" role="note">
              Broad: it hears any chat its connector monitors, from anyone.
            </p>
          ) : null}
          <EdgeChats
            name="reads"
            any
            help="The chats the plugin hears from the connector; it hears no other"
            connector={connector}
            monitored={monitored}
            value={edge.reads}
            set={(r) => props.change({ reads: r })}
          />
          <Senders
            connector={connector}
            value={edge.senders}
            set={(senders) => props.change({ senders })}
          />
        </section>
      ) : sends ? (
        <section>
          <h3>How it sends</h3>
          <div className="toggle" role="radiogroup" aria-label="how it sends">
            <button
              type="button"
              role="radio"
              aria-checked={edge.dryRun === true}
              className={edge.dryRun === true ? 'on' : ''}
              onClick={() => props.change({ dryRun: true })}
            >
              Dry-run
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={edge.dryRun !== true}
              className={edge.dryRun === true ? '' : 'on danger'}
              onClick={() => props.change({ dryRun: undefined })}
            >
              Send for real
            </button>
          </div>
          <p className="muted small">
            {edge.dryRun === true
              ? 'A dry run: what the plugin sends here is logged as sent, and nothing goes out.'
              : 'It sends for real, within the chats and commands below.'}{' '}
            Applied with Apply.
          </p>
          <h3>What it sends</h3>
          <EdgeChats
            name="sends"
            help="The chats the plugin may send to through the connector; the outbox refuses any other"
            connector={connector}
            monitored={monitored}
            value={edge.sends}
            set={(s) => props.change({ sends: s === '*' ? [] : s })}
          />
          <RowsField
            name="commands"
            help="The commands it may send there, by first word (/play); none: any text"
            placeholder="/play"
            value={edge.commands ?? []}
            set={(commands) => {
              // A command taken out takes its spacing with it.
              const kept = Object.entries(edge.minIntervalS ?? {}).filter(([c]) =>
                commands.includes(c)
              );
              props.change({
                commands,
                minIntervalS: kept.length === 0 ? undefined : Object.fromEntries(kept),
              });
            }}
          />
          <Spacing
            commands={edge.commands ?? []}
            value={edge.minIntervalS ?? {}}
            set={(minIntervalS) => props.change({ minIntervalS })}
          />
        </section>
      ) : (
        <p className="muted">It carries nothing to set: the binding is the permission.</p>
      )}
      <p>
        <button type="button" className="danger" onClick={props.remove}>
          Remove edge
        </button>
      </p>
    </aside>
  );
}
