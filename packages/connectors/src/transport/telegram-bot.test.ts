import { FloodWait, type Inbound } from '@megabottron1999/core';
import { BotError, type Context, GrammyError } from 'grammy';
import { type UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import {
  adminIn,
  createBot,
  type Startable,
  startBotWithRetry,
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

  function connector(o: { listen?: Promise<unknown> } = {}) {
    const stub = stubBot();
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
      sleep: () => Promise.resolve(),
    });
    c.onStatus((s) => states.push(`${s.state} ${s.phase}`));
    return { c, stub, logs, states, polls: () => polls };
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
