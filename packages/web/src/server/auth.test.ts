import { CORE_STORE, Stores } from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LoginLimiter,
  samePassword,
  SESSION_MS,
  Sessions,
  SESSIONS_DOC,
  type SessionStore,
} from './auth.ts';

const PASSWORD = 'a long enough password';

/** A store of documents in memory, as the core's own store keeps them. */
function memoryStore(): SessionStore & { docs: Map<string, string> } {
  const docs = new Map<string, string>();
  return {
    docs,
    read: <T>(name: string) => {
      const text = docs.get(name);
      return text === undefined ? undefined : (JSON.parse(text) as T);
    },
    write: (name, value) => docs.set(name, JSON.stringify(value)),
  };
}

describe('samePassword', () => {
  it('matches the password only, whatever the lengths', () => {
    expect(samePassword('correct horse', 'correct horse')).toBe(true);
    expect(samePassword('correct hors', 'correct horse')).toBe(false);
    expect(samePassword('', 'correct horse')).toBe(false);
    expect(samePassword('correct horse battery', 'correct horse')).toBe(false);
  });
});

describe('Sessions', () => {
  it('opens random sessions that last their length, and ends them', () => {
    let now = 0;
    const sessions = new Sessions({ now: () => now });
    const a = sessions.create();
    const b = sessions.create();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\w-]{43}$/u);
    expect(sessions.valid(a)).toBe(true);
    expect(sessions.valid(undefined)).toBe(false);
    expect(sessions.valid('forged')).toBe(false);
    sessions.end(b);
    sessions.end(undefined);
    expect(sessions.valid(b)).toBe(false);
    now = SESSION_MS - 1;
    expect(sessions.valid(a)).toBe(true);
    expect(sessions.size).toBe(1);
    now = SESSION_MS;
    expect(sessions.valid(a)).toBe(false);
    sessions.create();
    expect(sessions.size).toBe(1);
  });

  it('forgets expired sessions when it opens another', () => {
    let now = 0;
    const sessions = new Sessions({ now: () => now, ttlMs: 10 });
    sessions.create();
    sessions.create();
    now = 10;
    sessions.create();
    expect(sessions.size).toBe(1);
  });
});

describe('Sessions kept across restarts', () => {
  it('lasts 30 days by default', () => {
    expect(SESSION_MS).toBe(30 * 86_400_000);
  });

  it('survives a restart, in the core’s store, as hashes only, written atomically', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'web-sessions-'));
    const store = () => new Stores(data).open(CORE_STORE);
    let now = 1_000;
    const before = new Sessions({ now: () => now, store: store(), password: PASSWORD });
    const token = before.create();
    const file = path.join(data, CORE_STORE, `${SESSIONS_DOC}.json`);
    const text = fs.readFileSync(file, 'utf8');
    // Neither the token nor the password is in the file; no temporary file is left.
    expect(text).not.toContain(token);
    expect(text).not.toContain(PASSWORD);
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${SESSIONS_DOC}.json`]);
    const doc = JSON.parse(text) as { version: number; sessions: Record<string, number> };
    expect(doc.version).toBe(1);
    expect(Object.values(doc.sessions)).toEqual([1_000 + SESSION_MS]);
    expect(Object.keys(doc.sessions)[0]).toMatch(/^[0-9a-f]{64}$/u);

    // The next process reads them back.
    now = 2_000;
    const after = new Sessions({ now: () => now, store: store(), password: PASSWORD });
    expect(after.valid(token)).toBe(true);
    expect(after.size).toBe(1);
  });

  it('expires a session 30 days after its login, and prunes it from the file', () => {
    const store = memoryStore();
    let now = 0;
    const sessions = new Sessions({ now: () => now, store, password: PASSWORD });
    const token = sessions.create();
    now = SESSION_MS - 1;
    expect(new Sessions({ now: () => now, store, password: PASSWORD }).valid(token)).toBe(true);
    now = SESSION_MS;
    const later = new Sessions({ now: () => now, store, password: PASSWORD });
    expect(later.valid(token)).toBe(false);
    expect(store.read<{ sessions: object }>(SESSIONS_DOC)?.sessions).toEqual({});
    // Expired on a running process too, and forgotten.
    const t2 = later.create();
    now += SESSION_MS;
    expect(later.valid(t2)).toBe(false);
    expect(store.read<{ sessions: object }>(SESSIONS_DOC)?.sessions).toEqual({});
    later.create();
    now += SESSION_MS;
    expect(later.size).toBe(0);
    expect(store.read<{ sessions: object }>(SESSIONS_DOC)?.sessions).toEqual({});
  });

  it('ends every session when the password changes', () => {
    const store = memoryStore();
    const now = () => 0;
    const token = new Sessions({ now, store, password: PASSWORD }).create();
    const changed = new Sessions({ now, store, password: 'another long password' });
    expect(changed.valid(token)).toBe(false);
    expect(changed.size).toBe(0);
    // Not even the old password brings them back.
    expect(new Sessions({ now, store, password: PASSWORD }).valid(token)).toBe(false);
    expect(store.docs.get(SESSIONS_DOC)).not.toContain('another long password');
  });

  it('ends one session at its logout, the others kept', () => {
    const store = memoryStore();
    const now = () => 0;
    const sessions = new Sessions({ now, store, password: PASSWORD });
    const a = sessions.create();
    const b = sessions.create();
    sessions.end(a);
    sessions.end('not a session');
    const next = new Sessions({ now, store, password: PASSWORD });
    expect(next.valid(a)).toBe(false);
    expect(next.valid(b)).toBe(true);
  });

  it('starts afresh from a document it cannot read', () => {
    const store = memoryStore();
    store.docs.set(SESSIONS_DOC, 'not json');
    const sessions = new Sessions({ now: () => 0, store, password: PASSWORD });
    expect(sessions.size).toBe(0);
    store.docs.set(SESSIONS_DOC, JSON.stringify({ version: 1 }));
    expect(new Sessions({ now: () => 0, store, password: PASSWORD }).size).toBe(0);
    // Sessions with no password given are kept in memory only.
    const bare = memoryStore();
    new Sessions({ now: () => 0, store: bare }).create();
    expect(bare.docs.size).toBe(0);
  });

  it('skips a session record that is not a time', () => {
    const store = memoryStore();
    const token = new Sessions({ now: () => 0, store, password: PASSWORD }).create();
    const doc = store.read<{ sessions: Record<string, unknown> }>(SESSIONS_DOC);
    if (doc === undefined) throw new Error('no document');
    doc.sessions = { ...doc.sessions, odd: 'soon' };
    store.write(SESSIONS_DOC, doc);
    const next = new Sessions({ now: () => 0, store, password: PASSWORD });
    expect(next.size).toBe(1);
    expect(next.valid(token)).toBe(true);
  });
});

describe('LoginLimiter', () => {
  it('allows max failures per client within the window, then waits for the oldest to age', () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now, max: 3, windowMs: 1000 });
    for (const t of [0, 100, 200]) {
      now = t;
      expect(limiter.retryIn('a')).toBe(0);
      limiter.failed('a');
    }
    expect(limiter.retryIn('a')).toBe(800);
    expect(limiter.retryIn('b')).toBe(0);
    now = 1000;
    expect(limiter.retryIn('a')).toBe(0);
    limiter.failed('a');
    expect(limiter.retryIn('a')).toBe(100);
    limiter.succeeded('a');
    expect(limiter.retryIn('a')).toBe(0);
  });

  it('forgets a client whose failures aged, and defaults to 5 in 15 minutes', () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) limiter.failed('a');
    expect(limiter.retryIn('a')).toBe(15 * 60_000);
    now = 15 * 60_000;
    expect(limiter.retryIn('b')).toBe(0);
    expect(limiter.retryIn('a')).toBe(0);
  });
});
