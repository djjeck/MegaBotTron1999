/**
 * A connector's people directory (bot-os.md D167, docs/bot-os-api.md §4.5): everyone it has seen
 * send a message, by their stable id, with the username, display name and kind they had when last
 * seen. A plugin finds a person by id, or by a username they held when seen (`person`), and hears
 * a known person's new username (`onRename`): what a module needs to read a bot's text that names
 * people by username, and to move what it keeps of a person from their name to their id.
 *
 * - **Seen, not looked up:** a person is known once a message of theirs is read (live, edited or
 *   caught up). A username never seen is not resolved.
 * - **A username is one person's at a time:** seen on another id, it moves there, and the one who
 *   had it keeps none until seen again.
 * - **Kept** in its connector's store (`people`), at most `PEOPLE_KEPT`, those seen longest ago
 *   dropped first; written when someone is new or changed, or seen again an hour after it was last
 *   written, not on every message.
 */
import { type Inbound } from './connector.ts';

/** How many people a directory keeps. */
export const PEOPLE_KEPT = 5000;
/** The store's document of the directory. */
export const PEOPLE_DOC = 'people';
/** How long a person's `seen` may lag in the store, in milliseconds: an hour. */
const SEEN_SAVED_MS = 3_600_000;

/** A person as the directory knows them. */
export interface Person {
  /** Their stable id, as `Inbound.senderId` gives it. */
  id: string;
  /** Their username when last seen, without `@`; none if they had none, or another took it since. */
  username?: string;
  /** Their display name when last seen. */
  name?: string;
  /** Whether they are a bot, where the network said. */
  bot?: boolean;
  /** When they were last seen, in milliseconds (a message's time). */
  seen: number;
}

/** A known person seen under another username (`from`, none if they had none), now `to` (none). */
export interface Rename {
  id: string;
  from?: string;
  to?: string;
  /** When: the time of the message they were seen in. */
  time: number;
}

/** Where a directory is kept: its connector's store. */
export interface PeopleStore {
  read<T>(name: string): T | undefined;
  write(name: string, value: unknown): void;
}

/** What `list` searches: a part of a username or a name, or an id, without case. */
export interface PeopleQuery {
  search?: string;
  limit?: number;
}

const lower = (s: string): string => s.replace(/^@/u, '').toLowerCase();

export class People {
  private readonly byId = new Map<string, Person>();
  /** Each username's holder, by the username without case. */
  private readonly byName = new Map<string, string>();
  private renames: ((r: Rename) => void)[] = [];
  /** When each person was last written, by id. */
  private readonly saved = new Map<string, number>();
  private readonly store: PeopleStore | undefined;
  private readonly kept: number;

  constructor(o: { store?: PeopleStore | undefined; kept?: number } = {}) {
    this.store = o.store;
    this.kept = o.kept ?? PEOPLE_KEPT;
    const doc = o.store?.read<Person[]>(PEOPLE_DOC);
    for (const p of Array.isArray(doc) ? doc : []) {
      if (typeof p?.id !== 'string' || typeof p.seen !== 'number') continue;
      this.byId.set(p.id, { ...p });
      this.saved.set(p.id, p.seen);
      if (p.username !== undefined) this.byName.set(lower(p.username), p.id);
    }
  }

  /**
   * A message's sender, seen: added, or brought up to date, a rename told first. One without an id
   * (IRC's) is not kept.
   */
  see(m: Pick<Inbound, 'senderId' | 'senderUsername' | 'senderName' | 'senderBot' | 'time'>): void {
    const id = m.senderId;
    if (id === undefined) return;
    const was = this.byId.get(id);
    const username = m.senderUsername;
    const p: Person = {
      id,
      ...(username === undefined ? {} : { username }),
      ...(m.senderName === undefined ? {} : { name: m.senderName }),
      ...(m.senderBot === undefined ? {} : { bot: m.senderBot }),
      seen: Math.max(was?.seen ?? 0, m.time),
    };
    const renamed =
      was !== undefined &&
      (was.username === undefined ? '' : lower(was.username)) !==
        (username === undefined ? '' : lower(username));
    if (was?.username !== undefined && this.byName.get(lower(was.username)) === id)
      this.byName.delete(lower(was.username));
    if (username !== undefined) {
      const holder = this.byName.get(lower(username));
      const other = holder === undefined || holder === id ? undefined : this.byId.get(holder);
      if (other !== undefined) {
        const { username: _taken, ...rest } = other;
        this.byId.set(other.id, rest);
      }
      this.byName.set(lower(username), id);
    }
    this.byId.delete(id);
    this.byId.set(id, p);
    const changed =
      was === undefined ||
      was.username !== p.username ||
      was.name !== p.name ||
      was.bot !== p.bot ||
      p.seen - (this.saved.get(id) ?? 0) >= SEEN_SAVED_MS;
    if (renamed) {
      const r: Rename = {
        id,
        ...(was.username === undefined ? {} : { from: was.username }),
        ...(username === undefined ? {} : { to: username }),
        time: m.time,
      };
      for (const h of [...this.renames]) h(r);
    }
    if (changed) this.save(id);
  }

  /** A person by id, or by a username they held when last seen (without case, `@` or not). */
  person(idOrUsername: string): Person | undefined {
    const p =
      this.byId.get(idOrUsername) ?? this.byId.get(this.byName.get(lower(idOrUsername)) ?? '');
    return p === undefined ? undefined : { ...p };
  }

  /** Hears each known person seen under a new username; returns the way to stop. */
  onRename(handler: (r: Rename) => void): () => void {
    this.renames.push(handler);
    return () => {
      this.renames = this.renames.filter((h) => h !== handler);
    };
  }

  /** The people matching `query`, most recently seen first. */
  list(query: PeopleQuery = {}): Person[] {
    const search = query.search === undefined ? '' : lower(query.search);
    const out = [...this.byId.values()]
      .filter(
        (p) =>
          search === '' ||
          p.id === search ||
          (p.username !== undefined && p.username.toLowerCase().includes(search)) ||
          (p.name !== undefined && p.name.toLowerCase().includes(search))
      )
      .sort((a, b) => b.seen - a.seen);
    return out.slice(0, query.limit ?? out.length).map((p) => ({ ...p }));
  }

  /** The directory written to its store, the oldest dropped past `kept`. */
  private save(id: string): void {
    while (this.byId.size > this.kept) {
      let oldest: Person | undefined;
      for (const p of this.byId.values())
        if (oldest === undefined || p.seen < oldest.seen) oldest = p;
      if (oldest === undefined) break;
      this.byId.delete(oldest.id);
      this.saved.delete(oldest.id);
      if (oldest.username !== undefined && this.byName.get(lower(oldest.username)) === oldest.id)
        this.byName.delete(lower(oldest.username));
    }
    const p = this.byId.get(id);
    if (p !== undefined) this.saved.set(id, p.seen);
    this.store?.write(PEOPLE_DOC, [...this.byId.values()]);
  }
}
