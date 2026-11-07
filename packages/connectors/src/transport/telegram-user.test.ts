import { FloodWait, type Inbound, VirtualClock } from '@megabottron1999/core';
import { type UserAuthParams } from 'telegram/client/auth.js';
import { type StringSession } from 'telegram/sessions/index.js';
import { describe, expect, it } from 'vitest';
import {
  type Ask,
  createTelegramClient,
  type GramClient,
  login,
  type LoginClient,
  type RawMessage,
  RETRY_MS,
  TelegramUserConnector,
} from './telegram-user.ts';

const GROUP = '-1001000000001';

function raw(over: Partial<RawMessage> & { sender?: unknown; chat?: unknown } = {}): RawMessage {
  const { sender, chat, ...rest } = {
    sender: { username: 'LootBot' },
    chat: undefined,
    ...over,
  };
  return {
    id: 7,
    date: 1_793_000_000,
    out: false,
    message: 'Troppo presto',
    chatId: { toString: () => GROUP },
    getSender: () => Promise.resolve(sender),
    getChat: () => Promise.resolve(chat),
    ...rest,
  };
}

function fake(o: { failConnect?: number; send?: () => Promise<{ id: number }> } = {}) {
  const calls: string[] = [];
  const sent: { entity: unknown; message: string }[] = [];
  let failures = o.failConnect ?? 0;
  let handler: ((event: { message: RawMessage }) => Promise<void>) | undefined;
  let handlers = 0;
  const client: GramClient = {
    connect: () => {
      calls.push('connect');
      if (failures-- > 0) return Promise.reject(new Error('AUTH_KEY_UNREGISTERED'));
      return Promise.resolve(true);
    },
    disconnect: () => (calls.push('disconnect'), Promise.resolve()),
    getDialogs: () => (calls.push('dialogs'), Promise.resolve([])),
    getInputEntity: (id) => (calls.push(`entity ${id}`), Promise.resolve({ peer: id })),
    getMe: () => (calls.push('me'), Promise.resolve({ username: 'alice' })),
    sendMessage: (entity, { message }) => {
      sent.push({ entity, message });
      return o.send?.() ?? Promise.resolve({ id: 99 });
    },
    addEventHandler: (h) => {
      handler = h;
      handlers++;
    },
  };
  const deliver = (message: RawMessage) => handler?.({ message }) ?? Promise.resolve();
  return { client, calls, sent, deliver, handlers: () => handlers };
}

const flush = () => new Promise((r) => setImmediate(r));

async function connector(f = fake(), chats = [GROUP, '@Quiz_bot']) {
  const clock = new VirtualClock(0);
  const messages: Inbound[] = [];
  const logs: string[] = [];
  const told: string[] = [];
  const c = new TelegramUserConnector({
    account: 'telegram:alice',
    client: f.client,
    chats,
    clock,
    log: (l) => logs.push(l),
    notify: (t) => told.push(t),
  });
  c.onMessage((m) => messages.push(m));
  c.start();
  await flush();
  return { c, f, clock, messages, logs, told };
}

describe('TelegramUserConnector', () => {
  it('connects, fills the entity cache, then resolves its chats, once', async () => {
    const { c, f, logs } = await connector();
    expect(f.calls).toEqual(['connect', 'dialogs', `entity ${GROUP}`, 'entity @Quiz_bot', 'me']);
    expect(c.status()).toEqual({ state: 'connected', phase: 'ready' });
    expect(c.self()).toBe('alice');
    expect(logs).toEqual([`connected as alice, reading ${GROUP}, @Quiz_bot`]);
    c.start();
    await flush();
    expect(f.calls.filter((x) => x === 'connect')).toHaveLength(1);
  });

  it('retries a failed start every minute, telling the owner of the first failure only', async () => {
    const { c, f, clock, logs, told } = await connector(fake({ failConnect: 2 }));
    expect(c.status()).toMatchObject({ state: 'connecting', phase: 'retrying' });
    expect(logs[0]).toBe('start failed, retrying in 60 s: Error: AUTH_KEY_UNREGISTERED');
    clock.advance(RETRY_MS);
    await flush();
    clock.advance(RETRY_MS);
    await flush();
    expect(c.status().state).toBe('connected');
    expect(told).toEqual([
      "the owner's Telegram session failed to start: Error: AUTH_KEY_UNREGISTERED",
    ]);
    expect(f.handlers()).toBe(1);
  });

  it('stops retrying, and closes, when stopped', async () => {
    const { c, f, clock } = await connector(fake({ failConnect: 5 }));
    await c.stop();
    clock.advance(10 * RETRY_MS);
    await flush();
    expect(f.calls.filter((x) => x === 'connect')).toHaveLength(1);
    expect(f.calls.at(-1)).toBe('disconnect');
    expect(c.status().state).toBe('closed');
    await c.stop();
    expect(f.calls.filter((x) => x === 'disconnect')).toHaveLength(1);
  });

  it('forgets a start stopped before it connected', async () => {
    const f = fake();
    const clock = new VirtualClock(0);
    const c = new TelegramUserConnector({
      account: 'telegram:alice',
      client: f.client,
      chats: [GROUP],
      clock,
      log: () => {},
    });
    c.start();
    await c.stop();
    await flush();
    expect(c.status().state).toBe('closed');
    expect(f.handlers()).toBe(0);
  });

  it('passes on the messages of its chats, as Inbound, and nothing else', async () => {
    const { f, messages } = await connector();
    await f.deliver(raw({ id: 1, out: true, replyTo: { replyToMsgId: 5 } }));
    await f.deliver(raw({ id: 2, chatId: { toString: () => '-100999' } }));
    await f.deliver(raw({ id: 3, chatId: undefined }));
    await f.deliver(
      raw({ id: 4, chatId: { toString: () => '777' }, isPrivate: true, chat: { username: 'x' } })
    );
    await f.deliver(
      raw({
        id: 5,
        chatId: { toString: () => '888' },
        isPrivate: true,
        chat: { username: 'quiz_bot' },
        sender: { username: 'quiz_bot' },
      })
    );
    await f.deliver(raw({ id: 6, chatId: { toString: () => '999' }, isPrivate: true }));
    expect(messages).toEqual([
      {
        account: 'telegram:alice',
        network: 'telegram',
        chat: GROUP,
        sender: 'LootBot',
        text: 'Troppo presto',
        time: 1_793_000_000_000,
        id: '1',
        replyTo: '5',
        playback: false,
        own: true,
      },
      expect.objectContaining({ chat: '@Quiz_bot', id: '5', sender: 'quiz_bot' }),
    ]);
  });

  it('has no sender for one without a username', async () => {
    const { f, messages } = await connector();
    for (const sender of [undefined, null, {}, { username: null }])
      await f.deliver(raw({ sender }));
    expect(messages.map((m) => m.sender)).toEqual(['', '', '', '']);
  });

  it('logs and drops a message whose sender cannot be fetched', async () => {
    const { f, messages, logs } = await connector();
    await f.deliver(raw({ id: 4, getSender: () => Promise.reject(new Error('flood')) }));
    expect(messages).toEqual([]);
    expect(logs.at(-1)).toBe('message 4 dropped: Error: flood');
  });

  it("sends any text to its chats, with the message's id", async () => {
    const { c, f } = await connector();
    await expect(c.deliver('@quiz_bot', '/quiz')).resolves.toEqual({ id: '99' });
    await expect(c.deliver(GROUP, '/play')).resolves.toEqual({ id: '99' });
    expect(f.sent).toEqual([
      { entity: { peer: '@Quiz_bot' }, message: '/quiz' },
      { entity: { peer: Number(GROUP) }, message: '/play' },
    ]);
    await expect(c.deliver('-100999', 'x')).rejects.toThrow(
      '-100999 is not a chat of telegram:alice'
    );
  });

  it("turns GramJS's flood waits into the core's", async () => {
    const flood = Object.assign(new Error('A wait of 30 seconds is required'), { seconds: 30 });
    const { c } = await connector(fake({ send: () => Promise.reject(flood) }));
    const e: unknown = await c.deliver(GROUP, '/play').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FloodWait);
    expect((e as FloodWait).ms).toBe(30_000);
    const other = await connector(fake({ send: () => Promise.reject(new Error('PEER_FLOOD')) }));
    await expect(other.c.deliver(GROUP, 'x')).rejects.toThrow('PEER_FLOOD');
  });

  it("sends without waiting, logging a failure, and not while it isn't connected", async () => {
    const { c, logs } = await connector(fake({ send: () => Promise.reject(new Error('nope')) }));
    expect(c.send('-100999', 'x')).toBe(false);
    expect(c.send(GROUP, 'x')).toBe(true);
    await flush();
    expect(logs.at(-1)).toBe(`send to ${GROUP} failed: Error: nope`);
    await c.stop();
    expect(c.send(GROUP, 'x')).toBe(false);
  });
});

describe('createTelegramClient', () => {
  it('builds a client without connecting', () => {
    const client = createTelegramClient({ apiId: 1, apiHash: '0'.repeat(32), session: '' });
    expect(client.connected).toBeFalsy();
  });
});

describe('login', () => {
  const credentials = { apiId: 1, apiHash: '0'.repeat(32) };

  function loginClient(run: (p: UserAuthParams, session: StringSession) => Promise<void>) {
    const calls: string[] = [];
    const make = (session: StringSession): LoginClient => ({
      start: (p) => run(p, session),
      disconnect: () => (calls.push('disconnect'), Promise.resolve()),
    });
    return { make, calls };
  }

  it('asks for the phone, the code and the 2FA password, unechoed, and returns the session', async () => {
    const asked: [string, boolean | undefined][] = [];
    const ask: Ask = (q, secret) => (asked.push([q, secret]), Promise.resolve('x'));
    const { make, calls } = loginClient(async (p, session) => {
      if (typeof p.phoneNumber !== 'string') await p.phoneNumber();
      await p.phoneCode();
      await p.password?.('cat');
      await p.password?.();
      session.save = () => '1BQANOTAREALSESSION';
    });
    const saved = await login(credentials, ask, make);
    expect(asked).toEqual([
      ['Phone number (international, +39…): ', undefined],
      ['The code Telegram sent: ', undefined],
      ['2FA password (hint: cat): ', true],
      ['2FA password: ', true],
    ]);
    expect(saved).toBe('1BQANOTAREALSESSION');
    expect(calls).toEqual(['disconnect']);
  });

  it('stops at the first error and throws it, not GramJS cancel', async () => {
    const { make, calls } = loginClient(async (p) => {
      if (await p.onError(new Error('PHONE_CODE_INVALID'))) throw new Error('AUTH_USER_CANCEL');
    });
    await expect(login(credentials, () => Promise.resolve(''), make)).rejects.toThrow(
      'PHONE_CODE_INVALID'
    );
    expect(calls).toEqual(['disconnect']);
  });

  it('throws an error raised outside the callbacks as it is', async () => {
    const { make } = loginClient(() => Promise.reject(new Error('API_ID_INVALID')));
    await expect(login(credentials, () => Promise.resolve(''), make)).rejects.toThrow(
      'API_ID_INVALID'
    );
  });
});
