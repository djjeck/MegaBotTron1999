import {
  Core,
  definePlugin,
  type Graph,
  type GraphEdge,
  VirtualClock,
} from '@megabottron1999/core';
import { secretsWith } from '@megabottron1999/core/test/secrets.ts';
import { describe, expect, it } from 'vitest';
import { readWarnings } from '#test/monitors.ts';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import { telegramBotConfig, telegramBotPlugin } from './telegram-bot.ts';

const AUTHOR = 4242;
const GROUP = -100123;

/** The default graph with a commands edge from the bot to the pinger (D109), as `edge` says. */
const served =
  (edge: Partial<GraphEdge> = {}) =>
  (d: Graph): Graph => ({
    ...d,
    edges: [
      ...d.edges,
      {
        from: 'telegram-bot.commands',
        to: 'pinger.commands',
        type: 'commands',
        chats: [String(AUTHOR), String(GROUP)],
        privateChats: true,
        ...edge,
      },
    ],
  });

/** A plugin of one command, `/ping`, that answers `pong`. */
const pinger = () =>
  definePlugin({
    manifest: {
      id: 'pinger',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'answers',
      interface: { commands: { ping: { help: 'ping', menu: 'il ping' } } },
    },
    create: () => ({ commands: { ping: { run: (a) => a.text('pong') } } }),
  });

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
    // The send-queue watchdog's threshold, by default (D93).
    expect(connector?.limits).toEqual({ commandIntervalMs: 0, unansweredAt: 10 });
    expect(connector?.status().state).toBe('connecting');
    listen();
    await new Promise((r) => setImmediate(r));
    expect(polling).toBe(true);
    expect(connector?.status().state).toBe('connected');
    await core.stop();
    expect(polling).toBe(false);
  });

  it('monitors the chats of its config, or every chat: the check warns of one read beside (D89, D90)', () => {
    const plugin = telegramBotPlugin();
    expect(readWarnings(plugin, undefined, ['@QuestBot', String(GROUP)])).toEqual([]);
    // Not running: a chat named otherwise cannot be told.
    expect(readWarnings(plugin, { chats: [String(GROUP)] }, [String(GROUP), '@QuestBot'])).toEqual(
      []
    );
    // Running: the group seen as @lobby_group too, the bot's chat never.
    const both = [String(GROUP), '@lobby_group'];
    const names = (chat: string) =>
      ({ [String(GROUP)]: both, '@lobby_group': both })[chat.toLowerCase()];
    expect(
      readWarnings(plugin, { chats: [String(GROUP)] }, ['@Lobby_Group', '@QuestBot'], names)
    ).toEqual([
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

  it('is the owner’s chat surface: it answers, sets the menus, then polls; it tells nothing itself', async () => {
    const stub = stubBot();
    let polling = false;
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => ((polling = true), new Promise<void>(() => {}));
    stub.bot.stop = () => Promise.resolve();
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
      config: { 'telegram-bot': { owner: AUTHOR, group: GROUP, unansweredAtBy: { '/turn': 2 } } },
      graph: served(),
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
          // A notice (D94): no chat is sent it, with no owner-notice in the graph.
          ctx.notify('starting');
          return { commands: { ping: { run: (a) => a.text('pong') } } };
        },
      })
    );
    await core.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(polling).toBe(true);
    expect(core.connector('telegram-bot')?.limits?.unansweredAtBy).toEqual({ '/turn': 2 });
    // Its owner's chat, where owner-notice tells by default (D95).
    expect(core.connector('telegram-bot')?.owner?.()).toBe(String(AUTHOR));
    expect(core.notices().map((n) => `${n.kind} ${n.text}`)).toEqual(['told starting']);
    const sent = () =>
      stub.calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => `${String(c.payload['chat_id'])} ${String(c.payload['text'])}`);
    expect(sent()).toEqual([]);
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
    expect(sent().slice(0, 1)).toEqual([`${GROUP} pong`]);
    expect(sent()[1]).toMatch(/^4242 The bot is on\./u);
    await core.stop();
  });

  it('sends buttons to the owner’s chat through its surface, and text alone elsewhere', async () => {
    const stub = stubBot();
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => new Promise<void>(() => {});
    stub.bot.stop = () => Promise.resolve();
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
      config: { 'telegram-bot': { owner: AUTHOR } },
    });
    core.register(telegramBotPlugin({ bot: () => stub.bot }));
    await core.start();
    await new Promise((r) => setTimeout(r, 20));
    const c = core.connector('telegram-bot');
    const buttons = [[{ label: 'Kill', action: 'kill' }]];
    await c?.deliver?.(String(AUTHOR), 'pick one', { buttons });
    await c?.deliver?.(String(GROUP), 'no buttons here', { buttons });
    c?.send(String(AUTHOR), 'sent and forgotten', { buttons });
    await new Promise((r) => setTimeout(r, 20));
    const msgs = stub.calls.filter((x) => x.method === 'sendMessage');
    expect(msgs.map((x) => [x.payload['chat_id'], x.payload['text']])).toEqual([
      [AUTHOR, 'pick one'],
      [GROUP, 'no buttons here'],
      [AUTHOR, 'sent and forgotten'],
    ]);
    expect(JSON.stringify(msgs[0]?.payload['reply_markup'])).toContain('Kill');
    expect(msgs[1]?.payload['reply_markup']).toBeUndefined();
    expect(JSON.stringify(msgs[2]?.payload['reply_markup'])).toContain('Kill');
    await core.stop();
  });

  it('drops the group commands of those it denies, records and counts each (D100)', async () => {
    const stub = stubBot();
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => new Promise<void>(() => {});
    stub.bot.stop = () => Promise.resolve();
    const records: { type: string }[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
      record: (r) => void records.push(r as { type: string }),
      config: { 'telegram-bot': { owner: AUTHOR, group: GROUP, deny: ['66'] } },
      graph: served(),
    });
    core.register(telegramBotPlugin({ bot: () => stub.bot }), pinger());
    await core.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(core.controls.view('telegram-bot')).toMatchObject({ value: { state: { count: 0 } } });
    expect(core.controls.status().plugins.find((p) => p.id === 'telegram-bot')?.summary).toBe(
      undefined
    );
    await stub.bot.handleUpdate(stub.command(GROUP, 66, '/ping'));
    await stub.bot.handleUpdate(stub.command(66, 66, '/ping'));
    await new Promise((r) => setTimeout(r, 20));
    const sent = stub.calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => `${String(c.payload['chat_id'])} ${String(c.payload['text'])}`);
    expect(sent).toEqual(['66 pong']);
    expect(records.filter((r) => r.type === 'telegram-bot.denied')).toEqual([
      expect.objectContaining({
        type: 'telegram-bot.denied',
        chat: String(GROUP),
        sender: '66',
        command: '/ping',
        replied: false,
      }),
    ]);
    expect(core.controls.view('telegram-bot')).toMatchObject({
      value: { state: { count: 1, last: { sender: '66' } } },
    });
    expect(core.controls.status().plugins.find((p) => p.id === 'telegram-bot')?.summary).toBe(
      '1 command denied'
    );
    await core.stop();
  });

  it('answers a plugin’s command only where and to whom an edge serves it (D109)', async () => {
    const run = async (graph?: (d: Graph) => Graph) => {
      const stub = stubBot();
      stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
      stub.bot.start = () => new Promise<void>(() => {});
      stub.bot.stop = () => Promise.resolve();
      const records: { type: string; origin?: string; outcome?: string; chat?: string }[] = [];
      const core = new Core({
        clock: new VirtualClock(),
        secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
        record: (r) => void records.push(r as (typeof records)[number]),
        config: { 'telegram-bot': { owner: AUTHOR, group: GROUP } },
        ...(graph === undefined ? {} : { graph }),
      });
      core.register(telegramBotPlugin({ bot: () => stub.bot }), pinger());
      await core.start();
      await new Promise((r) => setTimeout(r, 20));
      await stub.bot.handleUpdate(stub.command(GROUP, 7, '/ping', 'bob'));
      await stub.bot.handleUpdate(stub.command(55, 55, '/ping', 'carol'));
      await stub.bot.handleUpdate(stub.command(AUTHOR, AUTHOR, '/ping'));
      await new Promise((r) => setTimeout(r, 20));
      await core.stop();
      const menus = stub.calls
        .filter((c) => c.method === 'setMyCommands')
        .map(
          (c) =>
            `${JSON.stringify(c.payload['scope'])} ${(c.payload['commands'] as { command: string }[]).map((x) => x.command).join(',')}`
        );
      const sent = stub.calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => `${String(c.payload['chat_id'])} ${String(c.payload['text'])}`);
      return { menus, sent, answers: records.filter((r) => r.origin === 'command /ping') };
    };
    // No edge, no chat command: listed nowhere, answered nowhere; the owner's controls stay.
    const none = await run();
    expect(none.sent).toEqual([]);
    expect(none.menus.some((m) => m.includes('ping'))).toBe(false);
    expect(none.menus).toContain(`{"type":"chat","chat_id":${AUTHOR}} plugins,kill,settings,set`);
    // The group alone: answered there, and listed in its menu alone.
    const group = await run(served({ chats: [String(GROUP)], privateChats: undefined }));
    expect(group.sent).toEqual([`${GROUP} pong`]);
    expect(group.menus).toContain(`{"type":"all_private_chats"} `);
    expect(group.answers).toEqual([
      expect.objectContaining({ outcome: 'sent', chat: String(GROUP) }),
    ]);
    // Every private chat, to the owner and to carol only: the group's ask is ignored.
    const asked = await run(served({ chats: [], senders: ['owner', '@Carol'] }));
    expect(asked.sent).toEqual(['55 pong', `${AUTHOR} pong`]);
    // A dry run answers nothing, and logs what it would have.
    const dry = await run(served({ dryRun: true }));
    expect(dry.sent).toEqual([]);
    expect(dry.answers.map((r) => `${r.outcome} ${r.chat}`)).toEqual([
      `dry-run ${GROUP}`,
      'dry-run 55',
      `dry-run ${AUTHOR}`,
    ]);
  });

  it('ends the core’s cards with the way home its config names (D105)', async () => {
    const stub = stubBot();
    stub.bot.api.getMe = () => Promise.resolve(BOT_INFO);
    stub.bot.start = () => new Promise<void>(() => {});
    stub.bot.stop = () => Promise.resolve();
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith({ telegram_bot_token: '1:abcdef' }),
      config: { 'telegram-bot': { owner: AUTHOR, home: '/menu' } },
    });
    core.register(telegramBotPlugin({ bot: () => stub.bot }));
    await core.start();
    await new Promise((r) => setTimeout(r, 20));
    await stub.bot.handleUpdate(stub.command(AUTHOR, AUTHOR, '/plugins'));
    await new Promise((r) => setTimeout(r, 20));
    const card = stub.calls.find((c) => c.method === 'sendMessage');
    const rows = (card?.payload['reply_markup'] as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    expect(rows.at(-1)?.map((b) => b.text)).toEqual(['🏠 Home']);
    await core.stop();
    // Its form: a command as typed or short, within a button's 64 bytes; a label of its own.
    const parse = (c: Record<string, unknown>) => telegramBotConfig.safeParse(c);
    expect(parse({ home: 'menu' }).data?.homeLabel).toBe('🏠 Home');
    expect(parse({ home: '/menu main', homeLabel: '⬅️ Back' }).success).toBe(true);
    expect(parse({ home: 'menu:main' }).success).toBe(true);
    for (const bad of ['', 'two words', '/', `/${'m'.repeat(64)}`, '/menu\nx'])
      expect(parse({ home: bad }).success, bad).toBe(false);
    expect(parse({ homeLabel: '' }).success).toBe(false);
  });

  it('never denies its owner, and replies in one line (D100)', () => {
    expect(
      telegramBotConfig.safeParse({ owner: AUTHOR, deny: [String(AUTHOR)] }).error?.issues
    ).toEqual([expect.objectContaining({ path: ['deny'], message: 'its owner cannot be denied' })]);
    expect(telegramBotConfig.safeParse({ deny: [String(AUTHOR)] }).success).toBe(true);
    expect(telegramBotConfig.safeParse({ denyReply: 'one\ntwo' }).success).toBe(false);
  });
});
