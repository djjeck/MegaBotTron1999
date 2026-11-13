import { FloodWait, type Inbound, type ReadFilter, VirtualClock } from '@megabottron1999/core';
import { type UserAuthParams } from 'telegram/client/auth.js';
import { type StringSession } from 'telegram/sessions/index.js';
import { describe, expect, it } from 'vitest';
import {
  type Ask,
  CATCH_UP_CAP,
  CATCH_UP_PAUSE_MS,
  CATCH_UP_RETRY_MAX_MS,
  createTelegramClient,
  DIALOGS_TTL_MS,
  type GramClient,
  LAST_SEEN_DOC,
  login,
  type LoginClient,
  type RawDialog,
  type RawMessage,
  RETRY_MS,
  SEEN_ABOVE_DOC,
  SURFACES_LIMIT,
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
    send?: () => Promise<{ id: number; chatId?: { toString(): string } }>;
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
    for (const [i, sender] of [undefined, null, {}, { username: null }].entries())
      await f.deliver(raw({ id: i + 1, sender }));
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

  /** A moment just after the fixtures' latest message. */
  const NOW = 1_793_000_300_000;
  function make(f: ReturnType<typeof fake>, o: { chats?: string[] } = {}) {
    const clock = new VirtualClock(NOW);
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

  it('lists its surfaces active this week, latest first, and searches all of them', async () => {
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
    // Without a search: those with a message this week; News, with none, is left out.
    expect(await c.surfaces()).toEqual([
      { id: '@Quiz_bot', title: 'Quiz Bot', kind: 'bot', lastActive: 1_793_000_200_000 },
      { id: GROUP, title: 'The Lobby', kind: 'group', lastActive: 1_793_000_100_000 },
      { id: '5000002', title: '5000002', kind: 'private', lastActive: 1_793_000_100_000 },
    ]);
    // Fetched whole, never with a limit (which would put the pinned chats first).
    expect(f.calls.filter((x) => x.startsWith('dialogs '))).toEqual([]);
    expect((await c.surfaces({ search: 'news' })).map((x) => x.id)).toEqual(['-1004']);
    expect((await c.surfaces({ search: ' lobby ', limit: 5 })).map((x) => x.id)).toEqual([GROUP]);
    expect((await c.surfaces({ search: 'quiz' })).map((x) => x.id)).toEqual(['@Quiz_bot']);
    expect(await c.surfaces({ limit: 1 })).toHaveLength(1);
  });

  it('given chats, lists the chats it does not monitor too, named as they would be given', async () => {
    const lottery = dialog({
      id: { toString: () => '-1005' },
      title: 'Lottery Announcements',
      date: 1_793_000_050,
      isGroup: false,
      isChannel: true,
    });
    const nobody = dialog({
      id: { toString: () => '5000003' },
      title: 'Bob',
      date: 1_793_000_010,
      isUser: true,
      isGroup: false,
      entity: {},
    });
    const f = fake({ dialogs: [dialog({}), quiz, lottery, nobody] });
    const { c, clock } = make(f, { chats: ['@quiz_bot'] });
    c.start();
    await flush();
    expect((await c.surfaces()).map((x) => x.id)).toEqual(['@quiz_bot', GROUP, '-1005', '5000003']);
    clock.advance(DIALOGS_TTL_MS);
    expect(await c.surfaces({ search: 'LOTTERY' })).toEqual([
      {
        id: '-1005',
        title: 'Lottery Announcements',
        kind: 'channel',
        lastActive: 1_793_000_050_000,
      },
    ]);
    expect((await c.surfaces({ search: 'bob' })).map((x) => x.id)).toEqual(['5000003']);
    // The lists share one fetch of every chat, until it is `DIALOGS_TTL_MS` old.
    const fetches = (): number => f.calls.filter((x) => x === 'dialogs').length;
    const before = fetches();
    await c.surfaces();
    expect(fetches()).toBe(before);
    clock.advance(DIALOGS_TTL_MS);
    expect((await c.surfaces({ search: 'lobby' })).map((x) => x.id)).toEqual([GROUP]);
    expect(fetches()).toBe(before + 1);
    // Still monitors only its chats: the others are listed, not read.
    expect(c.send(GROUP, 'hi')).toBe(false);
  });

  it('leaves the archived and the inactive out of its list, but not of a search', async () => {
    const DAY = 86_400;
    /** The archive's folder id, as GramJS gives it. */
    const ARCHIVE = 1;
    const at = (daysAgo: number): number => NOW / 1000 - daysAgo * DAY;
    const chat = (id: string, title: string, date: number, over: Partial<RawDialog> = {}) =>
      dialog({ id: { toString: () => id }, title, date, ...over });
    // Pinned first, as Telegram returns them: old ones, then the recent ones.
    const f = fake({
      dialogs: [
        chat('-1001', 'Pinned Old', at(90)),
        chat('-1002', 'Watched Old', at(60)),
        chat('-1003', 'Archived', at(1), { folderId: ARCHIVE }),
        chat('-1004', 'Recent', at(1)),
        chat('-1005', 'Edge Of The Week', at(7)),
        chat('-1006', 'Just Too Old', at(7) - 1),
        ...Array.from({ length: 60 }, (_, i) => chat(`-2${i}`, `Busy ${i}`, at(2) + i)),
      ],
    });
    const { c } = make(f, { chats: ['-1002'] });
    c.start();
    await flush();
    const listed = (await c.surfaces()).map((x) => x.title);
    // The cap applies after the filter: 50 of the 63 active or monitored, latest first.
    expect(listed).toHaveLength(SURFACES_LIMIT);
    expect(listed.slice(0, 2)).toEqual(['Recent', 'Busy 59']);
    const all = (await c.surfaces({ limit: 100 })).map((x) => x.title);
    expect(all).toHaveLength(63);
    expect(all.slice(-2)).toEqual(['Edge Of The Week', 'Watched Old']);
    expect(all).not.toContain('Pinned Old');
    expect(all).not.toContain('Archived');
    expect(all).not.toContain('Just Too Old');
    // A search finds any of them, the archived and the inactive too.
    expect((await c.surfaces({ search: 'old' })).map((x) => x.title)).toEqual([
      'Just Too Old',
      'Watched Old',
      'Pinned Old',
    ]);
    expect((await c.surfaces({ search: 'archived' })).map((x) => x.title)).toEqual(['Archived']);
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
      readers?: ReadFilter[] | (() => ReadFilter[]) | undefined;
      /** The store's documents, kept from a run before. */
      docs?: Map<string, unknown>;
    } = {}
  ) {
    const clock = new VirtualClock(0);
    const messages: Inbound[] = [];
    const logs: string[] = [];
    const warnings: string[] = [];
    const records: [string, Record<string, unknown>][] = [];
    const docs =
      o.docs ?? new Map<string, unknown>(o.seen === undefined ? [] : [[LAST_SEEN_DOC, o.seen]]);
    const readers = o.readers;
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
      ...(readers === undefined
        ? {}
        : { readers: typeof readers === 'function' ? readers : () => readers }),
    });
    c.onMessage((m) => messages.push(m));
    const seen = () => docs.get(LAST_SEEN_DOC);
    const above = () => docs.get(SEEN_ABOVE_DOC);
    return { c, clock, messages, logs, warnings, records, seen, above, docs };
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

  it('fetches only the chats its readers read, all monitored ones for *, skipping the others', async () => {
    const dialogs = [group(20), quiz(9)];
    const hist = { [GROUP]: said(18, 20), '@Quiz_bot': said(7, 9, PRIVATE_ID) };
    const seen = { [GROUP]: 17, [PRIVATE_ID]: 6 };
    const f1 = fake({ dialogs, history: hist });
    const one = make(f1, { seen, readers: [{ reads: ['@quiz_bot'] }] });
    one.c.start();
    await settle(one.clock);
    expect(history(f1)).toEqual([`history @Quiz_bot <10 >6 100`]);
    expect(one.messages.map((m) => m.chat)).toEqual(['@Quiz_bot', '@Quiz_bot', '@Quiz_bot']);
    // The group no reader reads: its gap skipped, not kept for later (D66).
    expect(one.seen()).toEqual({ [GROUP]: 20, [PRIVATE_ID]: 9 });

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
    expect(none.messages).toEqual([]);
    expect(none.seen()).toEqual({ [GROUP]: 20, [PRIVATE_ID]: 9 });
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
    // Nothing can be older than the last page: no request for more.
    expect(history(f).at(-1)).toBe(`history ${GROUP} <101 >0 100`);
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

  it('fetches again a chat whose history fails, later, live messages not moving past its gap', async () => {
    const f = fake({
      dialogs: [group(20), quiz(9)],
      history: { [GROUP]: said(19, 20), '@Quiz_bot': said(9, 9, PRIVATE_ID) },
      historyFails: [new Error('CHANNEL_PRIVATE')],
    });
    const { c, clock, messages, logs, seen, above } = make(f, {
      seen: { [GROUP]: 18, [PRIVATE_ID]: 8 },
      readers: [{ reads: '*' }],
    });
    c.start();
    await settle(clock, 5);
    expect(logs).toContain(`catch-up of ${GROUP} failed, again in 60 s: Error: CHANNEL_PRIVATE`);
    expect(messages.map((m) => m.chat)).toEqual(['@Quiz_bot']);
    // Heard live meanwhile: kept above the gap, which stays open.
    await f.deliver(raw({ id: 21, message: 'm21' }));
    expect(seen()).toEqual({ [GROUP]: 18, [PRIVATE_ID]: 9 });
    expect(above()).toEqual({ [GROUP]: [[21, 21]] });
    clock.advance(RETRY_MS);
    await settle(clock);
    expect(messages.map((m) => [m.id, m.missed === true])).toEqual([
      ['9', true],
      ['21', false],
      ['19', true],
      ['20', true],
    ]);
    expect(seen()).toEqual({ [GROUP]: 21, [PRIVATE_ID]: 9 });
    expect(above()).toEqual({});
  });

  it('waits at most an hour between two tries of a chat that keeps failing', async () => {
    const fails = Array.from({ length: 9 }, () => new Error('CHANNEL_PRIVATE'));
    const f = fake({ dialogs: [group(20)], history: {}, historyFails: fails });
    const { c, clock, logs } = make(f, { seen: { [GROUP]: 18 }, readers: [{ reads: [GROUP] }] });
    c.start();
    for (let i = 0; i < 9; i++) {
      await settle(clock, 2);
      clock.advance(CATCH_UP_RETRY_MAX_MS);
    }
    expect(logs.filter((l) => l.includes('failed, again in')).map((l) => l.split(' ')[6])).toEqual([
      '60',
      '120',
      '240',
      '480',
      '960',
      '1920',
      '3600',
      '3600',
      '3600',
    ]);
    await c.stop();
  });

  it('resumes a catch-up stopped while it delivers, delivering none twice', async () => {
    const f = fake({ dialogs: [group(20)], history: { [GROUP]: said(11, 20) } });
    const docs = new Map<string, unknown>([[LAST_SEEN_DOC, { [GROUP]: 10 }]]);
    const first = make(f, { readers: [{ reads: [GROUP] }], docs });
    first.c.onMessage((m) => {
      if (m.id === '13') void first.c.stop();
    });
    first.c.start();
    await settle(first.clock);
    expect(first.messages.map((m) => m.id)).toEqual(['11', '12', '13']);
    expect(first.seen()).toEqual({ [GROUP]: 13 });
    // The next run of the instance, from the store as kept.
    const second = make(f, { readers: [{ reads: [GROUP] }], docs });
    second.c.start();
    await settle(second.clock);
    expect(history(f).at(-1)).toBe(`history ${GROUP} <21 >13 100`);
    expect(second.messages.map((m) => m.id)).toEqual(['14', '15', '16', '17', '18', '19', '20']);
    expect(second.seen()).toEqual({ [GROUP]: 20 });
  });

  it('keeps what was heard live when stopped, and fetches only the gap below it next time', async () => {
    const f = fake({ dialogs: [group(20)], history: { [GROUP]: said(2, 20) } });
    const docs = new Map<string, unknown>([[LAST_SEEN_DOC, { [GROUP]: 1 }]]);
    const first = make(f, { readers: [{ reads: [GROUP] }], docs });
    f.client.getMessages = () => new Promise(() => {});
    first.c.start();
    await settle(first.clock, 3);
    await f.deliver(raw({ id: 21, message: 'm21' }));
    await f.deliver(raw({ id: 22, message: 'm22' }));
    await first.c.stop();
    expect(first.messages.map((m) => m.id)).toEqual(['21', '22']);
    expect(first.seen()).toEqual({ [GROUP]: 1 });
    expect(first.above()).toEqual({ [GROUP]: [[21, 22]] });
    // Down again; said meanwhile: 23 to 25.
    const g = fake({ dialogs: [group(25)], history: { [GROUP]: said(2, 25) } });
    const second = make(g, { readers: [{ reads: [GROUP] }], docs });
    second.c.start();
    await settle(second.clock);
    expect(history(g)).toEqual([`history ${GROUP} <26 >22 100`, `history ${GROUP} <21 >1 100`]);
    expect(second.messages.map((m) => Number(m.id))).toEqual([
      ...Array.from({ length: 19 }, (_, i) => i + 2),
      23,
      24,
      25,
    ]);
    expect(second.seen()).toEqual({ [GROUP]: 25 });
    expect(second.above()).toEqual({});
  });

  it('does not deliver as missed what the account sent itself', async () => {
    const f = fake({
      dialogs: [group(20)],
      send: () => Promise.resolve({ id: 21, chatId: { toString: () => GROUP } }),
    });
    const docs = new Map<string, unknown>([[LAST_SEEN_DOC, { [GROUP]: 20 }]]);
    const first = make(f, { chats: [GROUP, '@Quiz_bot'], readers: [{ reads: [GROUP] }], docs });
    first.c.start();
    await settle(first.clock);
    await f.deliver(raw({ id: 22, out: true, message: 'from the phone' }));
    await first.c.deliver(GROUP, '/play');
    expect(first.seen()).toEqual({ [GROUP]: 22 });
    // Its echo, if Telegram sends one, is delivered once, live.
    await f.deliver(raw({ id: 21, out: true, message: '/play' }));
    await f.deliver(raw({ id: 21, out: true, message: '/play' }));
    expect(first.messages.map((m) => [m.id, m.own])).toEqual([
      ['22', true],
      ['21', true],
    ]);
    await first.c.stop();
    // Sent through a private chat by @username: its id is the message's chat's.
    const sent = await first.c.deliver('@Quiz_bot', 'x').catch((e: unknown) => String(e));
    expect(sent).toEqual({ id: '21' });
    const g = fake({ dialogs: [group(22)], history: { [GROUP]: said(21, 22) } });
    const second = make(g, { readers: [{ reads: [GROUP] }], docs });
    second.c.start();
    await settle(second.clock);
    expect(history(g)).toEqual([]);
    expect(second.messages).toEqual([]);
  });

  it('skips a chat whose last reader stopped before its turn came', async () => {
    const f = fake({
      dialogs: [group(20), quiz(9)],
      history: { [GROUP]: said(19, 20), '@Quiz_bot': said(8, 9, PRIVATE_ID) },
    });
    let readers: ReadFilter[] = [{ reads: '*' }];
    const { c, clock, messages, seen } = make(f, {
      seen: { [GROUP]: 18, [PRIVATE_ID]: 7 },
      readers: () => readers,
    });
    // The group is fetched first; as it delivers, the quiz's reader stops.
    c.onMessage(() => {
      readers = [{ reads: [GROUP] }];
    });
    c.start();
    await settle(clock);
    expect(messages.map((m) => m.chat)).toEqual([GROUP, GROUP]);
    expect(history(f)).toEqual([`history ${GROUP} <21 >18 100`]);
    expect(seen()).toEqual({ [GROUP]: 20, [PRIVATE_ID]: 9 });
  });

  it('delivers once a message heard live twice', async () => {
    const f = fake({ dialogs: [group(20)] });
    const { c, clock, messages, seen } = make(f, { seen: { [GROUP]: 20 } });
    c.start();
    await settle(clock);
    await f.deliver(raw({ id: 21 }));
    await f.deliver(raw({ id: 21 }));
    // A chat it did not list at the connection: its live ids start at the first heard.
    await f.deliver(raw({ id: 5, chatId: { toString: () => '-100999' } }));
    await f.deliver(raw({ id: 6, chatId: { toString: () => '-100999' } }));
    expect(messages.map((m) => m.id)).toEqual(['21', '5', '6']);
    expect(seen()).toEqual({ [GROUP]: 21, '-100999': 6 });
  });

  it('accounts for a message whose sender cannot be fetched, dropped live', async () => {
    const f = fake({ dialogs: [group(20)] });
    const { c, clock, seen } = make(f, { seen: { [GROUP]: 20 } });
    c.start();
    await settle(clock);
    await f.deliver(raw({ id: 21, getSender: () => Promise.reject(new Error('gone')) }));
    expect(seen()).toEqual({ [GROUP]: 21 });
  });

  it('ends when stopped while it fetches, and ignores what comes after', async () => {
    const f = fake({ dialogs: [group(1500)], history: { [GROUP]: said(2, 1500) } });
    const { c, clock, messages, seen } = make(f, {
      seen: { [GROUP]: 1 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock, 3);
    await c.stop();
    await settle(clock);
    await f.deliver(raw({ id: 1501 }));
    expect(history(f).length).toBeLessThan(4);
    expect(messages).toEqual([]);
    expect(seen()).toEqual({ [GROUP]: 1 });
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

  it('keeps what is heard while the start fails, and catches up at the retry', async () => {
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
    expect(seen()).toEqual({ [GROUP]: 17 });
    clock.advance(RETRY_MS);
    await settle(clock);
    expect(history(f)).toEqual([`history ${GROUP} <21 >17 100`]);
    expect(messages.map((m) => m.id)).toEqual(['21', '18', '19', '20']);
    expect(seen()).toEqual({ [GROUP]: 21 });
  });

  it('stops at the cap across the gaps around what was heard live, skipping the older', async () => {
    const f = fake({ dialogs: [group(1600)], history: { [GROUP]: said(2, 1600) } });
    const docs = new Map<string, unknown>([
      [LAST_SEEN_DOC, { [GROUP]: 1 }],
      [SEEN_ABOVE_DOC, { [GROUP]: [[1001, 1100]] }],
    ]);
    const { c, clock, messages, warnings, seen } = make(f, {
      readers: [{ reads: [GROUP] }],
      docs,
    });
    c.start();
    await settle(clock, 60);
    expect(history(f).slice(0, 6)).toEqual([
      ...Array.from({ length: 5 }, (_, i) => `history ${GROUP} <${1601 - i * 100} >1100 100`),
      `history ${GROUP} <1101 >1100 100`,
    ]);
    expect(history(f).at(-1)).toBe(`history ${GROUP} <501 >1 1`);
    expect(messages).toHaveLength(1000);
    expect(messages[0]?.id).toBe('501');
    expect(warnings).toHaveLength(1);
    expect(seen()).toEqual({ [GROUP]: 1600 });
  });
});
