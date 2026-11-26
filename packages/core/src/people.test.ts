import { describe, expect, it } from 'vitest';
import { People, PEOPLE_DOC, type Rename } from './people.ts';

/** A store in memory: its documents, and how many writes it took. */
function memory(docs: Record<string, unknown> = {}) {
  let writes = 0;
  return {
    docs,
    writes: () => writes,
    read: <T>(name: string) => docs[name] as T | undefined,
    write: (name: string, value: unknown) => {
      writes++;
      docs[name] = structuredClone(value);
    },
  };
}

const HOUR = 3_600_000;

describe('a people directory (D167)', () => {
  it('knows a sender by id and by username, without case or @, and not one without an id', () => {
    const people = new People();
    people.see({ senderId: '1001', senderUsername: 'Alice', senderName: 'Alice A', time: 5 });
    people.see({ senderUsername: 'carol', time: 6 });
    expect(people.person('1001')).toEqual({
      id: '1001',
      username: 'Alice',
      name: 'Alice A',
      seen: 5,
    });
    expect(people.person('@alice')?.id).toBe('1001');
    expect(people.person('ALICE')?.id).toBe('1001');
    expect(people.person('carol')).toBeUndefined();
    expect(people.person('1002')).toBeUndefined();
  });

  it('tells a known person’s new username, before keeping it; the old one no longer finds them', () => {
    const people = new People();
    const renames: Rename[] = [];
    const stop = people.onRename((r) => renames.push(r));
    people.see({ senderId: '1001', senderUsername: 'alice', time: 1 });
    people.see({ senderId: '1001', senderUsername: 'Alice', time: 2 });
    people.see({ senderId: '1001', senderUsername: 'alice_b', time: 3 });
    people.see({ senderId: '1001', time: 4 });
    people.see({ senderId: '1001', senderUsername: 'alice', time: 5 });
    expect(renames).toEqual([
      { id: '1001', from: 'Alice', to: 'alice_b', time: 3 },
      { id: '1001', from: 'alice_b', time: 4 },
      { id: '1001', to: 'alice', time: 5 },
    ]);
    expect(people.person('alice_b')).toBeUndefined();
    stop();
    people.see({ senderId: '1001', senderUsername: 'ally', time: 6 });
    expect(renames).toHaveLength(3);
  });

  it('gives a username to one person at a time: whoever had it keeps none', () => {
    const people = new People();
    people.see({ senderId: '1001', senderUsername: 'alice', time: 1 });
    people.see({ senderId: '1002', senderUsername: 'alice', time: 2 });
    expect(people.person('alice')?.id).toBe('1002');
    expect(people.person('1001')).toEqual({ id: '1001', seen: 1 });
    // Seen again under a name of their own, the first is renamed from none.
    const renames: Rename[] = [];
    people.onRename((r) => renames.push(r));
    people.see({ senderId: '1001', senderUsername: 'alice_b', time: 3 });
    expect(renames).toEqual([{ id: '1001', to: 'alice_b', time: 3 }]);
  });

  it('keeps when someone was last seen, an edit of an older message moving it back never', () => {
    const people = new People();
    people.see({ senderId: '1001', senderUsername: 'alice', senderBot: false, time: 10 });
    people.see({ senderId: '1001', senderUsername: 'alice', senderBot: false, time: 4 });
    expect(people.person('1001')?.seen).toBe(10);
  });

  it('lists those matching a search, most recently seen first', () => {
    const people = new People();
    people.see({ senderId: '1001', senderUsername: 'alice', senderName: 'Alice Smith', time: 1 });
    people.see({ senderId: '1002', senderUsername: 'bob', senderName: 'Bob Stone', time: 3 });
    people.see({ senderId: '1003', senderName: 'Carol Smith', time: 2 });
    expect(people.list().map((p) => p.id)).toEqual(['1002', '1003', '1001']);
    expect(people.list({ search: 'smith' }).map((p) => p.id)).toEqual(['1003', '1001']);
    expect(people.list({ search: '@BO' }).map((p) => p.id)).toEqual(['1002']);
    expect(people.list({ search: '1001' }).map((p) => p.id)).toEqual(['1001']);
    expect(people.list({ limit: 1 }).map((p) => p.id)).toEqual(['1002']);
  });

  it('is kept in its store, written when someone is new or changed or an hour on, not every message', () => {
    const store = memory();
    const people = new People({ store });
    people.see({ senderId: '1001', senderUsername: 'alice', time: 0 });
    people.see({ senderId: '1001', senderUsername: 'alice', time: 1000 });
    expect(store.writes()).toBe(1);
    people.see({ senderId: '1001', senderUsername: 'alice', senderName: 'Alice', time: 2000 });
    expect(store.writes()).toBe(2);
    people.see({
      senderId: '1001',
      senderUsername: 'alice',
      senderName: 'Alice',
      time: HOUR + 2000,
    });
    expect(store.writes()).toBe(3);
    const again = new People({ store });
    expect(again.person('alice')).toEqual({
      id: '1001',
      username: 'alice',
      name: 'Alice',
      seen: HOUR + 2000,
    });
  });

  it('reads a store’s document leniently, and keeps the most recently seen past its limit', () => {
    const store = memory({
      [PEOPLE_DOC]: [{ id: '1001', username: 'alice', seen: 1 }, { id: 7 }, null, { id: '1002' }],
    });
    const people = new People({ store, kept: 2 });
    expect(people.list().map((p) => p.id)).toEqual(['1001']);
    expect(new People({ store: memory({ [PEOPLE_DOC]: 'nonsense' }) }).list()).toEqual([]);
    people.see({ senderId: '1002', senderUsername: 'bob', time: 2 });
    people.see({ senderId: '1003', senderUsername: 'carol', time: 3 });
    expect(people.list().map((p) => p.id)).toEqual(['1003', '1002']);
    expect(people.person('alice')).toBeUndefined();
    expect((store.docs[PEOPLE_DOC] as { id: string }[]).map((p) => p.id)).toEqual(['1002', '1003']);
  });
});
