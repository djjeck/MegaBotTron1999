import { Core, definePlugin, VirtualClock } from '@megabottron1999/core';
import { secretsWith } from '@megabottron1999/core/test/secrets.ts';
import { describe, expect, it } from 'vitest';
import { readWarnings } from '#test/monitors.ts';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import { telegramBotPlugin } from './telegram-bot.ts';

const AUTHOR = 4242;
const GROUP = -100123;

describe('the telegram-bot plugin', () => {
  it('makes the bot from its own secret, polls once the app listens, and stops it', async () => {
    const tokens: string[] = [];
    const stub = stubBot();
    let polling = false;
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => ((polling = true), new Promise<void>(() => {}));
    stub.bot.stop = () => ((polling = false), Promise.resolve());
    let listen: () => void = () => {};
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
    });
    core.register(
      telegramBotPlugin({
        listen: new Promise<void>((r) => (listen = r)),
        bot: (token) => (tokens.push(token), stub.bot),
      })
    );
    await core.start();
    expect(tokens).toEqual(['1:abcdef']);
    const connector = core.connector('telegram-bot');
    expect(connector?.account).toBe('telegram-bot:bot');
    expect(connector?.status().state).toBe('connecting');
    listen();
    await new Promise((r) => setImmediate(r));
    expect(polling).toBe(true);
    expect(connector?.status().state).toBe('connected');
    await core.stop();
    expect(polling).toBe(false);
  });

  it('monitors the chats of its config, or every chat: the check warns of one read beside (D89)', () => {
    const plugin = telegramBotPlugin();
    expect(readWarnings(plugin, undefined, ['@QuestBot', String(GROUP)])).toEqual([]);
    expect(readWarnings(plugin, { chats: [String(GROUP)] }, [String(GROUP), '@QuestBot'])).toEqual([
      `node quest: input port chat reads @QuestBot, which conn does not monitor (its chats: ${GROUP}) (edge conn → quest.chat)`,
    ]);
  });

  it('makes a real grammY bot by default', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
    });
    core.register(telegramBotPlugin({ name: 'OtherBot', listen: new Promise(() => {}) }));
    await core.start();
    expect(core.connector('telegram-bot')?.account).toBe('telegram-bot:OtherBot');
    expect(typeof core.connector('telegram-bot')?.isAdmin).toBe('function');
  });

  it('is a chat surface without a group, with the sleep it is given', async () => {
    const stub = stubBot();
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => new Promise<void>(() => {});
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
      config: { 'telegram-bot': { owner: AUTHOR } },
    });
    core.register(telegramBotPlugin({ bot: () => stub.bot, sleep: () => Promise.resolve() }));
    await core.start();
    expect(core.state('telegram-bot')?.state).toBe('running');
    await core.stop();
  });

  it('is the owner’s chat surface: it tells, answers, sets the menus, then polls', async () => {
    const stub = stubBot();
    let polling = false;
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => ((polling = true), new Promise<void>(() => {}));
    stub.bot.stop = () => Promise.resolve();
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
      config: { 'telegram-bot': { owner: AUTHOR, group: GROUP } },
      owner: 'telegram-bot',
    });
    core.register(
      telegramBotPlugin({ bot: () => stub.bot }),
      definePlugin({
        manifest: {
          id: 'pinger',
          version: '0.1.0',
          kinds: ['stats'],
          description: 'answers',
          interface: { commands: { ping: { help: 'ping', menu: 'il ping' } } },
        },
        create: (ctx) => {
          // Told before the surface is served: it waits, in order.
          ctx.notify('starting');
          return { commands: { ping: { run: (a) => a.text('pong') } } };
        },
      })
    );
    core.notify('first');
    await core.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(polling).toBe(true);
    const sent = () =>
      stub.calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => `${String(c.payload['chat_id'])} ${String(c.payload['text'])}`);
    expect(sent()).toEqual([`${AUTHOR} first`, `${AUTHOR} starting`]);
    // The menus, once connected: the owner's (every command but the hidden), the group's and the
    // other private chats' (the players').
    const menus = stub.calls
      .filter((c) => c.method === 'setMyCommands')
      .map((c) => (c.payload['commands'] as { command: string }[]).map((x) => x.command).join(','));
    expect(menus).toEqual(
      expect.arrayContaining(['ping,plugins,kill,settings,set', 'ping', 'ping'])
    );
    await stub.bot.handleUpdate(stub.command(GROUP, 7, '/ping'));
    await stub.bot.handleUpdate(stub.command(AUTHOR, AUTHOR, '/plugins'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent().slice(2, 3)).toEqual([`${GROUP} pong`]);
    expect(sent()[3]).toMatch(/^4242 The bot is on\./u);
    core.controls.turnOff();
    core.notify('silent');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent()).toHaveLength(4);
    await core.stop();
  });

  it('prints the notices for an owner’s surface that never started', async () => {
    const lines: string[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      owner: 'telegram-bot',
      print: (l) => lines.push(l),
    });
    core.notify('lost');
    await core.start();
    expect(lines).toEqual(['core: not told (no telegram-bot): lost']);
  });
});
