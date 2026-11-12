/**
 * The web UI's login (docs/bot-os.md D40): one owner (D19), one password, which comes in as a
 * Docker secret (`web_ui_password`); a session is a random token in an HttpOnly, SameSite=Strict
 * cookie, lasting 30 days from its login. The sessions are kept across restarts in the core's own
 * store (`<data>/core/web-sessions.json`), as the SHA-256 of each token, never the token, beside a
 * salted scrypt fingerprint of the password, never the password: a changed password ends them all.
 * Failed logins are limited per client address: behind a proxy every client is the proxy, so the
 * limit is the instance's.
 */
import crypto from 'node:crypto';

/** The session's cookie. */
export const SESSION_COOKIE = 'mbt_session';
/** How long a session lasts from its login. */
export const SESSION_MS = 30 * 86_400_000;
/** The shortest password the UI accepts: a shorter one leaves the UI off. */
export const MIN_PASSWORD = 12;

/**
 * Whether `given` is `password`, compared in constant time: the hashes of both are compared, so
 * that neither the content nor the length shows in the time taken.
 */
export function samePassword(given: string, password: string): boolean {
  const hash = (s: string): Buffer => crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(hash(given), hash(password));
}

/** The sessions' document in the core's own store: `<data>/core/web-sessions.json`. */
export const SESSIONS_DOC = 'web-sessions';

/** Where the sessions are kept: the core's own store, or none (memory only, for tests). */
export interface SessionStore {
  read<T = unknown>(name: string): T | undefined;
  write(name: string, value: unknown): void;
}

/**
 * The sessions' document: a fingerprint of the password they were opened with (scrypt, salted:
 * never the password), and each session as the SHA-256 of its token (never the token) with when it
 * expires, in ms.
 */
interface SessionsDoc {
  version: 1;
  password: { salt: string; hash: string };
  sessions: Record<string, number>;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const fingerprint = (password: string, salt: string): string =>
  crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32).toString('base64');

/** The sessions logged in, each until it expires or logs out, kept across restarts when stored. */
export class Sessions {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly store: SessionStore | undefined;
  private readonly password: { salt: string; hash: string } | undefined;
  /** Each session's token hash, and when it expires. */
  private readonly until = new Map<string, number>();

  constructor(o: { now: () => number; ttlMs?: number; store?: SessionStore; password?: string }) {
    this.now = o.now;
    this.ttlMs = o.ttlMs ?? SESSION_MS;
    this.store = o.password === undefined ? undefined : o.store;
    if (this.store === undefined || o.password === undefined) return;
    let doc: Partial<SessionsDoc> | undefined;
    try {
      doc = this.store.read<Partial<SessionsDoc>>(SESSIONS_DOC);
    } catch {
      doc = undefined;
    }
    const salt = doc?.password?.salt;
    const same = typeof salt === 'string' && doc?.password?.hash === fingerprint(o.password, salt);
    if (same && doc?.password !== undefined) {
      this.password = doc.password;
      for (const [hash, until] of Object.entries(doc.sessions ?? {}))
        if (typeof until === 'number') this.until.set(hash, until);
    } else {
      // A new password (or none kept): every session opened with the old one ends.
      const fresh = crypto.randomBytes(16).toString('base64');
      this.password = { salt: fresh, hash: fingerprint(o.password, fresh) };
    }
    this.prune();
    this.save();
  }

  /** A new session's token: 32 random bytes. Only its hash is kept. */
  create(): string {
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    this.until.set(sha256(token), this.now() + this.ttlMs);
    this.save();
    return token;
  }

  /** Whether `token` is a session not expired. */
  valid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const hash = sha256(token);
    const until = this.until.get(hash);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(hash);
    this.save();
    return false;
  }

  /** Ends a session, the others left as they are. */
  end(token: string | undefined): void {
    if (token !== undefined && this.until.delete(sha256(token))) this.save();
  }

  /** How many sessions are open. */
  get size(): number {
    if (this.prune()) this.save();
    return this.until.size;
  }

  /** Forgets the expired sessions; whether there were any. */
  private prune(): boolean {
    const now = this.now();
    let pruned = false;
    for (const [hash, until] of this.until)
      if (until <= now) {
        this.until.delete(hash);
        pruned = true;
      }
    return pruned;
  }

  /** Writes the sessions to the store (atomically, as the core's store writes), if there is one. */
  private save(): void {
    if (this.store === undefined || this.password === undefined) return;
    const doc: SessionsDoc = {
      version: 1,
      password: this.password,
      sessions: Object.fromEntries(this.until),
    };
    this.store.write(SESSIONS_DOC, doc);
  }
}

/** Failed logins, limited per client: `max` within `windowMs`, then none until the oldest ages. */
export class LoginLimiter {
  private readonly now: () => number;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly failures = new Map<string, number[]>();

  constructor(o: { now: () => number; max?: number; windowMs?: number }) {
    this.now = o.now;
    this.max = o.max ?? 5;
    this.windowMs = o.windowMs ?? 15 * 60_000;
  }

  /** How long until `client` may try again: 0 for now. */
  retryIn(client: string): number {
    const times = this.recent(client);
    if (times.length < this.max) return 0;
    return (times[times.length - this.max] as number) + this.windowMs - this.now();
  }

  /** A failed login. */
  failed(client: string): void {
    this.failures.set(client, [...this.recent(client), this.now()]);
  }

  /** A login that succeeded: the client's failures are forgotten. */
  succeeded(client: string): void {
    this.failures.delete(client);
  }

  private recent(client: string): number[] {
    const now = this.now();
    for (const [c, times] of this.failures) {
      const kept = times.filter((t) => now - t < this.windowMs);
      if (kept.length === 0) this.failures.delete(c);
      else this.failures.set(c, kept);
    }
    return this.failures.get(client) ?? [];
  }
}
