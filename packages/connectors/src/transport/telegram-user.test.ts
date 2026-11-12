import { FloodWait, type Inbound, type ReadFilter, VirtualClock } from '@megabottron1999/core';
import { type UserAuthParams } from 'telegram/client/auth.js';
import { type StringSession } from 'telegram/sessions/index.js';
import { describe, expect, it } from 'vitest';
import {
  type Ask,
  CATCH_UP_CAP,
  CATCH_UP_PAUSE_MS,
  createTelegramClient,
  type GramClient,
  LAST_SEEN_DOC,
  login,
  type LoginClient,
  type RawDialog,
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

function fake(
  o: {
    failConnect?: number;
    send?: () => Promise<{ id: number }>;
    dialogs?: RawDialog[];
    /** Each chat's history, by its peer. */
    history?: Record<string, RawMessage[]>;
    /** Fails the history's next requests with these, in turn. */
    historyFails?: Error[];
  } = {}
) {
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
    getDialogs: (p) => (
      calls.push(p.limit === undefined ? 'dialogs' : `dialogs ${p.limit}`),
      Promise.resolve(o.dialogs ?? [])
    ),
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
    getMessages: (entity, { limit, offsetId, minId }) => {
      const peer = String((entity as { peer: unknown }).peer);
      calls.push(`history ${peer} <${offsetId} >${minId} ${limit}`);
      const fail = o.historyFails?.shift();
      if (fail !== undefined) return Promise.reject(fail);
      return Promise.resolve(
        (o.history?.[peer] ?? [])
          .filter((m) => (offsetId === 0 || m.id < offsetId) && m.id > minId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
      );
    },
  };
  const deliver = (message: RawMessage) => handler?.({ message }) ?? Promise.resolve();
  return { client, calls, sent, deliver, handlers: () => handlers };
}

const flush = () => new Promise((r) => setImmediate(r));
/** Lets the catch-up run, a pause at a time. */
async function settle(clock: VirtualClock, steps = 40): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await flush();
    clock.advance(CATCH_UP_PAUSE_MS);
  }
  await flush();
}

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
    expect(f.handlers()).toBe(1);
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

describe('every chat, and the surfaces', () => {
  const PRIVATE_ID = '5000001';
  const dialog = (over: Partial<RawDialog>): RawDialog => ({
    id: { toString: () => GROUP },
    title: 'The Lobby',
    date: 1_793_000_100,
    isGroup: true,
    inputEntity: { peer: GROUP },
    message: { id: 20 },
    ...over,
  });
  const quiz = dialog({
    id: { toString: () => PRIVATE_ID },
    title: 'Quiz Bot',
    date: 1_793_000_200,
    isUser: true,
    isGroup: false,
    entity: { username: 'Quiz_bot', bot: true },
    inputEntity: { peer: '@Quiz_bot' },
    message: { id: 9 },
  });

  function make(f: ReturnType<typeof fake>, o: { chats?: string[] } = {}) {
    const clock = new VirtualClock(0);
    const messages: Inbound[] = [];
    const logs: string[] = [];
    const c = new TelegramUserConnector({
      account: 'telegram:alice',
      client: f.client,
      ...(o.chats === undefined ? {} : { chats: o.chats }),
      clock,
      log: (l) => logs.push(l),
    });
    c.onMessage((m) => messages.push(m));
    return { c, clock, messages, logs };
  }

  it('given no chats, monitors every chat, by @username or id, and sends to any', async () => {
    const f = fake();
    const { c, messages, logs } = make(f);
    c.start();
    await flush();
    expect(logs).toEqual(['connected as alice, reading every chat']);
    await f.deliver(raw({ id: 1, chatId: { toString: () => '-100999' } }));
    await f.deliver(
      raw({
        id: 2,
        chatId: { toString: () => '777' },
        isPrivate: true,
        chat: { username: 'x_bot' },
      })
    );
    await f.deliver(raw({ id: 3, chatId: { toString: () => '778' }, isPrivate: true }));
    expect(messages.map((m) => m.chat)).toEqual(['-100999', '@x_bot', '778']);
    await expect(c.deliver('778', 'hi')).resolves.toEqual({ id: '99' });
    await expect(c.deliver('778', 'again')).resolves.toEqual({ id: '99' });
    expect(f.calls.filter((x) => x.startsWith('entity'))).toEqual(['entity 778']);
  });

  it('lists its surfaces latest first, with their kind, and searches all of them', async () => {
    const f = fake({
      dialogs: [
        dialog({}),
        quiz,
        dialog({
          id: { toString: () => '-1004' },
          title: 'News',
          date: undefined,
          isGroup: false,
          isChannel: true,
        }),
        dialog({
          id: { toString: () => '5000002' },
          title: undefined,
          isUser: true,
          isGroup: false,
          entity: {},
        }),
      ],
    });
    const { c } = make(f);
    await expect(c.surfaces()).rejects.toThrow('not connected');
    c.start();
    await flush();
    expect(await c.surfaces()).toEqual([
      { id: '@Quiz_bot', title: 'Quiz Bot', kind: 'bot', lastActive: 1_793_000_200_000 },
      { id: GROUP, title: 'The Lobby', kind: 'group', lastActive: 1_793_000_100_000 },
      { id: '5000002', title: '5000002', kind: 'private', lastActive: 1_793_000_100_000 },
      { id: '-1004', title: 'News', kind: 'channel' },
    ]);
    expect(f.calls).toContain('dialogs 50');
    expect((await c.surfaces({ search: ' lobby ', limit: 5 })).map((x) => x.id)).toEqual([GROUP]);
    expect((await c.surfaces({ search: 'quiz' })).map((x) => x.id)).toEqual(['@Quiz_bot']);
    expect(await c.surfaces({ limit: 1 })).toHaveLength(1);
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

describe('the catch-up', () => {
  const PRIVATE_ID = '5000001';
  const group = (top: number): RawDialog => ({
    id: { toString: () => GROUP },
    title: 'The Lobby',
    isGroup: true,
    inputEntity: { peer: GROUP },
    message: { id: top },
  });
  const quiz = (top: number): RawDialog => ({
    id: { toString: () => PRIVATE_ID },
    title: 'Quiz Bot',
    isUser: true,
    entity: { username: 'Quiz_bot', bot: true },
    inputEntity: { peer: '@Quiz_bot' },
    message: { id: top },
  });
  const said = (from: number, to: number, chat = GROUP): RawMessage[] =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      raw({ id: from + i, message: `m${from + i}`, chatId: { toString: () => chat } })
    );

  function make(
    f: ReturnType<typeof fake>,
    o: {
      chats?: string[];
      seen?: Record<string, number>;
      readers?: ReadFilter[] | undefined;
    } = {}
  ) {
    const clock = new VirtualClock(0);
    const messages: Inbound[] = [];
    const logs: string[] = [];
    const warnings: string[] = [];
    const records: [string, Record<string, unknown>][] = [];
    const docs = new Map<string, unknown>(o.seen === undefined ? [] : [[LAST_SEEN_DOC, o.seen]]);
    const c = new TelegramUserConnector({
      account: 'telegram:alice',
      client: f.client,
      ...(o.chats === undefined ? {} : { chats: o.chats }),
      clock,
      log: (l) => logs.push(l),
      warn: (l) => warnings.push(l),
      record: (type, fields) => records.push([type, fields]),
      store: {
        read: <T>(name: string) => docs.get(name) as T | undefined,
        write: (name, value) => docs.set(name, structuredClone(value)),
      },
      ...(o.readers === undefined ? {} : { readers: () => o.readers ?? [] }),
    });
    c.onMessage((m) => messages.push(m));
    const seen = () => docs.get(LAST_SEEN_DOC);
    return { c, clock, messages, logs, warnings, records, seen };
  }
  const history = (f: ReturnType<typeof fake>) => f.calls.filter((x) => x.startsWith('history'));

  it('fetches a read chat back to the last id seen, and delivers it oldest first, once, missed', async () => {
    const f = fake({ dialogs: [group(20)], history: { [GROUP]: said(10, 20) } });
    const { c, clock, messages, seen } = make(f, {
      chats: [GROUP],
      seen: { [GROUP]: 15 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock);
    expect(history(f)).toEqual([`history ${GROUP} <21 >15 100`]);
    expect(messages.map((m) => [m.id, m.text, m.chat, m.playback, m.missed])).toEqual(
      [16, 17, 18, 19, 20].map((id) => [String(id), `m${id}`, GROUP, true, true])
    );
    expect(seen()).toEqual({ [GROUP]: 20 });
    // Connected again, there is nothing new: nothing is fetched or delivered twice.
    await c.stop();
    c.start();
    await settle(clock);
    expect(history(f)).toHaveLength(1);
    expect(messages).toHaveLength(5);
  });

  it('fetches only the chats its readers read, all monitored ones for *, and none without', async () => {
    const dialogs = [group(20), quiz(9)];
    const hist = { [GROUP]: said(18, 20), '@Quiz_bot': said(7, 9, PRIVATE_ID) };
    const seen = { [GROUP]: 17, [PRIVATE_ID]: 6 };
    const f1 = fake({ dialogs, history: hist });
    const one = make(f1, { seen, readers: [{ reads: ['@quiz_bot'] }] });
    one.c.start();
    await settle(one.clock);
    expect(history(f1)).toEqual([`history @Quiz_bot <10 >6 100`]);
    expect(one.messages.map((m) => m.chat)).toEqual(['@Quiz_bot', '@Quiz_bot', '@Quiz_bot']);

    const f2 = fake({ dialogs, history: hist });
    const all = make(f2, { seen, readers: [{ reads: [] }, { reads: '*', senders: ['me'] }] });
    all.c.start();
    await settle(all.clock);
    expect(history(f2)).toHaveLength(2);
    expect(all.messages).toHaveLength(6);

    // Monitored chats only: '*' is every chat the connector monitors.
    const f3 = fake({ dialogs, history: hist });
    const some = make(f3, { chats: [GROUP], seen, readers: [{ reads: '*' }] });
    some.c.start();
    await settle(some.clock);
    expect(history(f3)).toEqual([`history ${GROUP} <21 >17 100`]);

    const f4 = fake({ dialogs, history: hist });
    const none = make(f4, { seen });
    none.c.start();
    await settle(none.clock);
    expect(history(f4)).toEqual([]);
    expect(none.seen()).toEqual(seen);
  });

  it('skips a chat seen for the first time, keeping its latest id for the next connection', async () => {
    const f = fake({ dialogs: [group(20), quiz(9), { title: 'no id' }] });
    const { c, clock, messages, seen } = make(f, { readers: [{ reads: '*' }] });
    c.start();
    await settle(clock);
    expect(history(f)).toEqual([]);
    expect(messages).toEqual([]);
    expect(seen()).toEqual({ [GROUP]: 20, [PRIVATE_ID]: 9 });
  });

  it(`stops at ${CATCH_UP_CAP} messages a chat, a page of 100 at a time, warning and recording`, async () => {
    const f = fake({ dialogs: [group(1500)], history: { [GROUP]: said(2, 1500) } });
    const { c, clock, messages, warnings, records, seen } = make(f, {
      seen: { [GROUP]: 1 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock, 5);
    // Paced: one request a pause.
    expect(history(f).length).toBeLessThan(6);
    await settle(clock);
    expect(history(f)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `history ${GROUP} <${1501 - i * 100} >1 100`),
      `history ${GROUP} <501 >1 1`,
    ]);
    expect(messages).toHaveLength(CATCH_UP_CAP);
    expect(messages[0]?.id).toBe('501');
    expect(messages.at(-1)?.id).toBe('1500');
    expect(warnings).toEqual([`catch-up of ${GROUP} stopped at 1000 messages, older ones missed`]);
    expect(records).toEqual([['telegram-user.catch-up', { chat: GROUP, fetched: 1000 }]]);
    expect(seen()).toEqual({ [GROUP]: 1500 });
  });

  it('does not warn when exactly the cap was missing', async () => {
    const f = fake({ dialogs: [group(1000)], history: { [GROUP]: said(1, 1000) } });
    const { c, clock, messages, warnings, records } = make(f, {
      seen: { [GROUP]: 0 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock);
    expect(history(f).at(-1)).toBe(`history ${GROUP} <1 >0 1`);
    expect(messages).toHaveLength(1000);
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });

  it('waits out a FLOOD_WAIT, delivering live messages meanwhile, each once', async () => {
    const flood = Object.assign(new Error('A wait of 30 seconds is required'), { seconds: 30 });
    const f = fake({
      dialogs: [group(20)],
      history: { [GROUP]: said(16, 20) },
      historyFails: [flood],
    });
    const { c, clock, messages, logs, seen } = make(f, {
      seen: { [GROUP]: 15 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock, 2);
    expect(history(f)).toHaveLength(1);
    expect(logs.at(-1)).toBe('catch-up: Telegram asks to wait 30 s');
    // Heard live while it waits: one it is about to fetch (19), one newer (21).
    await f.deliver(raw({ id: 19, message: 'm19' }));
    await f.deliver(raw({ id: 21, message: 'm21' }));
    expect(seen()).toEqual({ [GROUP]: 15 });
    clock.advance(27_000);
    await flush();
    expect(history(f)).toHaveLength(1);
    await settle(clock);
    expect(history(f)).toHaveLength(2);
    expect(messages.map((m) => [m.id, m.missed === true])).toEqual([
      ['19', false],
      ['21', false],
      ['16', true],
      ['17', true],
      ['18', true],
      ['20', true],
    ]);
    expect(seen()).toEqual({ [GROUP]: 21 });
  });

  it('keeps what is heard live in the chats it does not fetch', async () => {
    const f = fake({ dialogs: [group(20), quiz(9)], history: { [GROUP]: said(18, 20) } });
    const { c, clock, messages, seen } = make(f, {
      seen: { [GROUP]: 17, [PRIVATE_ID]: 9 },
      readers: [{ reads: [GROUP] }],
    });
    // Heard as it connects, before it knows which chats it fetches.
    const dialogs = f.client.getDialogs;
    f.client.getDialogs = async (p) => {
      await f.deliver(raw({ id: 10, chatId: { toString: () => PRIVATE_ID }, isPrivate: true }));
      await f.deliver(raw({ id: 19 }));
      return dialogs(p);
    };
    c.start();
    await settle(clock);
    expect(seen()).toEqual({ [GROUP]: 20, [PRIVATE_ID]: 10 });
    expect(messages.map((m) => m.id)).toEqual(['10', '19', '18', '20']);
    await f.deliver(raw({ id: 11, chatId: { toString: () => PRIVATE_ID }, isPrivate: true }));
    await f.deliver(raw({ id: 21 }));
    await f.deliver(raw({ id: 4, chatId: undefined }));
    expect(seen()).toEqual({ [GROUP]: 21, [PRIVATE_ID]: 11 });
  });

  it('skips service messages, and drops one whose sender cannot be fetched', async () => {
    const service = { ...raw({ id: 17 }), message: undefined } as unknown as RawMessage;
    const broken = raw({ id: 18, getSender: () => Promise.reject(new Error('gone')) });
    const f = fake({
      dialogs: [group(19)],
      history: { [GROUP]: [service, broken, ...said(19, 19)] },
    });
    const { c, clock, messages, logs } = make(f, {
      seen: { [GROUP]: 16 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock);
    expect(messages.map((m) => m.id)).toEqual(['19']);
    expect(logs).toContain('message 18 dropped: Error: gone');
  });

  it('logs a chat whose history fails, and goes on with the next', async () => {
    const f = fake({
      dialogs: [group(20), quiz(9)],
      history: { [GROUP]: said(19, 20), '@Quiz_bot': said(9, 9, PRIVATE_ID) },
      historyFails: [new Error('CHANNEL_PRIVATE')],
    });
    const { c, clock, messages, logs, seen } = make(f, {
      seen: { [GROUP]: 18, [PRIVATE_ID]: 8 },
      readers: [{ reads: '*' }],
    });
    c.start();
    await settle(clock);
    expect(logs).toContain(`catch-up of ${GROUP} failed: Error: CHANNEL_PRIVATE`);
    expect(messages.map((m) => m.chat)).toEqual(['@Quiz_bot']);
    expect(seen()).toEqual({ [GROUP]: 18, [PRIVATE_ID]: 9 });
  });

  it('ends when stopped, keeping what was heard live', async () => {
    const f = fake({
      dialogs: [group(1500)],
      history: { [GROUP]: said(2, 1500) },
    });
    const { c, clock, messages, seen } = make(f, {
      seen: { [GROUP]: 1 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock, 3);
    await f.deliver(raw({ id: 1501 }));
    await c.stop();
    await settle(clock);
    expect(history(f).length).toBeLessThan(4);
    expect(messages.map((m) => m.id)).toEqual(['1501']);
    expect(seen()).toEqual({ [GROUP]: 1501 });
  });

  it('ends when stopped while it delivers', async () => {
    const f = fake({ dialogs: [group(20)], history: { [GROUP]: said(18, 20) } });
    const { c, clock, messages } = make(f, {
      seen: { [GROUP]: 17 },
      readers: [{ reads: [GROUP] }],
    });
    c.onMessage(() => void c.stop());
    c.start();
    await settle(clock);
    expect(messages.map((m) => m.id)).toEqual(['18']);
  });

  it('releases what it held when the start fails, and holds again at the retry', async () => {
    const f = fake({ dialogs: [group(20)], history: { [GROUP]: said(18, 20) } });
    let fail = true;
    const me = f.client.getMe;
    f.client.getMe = () => (fail ? ((fail = false), Promise.reject(new Error('x'))) : me());
    const { c, clock, messages, seen } = make(f, {
      seen: { [GROUP]: 17 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await flush();
    await f.deliver(raw({ id: 21 }));
    expect(seen()).toEqual({ [GROUP]: 21 });
    clock.advance(RETRY_MS);
    await settle(clock);
    expect(history(f)).toEqual([]);
    expect(messages.map((m) => m.id)).toEqual(['21']);
  });
});
