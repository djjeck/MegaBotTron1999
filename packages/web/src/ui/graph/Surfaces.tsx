/**
 * Chats picked from lists (bot-os.md D62, D63, D96): a connector's chats, in the one chat picker
 * (`ChatPicker.tsx`), for its config's `chats` (what it monitors: every chat while unset) and for
 * each edge's subset (a chat-in's `reads`, `'*'` for all of them; a chat-out's `sends`); a chat-in's
 * `senders`. A connector not running yet lists nothing: the owner applies first. Lists of words
 * (commands, senders) are rows to add and remove, not JSON.
 */
import { useState } from 'react';
import type { GraphEdge } from '#src/ui/api.ts';
import { ChatPicker, useSurfaces } from './ChatPicker.tsx';
import { edgeKey, endOf } from './draft.ts';

export { unlistedNote, useSurfaces } from './ChatPicker.tsx';

/** The config key of a connector that lists the chats it monitors. */
export const CHATS_KEY = 'chats';

/** A list of words as rows, each removable, and one more added (no JSON). */
export function RowsField(props: {
  name: string;
  help: string;
  value: readonly string[];
  set: (v: string[]) => void;
  placeholder?: string;
  /** Suggestions for a new row. */
  suggest?: readonly string[];
}) {
  const [next, setNext] = useState('');
  const add = (): void => {
    const v = next.trim();
    if (v === '' || props.value.includes(v)) return;
    props.set([...props.value, v]);
    setNext('');
  };
  const listId = `${props.name}-suggestions`;
  return (
    <div className="field rows" role="group" aria-label={props.name}>
      <code>{props.name}</code>
      <ul className="rows">
        {props.value.map((v, i) => (
          <li key={v}>
            <code>{v}</code>{' '}
            <button
              type="button"
              className="link"
              aria-label={`remove ${v}`}
              onClick={() => props.set(props.value.filter((_, j) => j !== i))}
            >
              remove
            </button>
          </li>
        ))}
      </ul>
      <span className="row-add">
        <input
          aria-label={`new ${props.name}`}
          value={next}
          placeholder={props.placeholder}
          list={props.suggest === undefined ? undefined : listId}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add}>
          Add
        </button>
      </span>
      {props.suggest === undefined ? null : (
        <datalist id={listId}>
          {props.suggest.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <small className="muted">{props.help}</small>
    </div>
  );
}

const has = (list: readonly string[], id: string): boolean =>
  list.some((x) => x.toLowerCase() === id.toLowerCase());

/** The same monitored chats, without case or order; undefined (every chat) only equals itself. */
export function sameChats(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.every((c) => has(b, c)) && b.every((c) => has(a, c));
}

/**
 * The connector's chat-in edges to update after its monitored chats change from `saved` to `draft`
 * (P6, D62, D63: the edges filter again): those with a `reads` list (not `'*'`) that miss a chat
 * added (any, when it now monitors every chat) or still read one it no longer monitors.
 */
export function edgesToUpdate(
  connector: string,
  saved: readonly string[] | undefined,
  draft: readonly string[] | undefined,
  edges: readonly GraphEdge[]
): GraphEdge[] {
  const added = draft === undefined ? undefined : draft.filter((c) => !has(saved ?? draft, c));
  return edges.filter((e) => {
    if (e.type !== 'chat-in' || endOf(e.from).node !== connector || !Array.isArray(e.reads))
      return false;
    const reads = e.reads;
    const misses = added === undefined || added.some((c) => !has(reads, c));
    return misses || (draft !== undefined && reads.some((c) => !has(draft, c)));
  });
}

/**
 * The reminder beside a connector's monitored chats once the draft changes them: its chat-in edges
 * filter again (P6, D62, D63), so a chat added is read only by those that tick it (or read `'*'`),
 * and one removed should leave their lists; the edges to update named, each opening its panel.
 */
function ChatsReminder(props: { edges: readonly GraphEdge[]; open?: (key: string) => void }) {
  const { open } = props;
  return (
    <div className="chats-reminder warning small" role="note" aria-label="edges to update">
      <p>
        Its chats changed: update the edges that should read them too, in each edge’s panel (an edge
        that reads all of them, <code>*</code>, needs nothing).
      </p>
      {props.edges.length === 0 ? null : (
        <p>
          To check:{' '}
          {props.edges.map((e, i) => (
            <span key={edgeKey(e)}>
              {i === 0 ? null : ', '}
              {open === undefined ? (
                <code>{edgeKey(e)}</code>
              ) : (
                <button type="button" className="link" onClick={() => open(edgeKey(e))}>
                  {edgeKey(e)}
                </button>
              )}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * A connector's monitored chats (its config's `chats`): every chat while unset; else those picked
 * in the chat picker (D96). Changed from `saved`, a reminder that its chat-in edges filter again,
 * naming those of `edges` to update.
 */
export function MonitoredChats(props: {
  connector: string;
  value: readonly string[] | undefined;
  set: (v: string[] | undefined) => void;
  /** The saved graph's `chats` of this connector (undefined: every chat, or a new node). */
  saved?: readonly string[] | undefined;
  /** The draft's edges. */
  edges?: readonly GraphEdge[];
  /** Opens an edge's panel, by its key. */
  openEdge?: (key: string) => void;
}) {
  const latest = useSurfaces(props.connector);
  const all = props.value === undefined;
  return (
    <fieldset className="field surfaces" aria-label="chats it monitors">
      <legend>
        <code>{CHATS_KEY}</code>: the chats it monitors
      </legend>
      {sameChats(props.saved, props.value) ? null : (
        <ChatsReminder
          edges={edgesToUpdate(props.connector, props.saved, props.value, props.edges ?? [])}
          {...(props.openEdge === undefined ? {} : { open: props.openEdge })}
        />
      )}
      <label className="block">
        <input
          type="checkbox"
          aria-label="every chat"
          checked={all}
          onChange={(e) =>
            props.set(
              e.target.checked
                ? undefined
                : latest.state === 'listed'
                  ? latest.surfaces.map((s) => s.id)
                  : []
            )
          }
        />{' '}
        Every chat it has <span className="muted small">(new chats too)</span>
      </label>
      {all ? null : (
        <ChatPicker
          label="monitored chats"
          connector={props.connector}
          value={props.value ?? []}
          set={(v) => props.set(v)}
        />
      )}
    </fieldset>
  );
}

/**
 * An edge's chats (a chat-in's `reads`, a chat-out's `sends`, a commands edge's `chats`) picked
 * among its connector's monitored chats (all of its chats while its config lists none); with `any`,
 * a box for all of them (`'*'`).
 */
export function EdgeChats(props: {
  name: 'reads' | 'sends' | 'chats';
  help: string;
  connector: string | undefined;
  /** The connector's config's `chats`. */
  monitored: readonly string[] | undefined;
  value: readonly string[] | '*' | undefined;
  set: (v: string[] | '*') => void;
  any?: boolean;
}) {
  const value = props.value ?? [];
  const list = value === '*' ? [] : value;
  const any = value === '*';
  const latest = useSurfaces(props.connector);
  // Back from all of them to a list: those it monitors, each picked.
  const all =
    props.monitored ?? (latest.state === 'listed' ? latest.surfaces.map((s) => s.id) : []);
  return (
    <fieldset className="field surfaces" aria-label={props.name}>
      <legend>
        <code>{props.name}</code>
      </legend>
      {props.any === true ? (
        <label className="block">
          <input
            type="checkbox"
            aria-label="all the chats it monitors"
            checked={any}
            onChange={(e) => props.set(e.target.checked ? '*' : [...all])}
          />{' '}
          All the chats its connector monitors <span className="muted small">(any chat)</span>
        </label>
      ) : null}
      {any ? null : (
        <ChatPicker
          label={`${props.name} chats`}
          connector={props.connector}
          noConnector="Wire it to a connector first."
          value={list}
          set={(v) => props.set(v)}
          {...(props.monitored === undefined ? {} : { within: props.monitored })}
        />
      )}
      <small className="muted">{props.help}</small>
    </fieldset>
  );
}

/** A chat-in's own box among its senders: the account's own messages (`me`). */
const ME_BOX = {
  token: 'me',
  label: 'Me',
  hint: 'the account’s own messages',
  legend: 'whom it hears',
};

/**
 * An edge's senders: anyone (unset), or a list: a box of its own (a chat-in's `me`, the account's
 * own messages; a commands edge's `owner`, the connector's owner, D109) and senders by @username,
 * the bots among its surfaces suggested.
 */
export function Senders(props: {
  connector: string | undefined;
  value: readonly string[] | undefined;
  set: (v: string[] | undefined) => void;
  /** Its own box: `me` by default. */
  self?: { token: string; label: string; hint: string; legend: string };
}) {
  const self = props.self ?? ME_BOX;
  const s = useSurfaces(props.connector);
  const anyone = props.value === undefined;
  const list = props.value ?? [];
  const me = list.includes(self.token);
  const named = list.filter((x) => x !== self.token);
  const bots =
    s.state === 'listed' ? s.surfaces.filter((x) => x.kind === 'bot').map((x) => x.id) : [];
  return (
    <fieldset className="field surfaces" aria-label="senders">
      <legend>
        <code>senders</code>: {self.legend}
      </legend>
      <label>
        <input
          type="radio"
          name="senders"
          aria-label="anyone"
          checked={anyone}
          onChange={() => props.set(undefined)}
        />{' '}
        Anyone
      </label>{' '}
      <label>
        <input
          type="radio"
          name="senders"
          aria-label="only these"
          checked={!anyone}
          onChange={() => props.set([self.token])}
        />{' '}
        Only these
      </label>
      {anyone ? null : (
        <>
          <label className="block">
            <input
              type="checkbox"
              aria-label={self.token}
              checked={me}
              onChange={(e) => props.set(e.target.checked ? [self.token, ...named] : named)}
            />{' '}
            {self.label} <span className="muted small">({self.hint})</span>
          </label>
          <RowsField
            name="senders list"
            help="Senders by @username (a bot’s never changes)"
            placeholder="@QuestBot"
            value={named}
            suggest={bots}
            set={(v) => props.set(me ? [self.token, ...v] : v)}
          />
        </>
      )}
    </fieldset>
  );
}
