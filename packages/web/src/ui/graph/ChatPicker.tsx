/**
 * The one chat picker (bot-os.md D96): every config key and edge list that names a chat picks it
 * from its connector's chats (`GET /accounts/<id>/surfaces`, D63), never as a typed id. Each chat
 * shows by its name, its kind by an icon (a person, a bot, a group, a channel), a person or a bot
 * with its `@username`, and when it was last active (`3 days ago`); the chats picked stay at the
 * top. A search finds a chat by its name, its `@username` or its id. What is stored is the chat's
 * `id`, the name its connector can send to (a `telegram-bot`'s chats by id). A value saved
 * otherwise (an id, a `@username`) is found by any of its names and shown by name.
 *
 * Where the connector says it cannot reach a chat (`unreachable`: a bot's owner who never started
 * it, a group it is not in), and for the chats only another connector of its network lists
 * (`peers`: the people and groups the owner's account knows and the bot has never seen), the row
 * says so; a chat it does not know at all is shown as such. A peer's chat, picked, is asked of the
 * connector first, which then lists it if it can reach it.
 *
 * A picker of people to recognise rather than chats to send to (`sender`, a `telegram-bot`'s deny
 * list, bot-os.md D100) says nothing of reaching them: a peer's person is picked at once, by id,
 * and one the connector does not know is still shown by the name a peer has for them.
 */
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Surface, SurfacesView } from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';

type Kind = Surface['kind'];

/** What a listing of a connector's chats says: not yet, listed, or why not. */
export type SurfacesState =
  | { state: 'loading' }
  | { state: 'not-running' }
  | { state: 'unlisted' }
  | { state: 'error'; error: string }
  | { state: 'listed'; surfaces: Surface[]; peers: { connector: string; surfaces: Surface[] }[] };

/**
 * A connector's chats matching `search`, with its network's other connectors' (`peers`) when
 * asked; loaded again when any changes.
 */
export function useSurfaces(id: string | undefined, search = '', peers = false): SurfacesState {
  const [state, setState] = useState<SurfacesState>({ state: 'loading' });
  useEffect(() => {
    if (id === undefined) return;
    let live = true;
    const params = [
      ...(search.trim() === '' ? [] : [`search=${encodeURIComponent(search.trim())}`]),
      ...(peers ? ['peers=1'] : []),
    ];
    const q = params.length === 0 ? '' : `?${params.join('&')}`;
    api<SurfacesView>(`/accounts/${seg(id)}/surfaces${q}`).then(
      (v) => {
        if (!live) return;
        setState(
          !v.running
            ? { state: 'not-running' }
            : v.listed
              ? { state: 'listed', surfaces: v.surfaces, peers: v.peers ?? [] }
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
  }, [id, search, peers]);
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

/** Every name of a chat, in lower case: its id and its aliases. */
export const namesOf = (s: Surface): string[] =>
  [s.id, ...(s.aliases ?? [])].map((n) => n.toLowerCase());

/** Whether `s` goes by `name`, without case. */
export const named = (s: Surface, name: string): boolean => namesOf(s).includes(name.toLowerCase());

/** When, in the owner's words: `just now`, `5 min ago`, `3 h ago`, `1 day ago`, `12 days ago`. */
export function ago(t: number | undefined, now: number): string | undefined {
  if (t === undefined) return undefined;
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** A chat's `@username`, shown beside a person's or a bot's name. */
function handleOf(s: Surface): string | undefined {
  if (s.kind !== 'private' && s.kind !== 'bot') return undefined;
  return [s.id, ...(s.aliases ?? [])].find((n) => n.startsWith('@') && n !== s.title);
}

const KIND_NAMES: Record<Kind | 'unknown', string> = {
  private: 'person',
  bot: 'bot',
  group: 'group',
  channel: 'channel',
  unknown: 'unknown chat',
};

/** A chat's kind as an icon, its name for a screen reader and a tooltip. */
export function KindIcon(props: { kind: Kind | 'unknown' }) {
  const paths: Record<Kind | 'unknown', ReactNode> = {
    private: (
      <>
        <circle cx="8" cy="5" r="3" />
        <path d="M2 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z" />
      </>
    ),
    bot: (
      <>
        <rect x="2.5" y="4.5" width="11" height="9" rx="2" />
        <path d="M8 1.5v3" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="5.7" cy="9" r="1.2" fill="var(--bg)" />
        <circle cx="10.3" cy="9" r="1.2" fill="var(--bg)" />
      </>
    ),
    group: (
      <>
        <circle cx="5.5" cy="5.5" r="2.5" />
        <circle cx="11" cy="6" r="2.2" />
        <path d="M0.5 15c0-2.9 2.2-4.8 5-4.8s5 1.9 5 4.8z" />
        <path d="M11.5 15c0-1.6-.5-3-1.4-4 .3-.1.6-.1.9-.1 2.5 0 4.5 1.7 4.5 4.1z" />
      </>
    ),
    channel: <path d="M1.5 6.5h3l7-4v11l-7-4h-3zM5 10l1.5 4.5h2L7.3 10.4" />,
    unknown: <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  };
  return (
    <svg
      className={`chat-kind chat-kind-${props.kind}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      role="img"
      aria-label={KIND_NAMES[props.kind]}
    >
      <title>{KIND_NAMES[props.kind]}</title>
      {paths[props.kind]}
    </svg>
  );
}

/** One row of the picker: a chat, or a name no list has. */
interface Row {
  /** The value it stands for once picked. */
  value: string;
  surface?: Surface;
  /** Why the connector may not reach it, shown on the row. */
  note?: string;
  /** Listed by another connector of the network, not this one. */
  peer?: string;
}

/**
 * The chats named in `values` that the lists at hand do not have (nor had): each looked up once by a search
 * of the connector for it, so that a chat saved by id or `@username` shows by its name after a
 * reload too; null for one no search finds.
 */
export function useLookups(
  connector: string | undefined,
  values: readonly string[],
  known: readonly Surface[],
  /** Look in the network's other connectors' chats too (`peers`). */
  peers = false
): ReadonlyMap<string, Surface | null> {
  const [found, setFound] = useState<ReadonlyMap<string, Surface | null>>(new Map());
  const asked = useRef(new Set<string>());
  const key = (v: string): string => `${connector ?? ''}\u0000${v.toLowerCase()}`;
  // Every chat a list has shown, by each of its names: one picked from a search, the search then
  // cleared, still shows by its name.
  const remembered = useRef(new Map<string, Surface>());
  for (const s of known) for (const n of namesOf(s)) remembered.current.set(key(n), s);
  const recall = (v: string): Surface | undefined =>
    known.find((s) => named(s, v)) ?? remembered.current.get(key(v));
  const missing = values.filter((v) => recall(v) === undefined);
  const missingKey = missing.join('\u0001');
  useEffect(() => {
    if (connector === undefined) return;
    for (const v of missing) {
      const k = key(v);
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      const done = (s: Surface | undefined): void => setFound((m) => new Map(m).set(k, s ?? null));
      api<SurfacesView>(
        `/accounts/${seg(connector)}/surfaces?search=${encodeURIComponent(v)}&limit=500${peers ? '&peers=1' : ''}`
      ).then(
        (r) =>
          done(
            [...r.surfaces, ...(r.peers ?? []).flatMap((p) => p.surfaces)].find((x) => named(x, v))
          ),
        () => done(undefined)
      );
    }
    // `missingKey` stands for `missing`, which each render makes anew.
  }, [connector, missingKey, peers]);
  const out = new Map<string, Surface | null>();
  for (const v of values) {
    const s = recall(v) ?? found.get(key(v));
    if (s !== undefined) out.set(v.toLowerCase(), s);
  }
  return out;
}

/** The name to send to among a peer's chat's names: its numeric id where it has one. */
const reachName = (s: Surface): string =>
  [s.id, ...(s.aliases ?? [])].find((n) => /^-?\d+$/u.test(n)) ?? s.id;

export function ChatPicker(props: {
  /** The picker's name, for a screen reader and its lists. */
  label: string;
  /** The connector node whose chats it picks from; undefined: none wired yet. */
  connector: string | undefined;
  value: readonly string[];
  set: (v: string[]) => void;
  /** One chat at most: picking another replaces it. */
  single?: boolean;
  /** The kinds of chat it offers; any without. */
  kinds?: readonly Kind[];
  /** People to recognise, not chats to send to (D100): nothing said of reaching them. */
  sender?: boolean;
  /** The chats it may offer, by any name; any of the connector's without (an edge's: those monitored). */
  within?: readonly string[];
  /** Why there is no connector to pick from, when `connector` is undefined. */
  noConnector?: string;
  disabled?: boolean;
  /** The time now, in ms (tests). */
  now?: number;
}) {
  const { connector, value, single = false } = props;
  const [search, setSearch] = useState('');
  const latest = useSurfaces(connector, '', true);
  const found = useSurfaces(search.trim() === '' ? undefined : connector, search, true);
  const [asking, setAsking] = useState<string>();
  const [typed, setTyped] = useState('');
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  // A peer's chat picked that the connector cannot reach: shown by the peer's name for it.
  const [borrowed, setBorrowed] = useState<ReadonlyMap<string, Surface>>(new Map());
  const note = connector === undefined ? props.noConnector : unlistedNote(latest);
  const listedOf = (s: SurfacesState): Surface[] => (s.state === 'listed' ? s.surfaces : []);
  const peersOf = (s: SurfacesState) => (s.state === 'listed' ? s.peers : []);
  const own = [...listedOf(latest), ...listedOf(found)];
  const sender = props.sender === true;
  // People to recognise may be the peers' too, by any of their names.
  const known = sender
    ? [...own, ...[...peersOf(latest), ...peersOf(found)].flatMap((p) => p.surfaces)]
    : own;
  const lookups = useLookups(note === undefined ? connector : undefined, value, known, sender);
  const allowed = (s: Surface): boolean =>
    (props.kinds === undefined || props.kinds.includes(s.kind)) &&
    (props.within === undefined || props.within.some((w) => named(s, w)));
  const now = props.now ?? Date.now();
  const reason = (s: Surface): string | undefined =>
    sender ? undefined : (s.unreachable ?? refused.get(s.id.toLowerCase()));

  // The chats picked first, in their order, each by its name where a list has it.
  const picked: Row[] = value.map((v): Row => {
    const s = lookups.get(v.toLowerCase());
    if (s === undefined || s === null) {
      const peer = borrowed.get(v.toLowerCase());
      const why =
        refused.get(v.toLowerCase()) ??
        (s === null && !sender
          ? `${connector ?? 'its connector'} does not know this chat: pick another`
          : undefined);
      return {
        value: v,
        ...(peer === undefined ? {} : { surface: peer }),
        ...(note === undefined && why !== undefined ? { note: why } : {}),
      };
    }
    const why = reason(s);
    return { value: v, surface: s, ...(why === undefined ? {} : { note: why }) };
  });
  const taken = (s: Surface): boolean => value.some((v) => named(s, v));
  const pool = search.trim() === '' ? latest : found;
  const offered: Row[] = listedOf(pool)
    .filter((s) => allowed(s) && !taken(s))
    .map((s) => {
      const why = reason(s);
      return { value: s.id, surface: s, ...(why === undefined ? {} : { note: why }) };
    });
  // Another connector's chats, which this one has not seen: offered, with why it may not reach them.
  const seen = new Set(own.flatMap(namesOf));
  const peers: Row[] =
    props.within === undefined
      ? peersOf(pool).flatMap((p) =>
          p.surfaces
            .filter((s) => allowed(s) && !taken(s) && !namesOf(s).some((n) => seen.has(n)))
            .map((s) => ({
              value: reachName(s),
              surface: s,
              peer: p.connector,
              ...(sender
                ? {}
                : {
                    note:
                      refused.get(reachName(s).toLowerCase()) ??
                      `${connector ?? 'its connector'} has never seen this chat (${p.connector} knows it): it can send there only once a person has messaged it, or a group has added it`,
                  }),
            }))
        )
      : [];

  const choose = (v: string): void => props.set(single ? [v] : [...value, v]);
  const drop = (v: string): void =>
    props.set(value.filter((x) => x.toLowerCase() !== v.toLowerCase()));
  /** A peer's chat: asked of this connector first, which lists it if it can reach it. */
  const pickPeer = (row: Row): void => {
    if (connector === undefined) return;
    if (sender) {
      // Recognised by id, whether or not the connector can reach them.
      const peer = row.surface;
      if (peer !== undefined) setBorrowed((m) => new Map(m).set(row.value.toLowerCase(), peer));
      choose(row.value);
      return;
    }
    setAsking(row.value);
    void api<SurfacesView>(
      `/accounts/${seg(connector)}/surfaces?search=${encodeURIComponent(row.value)}&limit=500`
    )
      .then(
        (r) => r.surfaces.find((x) => named(x, row.value)),
        () => undefined
      )
      .then((s) => {
        setAsking(undefined);
        if (s !== undefined && s.unreachable === undefined) choose(s.id);
        else {
          setRefused((m) =>
            new Map(m).set(
              row.value.toLowerCase(),
              `${connector} cannot reach this chat: a person must message it first (a bot: /start), a group must add it`
            )
          );
          if (row.surface !== undefined) {
            const peer = row.surface;
            setBorrowed((m) => new Map(m).set(row.value.toLowerCase(), peer));
          }
          choose(row.value);
        }
      });
  };

  const line = (row: Row, on: boolean) => {
    const s = row.surface;
    const handle = s === undefined ? undefined : handleOf(s);
    const when = ago(s?.lastActive, now);
    const title = s?.title ?? row.value;
    return (
      <li
        key={`${on ? 'on' : 'off'}-${row.peer ?? ''}-${row.value}`}
        className={`chat-row${on ? ' picked' : ''}${row.note === undefined ? '' : ' unreachable'}${row.peer === undefined ? '' : ' peer'}`}
      >
        <label>
          <input
            type={single ? 'radio' : 'checkbox'}
            name={single ? `${props.label}-pick` : undefined}
            aria-label={title}
            checked={on}
            disabled={props.disabled === true || asking !== undefined}
            onChange={(e) => {
              if (!e.target.checked) drop(row.value);
              else if (row.peer !== undefined) pickPeer(row);
              else choose(row.value);
            }}
          />
          <KindIcon kind={s?.kind ?? 'unknown'} />
          <span className="chat-title">{title}</span>
          {handle === undefined ? null : <span className="chat-handle muted">{handle}</span>}
          {when === undefined ? null : <span className="chat-when muted small">{when}</span>}
        </label>
        {row.note === undefined ? null : (
          <small className="chat-note" role="note">
            {row.note}
          </small>
        )}
      </li>
    );
  };

  return (
    <div className="chat-picker" role="group" aria-label={props.label}>
      {note !== undefined ? (
        <>
          <p className="muted small">{note}</p>
          {value.length === 0 ? null : (
            <ul className="chats" aria-label={`${props.label} picked`}>
              {picked.map((r) => line(r, true))}
            </ul>
          )}
          {latest.state !== 'unlisted' || props.disabled === true ? null : (
            // A connector that cannot list its chats (a module's): the one place a chat is typed.
            <span className="row-add">
              <input
                aria-label={`new ${props.label}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const v = typed.trim();
                  if (v === '' || value.some((x) => x.toLowerCase() === v.toLowerCase())) return;
                  choose(v);
                  setTyped('');
                }}
              >
                Add
              </button>
            </span>
          )}
        </>
      ) : (
        <>
          <input
            type="search"
            aria-label={`search ${props.label}`}
            placeholder="Search by name, @username or id"
            value={search}
            disabled={props.disabled}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="chats" aria-label={`${props.label} chats`}>
            {single && value.length > 0 && props.disabled !== true ? (
              <li className="chat-row">
                <button type="button" className="link small" onClick={() => props.set([])}>
                  clear
                </button>
              </li>
            ) : null}
            {picked.map((r) => line(r, true))}
            {offered.map((r) => line(r, false))}
            {peers.map((r) => line(r, false))}
          </ul>
          {search.trim() !== '' &&
          found.state === 'listed' &&
          offered.length === 0 &&
          peers.length === 0 ? (
            <p className="muted small">No chat matches.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
