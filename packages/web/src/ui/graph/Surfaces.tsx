/**
 * Chats picked from lists (bot-os.md D62, D63): a connector's surfaces, as
 * `GET /accounts/<id>/surfaces` lists them, latest first, for its config's `chats` (what it
 * monitors: every chat while unset) and for each edge's subset (a chat-in's `reads`, `'*'` for all
 * of them, and its `senders`; a chat-out's `sends`). A connector not running yet lists nothing: the
 * owner applies first. Lists of words (commands, senders) are rows to add and remove, not JSON.
 */
import { useEffect, useState } from 'react';
import type { Surface, SurfacesView } from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';

/** The config key of a connector that lists the chats it monitors. */
export const CHATS_KEY = 'chats';

/** What the surfaces' load says: not yet, listed, or why not. */
export type SurfacesState =
  | { state: 'loading' }
  | { state: 'not-running' }
  | { state: 'unlisted' }
  | { state: 'error'; error: string }
  | { state: 'listed'; surfaces: Surface[] };

/** A connector's surfaces, matching `search`; loaded again when either changes. */
export function useSurfaces(id: string | undefined, search = ''): SurfacesState {
  const [state, setState] = useState<SurfacesState>({ state: 'loading' });
  useEffect(() => {
    if (id === undefined) return;
    let live = true;
    const q = search.trim() === '' ? '' : `?search=${encodeURIComponent(search.trim())}`;
    api<SurfacesView>(`/accounts/${seg(id)}/surfaces${q}`).then(
      (v) => {
        if (!live) return;
        setState(
          !v.running
            ? { state: 'not-running' }
            : v.listed
              ? { state: 'listed', surfaces: v.surfaces }
              : { state: 'unlisted' }
        );
      },
      (e: unknown) => {
        if (!live) return;
        // A connector the running graph does not have yet (just added) runs nowhere.
        if (e instanceof ApiError && e.status === 404) setState({ state: 'not-running' });
        else setState({ state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    );
    return () => {
      live = false;
    };
  }, [id, search]);
  return id === undefined ? { state: 'not-running' } : state;
}

/** Why there is no list to pick from, in words; undefined when there is one. */
export function unlistedNote(s: SurfacesState): string | undefined {
  if (s.state === 'listed') return undefined;
  if (s.state === 'loading') return 'Listing its chats…';
  if (s.state === 'not-running') return 'Apply first to list its chats.';
  if (s.state === 'unlisted') return 'This connector cannot list its chats: type them.';
  return `Its chats cannot be listed now: ${s.error}`;
}

const when = (t: number | undefined): string =>
  t === undefined ? '' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');

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

/** Checkboxes over surfaces, ticked when `ticked` has their id (without case). */
function Checks(props: {
  label: string;
  surfaces: readonly Surface[];
  ticked: (id: string) => boolean;
  toggle: (id: string, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="checks" aria-label={props.label}>
      {props.surfaces.map((s) => (
        <li key={s.id}>
          <label>
            <input
              type="checkbox"
              aria-label={s.title}
              checked={props.ticked(s.id)}
              disabled={props.disabled}
              onChange={(e) => props.toggle(s.id, e.target.checked)}
            />{' '}
            {s.title} <span className="muted small">({s.kind}</span>
            {s.title === s.id ? null : (
              <span className="muted small">
                , <code>{s.id}</code>
              </span>
            )}
            <span className="muted small">
              {s.lastActive === undefined ? '' : `, ${when(s.lastActive)}`})
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

const has = (list: readonly string[], id: string): boolean =>
  list.some((x) => x.toLowerCase() === id.toLowerCase());

/** The chats of a list that the surfaces do not name, shown by their id. */
const others = (list: readonly string[], surfaces: readonly Surface[]): Surface[] =>
  list
    .filter((c) => !surfaces.some((s) => s.id.toLowerCase() === c.toLowerCase()))
    .map((c) => ({ id: c, title: c, kind: 'group' as const }));

/**
 * A connector's monitored chats (its config's `chats`): every chat while unset; else the ticked
 * ones. Its latest surfaces as checkboxes, and a search to find and tick others.
 */
export function MonitoredChats(props: {
  connector: string;
  value: readonly string[] | undefined;
  set: (v: string[] | undefined) => void;
}) {
  const [search, setSearch] = useState('');
  const latest = useSurfaces(props.connector);
  const found = useSurfaces(search.trim() === '' ? undefined : props.connector, search);
  const note = unlistedNote(latest);
  const all = props.value === undefined;
  const listed = latest.state === 'listed' ? latest.surfaces : [];
  const value = props.value ?? [];
  const toggle = (id: string, on: boolean): void => {
    // From every chat to a list: the ones listed, ticked, but this one.
    const base = all ? listed.map((s) => s.id) : value;
    props.set(on ? [...base.filter((c) => !has([id], c)), id] : base.filter((c) => !has([id], c)));
  };
  return (
    <fieldset className="field surfaces" aria-label="chats it monitors">
      <legend>
        <code>{CHATS_KEY}</code>: the chats it monitors
      </legend>
      {note === undefined ? (
        <>
          <label>
            <input
              type="checkbox"
              aria-label="every chat"
              checked={all}
              onChange={(e) => props.set(e.target.checked ? undefined : listed.map((s) => s.id))}
            />{' '}
            Every chat it has <span className="muted small">(new chats too)</span>
          </label>
          <Checks
            label="latest chats"
            surfaces={[...listed, ...others(value, listed)]}
            ticked={(id) => all || has(value, id)}
            toggle={toggle}
          />
          <input
            type="search"
            aria-label="search chats"
            placeholder="Search its chats by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {found.state === 'listed' ? (
            found.surfaces.length === 0 ? (
              <p className="muted small">No chat matches.</p>
            ) : (
              <Checks
                label="chats found"
                surfaces={found.surfaces}
                ticked={(id) => all || has(value, id)}
                toggle={toggle}
              />
            )
          ) : null}
        </>
      ) : (
        <>
          <p className="muted">{note}</p>
          <RowsField
            name={CHATS_KEY}
            help="Unset (no rows): every chat it has. A group by its id, a private chat by @username."
            value={value}
            set={(v) => props.set(v.length === 0 ? undefined : v)}
          />
        </>
      )}
    </fieldset>
  );
}

/**
 * The chats a connector monitors, as an edge picks from them: those its config lists (titled from
 * its surfaces), or every surface it lists while its config lists none.
 */
export function monitoredSurfaces(
  surfaces: readonly Surface[],
  chats: readonly string[] | undefined
): Surface[] {
  if (chats === undefined) return [...surfaces];
  return chats.map(
    (c) =>
      surfaces.find((s) => s.id.toLowerCase() === c.toLowerCase()) ?? {
        id: c,
        title: c,
        kind: 'group',
      }
  );
}

/**
 * An edge's chats (a chat-in's `reads`, a chat-out's `sends`) as checkboxes over its connector's
 * monitored chats; with `any`, a box for all of them (`'*'`).
 */
export function EdgeChats(props: {
  name: 'reads' | 'sends';
  help: string;
  connector: string | undefined;
  /** The connector's config's `chats`. */
  monitored: readonly string[] | undefined;
  value: readonly string[] | '*' | undefined;
  set: (v: string[] | '*') => void;
  any?: boolean;
}) {
  const s = useSurfaces(props.connector);
  const note = unlistedNote(s);
  const value = props.value ?? [];
  const list = value === '*' ? [] : value;
  const any = value === '*';
  const shown = s.state === 'listed' ? monitoredSurfaces(s.surfaces, props.monitored) : [];
  return (
    <fieldset className="field surfaces" aria-label={props.name}>
      <legend>
        <code>{props.name}</code>
      </legend>
      {props.any === true ? (
        <label>
          <input
            type="checkbox"
            aria-label="all the chats it monitors"
            checked={any}
            onChange={(e) => props.set(e.target.checked ? '*' : shown.map((x) => x.id))}
          />{' '}
          All the chats its connector monitors <span className="muted small">(any chat)</span>
        </label>
      ) : null}
      {note === undefined ? (
        <Checks
          label={`${props.name} chats`}
          surfaces={[...shown, ...others(list, shown)]}
          ticked={(id) => any || has(list, id)}
          disabled={any}
          toggle={(id, on) =>
            props.set(on ? [...list, id] : list.filter((c) => c.toLowerCase() !== id.toLowerCase()))
          }
        />
      ) : any ? null : (
        <>
          <p className="muted">{note}</p>
          <RowsField
            name={`${props.name} list`}
            help="A channel, a chat id, a bot’s @username"
            value={list}
            set={(v) => props.set(v)}
          />
        </>
      )}
      <small className="muted">{props.help}</small>
    </fieldset>
  );
}

/**
 * A chat-in edge's senders: anyone (unset), or a list: the account's own messages (`me`) and
 * senders by @username, the bots among its surfaces suggested.
 */
export function Senders(props: {
  connector: string | undefined;
  value: readonly string[] | undefined;
  set: (v: string[] | undefined) => void;
}) {
  const s = useSurfaces(props.connector);
  const anyone = props.value === undefined;
  const list = props.value ?? [];
  const me = list.includes('me');
  const named = list.filter((x) => x !== 'me');
  const bots =
    s.state === 'listed' ? s.surfaces.filter((x) => x.kind === 'bot').map((x) => x.id) : [];
  return (
    <fieldset className="field surfaces" aria-label="senders">
      <legend>
        <code>senders</code>: whom it hears
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
          onChange={() => props.set(['me'])}
        />{' '}
        Only these
      </label>
      {anyone ? null : (
        <>
          <label className="block">
            <input
              type="checkbox"
              aria-label="me"
              checked={me}
              onChange={(e) => props.set(e.target.checked ? ['me', ...named] : named)}
            />{' '}
            Me <span className="muted small">(the account’s own messages)</span>
          </label>
          <RowsField
            name="senders list"
            help="Senders by @username (a bot’s never changes)"
            placeholder="@QuestBot"
            value={named}
            suggest={bots}
            set={(v) => props.set(me ? ['me', ...v] : v)}
          />
        </>
      )}
    </fieldset>
  );
}
