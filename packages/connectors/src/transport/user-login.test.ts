import { Stores, VirtualClock } from '@megabottron1999/core';
import { type QrCodeAuthParams, type UserAuthParams } from 'telegram/client/auth.js';
import { type StringSession } from 'telegram/sessions/index.js';
import { describe, expect, it } from 'vitest';
import {
  LOGIN_DOC,
  LOGIN_TIMEOUT_MS,
  refusal,
  userId,
  UserLogin,
  type UserLoginClient,
  type UserLoginOptions,
  userName,
} from './user-login.ts';

const HASH = '0123456789abcdef0123456789abcdef';
const API = { apiId: 123456, apiHash: HASH };
const SESSION = '1BQANOTAREALSESSION';
let stores = 0;
/** A store in memory, of its own. */
const memoryStore = () => new Stores().open(`s${++stores}`);
const tick = () => new Promise((r) => setImmediate(r));

/** An RPC error as GramJS raises it. */
const rpc = (name: string) => Object.assign(new Error(`400: ${name}`), { errorMessage: name });

/**
 * A fake GramJS client: `phone` and `qr` run the login as the test says, through the callbacks.
 */
function fakeClient(o: {
  phone?: (p: UserAuthParams) => Promise<unknown>;
  qr?: (p: QrCodeAuthParams) => Promise<unknown>;
}) {
  const calls: string[] = [];
  const made: { api: unknown; session: StringSession }[] = [];
  const client = (api: unknown, session: StringSession): UserLoginClient => (
    made.push({ api, session }),
    {
      connect: () => (calls.push('connect'), Promise.resolve(true)),
      disconnect: () => (calls.push('disconnect'), Promise.resolve()),
      signInUser: async (_api, p) => {
        const user = await (o.phone ?? (() => Promise.reject(new Error('no phone'))))(p);
        session.save = () => SESSION;
        return user;
      },
      signInUserWithQrCode: async (_api, p) => {
        const user = await (o.qr ?? (() => Promise.reject(new Error('no qr'))))(p);
        session.save = () => SESSION;
        return user;
      },
    }
  );
  return { client, calls, made };
}

function setUp(o: Partial<UserLoginOptions> & Pick<UserLoginOptions, 'client'>) {
  const store = o.store ?? memoryStore();
  const clock = new VirtualClock(1000);
  const remembered: string[] = [];
  const logged: string[] = [];
  const login = new UserLogin({
    store,
    clock,
    source: undefined,
    self: () => undefined,
    remember: (v) => remembered.push(v),
    log: (l) => logged.push(l),
    ...o,
  });
  return { login, store, clock, remembered, logged };
}

describe('a telegram-user login (D116)', () => {
  it('asks for the API pair first, checks it, and keeps it', async () => {
    const { login, store, logged } = setUp({ client: fakeClient({}).client });
    const first = login.state();
    expect(first).toMatchObject({
      status: 'needed',
      step: { title: 'Your app’s API id and hash' },
    });
    expect(first.step?.link?.href).toBe('https://my.telegram.org');
    expect(first.step?.fields.map((f) => [f.name, f.secret === true])).toEqual([
      ['apiId', false],
      ['apiHash', true],
    ]);
    expect(await login.act('api', { apiId: '0', apiHash: 'nothex' })).toMatchObject({
      error: 'the api_id is a number; the api_hash is 32 hex digits',
    });
    const next = await login.act('api', { apiId: ' 123456 ', apiHash: HASH.toUpperCase() });
    expect(next.error).toBeUndefined();
    expect(next.actions.map((a) => a.name)).toEqual(['qr', 'phone', 'retype']);
    expect(store.read(LOGIN_DOC)).toEqual(API);
    expect(logged).toEqual(['the API id and hash are kept']);
    // Typed again on demand, or kept.
    expect((await login.act('retype', {})).step?.title).toBe('Your app’s API id and hash');
    expect((await login.act('cancel', {})).step?.title).toBe('Log in to Telegram');
  });

  it('logs in by phone: the number, a wrong code asked again, the 2FA password', async () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, API);
    const { client, calls, made } = fakeClient({
      phone: async (p) => {
        expect(typeof p.phoneNumber === 'function' ? await p.phoneNumber() : '').toBe('+15550100');
        let code = await p.phoneCode(true);
        if (code !== '22222') {
          expect(await p.onError(rpc('PHONE_CODE_INVALID'))).toBe(false);
          code = await p.phoneCode(true);
        }
        expect(code).toBe('22222');
        expect(await p.password?.('a cat')).toBe('hunter22');
        return { username: 'alice', id: 5000001 };
      },
    });
    const { login, remembered, logged } = setUp({ client, store });
    const asked = await login.act('phone', {});
    expect(asked).toMatchObject({ status: 'pending', step: { title: 'Your phone number' } });
    expect(asked.actions.map((a) => a.name)).toEqual(['number', 'cancel']);
    expect(made[0]?.api).toEqual(API);
    expect(await login.act('number', { number: ' +15550100 ' })).toMatchObject({
      step: {
        title: 'The code',
        text: 'Telegram sent a code to your Telegram app, in the chat with Telegram.',
      },
    });
    expect(await login.act('code', { code: '11111' })).toMatchObject({
      step: { title: 'The code' },
      error: 'Telegram refused it: PHONE_CODE_INVALID',
    });
    const password = await login.act('code', { code: '22222' });
    expect(password).toMatchObject({ step: { title: 'Your 2FA password' } });
    expect(password.error).toBeUndefined();
    expect(password.step?.text).toContain('its hint: a cat');
    expect(password.step?.fields[0]).toMatchObject({ name: 'password', secret: true });
    const done = await login.act('password', { password: 'hunter22' });
    await tick();
    expect(login.state()).toEqual({
      status: 'done',
      source: 'store',
      restart: true,
      as: '@alice',
      note: 'Restart to connect with it.',
      actions: [],
    });
    expect(done.status).not.toBe('needed');
    // Whom it is, and the account's id, never shown, kept beside the session (D120).
    expect(store.read(LOGIN_DOC)).toEqual({
      ...API,
      session: SESSION,
      as: '@alice',
      user: '5000001',
    });
    expect(calls).toEqual(['connect', 'disconnect']);
    // What was typed is marked secret, the code too short to be; the session too.
    expect(remembered).toEqual([HASH, '+15550100', 'hunter22', SESSION]);
    expect(logged.join('\n')).not.toMatch(/hunter22|15550100|1BQ/u);
    expect(logged).toEqual(['logged in as @alice; a restart connects it']);
  });

  it('logs in by QR code, which renews itself, then asks for the 2FA password', async () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, API);
    let qr: QrCodeAuthParams | undefined;
    let scanned: (user: unknown) => void = () => {};
    const { client } = fakeClient({
      qr: (p) => {
        qr = p;
        void p.qrCode?.({ token: Buffer.from('first'), expires: 30 });
        return new Promise((r) => (scanned = r));
      },
    });
    const { login } = setUp({ client, store });
    const shown = await login.act('qr', {});
    expect(shown).toMatchObject({
      status: 'pending',
      step: {
        title: 'Scan the QR code',
        qr: `tg://login?token=${Buffer.from('first').toString('base64url')}`,
        expires: 30_000,
      },
    });
    expect(shown.actions.map((a) => a.name)).toEqual(['cancel']);
    await qr?.qrCode?.({ token: Buffer.from('second'), expires: 60 });
    expect(login.state().step?.qr).toBe(
      `tg://login?token=${Buffer.from('second').toString('base64url')}`
    );
    const password = qr?.password?.();
    await tick();
    expect(login.state().step?.title).toBe('Your 2FA password');
    // A question it does not ask now.
    await expect(login.act('code', { code: '1' })).rejects.toThrow(
      'the login does not ask for code now'
    );
    void login.act('password', { password: 'hunter22' });
    expect(await password).toBe('hunter22');
    scanned({ firstName: 'Alice' });
    await tick();
    expect(login.state()).toMatchObject({ status: 'done', as: 'Alice', restart: true });
  });

  it('ends a login that fails, with why, and one cancelled or left unanswered', async () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, API);
    const { client, calls } = fakeClient({
      phone: async (p) => {
        if (typeof p.phoneNumber === 'function') await p.phoneNumber();
        // GramJS asks again after a refusal, and stops once told to.
        if (await p.onError(rpc('PHONE_NUMBER_INVALID'))) throw new Error('AUTH_USER_CANCEL');
        return p.phoneCode();
      },
      qr: () => Promise.reject(rpc('API_ID_INVALID')),
    });
    const { login, clock } = setUp({ client, store });
    await login.act('qr', {});
    await tick();
    expect(login.state()).toMatchObject({
      status: 'needed',
      error: 'Telegram refused it: API_ID_INVALID',
    });
    // Cancelled.
    await login.act('phone', {});
    expect((await login.act('cancel', {})).status).toBe('needed');
    // Unanswered: dropped after the timeout, and an answer then is refused.
    await login.act('phone', {});
    await login.act('number', { number: '+15550100' });
    clock.advance(LOGIN_TIMEOUT_MS);
    await tick();
    expect(login.state()).toMatchObject({
      status: 'needed',
      error: 'the login timed out: start it again',
    });
    await expect(login.act('code', { code: '1' })).rejects.toThrow(
      'the login does not offer code now'
    );
    expect(calls.filter((c) => c === 'disconnect')).toHaveLength(3);
  });

  it('says whom it is from what its login kept, before it connects (D120)', () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, { ...API, session: SESSION, as: 'Alice', user: '5000001' });
    const { login } = setUp({ client: fakeClient({}).client, store, source: 'store' });
    expect(login.state()).toMatchObject({ status: 'done', as: 'Alice' });
  });

  it('logs out a session of its store, on Telegram too, keeping the API pair', async () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, { ...API, session: SESSION });
    let out = 0;
    const { login, remembered } = setUp({
      client: fakeClient({}).client,
      store,
      source: 'store',
      self: () => 'alice',
      logOut: () => (out++, Promise.resolve()),
    });
    expect(remembered).toEqual([HASH, SESSION]);
    const state = login.state();
    expect(state).toMatchObject({ status: 'done', source: 'store', as: '@alice' });
    expect(state.actions[0]).toMatchObject({ name: 'logout' });
    expect(state.actions[0]?.confirm).toContain('ends on Telegram too');
    // Not while logged in.
    await expect(login.act('qr', {})).rejects.toThrow('the login does not offer qr now');
    const after = await login.act('logout', {});
    expect(out).toBe(1);
    expect(after).toMatchObject({ status: 'needed', restart: true });
    expect(store.read(LOGIN_DOC)).toEqual(API);
    await expect(login.act('logout', {})).rejects.toThrow('does not offer logout');
  });

  it('says why a logout failed, and needs a login after one', async () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, { ...API, session: SESSION });
    let fail = true;
    const { login } = setUp({
      client: fakeClient({}).client,
      store,
      source: 'store',
      logOut: () => (fail ? Promise.reject(new Error('not connected')) : Promise.resolve()),
    });
    expect(await login.act('logout', {})).toMatchObject({
      status: 'done',
      error: 'the logout failed: not connected',
    });
    fail = false;
    expect(await login.act('logout', {})).toMatchObject({ status: 'needed', restart: true });
  });

  it('offers no other action than its own', async () => {
    const { login } = setUp({ client: fakeClient({}).client });
    await expect(login.act('nonsense', {})).rejects.toThrow('does not offer nonsense');
    await expect(login.act('replace', {})).rejects.toThrow('does not offer replace');
  });

  it('drops the session of its store when its API pair changes', async () => {
    const store = memoryStore();
    store.write(LOGIN_DOC, { ...API, session: SESSION });
    const { login } = setUp({ client: fakeClient({}).client, store, source: 'store' });
    // A logged-in login offers no retype; the owner logs out first. Retyped anyway:
    await login.act('retype', {});
    await login.act('api', { apiId: '7654321', apiHash: HASH });
    expect(store.read(LOGIN_DOC)).toEqual({ apiId: 7654321, apiHash: HASH });
    expect(login.state()).toMatchObject({ status: 'needed', restart: true });
  });
});

describe('userName, userId and refusal', () => {
  it('name a user and a refusal', () => {
    expect(userId({ id: { toString: () => '5000001' } })).toBe('5000001');
    expect(userId({ id: null })).toBeUndefined();
    expect(userId({})).toBeUndefined();
    expect(userId(null)).toBeUndefined();
    expect(userName({ username: 'alice', firstName: 'Alice' })).toBe('@alice');
    expect(userName({ username: '', firstName: 'Alice' })).toBe('Alice');
    expect(userName({})).toBeUndefined();
    expect(userName(null)).toBeUndefined();
    expect(refusal(rpc('FLOOD_WAIT'))).toBe('Telegram refused it: FLOOD_WAIT');
    expect(refusal(new Error('down'))).toBe('down');
    expect(refusal('odd')).toBe('odd');
  });
});
