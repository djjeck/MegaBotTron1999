import { describe, expect, it } from 'vitest';
import { LoginLimiter, samePassword, SESSION_MS, Sessions } from './auth.ts';

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
