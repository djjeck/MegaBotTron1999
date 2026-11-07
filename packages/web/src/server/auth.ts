/**
 * The web UI's login (docs/bot-os.md D40): one owner (D19), one password, which comes in as a
 * Docker secret (`web_ui_password`); a session is a random token held in memory, in an HttpOnly,
 * SameSite=Strict cookie. A restart logs the owner out. Failed logins are limited per client
 * address: behind a proxy every client is the proxy, so the limit is the instance's.
 */
import crypto from 'node:crypto';

/** The session's cookie. */
export const SESSION_COOKIE = 'mbt_session';
/** How long a session lasts from its login. */
export const SESSION_MS = 12 * 3_600_000;
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

/** The sessions logged in, each until it expires or logs out. */
export class Sessions {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly until = new Map<string, number>();

  constructor(o: { now: () => number; ttlMs?: number }) {
    this.now = o.now;
    this.ttlMs = o.ttlMs ?? SESSION_MS;
  }

  /** A new session's token: 32 random bytes. */
  create(): string {
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    this.until.set(token, this.now() + this.ttlMs);
    return token;
  }

  /** Whether `token` is a session not expired. */
  valid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const until = this.until.get(token);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(token);
    return false;
  }

  /** Ends a session. */
  end(token: string | undefined): void {
    if (token !== undefined) this.until.delete(token);
  }

  /** How many sessions are open. */
  get size(): number {
    this.prune();
    return this.until.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, until] of this.until) if (until <= now) this.until.delete(token);
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
