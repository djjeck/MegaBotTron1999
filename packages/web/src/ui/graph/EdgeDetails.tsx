/**
 * The edge selected in the graph editor (D55): its two ends, its type, why the check refuses it,
 * and, for a chat, what it carries (bot-os-api.md §2.1, D60): a chat-in edge, the chats it `reads`;
 * a chat-out edge, those it `sends` to and the `commands` sent (their first words); one per line.
 * Then its removal. The edges are the permissions (P6): a plugin reads and sends only what its edge
 * says.
 */
import { useState } from 'react';
import type { GraphEdge } from '#src/ui/api.ts';

const lines = (v: readonly string[] | undefined): string => (v ?? []).join('\n');
const list = (text: string): string[] =>
  text
    .split(/[\n,]/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** A list edited as lines, set when the field is left. */
function ListField(props: {
  name: string;
  help: string;
  value: readonly string[] | undefined;
  set: (v: string[]) => void;
}) {
  const [text, setText] = useState(lines(props.value));
  return (
    <div className="field">
      <label>
        <code>{props.name}</code>
        <textarea
          aria-label={props.name}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => props.set(list(text))}
        />
      </label>
      <small className="muted">{props.help}</small>
    </div>
  );
}

export function EdgeDetails(props: {
  edge: GraphEdge;
  problems: string[];
  change: (change: Pick<GraphEdge, 'reads' | 'sends' | 'commands'>) => void;
  remove: () => void;
}) {
  const { edge } = props;
  const reads = edge.type === 'chat-in';
  const sends = edge.type === 'chat-out';
  const name = `${edge.from} → ${edge.to}`;
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
      {reads ? (
        <section>
          <h3>What it reads</h3>
          <ListField
            name="reads"
            help="The chats the plugin hears from the connector (a channel, a chat id, a bot’s @username), one per line; it hears no other"
            value={edge.reads}
            set={(r) => props.change({ reads: r })}
          />
        </section>
      ) : sends ? (
        <section>
          <h3>What it sends</h3>
          <ListField
            name="sends"
            help="The chats the plugin may send to through the connector, one per line; the outbox refuses any other"
            value={edge.sends}
            set={(s) => props.change({ sends: s })}
          />
          <ListField
            name="commands"
            help="The commands it may send there, by first word (/play); empty: any text"
            value={edge.commands}
            set={(commands) => props.change({ commands })}
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
