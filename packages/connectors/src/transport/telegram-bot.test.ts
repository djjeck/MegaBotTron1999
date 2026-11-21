import { FloodWait, type Inbound } from '@megabottron1999/core';
import { BotError, type Context, GrammyError, InputFile } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import {
  adminIn,
  createBot,
  downloadFile,
  MEMBER_UNREACHABLE,
  PHOTO_UNKNOWN,
  PHOTOS_DOC,
  PHOTOS_KEPT,
  type Startable,
  startBotWithRetry,
  surfaceOf,
  SURFACES_DOC,
  TelegramBotConnector,
} from './telegram-bot.ts';
import { type Denied, Gate, type GateOptions } from './telegram-gate.ts';

describe('createBot', () => {
  it('reports an update a handler fails on, and goes on polling', async () => {
    const warned: string[] = [];
    const bot = createBot('123456:test-token', (l) => warned.push(l));
    // What polling hands the bot's error handler when a handler throws.
    const ctx = { update: { update_id: 7 } } as unknown as Context;
    await bot.errorHandler(new BotError(new Error('boom'), ctx));
    expect(warned).toEqual(['update 7 failed: Error: boom']);
  });
});

describe('startBotWithRetry', () => {
  /** A bot whose getMe fails `failures` times, and whose polling stops with `stops` errors. */
  function fakeBot(failures: number, stops: Error[] = []) {
    const calls: string[] = [];
    let left = failures;
    const bot: Startable & { calls: string[] } = {
      calls,
      botInfo: undefined as unknown as UserFromGetMe,
      api: {
        getMe: async () => {
          calls.push('getMe');
          if (left-- > 0) throw new Error('offline');
          return BOT_INFO;
        },
      },
      start: async () => {
        calls.push('start');
        const stop = stops.shift();
        if (stop !== undefined) throw stop;
      },
    };
    return bot;
  }

  it('retries with a growing delay until it connects, then polls', async () => {
    const bot = fakeBot(3);
    const slept: number[] = [];
    const log: string[] = [];
    let started = 0;
    await startBotWithRetry(bot, {
      log: (l) => log.push(l),
      sleep: async (ms) => void slept.push(ms),
      onStart: () => started++,
    });
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(bot.calls).toEqual(['getMe', 'getMe', 'getMe', 'getMe', 'start']);
    expect(bot.botInfo).toBe(BOT_INFO);
    expect(started).toBe(1);
    expect(log.at(0)).toBe('could not connect, retrying in 1 s: Error: offline');
    expect(log.at(-1)).toBe('connected as @ExampleBot');
  });

  it('gives up a retry, or a restart of polling, once the bot is stopped', async () => {
    let running = true;
    const offline = fakeBot(5);
    await startBotWithRetry(offline, {
      log: () => {},
      sleep: async () => void (running = false),
      running: () => running,
    });
    expect(offline.calls).toEqual(['getMe']);
    running = true;
    const stops: unknown[] = [];
    const polled = fakeBot(0, [new Error('409: Conflict')]);
    await startBotWithRetry(polled, {
      log: () => {},
      sleep: async () => void (running = false),
      running: () => running,
      onStop: (e) => stops.push(e),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(polled.calls).toEqual(['getMe', 'start']);
    expect(String(stops[0])).toBe('Error: 409: Conflict');
    running = true;
    const late = fakeBot(1);
    await startBotWithRetry(late, {
      log: () => {},
      sleep: async () => {},
      running: () => (late.calls.length < 2 ? true : (running = false)),
    });
    expect(late.calls).toEqual(['getMe', 'getMe']);
  });

  it('starts polling again a minute after it stops', async () => {
    const bot = fakeBot(0, [new Error('409: Conflict')]);
    const slept: number[] = [];
    const log: string[] = [];
    let started = 0;
    await startBotWithRetry(bot, {
      log: (l) => log.push(l),
      sleep: async (ms) => void slept.push(ms),
      onStart: () => started++,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(slept).toEqual([60_000]);
    expect(bot.calls).toEqual(['getMe', 'start', 'getMe', 'start']);
    expect(started).toBe(2);
    expect(log).toContain('polling stopped, restarting in a minute: Error: 409: Conflict');
  });
});

describe('TelegramBotConnector', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  function connector(
    o: {
      listen?: Promise<unknown>;
      chats?: string[];
      ownerId?: number;
      docs?: Record<string, unknown>;
      download?: (fileId: string) => Promise<Uint8Array>;
      /** The time, in ms: what came before its connection was missed. */
      now?: number;
      gate?: Gate;
    } = {}
  ) {
    const stub = stubBot();
    const docs: Record<string, unknown> = o.docs ?? {};
    const logs: string[] = [];
    const states: string[] = [];
    const denied: Denied[] = [];
    let polls = 0;
    // Polling, faked: it runs until the bot stops.
    let stopPolling: () => void = () => {};
    stub.bot.start = () => {
      polls++;
      return new Promise<void>((r) => (stopPolling = r));
    };
    stub.bot.stop = () => (stopPolling(), Promise.resolve());
    stub.bot.api.getMe = () => (
      stub.calls.push({ method: 'getMe', payload: {} }),
      Promise.resolve(BOT_INFO)
    );
    const c = new TelegramBotConnector({
      account: 'telegram-bot:ExampleBot',
      bot: stub.bot,
      log: (l) => logs.push(l),
      ...(o.listen === undefined ? {} : { listen: o.listen }),
      ...(o.chats === undefined ? {} : { chats: o.chats }),
      ...(o.ownerId === undefined ? {} : { ownerId: o.ownerId }),
      store: {
        read: <T>(name: string) => docs[name] as T | undefined,
        write: (name, value) => {
          docs[name] = structuredClone(value);
        },
      },
      now: () => o.now ?? 10_000,
      sleep: () => Promise.resolve(),
      ...(o.download === undefined ? {} : { download: o.download }),
      ...(o.gate === undefined ? {} : { gate: o.gate, onDenied: (d) => denied.push(d) }),
    });
    c.onStatus((s) => states.push(`${s.state} ${s.phase}`));
    return { c, stub, logs, states, docs, denied, polls: () => polls };
  }

  it('polls once the app listens, and tells its status and its name', async () => {
    let listen: () => void = () => {};
    const { c, stub, logs, states, polls } = connector({
      listen: new Promise<void>((r) => (listen = r)),
    });
    c.start();
    c.start();
    await flush();
    expect(polls()).toBe(0);
    expect(c.status().state).toBe('connecting');
    listen();
    await flush();
    expect(polls()).toBe(1);
    expect(stub.calls.map((x) => x.method)).toEqual(['getMe']);
    expect(c.self()).toBe('ExampleBot');
    expect(states).toEqual(['connecting connecting', 'connected polling']);
    expect(logs).toEqual(['connected as @ExampleBot']);
    await c.stop();
    await c.stop();
    expect(c.status().state).toBe('closed');
  });

  it('never polls when stopped before the app listens', async () => {
    let listen: () => void = () => {};
    const { c, polls } = connector({ listen: new Promise<void>((r) => (listen = r)) });
    c.start();
    await c.stop();
    listen();
    await flush();
    expect(polls()).toBe(0);
  });

  it('hears the messages Telegram delivers the bot, as Inbound, before the app', async () => {
    const { c, stub } = connector();
    const heard: Inbound[] = [];
    const order: string[] = [];
    c.onMessage((m) => (heard.push(m), order.push('connector')));
    stub.bot.command('map', () => void order.push('app'));
    await stub.bot.handleUpdate(stub.command(-100123, 5, '/map@ExampleBot', 'ada'));
    await stub.bot.handleUpdate(stub.command(5, 5, '/map'));
    expect(order).toEqual(['connector', 'app', 'connector', 'app']);
    expect(heard[0]).toEqual({
      account: 'telegram-bot:ExampleBot',
      network: 'telegram',
      chat: '-100123',
      sender: 'ada',
      text: '/map@ExampleBot',
      time: 0,
      id: expect.any(String) as string,
      playback: false,
      private: false,
    });
    expect(heard[1]?.sender).toBe('');
    // User 5's own chat with the bot: private, by its id (D90).
    expect(heard[1]).toMatchObject({ chat: '5', private: true });
  });

  describe('a file (D82)', () => {
    const LIST = 'Crate\n- 4 x Wooden Peg\n';
    /** A message with a file, from user 5 in `chatId`, its caption if any. */
    const withFile = (
      stub: ReturnType<typeof stubBot>,
      document: Record<string, unknown>,
      caption?: string
    ) => {
      const u = stub.command(5, 5, 'x') as unknown as { message: Record<string, unknown> };
      delete u.message['text'];
      delete u.message['entities'];
      u.message['document'] = document;
      if (caption !== undefined) u.message['caption'] = caption;
      return u as unknown as ReturnType<typeof stub.command>;
    };

    it('downloads a text file, and passes it on with its caption, or none', async () => {
      const ids: string[] = [];
      const { c, stub } = connector({
        download: (id) => (ids.push(id), Promise.resolve(new TextEncoder().encode(LIST))),
      });
      const heard: Inbound[] = [];
      c.onMessage((m) => heard.push(m));
      const file = { file_id: 'f1', file_unique_id: 'u1', file_name: 'crate.txt' };
      await stub.bot.handleUpdate(
        withFile(stub, { ...file, mime_type: 'text/plain', file_size: 23 }, 'Your crate')
      );
      await stub.bot.handleUpdate(withFile(stub, { file_id: 'f2', file_unique_id: 'u2' }));
      expect(ids).toEqual(['f1']);
      expect(heard.map((m) => [m.text, m.document])).toEqual([
        ['Your crate', { name: 'crate.txt', mime: 'text/plain', size: 23, text: LIST }],
        ['', { name: '', mime: '', size: 0, skipped: 'type' }],
      ]);
    });

    it('downloads through the Bot API, saying only the status of a failure', async () => {
      const { stub } = connector();
      stub.bot.api.getFile = (id) =>
        Promise.resolve({ file_id: id, file_unique_id: 'u', file_path: 'documents/file_1.txt' });
      const urls: string[] = [];
      const ok = (url: string | URL | Request) => (
        urls.push(String(url)),
        Promise.resolve(new Response(LIST))
      );
      expect(new TextDecoder().decode(await downloadFile(stub.bot, 'f1', ok as never))).toBe(LIST);
      expect(urls).toEqual([
        'https://api.telegram.org/file/bot123456:test-token/documents/file_1.txt',
      ]);
      const missing = () => Promise.resolve(new Response('', { status: 404 }));
      await expect(downloadFile(stub.bot, 'f1', missing as never)).rejects.toThrow('HTTP 404');
      stub.bot.api.getFile = (id) => Promise.resolve({ file_id: id, file_unique_id: 'u' });
      await expect(downloadFile(stub.bot, 'f1', ok as never)).rejects.toThrow(
        'Telegram gave no path for the file'
      );
    });

    it('downloads by default through its bot, and logs a failure', async () => {
      const { c, stub, logs } = connector();
      stub.bot.api.getFile = () => Promise.reject(new Error('Bad Request: file is too big'));
      const heard: Inbound[] = [];
      c.onMessage((m) => heard.push(m));
      await stub.bot.handleUpdate(
        withFile(stub, { file_id: 'f1', file_unique_id: 'u1', file_name: 'crate.txt' })
      );
      expect(heard.map((m) => m.document?.skipped)).toEqual(['failed']);
      expect(logs.at(-1)).toBe('download of crate.txt failed: Error: Bad Request: file is too big');
    });
  });

  it('marks what Telegram kept while it was down as missed, and monitors only its chats', async () => {
    const { c, stub } = connector({ chats: ['-100123', '@lobby_chat'], now: 1_000_000 });
    const heard: Inbound[] = [];
    c.onMessage((m) => heard.push(m));
    c.start();
    await flush();
    const at = (u: ReturnType<typeof stub.command>, date: number, username?: string) => {
      const m = (u as unknown as { message: { date: number; chat: Record<string, unknown> } })
        .message;
      m.date = date;
      if (username !== undefined) m.chat['username'] = username;
      return u;
    };
    await stub.bot.handleUpdate(at(stub.command(-100123, 5, '/map'), 9));
    // Missed, but within its grace (D83): news still.
    await stub.bot.handleUpdate(at(stub.command(-100123, 5, '/map'), 900));
    await stub.bot.handleUpdate(at(stub.command(-100123, 5, '/map'), 1000));
    await stub.bot.handleUpdate(at(stub.command(-100777, 5, '/map'), 1000, 'Lobby_Chat'));
    await stub.bot.handleUpdate(at(stub.command(-100999, 5, '/map'), 1000));
    expect(heard.map((m) => [m.chat, m.playback, m.missed])).toEqual([
      ['-100123', true, true],
      ['-100123', false, true],
      ['-100123', false, undefined],
      ['-100777', false, undefined],
    ]);
    await c.stop();
  });

  it('gives a chat its @username as an alias, and knows its names once seen (D90)', async () => {
    const { c, stub } = connector({ chats: ['@lobby_chat'] });
    const heard: Inbound[] = [];
    c.onMessage((m) => heard.push(m));
    c.start();
    await flush();
    expect(c.chatNames('@Lobby_Chat')).toBeUndefined();
    const named = (u: ReturnType<typeof stub.command>, username: string) => {
      (u as unknown as { message: { chat: Record<string, unknown> } }).message.chat['username'] =
        username;
      return u;
    };
    await stub.bot.handleUpdate(named(stub.command(-100777, 5, '/map'), 'Lobby_Chat'));
    expect(heard.map((m) => [m.chat, m.aliases])).toEqual([['-100777', ['@Lobby_Chat']]]);
    expect(c.chatNames('@lobby_chat')).toEqual(['-100777', '@Lobby_Chat']);
    expect(c.chatNames('-100777')).toEqual(['-100777', '@Lobby_Chat']);
    await c.stop();
  });

  it('delivers a message Telegram delivers again only once, across a restart too', async () => {
    const { c, stub, docs } = connector();
    const heard: string[] = [];
    c.onMessage((m) => heard.push(`${m.chat} ${m.id}`));
    let app = 0;
    stub.bot.command('map', () => void app++);
    const update = stub.command(-100123, 5, '/map');
    const other = stub.command(-100456, 5, '/map');
    await stub.bot.handleUpdate(update);
    await stub.bot.handleUpdate(update);
    await stub.bot.handleUpdate(other);
    expect(heard).toHaveLength(2);
    // The app's own handlers are not the readers': they hear it each time.
    expect(app).toBe(3);
    expect(docs['last-seen']).toEqual({
      '-100123': Number(heard[0]?.split(' ')[1]),
      '-100456': Number(heard[1]?.split(' ')[1]),
    });
    // The next run, from the store as kept, after an unconfirmed poll.
    const next = new TelegramBotConnector({
      account: 'telegram-bot:ExampleBot',
      bot: stub.bot,
      log: () => {},
      store: {
        read: <T>(name: string) => docs[name] as T | undefined,
        write: (name, value) => (docs[name] = structuredClone(value)),
      },
    });
    next.onMessage((m) => heard.push(`again ${m.id}`));
    await stub.bot.handleUpdate(update);
    expect(heard).toHaveLength(2);
  });

  it('lists the chats it has seen, latest first, kept, and one searched by id', async () => {
    const { c, stub, docs } = connector();
    await stub.bot.handleUpdate(stub.command(-100123, 5, '/map'));
    await stub.bot.handleUpdate(stub.command(5, 5, '/map'));
    const at = (u: ReturnType<typeof stub.command>, date: number) => (
      ((u as unknown as { message: { date: number } }).message.date = date),
      u
    );
    await stub.bot.handleUpdate(at(stub.command(5, 5, '/map'), 30));
    await stub.bot.handleUpdate(at(stub.command(5, 5, '/map'), 200));
    expect(await c.surfaces()).toEqual([
      { id: '5', title: 'Ada', kind: 'private', lastActive: 200_000 },
      { id: '-100123', title: 'The Lobby', kind: 'group' },
    ]);
    expect(Object.keys(docs[SURFACES_DOC] as object)).toEqual(['5', '-100123']);
    expect(await c.surfaces({ search: 'lobby' })).toHaveLength(1);
    expect(await c.surfaces({ limit: 1 })).toHaveLength(1);
    expect(await c.surfaces({ search: 'nothing' })).toEqual([]);
    // One it has not seen, by its id: from Telegram, then kept.
    stub.bot.api.getChat = ((id: number) =>
      Promise.resolve({ id, type: 'channel', title: '' })) as never;
    expect(await c.surfaces({ search: '-100555' })).toEqual([
      { id: '-100555', title: '-100555', kind: 'channel' },
    ]);
    stub.bot.api.getChat = (() => Promise.reject(new Error('chat not found'))) as never;
    expect(await c.surfaces({ search: '@nowhere_chat' })).toEqual([]);
  });

  it('lists its owner before it has seen them, or why it cannot reach them (D96)', async () => {
    const { c, stub } = connector({ ownerId: 7 });
    const asked: number[] = [];
    stub.bot.api.getChat = ((id: number) => {
      asked.push(id);
      return Promise.reject(new Error('400: Bad Request: chat not found'));
    }) as never;
    expect(await c.surfaces()).toEqual([
      {
        id: '7',
        title: 'its owner',
        kind: 'private',
        unreachable: expect.stringContaining('/start') as unknown,
      },
    ]);
    // Not asked again soon; once the owner writes, it is seen, and reachable.
    await c.surfaces();
    expect(asked).toEqual([7]);
    await stub.bot.handleUpdate(stub.command(7, 7, '/map', 'ada_x'));
    expect((await c.surfaces({ search: '@ada_x' })).map((x) => [x.id, x.unreachable])).toEqual([
      ['7', undefined],
    ]);
    expect(c.chatTitle('@ADA_X')).toBe('Ada');
    expect(c.chatTitle('-1')).toBeUndefined();
    // An owner Telegram gives at once is listed as any chat seen.
    const given = connector({ ownerId: 8 });
    given.stub.bot.api.getChat = ((id: number) =>
      Promise.resolve({ id, type: 'private', first_name: 'Bea' })) as never;
    expect(await given.c.surfaces()).toEqual([{ id: '8', title: 'Bea', kind: 'private' }]);
  });

  it('sends to a person by the @username it saw, through their id, after a restart too', async () => {
    const first = connector();
    await first.stub.bot.handleUpdate(first.stub.command(5, 5, '/map', 'ada_x'));
    const { c, stub } = connector({ docs: first.docs });
    expect(c.owner()).toBeUndefined();
    await c.deliver('@Ada_X', 'hello');
    await c.deliver('@lobby', 'hello');
    expect(stub.calls.map((x) => x.payload['chat_id'])).toEqual([5, '@lobby']);
  });

  it('names a chat by its username when it has no title', () => {
    expect(surfaceOf({ id: 1, type: 'private', first_name: '', username: 'ada_x' })).toEqual({
      id: '1',
      title: '@ada_x',
      kind: 'private',
      aliases: ['@ada_x'],
    });
    expect(surfaceOf({ id: 2, type: 'private', first_name: 'Ada', last_name: 'L' }, 5).title).toBe(
      'Ada L'
    );
  });

  it('logs a listener that fails, and the app still hears the message', async () => {
    const { c, stub, logs } = connector();
    let app = 0;
    c.onMessage(() => {
      throw new Error('boom');
    });
    stub.bot.command('map', () => void app++);
    await stub.bot.handleUpdate(stub.command(5, 5, '/map'));
    expect(app).toBe(1);
    expect(logs.at(-1)).toMatch(/^a listener failed on message \d+: Error: boom$/u);
  });

  it("sends to a chat by id or by username, with the message's id", async () => {
    const { c, stub } = connector();
    await expect(c.deliver('-100123', 'hello')).resolves.toEqual({ id: '101' });
    await expect(c.deliver('@lobby', 'hello')).resolves.toEqual({ id: '102' });
    expect(stub.calls.map((x) => x.payload['chat_id'])).toEqual([-100123, '@lobby']);
  });

  it('sends Markdown as Telegram HTML, and as written if Telegram cannot parse it', async () => {
    const { c, stub, logs } = connector();
    await c.deliver('1', '**a**', { format: 'markdown' });
    expect(stub.calls.at(-1)?.payload).toMatchObject({ text: '<b>a</b>', parse_mode: 'HTML' });
    const send = stub.bot.api.sendMessage.bind(stub.bot.api);
    let first = true;
    stub.bot.api.sendMessage = ((chat: number, text: string, other?: object) => {
      if (!first) return send(chat, text, other);
      first = false;
      return Promise.reject(
        new GrammyError(
          'Bad Request',
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: no end tag",
          },
          'sendMessage',
          {}
        )
      );
    }) as typeof stub.bot.api.sendMessage;
    await expect(c.deliver('1', '**b**', { format: 'markdown' })).resolves.toEqual({
      id: expect.any(String) as string,
    });
    expect(stub.calls.at(-1)?.payload).toMatchObject({ text: '**b**' });
    expect(stub.calls.at(-1)?.payload['parse_mode']).toBeUndefined();
    expect(logs.at(-1)).toMatch(/^formatting refused, sending plain text: /u);
  });

  it('sends a photo with sendPhoto: its caption, as HTML from Markdown, in reply; its file id (D150)', async () => {
    const { c, stub, logs } = connector();
    const bytes = { data: new Uint8Array([1, 2]), filename: 'card.png' };
    await expect(
      c.deliverPhoto('-100123', bytes, { caption: '**A** card', format: 'markdown', replyTo: '41' })
    ).resolves.toEqual({ id: '101', photo: 'photo-101' });
    const sent = stub.calls.at(-1);
    expect(sent?.method).toBe('sendPhoto');
    expect(sent?.payload).toMatchObject({
      chat_id: -100123,
      caption: '<b>A</b> card',
      parse_mode: 'HTML',
      reply_parameters: { message_id: 41, allow_sending_without_reply: true },
    });
    expect(sent?.payload['photo']).toBeInstanceOf(InputFile);
    // By its file id, with nothing more.
    await expect(c.deliverPhoto('@lobby', 'photo-101')).resolves.toEqual({
      id: '102',
      photo: 'photo-102',
    });
    expect(stub.calls.at(-1)?.payload).toEqual({ chat_id: '@lobby', photo: 'photo-101' });
    // A plain caption as written.
    await c.deliverPhoto('1', 'photo-101', { caption: '**as is**' });
    expect(stub.calls.at(-1)?.payload).toEqual({
      chat_id: 1,
      photo: 'photo-101',
      caption: '**as is**',
    });
    // A caption Telegram cannot parse goes again as written.
    const send = stub.bot.api.sendPhoto.bind(stub.bot.api);
    let first = true;
    stub.bot.api.sendPhoto = ((chat: number, photo: string, other?: object) => {
      if (!first) return send(chat, photo, other);
      first = false;
      return Promise.reject(
        new GrammyError(
          'Bad Request',
          { ok: false, error_code: 400, description: "Bad Request: can't parse entities: x" },
          'sendPhoto',
          {}
        )
      );
    }) as typeof stub.bot.api.sendPhoto;
    await c.deliverPhoto('1', 'photo-101', { caption: '**b**', format: 'markdown' });
    expect(stub.calls.at(-1)?.payload).toEqual({
      chat_id: 1,
      photo: 'photo-101',
      caption: '**b**',
    });
    expect(logs.at(-1)).toMatch(/^formatting refused, sending the caption plain: /u);
    // Any other refusal, and a flood wait, as a text's.
    stub.bot.api.sendPhoto = (() =>
      Promise.reject(
        new GrammyError(
          'Too Many Requests',
          { ok: false, error_code: 429, description: 'x', parameters: { retry_after: 90 } },
          'sendPhoto',
          {}
        )
      )) as unknown as typeof stub.bot.api.sendPhoto;
    await expect(c.deliverPhoto('1', 'photo-101')).rejects.toBeInstanceOf(FloodWait);
    stub.bot.api.sendPhoto = (() =>
      Promise.reject(
        new GrammyError(
          'Bad Request',
          { ok: false, error_code: 400, description: "Bad Request: can't parse entities: y" },
          'sendPhoto',
          {}
        )
      )) as unknown as typeof stub.bot.api.sendPhoto;
    await expect(
      c.deliverPhoto('1', 'photo-101', { caption: '**c**', format: 'markdown' })
    ).rejects.toBeInstanceOf(GrammyError);
  });

  it("turns Telegram's longer flood waits into the core's, and passes other errors on", async () => {
    const { c, stub } = connector();
    const fail = (e: Error) =>
      (stub.bot.api.sendMessage = () => Promise.reject(e)) as unknown as void;
    fail(
      new GrammyError(
        'Too Many Requests',
        {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 90 },
        },
        'sendMessage',
        {}
      )
    );
    const e: unknown = await c.deliver('1', 'x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FloodWait);
    expect((e as FloodWait).ms).toBe(90_000);
    fail(
      new GrammyError(
        'Forbidden',
        { ok: false, error_code: 403, description: 'Forbidden' },
        'sendMessage',
        {}
      )
    );
    await expect(c.deliver('1', 'x')).rejects.toBeInstanceOf(GrammyError);
  });

  describe('a gate (D128)', () => {
    const OWNER = 4242;
    const LOBBY = -100123;
    const gate = (o: Partial<GateOptions> = {}) =>
      new Gate({
        people: { block: ['66', '@Spam_Bot', String(OWNER)] },
        owner: OWNER,
        now: () => 0,
        ...o,
      });
    const sent = (stub: ReturnType<typeof stubBot>) =>
      stub.calls.filter((x) => x.method === 'sendMessage').map((x) => x.payload['text']);

    it('drops the commands of those it blocks, before any reader or the app', async () => {
      const { c, stub, logs, denied } = connector({ gate: gate() });
      const heard: string[] = [];
      c.onMessage((m) => heard.push(`${m.chat} ${m.text}`));
      stub.bot.on('message', (ctx) => void heard.push(`app ${ctx.message.text ?? ''}`));
      const update = stub.command(LOBBY, 66, '/roll 3');
      await stub.bot.handleUpdate(update);
      // Delivered again (an unconfirmed poll): neither heard nor counted twice.
      await stub.bot.handleUpdate(update);
      await stub.bot.handleUpdate(stub.command(LOBBY, 77, '/roll@ExampleBot', 'spam_bot'));
      // In a private chat too.
      await stub.bot.handleUpdate(stub.command(66, 66, '/roll'));
      expect(heard).toEqual([]);
      const lobby = { chat: String(LOBBY), chatTitle: 'The Lobby', by: 'person', replied: false };
      expect(denied).toEqual([
        { ...lobby, sender: '66', command: '/roll' },
        { ...lobby, sender: '@Spam_Bot', command: '/roll' },
        { chat: '66', sender: '66', by: 'person', command: '/roll', replied: false },
      ]);
      expect(logs).toContain('denied /roll of 66 in The Lobby');
      expect(c.denied()).toMatchObject({ count: 3, last: { sender: '66', t: 0 } });
      expect(sent(stub)).toEqual([]);
    });

    it('leaves the owner, other bots’ commands and what they say alone', async () => {
      const { c, stub, denied } = connector({ gate: gate() });
      const heard: string[] = [];
      c.onMessage((m) => heard.push(`${m.chat} ${m.text}`));
      c.start();
      await flush();
      await stub.bot.handleUpdate(stub.command(LOBBY, OWNER, '/roll'));
      await stub.bot.handleUpdate(stub.command(LOBBY, 66, '/roll@OtherBot'));
      const plain = stub.command(LOBBY, 66, 'hello') as unknown as {
        message: { entities?: unknown };
      };
      delete plain.message.entities;
      await stub.bot.handleUpdate(plain as never);
      expect(heard).toEqual([`${LOBBY} /roll`, `${LOBBY} /roll@OtherBot`, `${LOBBY} hello`]);
      expect(denied).toEqual([]);
      expect(c.denied()).toEqual({ count: 0 });
      await c.stop();
    });

    it('works only for the people it lists, and its owner', async () => {
      const { c, stub, denied } = connector({
        gate: gate({ people: { only: ['@ada_x'] } }),
      });
      const heard: string[] = [];
      c.onMessage((m) => heard.push(`${m.chat} ${m.text}`));
      await stub.bot.handleUpdate(stub.command(LOBBY, 5, '/roll', 'ada_x'));
      await stub.bot.handleUpdate(stub.command(LOBBY, OWNER, '/roll'));
      await stub.bot.handleUpdate(stub.command(LOBBY, 77, '/roll', 'mallory_x'));
      await stub.bot.handleUpdate(stub.command(77, 77, '/roll', 'mallory_x'));
      expect(heard).toEqual([`${LOBBY} /roll`, `${LOBBY} /roll`]);
      expect(denied.map((d) => `${d.chat} ${d.sender} ${d.by}`)).toEqual([
        `${LOBBY} @mallory_x person`,
        '77 @mallory_x person',
      ]);
    });

    it('hears nothing in a group it does not work in, and records the commands there', async () => {
      const { c, stub, denied } = connector({
        gate: gate({ groups: { only: ['-100999'] }, reply: 'Not for you.' }),
      });
      const heard: string[] = [];
      c.onMessage((m) => heard.push(`${m.chat} ${m.text}`));
      await stub.bot.handleUpdate(stub.command(LOBBY, OWNER, '/roll'));
      const plain = stub.command(LOBBY, 5, 'hello') as unknown as {
        message: { entities?: unknown };
      };
      delete plain.message.entities;
      await stub.bot.handleUpdate(plain as never);
      await stub.bot.handleUpdate(stub.tap(LOBBY, 5, '/report 8'));
      // A private chat is no group: the owner's, heard.
      await stub.bot.handleUpdate(stub.command(OWNER, OWNER, '/roll'));
      expect(heard).toEqual([`${OWNER} /roll`]);
      // Seen all the same, so that the owner can pick it.
      expect((await c.surfaces()).map((x) => x.id)).toContain(String(LOBBY));
      // Its owner's command too, and silently: the reply line is for people.
      expect(denied.map((d) => `${d.sender} ${d.by} ${d.command} ${d.replied}`)).toEqual([
        `${OWNER} group /roll false`,
        '5 group /report false',
      ]);
      expect(sent(stub)).toEqual([]);
    });

    it('blocks a group, any other heard', async () => {
      const { c, stub, denied } = connector({
        gate: new Gate({ groups: { block: [String(LOBBY)] }, now: () => 0 }),
      });
      const heard: string[] = [];
      c.onMessage((m) => heard.push(`${m.chat} ${m.text}`));
      await stub.bot.handleUpdate(stub.command(LOBBY, 5, '/roll'));
      await stub.bot.handleUpdate(stub.command(-100999, 5, '/roll'));
      expect(heard).toEqual(['-100999 /roll']);
      expect(denied.map((d) => d.chat)).toEqual([String(LOBBY)]);
    });

    it('answers with its reply line, at most once in 10 minutes per person', async () => {
      let now = 0;
      const { stub, denied, logs } = connector({
        gate: gate({ reply: 'Not for you.', now: () => now }),
      });
      await stub.bot.handleUpdate(stub.command(LOBBY, 66, '/roll'));
      await stub.bot.handleUpdate(stub.command(LOBBY, 66, '/roll'));
      now = 10 * 60_000;
      stub.bot.api.sendMessage = () => Promise.reject(new Error('no right to post'));
      await stub.bot.handleUpdate(stub.command(LOBBY, 66, '/roll'));
      expect(denied.map((d) => d.replied)).toEqual([true, false, true]);
      const reply = stub.calls.find((x) => x.method === 'sendMessage')?.payload;
      expect(reply).toMatchObject({ chat_id: LOBBY, text: 'Not for you.' });
      expect(logs).toContain('deny reply failed: Error: no right to post');
    });

    it('drops their taps on buttons, in any chat', async () => {
      const { stub, denied } = connector({ gate: gate() });
      const taps: string[] = [];
      stub.bot.on('callback_query:data', (ctx) => void taps.push(ctx.callbackQuery.data));
      await stub.bot.handleUpdate(stub.tap(LOBBY, 66, '/report 8'));
      await stub.bot.handleUpdate(stub.tap(66, 66, '/report 9'));
      await stub.bot.handleUpdate(stub.tap(LOBBY, 77, '/report 7'));
      expect(taps).toEqual(['/report 7']);
      expect(denied.map((d) => `${d.sender} ${d.command}`)).toEqual(['66 /report', '66 /report']);
      expect(stub.calls.map((x) => x.method)).toContain('answerCallbackQuery');
    });

    it('lists the people it saw in its groups, in memory, as people it cannot message', async () => {
      const { c, stub, docs } = connector();
      await stub.bot.handleUpdate(stub.command(LOBBY, 66, '/roll', 'mallory_x'));
      await stub.bot.handleUpdate(stub.command(LOBBY, 66, '/roll', 'mallory_x'));
      // One who opened the bot is listed by their private chat instead.
      await stub.bot.handleUpdate(stub.command(LOBBY, 5, '/roll'));
      await stub.bot.handleUpdate(stub.command(5, 5, '/start'));
      const people = (await c.surfaces()).filter((x) => x.kind === 'private');
      expect(people).toEqual([
        { id: '5', title: 'Ada', kind: 'private' },
        {
          id: '66',
          title: 'Ada',
          kind: 'private',
          aliases: ['@mallory_x'],
          unreachable: MEMBER_UNREACHABLE,
        },
      ]);
      expect(JSON.stringify(docs)).not.toContain('mallory_x');
      expect((await c.surfaces({ search: 'MALLORY' })).map((x) => x.id)).toEqual(['66']);
    });

    it('keeps the latest 200 of them, a bot as a bot, and re-dates one seen again later', async () => {
      const { c, stub } = connector();
      const at = (u: ReturnType<typeof stub.command>, date: number, bot = false) => {
        const m = (u as unknown as { message: { date: number; from: { is_bot: boolean } } })
          .message;
        m.date = date;
        m.from.is_bot = bot;
        return u;
      };
      for (let i = 1; i <= 201; i++)
        await stub.bot.handleUpdate(at(stub.command(LOBBY, 1000 + i, '/roll'), i, i === 201));
      await stub.bot.handleUpdate(at(stub.command(LOBBY, 1002, '/roll'), 500));
      const listed = await c.surfaces({ limit: 500 });
      expect(listed.filter((x) => x.kind !== 'group')).toHaveLength(200);
      expect(listed.some((x) => x.id === '1001')).toBe(false);
      expect(listed.find((x) => x.id === '1201')?.kind).toBe('bot');
      expect(listed.find((x) => x.id === '1002')?.lastActive).toBe(500_000);
    });
  });

  it("sends without waiting, logging a failure, and not while it isn't connected", async () => {
    const { c, stub, logs } = connector();
    expect(c.send('1', 'x')).toBe(false);
    c.start();
    await flush();
    stub.bot.api.sendMessage = () => Promise.reject(new Error('nope'));
    expect(c.send('1', 'x')).toBe(true);
    await flush();
    expect(logs.at(-1)).toBe('send to 1 failed: Error: nope');
  });

  describe('a message’s photo (D151)', () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
    /** A message with a photo, its sizes smallest first as Telegram gives them, in `chatId`. */
    const withPhoto = (
      stub: ReturnType<typeof stubBot>,
      chatId: number,
      sizes: Record<string, unknown>[]
    ) => {
      const u = stub.command(chatId, 5, 'x') as unknown as { message: Record<string, unknown> };
      delete u.message['text'];
      delete u.message['entities'];
      u.message['photo'] = sizes;
      return u as unknown as ReturnType<typeof stub.command>;
    };
    const idOf = (u: ReturnType<ReturnType<typeof stubBot>['command']>): string =>
      String((u as unknown as { message: { message_id: number } }).message.message_id);
    const SMALL = { file_id: 'small', file_unique_id: 's', width: 90, height: 60 };
    const LARGE = {
      file_id: 'large',
      file_unique_id: 'l',
      width: 1280,
      height: 853,
      file_size: 90_000,
    };

    it('keeps the photos it hears and sends, and downloads the largest when asked', async () => {
      const ids: string[] = [];
      const { c, stub, docs } = connector({
        download: (id) => (ids.push(id), Promise.resolve(JPEG)),
      });
      const photo = withPhoto(stub, -100123, [SMALL, LARGE]);
      const text = stub.command(-100123, 5, 'just words');
      await stub.bot.handleUpdate(photo);
      await stub.bot.handleUpdate(text);
      expect(await c.photo('-100123', idOf(photo))).toEqual({
        data: JPEG,
        mime: 'image/jpeg',
        width: 1280,
        height: 853,
      });
      expect(ids).toEqual(['large']);
      // A message it heard without a photo has none.
      expect(await c.photo('-100123', idOf(text))).toBeNull();
      // Its own, sent: kept by its chat and the id Telegram gave it.
      const sent = await c.deliverPhoto('-100123', { data: JPEG, filename: 'room.jpg' });
      await c.photo('-100123', sent.id ?? '');
      expect(ids.at(-1)).toBe(`photo-${sent.id}`);
      expect(Object.keys(docs[PHOTOS_DOC] as object)).toEqual([
        `-100123 ${idOf(photo)}`,
        `-100123 ${sent.id}`,
      ]);
    });

    it('fetches a photo kept before a restart, by any name of its chat', async () => {
      const first = connector({ download: () => Promise.resolve(JPEG) });
      const u = withPhoto(first.stub, 5, [LARGE]);
      await first.stub.bot.handleUpdate(u);
      const again = connector({ docs: first.docs, download: () => Promise.resolve(JPEG) });
      expect(await again.c.photo('5', idOf(u))).toMatchObject({ width: 1280 });
      // A private chat named by its @username, once seen.
      await again.stub.bot.handleUpdate(again.stub.command(5, 5, '/start', 'ada'));
      expect(await again.c.photo('@ada', idOf(u))).toMatchObject({ width: 1280 });
    });

    it('refuses what it cannot fetch, with why', async () => {
      const { c, stub } = connector({
        chats: ['-100123'],
        download: () => Promise.reject(new Error('HTTP 502')),
      });
      await expect(c.photo('-100999', '1')).rejects.toThrow(
        '-100999 is not a chat telegram-bot:ExampleBot monitors'
      );
      await expect(c.photo('-100123', '77')).rejects.toThrow(
        `no photo of message 77 in -100123 kept: ${PHOTO_UNKNOWN}`
      );
      const big = withPhoto(stub, -100123, [{ ...LARGE, file_size: 11 * 1024 * 1024 }]);
      await stub.bot.handleUpdate(big);
      await expect(c.photo('-100123', idOf(big))).rejects.toThrow(
        'the photo is 11.0 MiB, more than the 10.0 MiB a photo may be'
      );
      const ok = withPhoto(stub, -100123, [SMALL]);
      await stub.bot.handleUpdate(ok);
      await expect(c.photo('-100123', idOf(ok))).rejects.toThrow(
        `the photo of message ${idOf(ok)} could not be downloaded: HTTP 502`
      );
      // A photo in a chat it does not monitor is not kept.
      const elsewhere = withPhoto(stub, -100999, [SMALL]);
      await stub.bot.handleUpdate(elsewhere);
      expect(Object.keys(c['photos'] as object)).toHaveLength(2);
    });

    it("says Telegram's wait, and reads a PNG's type from its bytes", async () => {
      const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      let answer: Promise<Uint8Array> = Promise.resolve(PNG);
      const { c, stub } = connector({ download: () => answer });
      const u = withPhoto(stub, -100123, [SMALL]);
      await stub.bot.handleUpdate(u);
      expect(await c.photo('-100123', idOf(u))).toMatchObject({ mime: 'image/png' });
      answer = Promise.reject(
        new GrammyError(
          'slow down',
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 9 },
          },
          'getFile',
          {}
        )
      );
      await expect(c.photo('-100123', idOf(u))).rejects.toThrow('Telegram asks to wait 9 s');
      answer = Promise.reject('odd');
      await expect(c.photo('-100123', idOf(u))).rejects.toThrow('could not be downloaded: odd');
    });

    it(`keeps the latest ${PHOTOS_KEPT} photos, and as many messages without one`, async () => {
      const { c, stub, docs } = connector({ download: () => Promise.resolve(JPEG) });
      const first = withPhoto(stub, -100123, [SMALL]);
      const plain = stub.command(-100123, 5, 'words');
      await stub.bot.handleUpdate(first);
      await stub.bot.handleUpdate(plain);
      for (let i = 0; i < PHOTOS_KEPT; i++) {
        await stub.bot.handleUpdate(withPhoto(stub, -100123, [SMALL]));
        await stub.bot.handleUpdate(stub.command(-100123, 5, 'words'));
      }
      expect(Object.keys(docs[PHOTOS_DOC] as object)).toHaveLength(PHOTOS_KEPT);
      await expect(c.photo('-100123', idOf(first))).rejects.toThrow(PHOTO_UNKNOWN);
      await expect(c.photo('-100123', idOf(plain))).rejects.toThrow(PHOTO_UNKNOWN);
    }, 30_000);
  });
});

describe('adminIn', () => {
  const me = () => ({ id: 1 });
  const api = (status: string | Error) => ({
    getChatMember: () =>
      status instanceof Error ? Promise.reject(status) : Promise.resolve({ status }),
  });

  it('says whether the bot is an admin or the creator of the group, as Telegram says', async () => {
    expect(await adminIn(api('member'), -100, me)).toBe(false);
    expect(await adminIn(api('administrator'), -100, me)).toBe(true);
    expect(await adminIn(api('creator'), -100, me)).toBe(true);
  });

  it('says no when Telegram does not say, or the bot is not connected yet', async () => {
    expect(await adminIn(api(new Error('400')), -100, me)).toBe(false);
    expect(await adminIn(api('administrator'), -100, () => undefined)).toBe(false);
  });

  it('asks Telegram about the connector’s own bot, once connected', async () => {
    const stub = stubBot();
    const c = new TelegramBotConnector({
      account: 'telegram-bot:ExampleBot',
      bot: stub.bot,
      log: () => {},
    });
    expect(await c.isAdmin('-100')).toBe(false);
    expect(stub.calls.at(-1)).toMatchObject({
      method: 'getChatMember',
      payload: { chat_id: -100, user_id: 1 },
    });
  });
});
