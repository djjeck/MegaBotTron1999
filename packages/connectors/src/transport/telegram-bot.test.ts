import { FloodWait, type Inbound } from '@megabottron1999/core';
import { BotError, type Context, GrammyError } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import {
  adminIn,
  createBot,
  downloadFile,
  type Startable,
  startBotWithRetry,
  surfaceOf,
  SURFACES_DOC,
  TelegramBotConnector,
} from './telegram-bot.ts';

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
      download?: (fileId: string) => Promise<Uint8Array>;
    } = {}
  ) {
    const stub = stubBot();
    const docs: Record<string, unknown> = {};
    const logs: string[] = [];
    const states: string[] = [];
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
      store: {
        read: <T>(name: string) => docs[name] as T | undefined,
        write: (name, value) => {
          docs[name] = structuredClone(value);
        },
      },
      now: () => 10_000,
      sleep: () => Promise.resolve(),
      ...(o.download === undefined ? {} : { download: o.download }),
    });
    c.onStatus((s) => states.push(`${s.state} ${s.phase}`));
    return { c, stub, logs, states, docs, polls: () => polls };
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
    });
    expect(heard[1]?.sender).toBe('');
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
    const { c, stub } = connector({ chats: ['-100123', '@lobby_chat'] });
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
    await stub.bot.handleUpdate(at(stub.command(-100123, 5, '/map'), 10));
    await stub.bot.handleUpdate(at(stub.command(-100777, 5, '/map'), 10, 'Lobby_Chat'));
    await stub.bot.handleUpdate(at(stub.command(-100999, 5, '/map'), 10));
    expect(heard.map((m) => [m.chat, m.playback, m.missed])).toEqual([
      ['-100123', true, true],
      ['-100123', false, undefined],
      ['-100777', false, undefined],
    ]);
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

  it('names a chat by its username when it has no title', () => {
    expect(surfaceOf({ id: 1, type: 'private', first_name: '', username: 'ada_x' })).toEqual({
      id: '1',
      title: '@ada_x',
      kind: 'private',
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
