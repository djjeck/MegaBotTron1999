import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretsWith } from '#test/secrets.ts';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import { KEY_SECRET, REDACTED, Secrets, SecretStore } from './secrets.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Secrets', () => {
  it('reads Docker secret files once, without their newline, and redacts every value read', () => {
    const s = secretsWith({ znc_password: 'hunter22', api_key: 'sk-ant-xyz-1234' });
    expect(s.has('znc_password')).toBe(true);
    expect(s.has('nope')).toBe(false);
    expect(s.has('../etc')).toBe(false);
    expect(s.read('missing')).toBeUndefined();
    expect(() => s.read('Bad/Name')).toThrow("not a secret's name");
    // Not read yet: not known, not redacted.
    expect(s.redact('pass hunter22')).toBe('pass hunter22');
    expect(s.read('znc_password')).toBe('hunter22');
    expect(s.read('znc_password')).toBe('hunter22');
    s.read('api_key');
    expect(s.redact('PASS alice/ExampleNet:hunter22 and sk-ant-xyz-1234')).toBe(
      `PASS alice/ExampleNet:${REDACTED} and ${REDACTED}`
    );
    expect(
      s.redactDeep({ a: ['hunter22', 1, null], b: { c: 'x hunter22' }, d: true, e: undefined })
    ).toEqual({ a: [REDACTED, 1, null], b: { c: `x ${REDACTED}` }, d: true, e: undefined });
    expect(new Secrets(dir).redactDeep({ a: 'x' })).toEqual({ a: 'x' });
  });

  it('does not redact a value too short or only digits, and is at /run/secrets by default', () => {
    const s = secretsWith({ pin: '12', api_id: '37780000' });
    s.read('pin');
    s.read('api_id');
    expect(s.redact('12 apples, 37780000 points')).toBe('12 apples, 37780000 points');
    expect(new Secrets().dir).toBe('/run/secrets');
  });

  it('lists the names of the secrets provided, never their values', () => {
    const s = secretsWith({ znc_password: 'hunter22', api_key: 'sk-ant-xyz-1234' });
    fs.mkdirSync(path.join(s.dir, 'a_dir'));
    fs.writeFileSync(path.join(s.dir, 'Not.A.Name'), 'x');
    expect(s.names()).toEqual(['api_key', 'znc_password']);
    expect(new Secrets(path.join(dir, 'nowhere')).names()).toEqual([]);
  });
});

describe('SecretStore', () => {
  it('keeps secrets encrypted at rest, in files only its user reads', () => {
    const secrets = secretsWith({ [KEY_SECRET]: 'a-long-random-key-from-docker' });
    const store = new SecretStore(path.join(dir, 'secrets'), secrets);
    expect(store.available).toBe(true);
    expect(store.get('session')).toBeUndefined();
    store.put('session', 'the-session-string');
    const file = path.join(dir, 'secrets', 'session.json');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('the-session-string');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    expect(store.get('session')).toBe('the-session-string');
    expect(secrets.redact('session the-session-string')).toBe(`session ${REDACTED}`);
    // Another key cannot read it, nor a file moved to another name.
    const other = new SecretStore(
      path.join(dir, 'secrets'),
      secretsWith({ [KEY_SECRET]: 'x'.repeat(30) })
    );
    expect(() => other.get('session')).toThrow();
    fs.copyFileSync(file, path.join(dir, 'secrets', 'moved.json'));
    expect(() => store.get('moved')).toThrow();
    store.remove('session');
    expect(store.get('session')).toBeUndefined();
    expect(() => store.put('Bad Name', 'x')).toThrow("not a secret's name");
    expect(() => store.get('../x')).toThrow("not a secret's name");
    expect(() => store.remove('../x')).toThrow("not a secret's name");
  });

  it('stores nothing without its key', () => {
    const store = new SecretStore(dir, secretsWith({}));
    expect(store.available).toBe(false);
    expect(() => store.put('session', 'x')).toThrow(`no ${KEY_SECRET} secret`);
  });
});

describe('secrets in the core', () => {
  const connector = (id: string, secrets: string[], got: Record<string, PluginContext>) =>
    definePlugin({
      manifest: {
        id,
        version: '0.1.0',
        kinds: ['connector'],
        description: id,
        account: `test:${id}`,
        secrets,
      },
      create: (ctx) => {
        got[id] = ctx;
        // Read at create, as a connector makes its client: from then on, it is redacted.
        if (secrets[0] !== undefined) ctx.secrets?.get(secrets[0]);
        return {
          connector: {
            account: `test:${id}`,
            network: 'test',
            status: () => ({ state: 'connected' as const, phase: 'up' }),
            self: () => undefined,
            onMessage: () => () => {},
            onStatus: () => () => {},
            send: () => true,
          },
        };
      },
    });

  it('go to the connectors that declare them, and to nobody else', async () => {
    const got: Record<string, PluginContext> = {};
    const lines: string[] = [];
    const told: string[] = [];
    const records: unknown[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ token: 'tok-123456', other: 'other-654321' }),
      print: (l) => lines.push(l),
      notify: (t) => told.push(t),
      record: (r) => records.push(r),
    });
    core.register(
      connector('conn', ['token'], got),
      definePlugin({
        manifest: { id: 'stats', version: '0.1.0', kinds: ['stats'], description: 'stats' },
        create: (ctx) => {
          got['stats'] = ctx;
          throw new Error('cannot start without tok-123456');
        },
      })
    );
    await core.start();
    expect(got['stats']?.secrets).toBeUndefined();
    expect(got['conn']?.secrets?.get('token')).toBe('tok-123456');
    expect(() => got['conn']?.secrets?.get('other')).toThrow(
      'conn does not declare the secret other'
    );
    // A plugin's error naming a secret is redacted everywhere the core says it.
    expect(core.state('stats')?.reason).toBe(`cannot start without ${REDACTED}`);
    expect(lines.join('\n')).not.toContain('tok-123456');
    expect(told.join('\n')).not.toContain('tok-123456');
    expect(JSON.stringify(records)).not.toContain('tok-123456');
    expect(core.secretStore).toBeUndefined();
  });

  it('give a store of the core’s own with a data volume', () => {
    const core = new Core({
      clock: new VirtualClock(),
      dataDir: dir,
      secrets: secretsWith({ [KEY_SECRET]: 'k'.repeat(32) }),
    });
    core.secretStore?.put('later', 'login-done-later');
    expect(core.secretStore?.get('later')).toBe('login-done-later');
    expect(fs.existsSync(path.join(dir, 'core', 'secrets', 'later.json'))).toBe(true);
  });

  it('refuse a secret a connector declares that is not provided', () => {
    const core = new Core({ clock: new VirtualClock(), secrets: secretsWith({ token: 'x' }) });
    core.register(connector('conn', ['token', 'missing'], {}));
    expect(() => core.load()).toThrow('plugin conn: the secret missing is not provided');
  });
});
