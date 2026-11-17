/**
 * The edge selected in the graph editor (D55): its two ends, its type, why the check refuses it,
 * and, for a chat, what it carries (bot-os-api.md §2.1, D60–D63), picked from its connector's
 * monitored chats (`Surfaces.tsx`): a chat-in edge, the chats it `reads` (or all of them, `'*'`)
 * and the `senders` it hears (anyone, or a list with `me`), any chat from anyone flagged as broad;
 * a chat-out edge, those it `sends` to (among all its connector's chats: sending needs no
 * monitoring; an edge naming none from an output that tells the owner says it sends to the
 * connector's owner's chat, D97) and the `commands` sent (their first words), as rows, and
 * each command's spacing for the queued sends (D73: the least seconds between two of it in one
 * chat; empty, the connector's default), and
 * whether it is a dry run (D64): **Dry-run** logs what it would send, as sent, and sends nothing;
 * **Send for real** sends. A commands edge (D109), from a connector to a plugin's chat commands:
 * which of them it answers (checkboxes, every one by default), the `chats` it answers them in (in
 * the chat picker) and every private chat (`privateChats`), who may ask (`senders`: anyone, or a
 * list with _the owner_), all within whom and where its connector works for (a `telegram-bot`'s
 * gate, bot-os.md D128, which it says), and its dry run, which logs each answer and sends none.
 * Then its removal.
 * The edges are the permissions (P6): a plugin reads, sends and answers only what its edge says.
 */
import type { GraphEdge, GraphNode, PortView } from '#src/ui/api.ts';
import type { EdgeChange } from './draft.ts';
import { Payloads } from './Payloads.tsx';
import { CHATS_KEY, EdgeChats, RowsField, Senders } from './Surfaces.tsx';

/** A chat-out's or a commands edge's dry run (D64, D109): logged as sent, and nothing goes out. */
function DryRun(props: {
  label: string;
  dryRun: boolean;
  set: (dryRun: true | undefined) => void;
  /** What it does, either way. */
  dry: string;
  live: string;
}) {
  return (
    <>
      <div className="toggle" role="radiogroup" aria-label={props.label}>
        <button
          type="button"
          role="radio"
          aria-checked={props.dryRun}
          className={props.dryRun ? 'on' : ''}
          onClick={() => props.set(true)}
        >
          Dry-run
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!props.dryRun}
          className={props.dryRun ? '' : 'on danger'}
          onClick={() => props.set(undefined)}
        >
          Send for real
        </button>
      </div>
      <p className="muted small">{props.dryRun ? props.dry : props.live} Applied with Apply.</p>
    </>
  );
}

/**
 * The chat commands a commands edge serves (D109), as checkboxes over its plugin's: unset, every
 * one (a command added to the plugin later too).
 */
function Serves(props: {
  commands: readonly string[];
  value: readonly string[] | undefined;
  set: (v: string[] | undefined) => void;
}) {
  const on = props.value ?? props.commands;
  const flip = (c: string, checked: boolean): void => {
    const next = props.commands.filter((x) => (x === c ? checked : on.includes(x)));
    props.set(next.length === props.commands.length ? undefined : next);
  };
  return (
    <fieldset className="field" aria-label="serves">
      <legend>
        <code>serves</code>: the commands it answers
      </legend>
      {props.commands.map((c) => (
        <label key={c} className="block">
          <input
            type="checkbox"
            aria-label={`answers /${c}`}
            checked={on.includes(c)}
            onChange={(e) => flip(c, e.target.checked)}
          />{' '}
          <code>/{c}</code>
        </label>
      ))}
      <small className="muted">
        All of them while every box is ticked, those the plugin adds later too. Not a chat-out
        edge’s <code>commands</code>, the words a plugin may send.
      </small>
    </fieldset>
  );
}

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
  /** The output it leaves, and the input it enters, as their plugins declare them. */
  output?: PortView | undefined;
  input?: PortView | undefined;
  /** The connector's owner's chat, as its config names it (D97). */
  owner?: string | undefined;
  /** A player's chat edge (D137): the node whose checklist its commands follow. */
  follows?: string | undefined;
  change: (change: EdgeChange) => void;
  remove: () => void;
}) {
  const { edge } = props;
  const reads = edge.type === 'chat-in';
  const sends = edge.type === 'chat-out';
  const answers = edge.type === 'commands';
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
          {props.input?.type === 'chat-in' && props.input.sameAs !== undefined ? (
            <p className="muted small" role="note">
              It reads the one chat its <code>{props.input.sameAs}</code> output sends to, and no
              other (the check says so otherwise).
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
      ) : answers ? (
        <section>
          <h3>How it answers</h3>
          <DryRun
            label="how it answers"
            dryRun={edge.dryRun === true}
            set={(dryRun) => props.change({ dryRun })}
            dry="A dry run: each answer is logged as sent, and nothing goes out."
            live="It answers for real, within the commands, chats and senders below."
          />
          <h3>What it answers, where, to whom</h3>
          <Serves
            commands={props.input?.type === 'commands' ? (props.input.commands ?? []) : []}
            value={edge.serves}
            set={(serves) => props.change({ serves })}
          />
          <EdgeChats
            name="chats"
            help="The chats it answers them in, and lists them in the menus of; it answers in no other, nor where its connector does not work (a Telegram bot's groups)"
            connector={connector}
            monitored={undefined}
            value={edge.chats}
            set={(c) => props.change({ chats: c === '*' ? [] : c })}
          />
          <label className="block">
            <input
              type="checkbox"
              aria-label="every private chat"
              checked={edge.privateChats === true}
              onChange={(e) => props.change({ privateChats: e.target.checked ? true : undefined })}
            />{' '}
            Every private chat with {connector ?? 'its connector'} too{' '}
            <span className="muted small">
              (anyone who writes to it, among those its connector works for)
            </span>
          </label>
          {(edge.chats ?? []).length === 0 && edge.privateChats !== true ? (
            <p className="warning small" role="note">
              No chat named: it answers nowhere.
            </p>
          ) : null}
          <Senders
            connector={connector}
            value={edge.senders}
            set={(senders) => props.change({ senders })}
            self={{
              token: 'owner',
              label: 'The owner',
              hint: `${connector ?? 'the connector'}’s owner`,
              legend: 'who may ask',
            }}
          />
          <p className="muted small">
            All within whom and where its connector works for (a Telegram bot's groups and people,
            in its panel); the plugin may answer fewer still: its own check applies.
          </p>
        </section>
      ) : sends ? (
        <section>
          <h3>How it sends</h3>
          <DryRun
            label="how it sends"
            dryRun={edge.dryRun === true}
            set={(dryRun) => props.change({ dryRun })}
            dry="A dry run: what the plugin sends here is logged as sent, and nothing goes out."
            live="It sends for real, within the chats and commands below."
          />
          <h3>What it sends</h3>
          {props.output?.type === 'chat-out' && props.output.single !== undefined ? (
            <p className="muted small" role="note">
              It sends to exactly one chat
              {props.output.single.expected === undefined
                ? ''
                : `, ${props.output.single.expected}`}
              : the one named here is its only setting.
            </p>
          ) : null}
          <EdgeChats
            name="sends"
            help={
              props.output?.type === 'chat-out' && props.output.many === true
                ? 'The chats it tells, each of them, through this connector; it sends to no other'
                : 'The chats the plugin may send to through the connector; the outbox refuses any other'
            }
            connector={connector}
            monitored={undefined}
            value={edge.sends}
            set={(s) => props.change({ sends: s === '*' ? [] : s })}
          />
          {props.output?.type === 'chat-out' &&
          props.output.owner === true &&
          (edge.sends ?? []).length === 0 ? (
            <p className="note small" role="note" aria-label="sends to the owner">
              No chat named: it sends to the private chat of {connector ?? 'its connector'}’s owner
              {props.owner === undefined ? (
                <>, and {connector ?? 'its connector'} has none set: name a chat above.</>
              ) : (
                <>
                  .{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => props.change({ sends: [props.owner as string] })}
                  >
                    Name it here
                  </button>
                </>
              )}
            </p>
          ) : null}
          {props.follows === undefined ? (
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
          ) : (
            <p className="small" role="note" aria-label="commands it sends">
              <code>commands</code>:{' '}
              {(edge.commands ?? []).length === 0 ? (
                <span className="muted">none</span>
              ) : (
                (edge.commands ?? []).map((c, i) => (
                  <span key={c}>
                    {i === 0 ? '' : ', '}
                    <code>{c}</code>
                  </span>
                ))
              )}
              <br />
              <span className="muted">
                Those {props.follows} plays: they follow its checklist of commands, in its panel.
              </span>
            </p>
          )}
          <Spacing
            commands={edge.commands ?? []}
            value={edge.minIntervalS ?? {}}
            set={(minIntervalS) => props.change({ minIntervalS })}
          />
        </section>
      ) : (
        <p className="muted">It carries nothing to set: the binding is the permission.</p>
      )}
      {props.output?.type === 'events' ? (
        <section aria-label="what it carries">
          <h3>What it carries</h3>
          <p className="muted small">
            Each event type and its payload’s fields, by the path a reaction’s <code>when</code> and{' '}
            <code>send</code> name (<code>{'{outcome.item}'}</code>).
          </p>
          <Payloads types={props.output.types ?? []} />
        </section>
      ) : null}
      <p>
        <button type="button" className="danger" onClick={props.remove}>
          Remove edge
        </button>
      </p>
    </aside>
  );
}
