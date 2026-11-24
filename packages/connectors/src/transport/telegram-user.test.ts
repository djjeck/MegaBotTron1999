import {
  type Deletion,
  FloodWait,
  type Inbound,
  type ReadFilter,
  VirtualClock,
} from '@megabottron1999/core';
import { Api } from 'telegram';
import { DeletedMessage } from 'telegram/events/DeletedMessage.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { type NewMessage } from 'telegram/events/index.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { describe, expect, it } from 'vitest';
import { RAW_LOG_DOC, RAW_LOG_FLUSH_MS, RAW_LOG_MS } from './raw-log.ts';
import {
  CATCH_UP_CAP,
  CATCH_UP_PAUSE_MS,
  CATCH_UP_RETRY_MAX_MS,
  createTelegramClient,
  DIALOGS_TTL_MS,
  GAP_LOOK_MS,
  type GramClient,
  LAST_SEEN_DOC,
  LOOK_AFTER_SEND_MS,
  LOOK_LIMIT,
  mediaOf,
  photoId,
  type RawDeletion,
  type RawDialog,
  type RawMessage,
  RETRY_MS,
  SEEN_ABOVE_DOC,
  SURFACES_LIMIT,
  TelegramUserConnector,
} from './telegram-user.ts';

const GROUP = '-1001000000001';
/** When the test's messages were said, in ms. */
const SAID = 1_793_000_000_000;

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
    /** Each message's file, by its id: its bytes, or the download's error. */
    files?: Record<number, Uint8Array | string | Error>;
    /** A media message's send, its answer. */
    sendFile?: () => Promise<{ id: number; media?: unknown }>;
  } = {}
) {
  const calls: string[] = [];
  const sent: { entity: unknown; message: string }[] = [];
  const media: { entity: unknown; params: Parameters<GramClient['sendFile']>[1] }[] = [];
  let failures = o.failConnect ?? 0;
  let handler: ((event: { message: RawMessage }) => Promise<void>) | undefined;
  let editHandler: ((event: { message: RawMessage }) => Promise<void>) | undefined;
  let deleteHandler: ((event: RawDeletion) => Promise<void>) | undefined;
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
    uploadFile: ({ file }) => {
      calls.push(`upload ${file.name} ${file.size}`);
      return Promise.resolve({ uploaded: file.name } as never);
    },
    sendFile: (entity, params) => {
      media.push({ entity, params });
      return (
        o.sendFile?.() ??
        Promise.resolve({
          id: 98,
          chatId: { toString: () => GROUP },
          media: { photo: { id: 7, accessHash: -8, fileReference: new Uint8Array([1, 2, 255]) } },
        })
      );
    },
    addEventHandler: (h: (event: never) => Promise<void>, builder: NewMessage | DeletedMessage) => {
      if (builder instanceof DeletedMessage) deleteHandler = h as typeof deleteHandler;
      else if (builder instanceof EditedMessage) editHandler = h as typeof editHandler;
      else handler = h as typeof handler;
      handlers++;
    },
    getMessages: (entity, params) => {
      const peer = String((entity as { peer: unknown }).peer);
      if ('ids' in params) {
        calls.push(`messages ${peer} ${params.ids.join(',')}`);
        const all = o.history?.[peer] ?? [];
        return Promise.resolve(
          params.ids.map((id) => all.find((m) => m.id === id)) as unknown as RawMessage[]
        );
      }
      const { limit, offsetId, minId } = params;
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
    downloadMedia: (message: RawMessage) => {
      calls.push(`download ${message.id}`);
      const file = o.files?.[message.id];
      return file instanceof Error ? Promise.reject(file) : Promise.resolve(file);
    },
  };
  const deliver = (message: RawMessage) => handler?.({ message }) ?? Promise.resolve();
  const edit = (message: RawMessage) => editHandler?.({ message }) ?? Promise.resolve();
  const drop = (event: RawDeletion) => deleteHandler?.(event) ?? Promise.resolve();
  return { client, calls, sent, media, deliver, edit, drop, handlers: () => handlers };
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

/** A connector's options on a fake client, unstarted. */
const optionsOf = (f: ReturnType<typeof fake>) => ({
  account: 'telegram:alice',
  client: f.client,
  clock: new VirtualClock(0),
  log: () => {},
});

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
  it('logs out on Telegram, then needs a login; not before it is connected (D116)', async () => {
    const { c, f } = await connector();
    const sent: unknown[] = [];
    await expect(new TelegramUserConnector({ ...optionsOf(f) }).logOut()).rejects.toThrow(
      'not connected'
    );
    await expect(c.logOut()).rejects.toThrow('not connected');
    f.client.invoke = (r) => (sent.push(r), Promise.resolve(true));
    await c.logOut();
    expect(sent).toHaveLength(1);
    expect(c.status()).toEqual({ state: 'closed', phase: 'needs login', detail: 'logged out' });
  });

  it('connects, fills the entity cache, then resolves its chats, once', async () => {
    const { c, f, logs } = await connector();
    expect(f.calls).toEqual(['connect', 'dialogs', `entity ${GROUP}`, 'entity @Quiz_bot', 'me']);
    expect(f.handlers()).toBe(3);
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
    expect(f.handlers()).toBe(3);
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
        senderBot: false,
        text: 'Troppo presto',
        time: 1_793_000_000_000,
        id: '1',
        replyTo: '5',
        playback: false,
        own: true,
        buttons: [],
      },
      // A private chat, as the network says (D90): its name may be an id.
      expect.objectContaining({ chat: '@Quiz_bot', id: '5', sender: 'quiz_bot', private: true }),
    ]);
  });

  it('has no sender for one without a username', async () => {
    const { f, messages } = await connector();
    for (const [i, sender] of [undefined, null, {}, { username: null }].entries())
      await f.deliver(raw({ id: i + 1, sender }));
    expect(messages.map((m) => m.sender)).toEqual(['', '', '', '']);
  });

  it('gives the sender’s display name, a channel’s title, and whether it is a bot, where GramJS has them (D159)', async () => {
    const { f, messages } = await connector();
    const senders = [
      { firstName: 'Ada', lastName: 'Lovelace' },
      { firstName: 'Ada', lastName: null },
      { username: 'quest_bot', firstName: 'Quest', bot: true },
      { title: 'The Lobby' },
      { firstName: '' },
      undefined,
    ];
    for (const [i, sender] of senders.entries()) await f.deliver(raw({ id: i + 1, sender }));
    expect(messages.map((m) => [m.senderName, m.senderBot])).toEqual([
      ['Ada Lovelace', false],
      ['Ada', false],
      ['Quest', true],
      ['The Lobby', false],
      [undefined, false],
      [undefined, undefined],
    ]);
  });

  it('logs and drops a message whose sender cannot be fetched', async () => {
    const { f, messages, logs } = await connector();
    await f.deliver(raw({ id: 4, getSender: () => Promise.reject(new Error('flood')) }));
    expect(messages).toEqual([]);
    expect(logs.at(-1)).toBe('message 4 dropped: Error: flood');
  });

  describe('a file (D82)', () => {
    const LIST = 'Satchel\n- 2 x Tin Whistle\n- 5 x Glass Marble\n';
    const textFile = (name = 'satchel.txt', mimeType = 'text/plain', size: unknown = 45) => ({
      mimeType,
      size: { toString: () => String(size) },
      attributes: [
        { className: 'DocumentAttributeImageSize' },
        null,
        { className: 'DocumentAttributeFilename', fileName: name },
      ],
    });

    it('downloads a text file, and passes it on with its caption', async () => {
      const f = fake({ files: { 8: new TextEncoder().encode(LIST) } });
      const { messages } = await connector(f);
      await f.deliver(raw({ id: 8, message: 'Your satchel', document: textFile() }));
      expect(f.calls.at(-1)).toBe('download 8');
      expect(messages).toEqual([
        expect.objectContaining({
          id: '8',
          text: 'Your satchel',
          document: { name: 'satchel.txt', mime: 'text/plain', size: 45, text: LIST },
        }),
      ]);
    });

    it('describes any other file, without downloading it', async () => {
      const f = fake();
      const { messages } = await connector(f);
      await f.deliver(
        raw({ id: 8, message: '', document: { mimeType: 'image/webp', size: 900, attributes: [] } })
      );
      await f.deliver(
        raw({ id: 9, message: '', document: textFile('big.txt', 'text/plain', 1e7) })
      );
      await f.deliver(raw({ id: 10, message: '', document: {} }));
      expect(f.calls.filter((x) => x.startsWith('download'))).toEqual([]);
      expect(messages.map((m) => m.document)).toEqual([
        { name: '', mime: 'image/webp', size: 900, skipped: 'type' },
        { name: 'big.txt', mime: 'text/plain', size: 1e7, skipped: 'size' },
        { name: '', mime: '', size: 0, skipped: 'type' },
      ]);
    });

    it('passes the message on when its download fails, or gives no bytes, and warns', async () => {
      const f = fake({ files: { 8: new Error('FILE_REFERENCE_EXPIRED'), 9: '/tmp/saved' } });
      const { messages, logs } = await connector(f);
      await f.deliver(raw({ id: 8, message: 'Your satchel', document: textFile() }));
      await f.deliver(raw({ id: 9, message: 'Your satchel', document: textFile() }));
      expect(messages.map((m) => [m.text, m.document?.skipped])).toEqual([
        ['Your satchel', 'failed'],
        ['Your satchel', 'failed'],
      ]);
      expect(logs.at(-1)).toBe(
        'message 8: download of satchel.txt failed: Error: FILE_REFERENCE_EXPIRED'
      );
    });
  });

  it('says what a message carries besides its text, a sticker with its emoji (D161)', async () => {
    const f = fake();
    const { messages } = await connector(f);
    const sticker = {
      mimeType: 'image/webp',
      size: 900,
      attributes: [
        { className: 'DocumentAttributeFilename', fileName: 'sticker.webp' },
        { className: 'DocumentAttributeSticker', alt: '😂' },
      ],
    };
    await f.deliver(raw({ id: 8, message: '', document: sticker }));
    await f.deliver(raw({ id: 9, message: 'hi' }));
    expect(messages.map((m) => [m.text, m.media, m.document?.name])).toEqual([
      ['', { kind: 'sticker', emoji: '😂' }, 'sticker.webp'],
      ['hi', undefined, undefined],
    ]);
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

  it('sends a photo with sendFile: uploaded or by its id, its caption, in reply (D150)', async () => {
    const { c, f } = await connector();
    const bytes = { data: new Uint8Array([1, 2, 3]), mime: 'image/png' };
    const id = `7:-8:${Buffer.from([1, 2, 255]).toString('base64url')}`;
    await expect(
      c.deliverPhoto(GROUP, bytes, { caption: '**A** card', format: 'markdown', replyTo: '41' })
    ).resolves.toEqual({ id: '98', photo: id });
    expect(f.calls).toContain('upload photo.png 3');
    const [first] = f.media;
    expect(first?.entity).toEqual({ peer: Number(GROUP) });
    expect(first?.params).toMatchObject({
      caption: '<b>A</b> card',
      parseMode: 'html',
      replyTo: 41,
    });
    expect(first?.params.file).toBeInstanceOf(Api.InputMediaUploadedPhoto);
    // Again by the id it gave, a plain caption as written, in no reply.
    await c.deliverPhoto('@quiz_bot', id, { caption: '**as is**' });
    const again = f.media.at(-1);
    expect(again?.params).toEqual({
      file: expect.any(Api.InputMediaPhoto) as unknown,
      caption: '**as is**',
      parseMode: false,
    });
    const photo = (again?.params.file as Api.InputMediaPhoto).id as Api.InputPhoto;
    expect([String(photo.id), String(photo.accessHash), [...photo.fileReference]]).toEqual([
      '7',
      '-8',
      [1, 2, 255],
    ]);
    // No caption: an empty one, and no id of a message with no photo.
    const bare = await connector(fake({ sendFile: () => Promise.resolve({ id: 5 }) }));
    await expect(bare.c.deliverPhoto(GROUP, id)).resolves.toEqual({ id: '5' });
    expect(bare.f.media[0]?.params).toMatchObject({ caption: '', parseMode: false });
    await expect(c.deliverPhoto(GROUP, 'photo-101')).rejects.toThrow(
      'photo-101 is not the id of a photo telegram:alice sent'
    );
    await expect(c.deliverPhoto('-100999', bytes)).rejects.toThrow(
      '-100999 is not a chat of telegram:alice'
    );
    const flood = Object.assign(new Error('A wait of 30 seconds is required'), { seconds: 30 });
    const slow = await connector(fake({ sendFile: () => Promise.reject(flood) }));
    await expect(slow.c.deliverPhoto(GROUP, id)).rejects.toBeInstanceOf(FloodWait);
    const gone = await connector(
      fake({ sendFile: () => Promise.reject(new Error('FILE_REFERENCE_EXPIRED')) })
    );
    await expect(gone.c.deliverPhoto(GROUP, id)).rejects.toThrow('FILE_REFERENCE_EXPIRED');
  });

  it('reads the id of a photo only from a message that carries one (D150)', () => {
    expect(photoId(undefined)).toBeUndefined();
    expect(photoId({})).toBeUndefined();
    expect(photoId({ photo: { id: 1, accessHash: 2 } })).toBeUndefined();
    expect(photoId({ photo: { id: 1, accessHash: 2, fileReference: new Uint8Array([]) } })).toBe(
      '1:2:'
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
    expect(messages.map((m) => m.private)).toEqual([undefined, true, true]);
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
        // The account's own chat (Saved Messages): never listed, nor found by a search.
        dialog({
          id: { toString: () => '5000009' },
          title: 'Saved Messages',
          isUser: true,
          isGroup: false,
          entity: { username: 'alice', self: true },
        }),
      ],
    });
    const { c } = make(f);
    await expect(c.surfaces()).rejects.toThrow('not connected');
    c.start();
    await flush();
    // Without a search: those with a message this week; News, with none, is left out.
    expect(await c.surfaces()).toEqual([
      {
        id: '@Quiz_bot',
        title: 'Quiz Bot',
        kind: 'bot',
        aliases: ['5000001'],
        lastActive: 1_793_000_200_000,
      },
      { id: GROUP, title: 'The Lobby', kind: 'group', lastActive: 1_793_000_100_000 },
      { id: '5000002', title: '5000002', kind: 'private', lastActive: 1_793_000_100_000 },
    ]);
    // Fetched whole, never with a limit (which would put the pinned chats first).
    expect(f.calls.filter((x) => x.startsWith('dialogs '))).toEqual([]);
    expect((await c.surfaces({ search: 'news' })).map((x) => x.id)).toEqual(['-1004']);
    expect((await c.surfaces({ search: ' lobby ', limit: 5 })).map((x) => x.id)).toEqual([GROUP]);
    expect((await c.surfaces({ search: 'quiz' })).map((x) => x.id)).toEqual(['@Quiz_bot']);
    expect(await c.surfaces({ search: 'saved' })).toEqual([]);
    expect(await c.surfaces({ search: '5000009' })).toEqual([]);
    // By any of its names: a bot's id finds it by its @username (D96).
    expect((await c.surfaces({ search: '5000001' })).map((x) => x.id)).toEqual(['@Quiz_bot']);
    expect(await c.surfaces({ limit: 1 })).toHaveLength(1);
    expect(c.chatTitle('5000001')).toBe('Quiz Bot');
    expect(c.chatTitle('@nobody_here')).toBeUndefined();
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

describe('the surfaces, on GramJS’s own list of chats', () => {
  // GramJS's `getDialogs` itself, on a made-up answer of Telegram's: its `ignoreMigrated` kept
  // the basic groups alone (it tests that `migratedTo` exists, which only they have), and every
  // user, bot, channel and supergroup was missing from the list and the search.
  it('finds a chat of every kind, archived or not, but a migrated group', async () => {
    const big = (n: number) => returnBigInt(n);
    const photo = new Api.ChatPhotoEmpty();
    const users = [
      new Api.User({ id: big(11), firstName: 'Alice', accessHash: big(1) }),
      new Api.User({
        id: big(12),
        firstName: 'Quest',
        bot: true,
        username: 'QuestBot',
        accessHash: big(2),
      }),
    ];
    const chats = [
      new Api.Chat({
        id: big(21),
        title: 'Lobby',
        participantsCount: 3,
        date: 1,
        version: 1,
        photo,
      }),
      new Api.Chat({
        id: big(22),
        title: 'Guild (old)',
        participantsCount: 3,
        date: 1,
        version: 1,
        photo,
        migratedTo: new Api.InputChannel({ channelId: big(32), accessHash: big(4) }),
      }),
      new Api.Channel({
        id: big(31),
        title: 'Loot News',
        broadcast: true,
        date: 1,
        photo,
        accessHash: big(3),
      }),
      new Api.Channel({
        id: big(32),
        title: 'Guild',
        megagroup: true,
        date: 1,
        photo,
        accessHash: big(4),
      }),
    ];
    const peers = [
      new Api.PeerUser({ userId: big(11) }),
      new Api.PeerUser({ userId: big(12) }),
      new Api.PeerChat({ chatId: big(21) }),
      new Api.PeerChat({ chatId: big(22) }),
      new Api.PeerChannel({ channelId: big(31) }),
      new Api.PeerChannel({ channelId: big(32) }),
    ];
    const at = 1_793_000_000;
    const answer = new Api.messages.Dialogs({
      dialogs: peers.map(
        (peer, i) =>
          new Api.Dialog({
            peer,
            topMessage: i + 1,
            readInboxMaxId: 0,
            readOutboxMaxId: 0,
            unreadCount: 0,
            unreadMentionsCount: 0,
            unreadReactionsCount: 0,
            notifySettings: new Api.PeerNotifySettings({}),
            // The archive's, but for Alice: an owner's folders are filters over these two.
            ...(i === 0 ? {} : { folderId: 1 }),
          })
      ),
      messages: peers.map(
        (peerId, i) => new Api.Message({ id: i + 1, peerId, date: at - i, message: 'hi' })
      ),
      chats,
      users,
    });
    const gram = createTelegramClient({ apiId: 1, apiHash: 'x', session: '' });
    gram.invoke = (() => Promise.resolve(answer)) as unknown as typeof gram.invoke;
    const f = fake();
    f.client.getDialogs = (p) => gram.getDialogs(p) as unknown as Promise<Iterable<RawDialog>>;
    const clock = new VirtualClock(at * 1000);
    const c = new TelegramUserConnector({
      account: 'telegram:alice',
      client: f.client,
      clock,
      log: () => {},
    });
    c.start();
    // GramJS's own awaits, a few turns of the loop.
    for (let i = 0; i < 10; i++) await flush();
    const found = [];
    for (const search of ['alice', 'quest', 'lobby', 'loot', 'guild'])
      found.push(...(await c.surfaces({ search })).map((x) => [x.id, x.title, x.kind]));
    expect(found).toEqual([
      ['11', 'Alice', 'private'],
      ['@QuestBot', 'Quest', 'bot'],
      ['-21', 'Lobby', 'group'],
      ['-10031', 'Loot News', 'channel'],
      ['-10032', 'Guild', 'group'],
    ]);
    // Without a search, the archived are left out.
    expect((await c.surfaces()).map((x) => x.title)).toEqual(['Alice']);
    await c.stop();
  });
});

describe('createTelegramClient', () => {
  it('builds a client without connecting', () => {
    const client = createTelegramClient({ apiId: 1, apiHash: '0'.repeat(32), session: '' });
    expect(client.connected).toBeFalsy();
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
      /** When it runs: an hour after the messages were said, by default. */
      at?: number;
      liveGraceMs?: number;
    } = {}
  ) {
    const clock = new VirtualClock(o.at ?? SAID + 3_600_000);
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
      ...(o.liveGraceMs === undefined ? {} : { liveGraceMs: o.liveGraceMs }),
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

  it('downloads the text file of a missed message, as a live one (D82)', async () => {
    const list = 'Pouch\n- 1 x Brass Key\n';
    const file = {
      mimeType: 'text/plain',
      size: 22,
      attributes: [{ className: 'DocumentAttributeFilename', fileName: 'pouch.txt' }],
    };
    const history = [...said(16, 16), raw({ id: 17, message: 'Your pouch', document: file })];
    const f = fake({
      dialogs: [group(17)],
      history: { [GROUP]: history },
      files: { 17: new TextEncoder().encode(list) },
    });
    const { c, clock, messages } = make(f, {
      chats: [GROUP],
      seen: { [GROUP]: 15 },
      readers: [{ reads: [GROUP] }],
    });
    c.start();
    await settle(clock);
    expect(messages.map((m) => [m.id, m.text, m.missed, m.document])).toEqual([
      ['16', 'm16', true, undefined],
      ['17', 'Your pouch', true, { name: 'pouch.txt', mime: 'text/plain', size: 22, text: list }],
    ]);
  });

  it('delivers a missed message within its grace as news, older as played back (D83)', async () => {
    const at = (id: number, ago: number) =>
      raw({ id, message: `m${id}`, date: (SAID - ago) / 1000 });
    const f = fake({
      dialogs: [group(18)],
      history: { [GROUP]: [at(16, 600_000), at(17, 120_000), at(18, 60_000)] },
    });
    const { c, clock, messages } = make(f, {
      chats: [GROUP],
      seen: { [GROUP]: 15 },
      readers: [{ reads: [GROUP] }],
      at: SAID,
    });
    c.start();
    // The catch-up's pauses: its messages are some seconds older when delivered.
    await settle(clock, 3);
    expect(messages.map((m) => [m.id, m.missed, m.playback])).toEqual([
      ['16', true, true],
      ['17', true, true],
      ['18', true, false],
    ]);
    const g = fake({ dialogs: [group(16)], history: { [GROUP]: [at(16, 600_000)] } });
    const wide = make(g, {
      chats: [GROUP],
      seen: { [GROUP]: 15 },
      readers: [{ reads: [GROUP] }],
      at: SAID,
      liveGraceMs: 3_600_000,
    });
    wide.c.start();
    await settle(wide.clock, 3);
    expect(wide.messages.map((m) => m.playback)).toEqual([false]);
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

  it('passes on an edit, live, to the listeners of edits alone, each edit once (D144)', async () => {
    const { c, f, messages } = await connector();
    const edits: Inbound[] = [];
    c.onEdit((m) => edits.push(m));
    await f.deliver(raw({ id: 4, message: 'Scegli', replyTo: { replyToMsgId: 3 } }));
    const changed = raw({
      id: 4,
      message: 'Scelto',
      replyTo: { replyToMsgId: 3 },
      editDate: 1_793_000_060,
    });
    await f.edit(changed);
    await f.edit(changed);
    await f.edit(raw({ id: 4, message: 'Scelto ancora', editDate: 1_793_000_090 }));
    // Another chat's: not one of its chats.
    await f.edit(raw({ id: 5, chatId: { toString: () => '-100999' }, editDate: 1_793_000_100 }));
    expect(messages.map((m) => m.text)).toEqual(['Scegli']);
    expect(edits).toMatchObject([
      { chat: GROUP, id: '4', text: 'Scelto', replyTo: '3', time: SAID, edited: SAID + 60_000 },
      { id: '4', text: 'Scelto ancora', edited: SAID + 90_000 },
    ]);
    expect(edits[0]).not.toHaveProperty('missed');
  });

  it('passes on a supergroup’s deletions, live, to the listeners of deletions alone; a basic group’s, ids alone, never (D158)', async () => {
    const { c, f, clock, messages } = await connector();
    const lost: Deletion[] = [];
    c.onDelete((d) => lost.push(d));
    clock.advance(5_000);
    // GramJS's PeerChannel: the channel's id unmarked (a BigInteger), its chat `-100<id>`.
    await f.drop({ deletedIds: [4, 5], peer: { channelId: { toString: () => '1000000001' } } });
    // Ids alone (a basic group's, a private chat's): no chat to name.
    await f.drop({ deletedIds: [6] });
    // Another chat's: not one of its chats.
    await f.drop({ deletedIds: [7], peer: { channelId: 999 } });
    await f.drop({ deletedIds: [], peer: { channelId: 1000000001 } });
    expect(messages).toEqual([]);
    expect(lost).toEqual([
      { account: 'telegram:alice', network: 'telegram', chat: GROUP, ids: ['4', '5'], time: 5_000 },
    ]);
    await c.stop();
    await f.drop({ deletedIds: [8], peer: { channelId: 1000000001 } });
    expect(lost).toHaveLength(1);
  });

  it('gives the labels of a message’s inline buttons, row by row, none as none, and as an edit sets them (D145)', async () => {
    const { c, f, messages } = await connector();
    const edits: Inbound[] = [];
    c.onEdit((m) => edits.push(m));
    const page = (left: string, right: string) => ({
      rows: [{ buttons: [{ text: left }, { text: right }] }, { buttons: [] }],
    });
    await f.deliver(raw({ id: 8, message: 'Pagina', replyMarkup: page('🔒', '▶️') }));
    await f.deliver(raw({ id: 9, message: 'Nessun bottone', replyMarkup: { rows: [] } }));
    await f.edit(
      raw({ id: 8, message: 'Pagina dopo', replyMarkup: page('◀️', '🔒'), editDate: 1_793_000_030 })
    );
    // None is said (`[]`): a page without buttons is a whole list, unlike one a connector cannot tell.
    expect(messages.map((m) => m.buttons)).toEqual([[['🔒', '▶️']], []]);
    expect(edits[0]?.buttons).toEqual([['◀️', '🔒']]);
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

describe('a GramJS workaround: the updates it was not pushed, looked for (D147)', () => {
  const group: RawDialog = {
    id: { toString: () => GROUP },
    title: 'The Lobby',
    isGroup: true,
    inputEntity: { peer: GROUP },
    message: { id: 20 },
  };
  const said = (from: number, to: number): RawMessage[] =>
    Array.from({ length: to - from + 1 }, (_, i) => raw({ id: from + i, message: `m${from + i}` }));

  async function connected(f: ReturnType<typeof fake>, docs = new Map<string, unknown>()) {
    if (!docs.has(LAST_SEEN_DOC)) docs.set(LAST_SEEN_DOC, { [GROUP]: 20 });
    const clock = new VirtualClock(SAID);
    const messages: Inbound[] = [];
    const logs: string[] = [];
    const c = new TelegramUserConnector({
      account: 'telegram:alice',
      client: f.client,
      chats: [GROUP],
      clock,
      log: (l) => logs.push(l),
      store: {
        read: <T>(name: string) => docs.get(name) as T | undefined,
        write: (name, value) => docs.set(name, structuredClone(value)),
      },
      readers: () => [{ reads: [GROUP] }],
    });
    c.onMessage((m) => messages.push(m));
    c.start();
    await settle(clock, 3);
    return { c, clock, messages, logs, docs };
  }
  const looks = (f: ReturnType<typeof fake>) => f.calls.filter((x) => x.startsWith('history'));
  /** Runs the clock `ms` on, letting each look end. */
  const run = async (clock: VirtualClock, ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      clock.advance(500);
      await flush();
      await flush();
    }
  };

  it('fetches the ids a live message skipped, a second later, as caught up but news', async () => {
    const f = fake({ dialogs: [group], history: { [GROUP]: said(21, 24) } });
    const { c, clock, messages, docs } = await connected(f);
    await f.deliver(raw({ id: 21, message: 'm21' }));
    expect(looks(f)).toEqual([]);
    // 22 and 23 never pushed.
    await f.deliver(raw({ id: 24, message: 'm24' }));
    await run(clock, GAP_LOOK_MS);
    expect(looks(f)).toEqual([`history ${GROUP} <0 >21 ${LOOK_LIMIT}`]);
    expect(messages.map((m) => [m.id, m.missed === true, m.playback])).toEqual([
      ['21', false, false],
      ['24', false, false],
      ['22', true, false],
      ['23', true, false],
    ]);
    expect(docs.get(LAST_SEEN_DOC)).toEqual({ [GROUP]: 24 });
    // In order, nothing is looked for.
    await f.deliver(raw({ id: 25, message: 'm25' }));
    await run(clock, 5000);
    expect(looks(f)).toHaveLength(1);
    await c.stop();
  });

  it('looks after its own send, twice, for an answer no later message would show', async () => {
    const f = fake({
      dialogs: [group],
      history: {
        [GROUP]: [
          ...said(21, 21),
          raw({ id: 22, message: 'Troppo presto', replyTo: { replyToMsgId: 21 } }),
        ],
      },
      send: () => Promise.resolve({ id: 21, chatId: { toString: () => GROUP } }),
    });
    const { c, clock, messages, docs } = await connected(f);
    await c.deliver(GROUP, '/play');
    // Its own id alone is accounted for (no range assumed).
    expect(docs.get(LAST_SEEN_DOC)).toEqual({ [GROUP]: 21 });
    await run(clock, LOOK_AFTER_SEND_MS[0] as number);
    expect(looks(f)).toEqual([`history ${GROUP} <0 >20 ${LOOK_LIMIT}`]);
    expect(messages.map((m) => [m.id, m.replyTo, m.missed])).toEqual([['22', '21', true]]);
    await run(clock, LOOK_AFTER_SEND_MS[1] as number);
    expect(looks(f)).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(docs.get(LAST_SEEN_DOC)).toEqual({ [GROUP]: 22 });
    await c.stop();
  });

  it('leaves a gap no look filled to the next connection, and logs a failed look', async () => {
    const f = fake({
      dialogs: [group],
      history: { [GROUP]: said(21, 23) },
      historyFails: [new Error('CHANNEL_PRIVATE')],
    });
    const docs = new Map<string, unknown>();
    const first = await connected(f, docs);
    await f.deliver(raw({ id: 23, message: 'm23' }));
    await run(first.clock, GAP_LOOK_MS);
    expect(first.logs).toContain(`look in ${GROUP} failed: Error: CHANNEL_PRIVATE`);
    expect(docs.get(LAST_SEEN_DOC)).toEqual({ [GROUP]: 20 });
    expect(docs.get(SEEN_ABOVE_DOC)).toEqual({ [GROUP]: [[23, 23]] });
    await first.c.stop();
    const second = await connected(
      fake({ dialogs: [{ ...group, message: { id: 23 } }], history: { [GROUP]: said(21, 23) } }),
      docs
    );
    expect(second.messages.map((m) => [m.id, m.missed])).toEqual([
      ['21', true],
      ['22', true],
    ]);
    expect(docs.get(LAST_SEEN_DOC)).toEqual({ [GROUP]: 23 });
    await second.c.stop();
  });

  it('keeps 8 hours of what it heard, sent and found missing, raw, in its store', async () => {
    const f = fake({
      dialogs: [group],
      history: { [GROUP]: said(21, 22) },
      send: () => Promise.resolve({ id: 23, chatId: { toString: () => GROUP } }),
    });
    const { c, clock, docs } = await connected(f);
    await f.deliver(raw({ id: 22, message: 'm22' }));
    await run(clock, GAP_LOOK_MS);
    await c.deliver(GROUP, '/play');
    await run(clock, RAW_LOG_FLUSH_MS);
    const log = docs.get(RAW_LOG_DOC) as { via: string; id?: unknown; text?: unknown }[];
    expect(log.map((e) => [e.via, e.id ?? null, e.text ?? null])).toEqual([
      ['gap', null, null],
      ['live', '22', 'm22'],
      ['look', '21', 'm21'],
      ['sent', 23, '/play'],
    ]);
    // Past 8 hours, gone at the next write.
    clock.advance(RAW_LOG_MS);
    await f.deliver(raw({ id: 24, message: 'm24' }));
    await c.stop();
    expect((docs.get(RAW_LOG_DOC) as { via: string }[]).map((e) => e.via)).toEqual(['live']);
  });
});

describe('a chat by any of its names (D90)', () => {
  const BOT_ID = '5000001';
  const dialogs: RawDialog[] = [
    {
      id: { toString: () => GROUP },
      title: 'The Lobby',
      date: 1_793_000_000,
      isGroup: true,
      entity: { username: 'lobby_group' },
      inputEntity: { peer: GROUP },
      message: { id: 20 },
    },
    {
      id: { toString: () => BOT_ID },
      title: 'Quest Bot',
      date: 1_793_000_000,
      isUser: true,
      entity: { username: 'QuestBot', bot: true },
      inputEntity: { peer: '@QuestBot' },
      message: { id: 9 },
    },
  ];
  const bot = (id: number) =>
    raw({
      id,
      chatId: { toString: () => BOT_ID },
      isPrivate: true,
      chat: { username: 'QuestBot' },
      sender: { username: 'QuestBot' },
    });

  function make(chats: string[] | undefined, readers: ReadFilter[] = []) {
    const f = fake({ dialogs, history: { '@QuestBot': [bot(8), bot(9)] } });
    const clock = new VirtualClock(SAID + 3_600_000);
    const messages: Inbound[] = [];
    const docs = new Map<string, unknown>([[LAST_SEEN_DOC, { [BOT_ID]: 7 }]]);
    const c = new TelegramUserConnector({
      account: 'telegram:alice',
      client: f.client,
      ...(chats === undefined ? {} : { chats }),
      clock,
      log: () => {},
      store: {
        read: <T>(name: string) => docs.get(name) as T | undefined,
        write: (name, value) => docs.set(name, value),
      },
      readers: () => readers,
    });
    c.onMessage((m) => messages.push(m));
    return { c, f, clock, messages };
  }

  it('knows each chat by its id and its @username, from the dialogs', async () => {
    const { c } = make([BOT_ID]);
    expect(c.chatNames('@QuestBot')).toBeUndefined();
    c.start();
    await flush();
    expect(c.chatNames('@questbot')).toEqual([BOT_ID, '@QuestBot']);
    expect(c.chatNames(BOT_ID)).toEqual([BOT_ID, '@QuestBot']);
    expect(c.chatNames('@Lobby_Group')).toEqual([GROUP, '@lobby_group']);
    expect(c.chatNames('@DiceBot')).toBeUndefined();
  });

  it('delivers a chat as its config names it, with its other names, and sends to it by either', async () => {
    const { c, f, clock, messages } = make([BOT_ID, '@lobby_group']);
    c.start();
    await settle(clock);
    await f.deliver(bot(10));
    await f.deliver(raw({ id: 21 }));
    expect(messages.map((m) => [m.chat, m.aliases])).toEqual([
      [BOT_ID, ['@QuestBot']],
      // A public group listed by its @username is heard, and delivered so.
      ['@lobby_group', [GROUP]],
    ]);
    await expect(c.deliver('@questbot', 'hi')).resolves.toEqual({ id: '99' });
    await expect(c.deliver('@DiceBot', 'hi')).rejects.toThrow('is not a chat of');
  });

  it('given no chats, delivers a chat as before, with its other names', async () => {
    const { c, f, clock, messages } = make(undefined);
    c.start();
    await settle(clock);
    await f.deliver(bot(10));
    await f.deliver(raw({ id: 21 }));
    // A private chat first heard live: its names learnt from it.
    await f.deliver(
      raw({
        id: 1,
        chatId: { toString: () => '5000002' },
        isPrivate: true,
        chat: { username: 'DiceBot' },
      })
    );
    expect(messages.map((m) => [m.chat, m.aliases])).toEqual([
      ['@QuestBot', [BOT_ID]],
      [GROUP, ['@lobby_group']],
      ['@DiceBot', ['5000002']],
    ]);
    expect(c.chatNames('5000002')).toEqual(['5000002', '@DiceBot']);
  });

  it('catches up on a chat its readers name otherwise than its config', async () => {
    const { c, f, clock, messages } = make([BOT_ID], [{ reads: ['@questbot'] }]);
    c.start();
    await settle(clock);
    expect(f.calls.filter((x) => x.startsWith('history'))).toEqual([
      'history @QuestBot <10 >7 100',
    ]);
    expect(messages.map((m) => [m.id, m.chat, m.missed])).toEqual([
      ['8', BOT_ID, true],
      ['9', BOT_ID, true],
    ]);
  });

  it('lists a chat its config names otherwise as monitored, as its config names it', async () => {
    const { c, clock } = make(['@lobby_group']);
    c.start();
    await settle(clock);
    expect((await c.surfaces({ search: 'lobby' })).map((x) => x.id)).toEqual(['@lobby_group']);
  });
});

describe('TelegramUserConnector.photo (D151)', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  /** A photo's media, its sizes as GramJS gives them. */
  const photoMedia = (sizes: unknown[]) => ({
    className: 'MessageMediaPhoto',
    photo: { className: 'Photo', sizes },
  });
  const SIZES = [
    { className: 'PhotoStrippedSize', type: 'i', bytes: new Uint8Array(40) },
    { className: 'PhotoSize', type: 'm', w: 320, h: 240, size: 9000 },
    { className: 'PhotoSizeProgressive', type: 'y', w: 1280, h: 960, sizes: [5000, 60_000] },
    { className: 'PhotoPathSize', type: 'j', bytes: new Uint8Array(900_000) },
  ];

  it('fetches a message by its id in its chat, and downloads its largest size', async () => {
    const f = fake({
      history: {
        [GROUP]: [
          raw({ id: 41, media: photoMedia(SIZES) }),
          raw({ id: 42, message: 'no picture' }),
          raw({ id: 43, media: { className: 'MessageMediaWebPage', webpage: {} } }),
          raw({ id: 44, media: { className: 'MessageMediaDocument', document: {} } }),
          raw({ id: 45, media: photoMedia([{ className: 'PhotoStrippedSize', bytes: JPEG }]) }),
        ],
      },
    });
    const thumbs: unknown[] = [];
    f.client.downloadMedia = (_m, params) => (
      thumbs.push(params.thumb),
      Promise.resolve(Buffer.from(JPEG))
    );
    const { c } = await connector(f);
    const got = await c.photo(GROUP, '41');
    expect(got).toEqual({ data: JPEG, mime: 'image/jpeg', width: 1280, height: 960 });
    expect(got?.data).not.toBeInstanceOf(Buffer);
    expect(thumbs).toEqual([SIZES[2]]);
    expect(f.calls).toContain(`messages ${GROUP} 41`);
    // A text, a link's preview, a file and a mere preview of a photo have no photo.
    for (const id of ['42', '43', '44', '45']) expect(await c.photo(GROUP, id)).toBeNull();
    expect(thumbs).toHaveLength(1);
  });

  it('reads the type from the bytes, and a cached size as the largest', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const f = fake({
      history: {
        [GROUP]: [
          raw({ id: 1, media: photoMedia([{ className: 'PhotoCachedSize', bytes: PNG }]) }),
          raw({ id: 2, media: photoMedia([{ className: 'PhotoSize', w: 1, h: 1, size: 3 }]) }),
        ],
      },
    });
    f.client.downloadMedia = (m: RawMessage) =>
      Promise.resolve(m.id === 1 ? PNG : new Uint8Array([1, 2, 3]));
    const { c } = await connector(f);
    expect(await c.photo(GROUP, '1')).toEqual({ data: PNG, mime: 'image/png' });
    // Bytes of no known type are taken as Telegram's JPEG.
    expect(await c.photo(GROUP, '2')).toMatchObject({ mime: 'image/jpeg', width: 1, height: 1 });
  });

  it('refuses with why: not connected, not its chat, no id, no message, too large, no bytes', async () => {
    const big = [{ className: 'PhotoSize', w: 9000, h: 9000, size: 11 * 1024 * 1024 }];
    const f = fake({
      history: {
        [GROUP]: [
          raw({ id: 1, media: photoMedia(big) }),
          raw({ id: 2, media: photoMedia(SIZES) }),
          { className: 'MessageEmpty', id: 3 } as unknown as RawMessage,
        ],
      },
      files: { 2: new Uint8Array(0) },
    });
    await expect(new TelegramUserConnector(optionsOf(f)).photo(GROUP, '1')).rejects.toThrow(
      'not connected'
    );
    const { c } = await connector(f);
    await expect(c.photo('-100999', '1')).rejects.toThrow(
      '-100999 is not a chat telegram:alice monitors'
    );
    for (const bad of ['x', '0', '1.5', '-2'])
      await expect(c.photo(GROUP, bad)).rejects.toThrow(`${bad} is not a message id`);
    await expect(c.photo(GROUP, '3')).rejects.toThrow(`no message 3 in ${GROUP}`);
    await expect(c.photo(GROUP, '4')).rejects.toThrow(`no message 4 in ${GROUP}`);
    await expect(c.photo(GROUP, '1')).rejects.toThrow(
      'the photo is 11.0 MiB, more than the 10.0 MiB a photo may be'
    );
    expect(f.calls).not.toContain('download 1');
    await expect(c.photo(GROUP, '2')).rejects.toThrow(
      'the photo of message 2 could not be downloaded'
    );
  });

  it("says Telegram's wait, and passes any other failure on", async () => {
    const f = fake({ history: { [GROUP]: [raw({ id: 1, media: photoMedia(SIZES) })] } });
    const { c } = await connector(f);
    f.client.downloadMedia = () =>
      Promise.reject(Object.assign(new Error('FLOOD'), { seconds: 7 }));
    await expect(c.photo(GROUP, '1')).rejects.toThrow('Telegram asks to wait 7 s');
    f.client.getMessages = () => Promise.reject(new Error('CHANNEL_PRIVATE'));
    await expect(c.photo(GROUP, '1')).rejects.toThrow('CHANNEL_PRIVATE');
  });
});

describe('mediaOf (D161)', () => {
  const doc = (...attributes: unknown[]) => ({
    media: { className: 'MessageMediaDocument', document: { attributes } },
  });
  const of = (className: string, fields: Record<string, unknown> = {}) =>
    mediaOf({ media: { className, ...fields } });

  it('tells a document by its attributes', () => {
    expect(mediaOf(doc({ className: 'DocumentAttributeSticker', alt: ' 🙈 ' }))).toEqual({
      kind: 'sticker',
      emoji: '🙈',
    });
    expect(mediaOf(doc({ className: 'DocumentAttributeSticker', alt: '' }))).toEqual({
      kind: 'sticker',
    });
    expect(
      mediaOf(
        doc({ className: 'DocumentAttributeVideo' }, { className: 'DocumentAttributeAnimated' })
      )
    ).toEqual({ kind: 'animation' });
    expect(mediaOf(doc({ className: 'DocumentAttributeVideo', roundMessage: true }))).toEqual({
      kind: 'round',
    });
    expect(mediaOf(doc({ className: 'DocumentAttributeVideo' }))).toEqual({ kind: 'video' });
    expect(mediaOf(doc({ className: 'DocumentAttributeAudio', voice: true }))).toEqual({
      kind: 'voice',
    });
    expect(
      mediaOf(doc({ className: 'DocumentAttributeAudio', performer: 'The Band', title: 'Song' }))
    ).toEqual({ kind: 'audio', title: 'The Band Song' });
    expect(mediaOf(doc({ className: 'DocumentAttributeAudio' }))).toEqual({ kind: 'audio' });
    expect(
      mediaOf(doc(null, { className: 'DocumentAttributeFilename', fileName: 'a.pdf' }))
    ).toEqual({
      kind: 'file',
    });
    expect(mediaOf({ media: { className: 'MessageMediaDocument' } })).toEqual({ kind: 'file' });
    // Without its media, by the message's document.
    expect(
      mediaOf({ document: { attributes: [{ className: 'DocumentAttributeSticker' }] } })
    ).toEqual({ kind: 'sticker' });
    expect(mediaOf({ document: {} })).toEqual({ kind: 'file' });
  });

  it('describes the rest, a contact by name alone, a place without its coordinates', () => {
    expect(mediaOf({})).toBeUndefined();
    expect(of('MessageMediaEmpty')).toBeUndefined();
    expect(of('MessageMediaWebPage')).toBeUndefined();
    expect(of('MessageMediaPhoto')).toEqual({ kind: 'photo' });
    expect(
      of('MessageMediaPoll', {
        poll: {
          question: { text: 'Pizza?' },
          answers: [{ text: { text: 'Yes' } }, { text: 'No' }, null, { text: { text: ' ' } }],
        },
      })
    ).toEqual({ kind: 'poll', title: 'Pizza?', options: ['Yes', 'No'] });
    expect(of('MessageMediaPoll')).toEqual({ kind: 'poll' });
    expect(of('MessageMediaGeo', { geo: { lat: 1, long: 2 } })).toEqual({ kind: 'location' });
    expect(of('MessageMediaGeoLive')).toEqual({ kind: 'location' });
    expect(of('MessageMediaVenue', { title: 'The Inn', address: '1 Road' })).toEqual({
      kind: 'venue',
      title: 'The Inn',
    });
    expect(of('MessageMediaVenue')).toEqual({ kind: 'venue' });
    expect(
      of('MessageMediaContact', { firstName: 'Alice', lastName: '', phoneNumber: '555' })
    ).toEqual({ kind: 'contact', title: 'Alice' });
    expect(of('MessageMediaContact')).toEqual({ kind: 'contact' });
    expect(of('MessageMediaDice', { emoticon: '🎲', value: 4 })).toEqual({
      kind: 'dice',
      emoji: '🎲',
    });
    expect(of('MessageMediaDice')).toEqual({ kind: 'dice' });
    expect(of('MessageMediaGame', { game: { title: 'Quest' } })).toEqual({
      kind: 'game',
      title: 'Quest',
    });
    expect(of('MessageMediaGame')).toEqual({ kind: 'game' });
    expect(of('MessageMediaStory')).toEqual({ kind: 'story' });
    expect(of('MessageMediaInvoice')).toEqual({ kind: 'other' });
  });
});
