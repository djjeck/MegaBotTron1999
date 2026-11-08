/**
 * The edge selected in the graph editor (D55): its two ends, its type, why the check refuses it,
 * and, for a chat, what it carries (bot-os-api.md §2.1): the chats it `reads`, those it `sends` to,
 * and the `commands` sent (their first words), one per line; then its removal. The edges are the
 * permissions (P6): a plugin reads and sends only what its edge says.
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
  const chat = edge.type === 'chat';
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
      {chat ? (
        <section>
          <h3>What it carries</h3>
          <ListField
            name="reads"
            help="The chats its input hears (a channel, a chat id, a bot’s @username), one per line"
            value={edge.reads}
            set={(reads) => props.change({ reads })}
          />
          <ListField
            name="sends"
            help="The chats it may send to; the outbox refuses any other"
            value={edge.sends}
            set={(sends) => props.change({ sends })}
          />
          <ListField
            name="commands"
            help="The commands it may send, by first word (/play); empty: any text"
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
