import { type Asker, type ChatCommand } from '@megabottron1999/core';
import { Switchboard } from 'grammy-switchboard';
import { describe, expect, it } from 'vitest';
import { callbackData, stubBot } from '#test/telegram.ts';
import {
  chatMenus,
  type Handlers,
  installPublicCommands,
  PER_CHAT_MS,
  PER_USER_MS,
  type PublicCommandsOptions,
  registerPrivateMenu,
  surfaceOf,
  Throttle,
} from './telegram-commands.ts';
import { AUTHOR_TOPIC, telegramTopics } from './telegram-switchboard.ts';

const AUTHOR = 4242;
const GROUP = -100123;
/** Another group an edge names: its own throttles. */
const OTHER = -100777;
const PLAYER = 7;
const T0 = Date.UTC(2026, 9, 27, 18, 0, 0);

const PUBLIC_MENU = [
  { command: 'map', description: 'La mappa delle case dei giocatori' },
  { command: 'countdown', description: 'conto alla rovescia' },
];
const AUTHOR_MENU = [
  { command: 'map', description: "The map of the players' homes" },
  { command: 'countdown', description: 'The countdown' },
];

/**
 * The public commands on a real switchboard with the author's chat and the group, fed through a
 * stub bot: `/map` answers with a photo, a Markdown caption under it, and reports its file id, `/ping` with a line, `/bold` with a
 * line in Markdown, `/brief` with a line to delete from the group in a minute; `/pong` is an alias of `/ping`, and
 * `/nothing` of no command. `run()` runs what was scheduled.
 */
function chats(handlers?: Handlers, allow?: PublicCommandsOptions['allow']) {
  const stub = stubBot();
  const switchboard = new Switchboard({
    api: stub.bot.api,
    topics: telegramTopics(AUTHOR),
    commands: {
      [AUTHOR_TOPIC]: [
        { command: 'status', description: 'Status' },
        ...AUTHOR_MENU,
        { command: 'brief', description: 'Brief' },
      ],
    },
  });
  const fileIds: (string | undefined)[] = [];
  let now = T0;
  const warned: string[] = [];
  const scheduled: { ms: number; fn: () => void }[] = [];
  stub.bot.use(switchboard);
  const answering: Handlers = handlers ?? {
    map: async (a) =>
      void fileIds.push(
        await a.photo({ data: Buffer.from([1]), mime: 'image/png' }, 'the **map**', 'markdown')
      ),
    ping: (a) => a.text('pong'),
    bold: (a) => a.text('**pong** & <ping>', 'markdown'),
    brief: (a) => a.text('gone soon', undefined, { deleteInGroupAfterMs: 60_000 }),
  };
  // As an edge naming the group and every private chat would serve them (D109).
  const served = Object.fromEntries(
    Object.keys(answering).map((name) => [
      name,
      (chat: { id: number; type: string }) =>
        chat.id === GROUP || chat.id === OTHER || chat.type === 'private',
    ])
  );
  installPublicCommands(switchboard, stub.bot, {
    handlers: answering,
    served,
    aliases: { pong: 'ping', nothing: 'none' },
    ...(allow && { allow }),
    authorId: AUTHOR,
    now: () => now,
    schedule: (ms, fn) => void scheduled.push({ ms, fn }),
    warn: (l) => warned.push(l),
  });
  const run = async () => {
    for (const s of scheduled.splice(0)) s.fn();
    await new Promise((r) => setTimeout(r, 10));
  };
  const feed = async (chat: number, from: number, text: string, username?: string) => {
    await stub.bot.handleUpdate(stub.command(chat, from, text, username));
    await new Promise((r) => setTimeout(r, 10));
  };
  /** Taps the button with callback data `data` on the last message sent to `chat`. */
  const press = async (chat: number, from: number, data: string, username?: string) => {
    const last = sent()
      .filter((c) => c.payload['chat_id'] === chat)
      .at(-1);
    const message = Number(last?.payload['message_id'] ?? lastId(chat));
    await stub.bot.handleUpdate(stub.tap(chat, from, data, message, username));
    await new Promise((r) => setTimeout(r, 10));
  };
  // The message id the stub gave the last message sent to a chat.
  const ids = new Map<number, number>();
  stub.bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    const r = (res as { result?: { message_id?: number } }).result;
    const chat = (payload as { chat_id?: number }).chat_id;
    if (method === 'sendMessage' && chat !== undefined && r?.message_id !== undefined)
      ids.set(chat, r.message_id);
    return res;
  });
  const lastId = (chat: number) => ids.get(chat) ?? 0;
  const edits = () =>
    stub.calls
      .filter((c) => c.method === 'editMessageText')
      .map((c) => [c.payload['chat_id'], c.payload['message_id'], c.payload['text']]);
  const sent = () =>
    stub.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendMessage');
  const to = () => sent().map((c) => c.payload['chat_id']);
  const deleted = () =>
    stub.calls
      .filter((c) => c.method === 'deleteMessage')
      .map((c) => [c.payload['chat_id'], c.payload['message_id']]);
  return {
    ...stub,
    feed,
    press,
    lastId,
    edits,
    sent,
    to,
    fileIds,
    warned,
    scheduled,
    run,
    deleted,
    later: (ms: number) => void (now += ms),
  };
}

describe('installPublicCommands', () => {
  it('answers in the group, in reply, with the photo and its file id', async () => {
    const c = chats();
    await c.feed(GROUP, 1, '/map');
    await c.feed(GROUP, 2, '/ping@ExampleBot');
    const [photo, line] = c.sent();
    expect(photo?.method).toBe('sendPhoto');
    expect(photo?.payload).toMatchObject({
      chat_id: GROUP,
      caption: 'the <b>map</b>',
      parse_mode: 'HTML',
    });
    expect(JSON.stringify(photo?.payload['reply_parameters'])).toMatch(/"message_id":\d+/u);
    // The largest size's id.
    expect(c.fileIds).toEqual([expect.stringMatching(/^photo-\d+$/u)]);
    expect(line?.payload).toMatchObject({ chat_id: GROUP, text: 'pong' });
    expect(c.warned).toEqual([]);
  });

  it("answers in the author's chat without a throttle, through the switchboard alone", async () => {
    const c = chats();
    await c.feed(GROUP, 1, '/map');
    await c.feed(AUTHOR, AUTHOR, '/map');
    await c.feed(AUTHOR, AUTHOR, '/map');
    expect(c.to()).toEqual([GROUP, AUTHOR, AUTHOR]);
    // Its caption, formatted by the switchboard (D150).
    expect(c.sent()[1]?.payload).toMatchObject({ caption: 'the <b>map</b>', parse_mode: 'HTML' });
  });

  it("answers in anyone's private chat, once per user a minute", async () => {
    const c = chats();
    await c.feed(PLAYER, PLAYER, '/map');
    await c.feed(PLAYER, PLAYER, '/map');
    await c.feed(8, 8, '/map@ExampleBot');
    expect(c.to()).toEqual([PLAYER, 8]);
    const [first] = c.sent();
    expect(JSON.stringify(first?.payload['reply_parameters'])).toMatch(/"message_id":\d+/u);
    expect(c.fileIds).toEqual([
      expect.stringMatching(/^photo-\d+$/u),
      expect.stringMatching(/^photo-\d+$/u),
    ]);
    c.later(PER_USER_MS);
    await c.feed(PLAYER, PLAYER, '/map');
    expect(c.to()).toEqual([PLAYER, 8, PLAYER]);
  });

  it('answers a line in a private chat in reply too', async () => {
    const c = chats();
    await c.feed(PLAYER, PLAYER, '/ping');
    expect(c.sent()[0]?.payload).toMatchObject({ chat_id: PLAYER, text: 'pong' });
  });

  it('sends Markdown as Telegram HTML, through the switchboard and in a private chat', async () => {
    const c = chats();
    await c.feed(GROUP, 1, '/bold');
    await c.feed(PLAYER, PLAYER, '/bold');
    const html = { text: '<b>pong</b> &amp; &lt;ping&gt;', parse_mode: 'HTML' };
    expect(c.sent().map((s) => s.payload)).toMatchObject([
      { chat_id: GROUP, ...html },
      { chat_id: PLAYER, ...html },
    ]);
  });

  it('deletes an answer from the group when its handler asks, and keeps it in private chats', async () => {
    const c = chats({
      brief: (a) => a.text('gone soon', undefined, { deleteInGroupAfterMs: 60_000 }),
      ping: (a) => a.text('pong'),
    });
    await c.feed(GROUP, 1, '/brief');
    await c.feed(GROUP, 2, '/ping');
    await c.feed(AUTHOR, AUTHOR, '/brief');
    await c.feed(PLAYER, PLAYER, '/brief');
    expect(c.sent().map((s) => [s.payload['chat_id'], s.payload['text']])).toEqual([
      [GROUP, 'gone soon'],
      [GROUP, 'pong'],
      [AUTHOR, 'gone soon'],
      [PLAYER, 'gone soon'],
    ]);
    expect(c.scheduled.map((s) => s.ms)).toEqual([60_000]);
    expect(c.deleted()).toEqual([]);
    await c.run();
    expect(c.deleted()).toEqual([[GROUP, expect.any(Number)]]);
    expect(c.warned).toEqual([]);
  });

  it('deletes an alias answer from the group too', async () => {
    const c = chats({
      ping: (a) => a.text('pong', undefined, { deleteInGroupAfterMs: 60_000 }),
    });
    await c.feed(GROUP, 1, '/pong');
    await c.feed(AUTHOR, AUTHOR, '/pong');
    await c.feed(PLAYER, PLAYER, '/pong');
    expect(c.to()).toEqual([GROUP, AUTHOR, PLAYER]);
    await c.run();
    expect(c.deleted()).toEqual([[GROUP, expect.any(Number)]]);
  });

  it('reports a deletion that fails', async () => {
    const c = chats();
    c.bot.api.config.use((prev, method, payload, signal) =>
      method === 'deleteMessage'
        ? Promise.reject(new Error('400: message to delete not found'))
        : prev(method, payload, signal)
    );
    await c.feed(GROUP, 1, '/brief');
    await c.run();
    expect(c.warned).toEqual(['brief: delete failed: Error: 400: message to delete not found']);
  });

  it('is ignored elsewhere, when addressed to another bot, and for other commands', async () => {
    const c = chats();
    await c.feed(GROUP, 1, '/map@AnotherBot');
    await c.feed(AUTHOR, AUTHOR, '/map@AnotherBot');
    await c.feed(PLAYER, PLAYER, '/map@AnotherBot');
    await c.feed(PLAYER, PLAYER, '/status');
    await c.feed(AUTHOR, AUTHOR, '/status');
    await c.feed(-100999, 1, '/map');
    expect(c.sent()).toEqual([]);
  });

  it('answers in the group once per user a minute and once in 10 s, each command apart', async () => {
    const c = chats();
    await c.feed(GROUP, 1, '/map');
    await c.feed(GROUP, 2, '/map');
    await c.feed(GROUP, 1, '/ping');
    c.later(PER_CHAT_MS);
    await c.feed(GROUP, 1, '/map');
    await c.feed(GROUP, 2, '/map');
    expect(c.sent().map((s) => s.method)).toEqual(['sendPhoto', 'sendMessage', 'sendPhoto']);
    c.later(PER_USER_MS - PER_CHAT_MS);
    await c.feed(GROUP, 1, '/map');
    expect(c.sent()).toHaveLength(4);
    // Another group, its own throttles (D128): answered at once, and deleted from there too.
    await c.feed(OTHER, 1, '/map');
    await c.feed(OTHER, 1, '/brief');
    expect(c.to().slice(4)).toEqual([OTHER, OTHER]);
    expect(c.scheduled).toHaveLength(1);
  });

  it('answers an alias as its command, with its throttles, in the same chats', async () => {
    const c = chats();
    await c.feed(GROUP, 1, '/pong@ExampleBot');
    await c.feed(GROUP, 1, '/ping');
    await c.feed(AUTHOR, AUTHOR, '/pong');
    await c.feed(AUTHOR, AUTHOR, '/pong');
    await c.feed(PLAYER, PLAYER, '/ping');
    await c.feed(PLAYER, PLAYER, '/pong');
    await c.feed(8, 8, '/pong');
    expect(c.sent().map((s) => [s.payload['chat_id'], s.payload['text']])).toEqual([
      [GROUP, 'pong'],
      [AUTHOR, 'pong'],
      [AUTHOR, 'pong'],
      [PLAYER, 'pong'],
      [8, 'pong'],
    ]);
    expect(JSON.stringify(c.sent()[0]?.payload['reply_parameters'])).toMatch(/"message_id":\d+/u);
  });

  it('ignores an alias elsewhere, addressed to another bot, or of no command', async () => {
    const c = chats();
    await c.feed(-100999, 1, '/pong');
    await c.feed(GROUP, 1, '/pong@AnotherBot');
    await c.feed(PLAYER, PLAYER, '/nothing');
    expect(c.sent()).toEqual([]);
  });

  it("makes the switchboard's view of the plugins' commands: handlers, checks, aliases, menus", async () => {
    const ran: string[] = [];
    const command = (name: string, more: Partial<ChatCommand> = {}): ChatCommand => ({
      plugin: 'p',
      name,
      help: `${name} help`,
      aliases: [],
      owner: false,
      hidden: false,
      run: (_a, r) => (ran.push(`${name} ${r.args}`), Promise.resolve()),
      ...more,
    });
    const owner = (who: Asker) => who.owner === true;
    const everywhere = { chats: [String(AUTHOR), String(GROUP)], privateChats: true };
    const surface = surfaceOf(
      [
        command('map', { menu: 'la mappa', where: everywhere }),
        command('countdown', { menu: 'conto', aliases: ['timer', 'clock'], where: everywhere }),
        command('report', { aliases: ['stats'], allow: owner, where: everywhere }),
      ],
      { author: AUTHOR }
    );
    expect(surface.aliases).toEqual({
      timer: 'countdown',
      clock: 'countdown',
      stats: 'report',
    });
    // The group's menu, in the players' words; every private chat's too.
    expect(surface.chatMenus.get(String(GROUP))).toEqual([
      { command: 'map', description: 'la mappa' },
      { command: 'countdown', description: 'conto' },
    ]);
    expect(surface.privateMenu).toEqual(surface.chatMenus.get(String(GROUP)));
    expect(surface.authorMenu.map((c) => c.description)).toEqual([
      'map help',
      'countdown help',
      'report help',
    ]);
    expect(Object.keys(surface.allow)).toEqual(['report']);
    const answer = { text: () => Promise.resolve(), photo: () => Promise.resolve(undefined) };
    await surface.handlers['report']?.(answer, { args: '8' });
    expect(ran).toEqual(['report 8']);
  });

  it('tells a check whether the asker is the author, the owner', async () => {
    const asked: Asker[] = [];
    const c = chats({ ping: (a) => a.text('pong') }, { ping: (who) => (asked.push(who), true) });
    await c.feed(AUTHOR, AUTHOR, '/ping', 'alice');
    await c.feed(PLAYER, PLAYER, '/ping');
    expect(asked).toEqual([
      { id: String(AUTHOR), username: 'alice', owner: true },
      { id: String(PLAYER) },
    ]);
  });

  it('hands each handler the text typed after the command, trimmed, in every chat', async () => {
    const c = chats({ echo: (a, r) => a.text(`[${r.args}]`), ping: (a, r) => a.text(r.args) });
    await c.feed(AUTHOR, AUTHOR, '/echo  8 ');
    await c.feed(GROUP, 1, '/echo 12');
    await c.feed(PLAYER, PLAYER, '/echo');
    await c.feed(GROUP, 2, '/ping@ExampleBot hi');
    await c.feed(PLAYER, 8, '/pong there');
    expect(c.sent().map((s) => s.payload['text'])).toEqual(['[8]', '[12]', '[]', 'hi', 'there']);
  });

  it('answers a command left out of a menu, in the group too', async () => {
    const c = chats({ secret: (a) => a.text('shh', undefined, { deleteInGroupAfterMs: 1000 }) });
    await c.feed(GROUP, 1, '/secret@ExampleBot');
    await c.feed(GROUP, 1, '/secret');
    await c.feed(AUTHOR, AUTHOR, '/secret');
    await c.feed(-100999, 1, '/secret');
    expect(c.to()).toEqual([GROUP, AUTHOR]);
    await c.run();
    expect(c.deleted()).toEqual([[GROUP, expect.any(Number)]]);
  });

  it('answers a command with a check only to whom it allows, uncounted by the throttles', async () => {
    const asked: Asker[] = [];
    const c = chats(
      { map: (a) => a.text('map'), ping: (a) => a.text('pong'), secret: (a) => a.text('shh') },
      {
        ping: (who) => (asked.push(who), who.id === String(AUTHOR) || who.username === 'ally'),
        secret: (who) => who.username === 'ally',
      }
    );
    await c.feed(GROUP, 1, '/ping');
    await c.feed(GROUP, 1, '/pong');
    await c.feed(GROUP, 1, '/secret');
    await c.feed(PLAYER, PLAYER, '/ping', 'stranger');
    await c.feed(GROUP, 2, '/ping', 'ally');
    await c.feed(GROUP, 3, '/map');
    await c.feed(AUTHOR, AUTHOR, '/ping');
    await c.feed(AUTHOR, AUTHOR, '/secret');
    await c.feed(PLAYER, 8, '/secret', 'ally');
    expect(c.sent().map((s) => [s.payload['chat_id'], s.payload['text']])).toEqual([
      [GROUP, 'pong'],
      // Another command, under its own throttles.
      [GROUP, 'map'],
      [AUTHOR, 'pong'],
      [PLAYER, 'shh'],
    ]);
    expect(asked).toEqual([
      { id: '1' },
      { id: '1' },
      { id: String(PLAYER), username: 'stranger' },
      { id: '2', username: 'ally' },
      { id: String(AUTHOR), owner: true },
    ]);
  });

  describe('buttons', () => {
    const SPANS = [
      [
        { label: '1', action: '/span 1' },
        { label: '2', action: '/span 2' },
      ],
    ];
    const handlers: Handlers = {
      span: (a, r) =>
        a.text(`span ${r.args || '0'}`, undefined, { deleteInGroupAfterMs: 1000, buttons: SPANS }),
      map: (a) => a.text('map', undefined, { buttons: [[{ label: 'x', action: '/nothing' }]] }),
    };
    const allyOnly = { span: (who: Asker) => who.id === String(AUTHOR) || who.username === 'ally' };
    const allyChats = () => chats(handlers, allyOnly);

    it('sends them through the switchboard, and redraws the answer in place on a tap', async () => {
      const c = allyChats();
      await c.feed(AUTHOR, AUTHOR, '/map');
      const [data] = callbackData(c.calls);
      expect(data).toMatch(/^~/u);
      // In the author's chat, through the switchboard: /map is in its menu.
      const sent = c.calls.filter((x) => x.method === 'sendMessage');
      expect(sent).toHaveLength(1);
      // A switchboard button whose command is not ours does nothing.
      await c.press(AUTHOR, AUTHOR, data ?? '');
      expect(c.edits()).toEqual([]);
    });

    it('redraws an answer sent through the Bot API, for whoever is allowed, again and again', async () => {
      const c = allyChats();
      await c.feed(GROUP, 1, '/span', 'ally');
      const id = c.lastId(GROUP);
      expect(callbackData(c.calls)).toEqual(['/span 1', '/span 2']);
      await c.press(GROUP, 2, '/span 2', 'ally');
      await c.press(GROUP, 3, '/span 1');
      await c.press(GROUP, 2, '/span@ExampleBot 1', 'ally');
      await c.press(GROUP, 2, '/span 1', 'ally');
      expect(c.edits()).toEqual([
        [GROUP, id, 'span 2'],
        [GROUP, id, 'span 1'],
      ]);
      // Answered when the command is ours, whoever tapped; a command addressed to a bot is not.
      expect(c.calls.filter((x) => x.method === 'answerCallbackQuery')).toHaveLength(3);
      const edit = c.calls.find((x) => x.method === 'editMessageText');
      expect(callbackData(edit === undefined ? [] : [edit])).toEqual(['/span 1', '/span 2']);
    });

    it('counts the deletion from the group again from each tap', async () => {
      const c = allyChats();
      await c.feed(GROUP, 1, '/span', 'ally');
      await c.press(GROUP, 1, '/span 1', 'ally');
      expect(c.scheduled).toHaveLength(2);
      const [first, second] = c.scheduled.splice(0);
      first?.fn();
      await new Promise((r) => setTimeout(r, 10));
      expect(c.deleted()).toEqual([]);
      second?.fn();
      await new Promise((r) => setTimeout(r, 10));
      expect(c.deleted()).toEqual([[GROUP, c.lastId(GROUP)]]);
    });

    it('sends them through the Bot API in a group, and redraws there on a tap', async () => {
      const c = chats(
        {
          ping: (a, r) =>
            a.text(`pong ${r.args}`, undefined, {
              deleteInGroupAfterMs: 1000,
              buttons: [[{ label: 'again', action: '/pong 2' }]],
            }),
        },
        { ping: (who) => who.id !== '9' }
      );
      await c.feed(GROUP, 1, '/ping 1');
      const id = c.lastId(GROUP);
      const [data] = callbackData(c.calls);
      expect(data).toBe('/pong 2');
      await c.press(GROUP, 9, data ?? '');
      await c.press(GROUP, 1, data ?? '');
      expect(c.edits()).toEqual([[GROUP, id, 'pong 2']]);
      expect(c.scheduled).toHaveLength(2);
      await c.run();
      expect(c.deleted()).toEqual([[GROUP, id]]);
    });

    it('takes an unchanged redraw as done, and reports another failure', async () => {
      const c = allyChats();
      let refusal = 'Bad Request: message is not modified';
      c.bot.api.config.use((prev, method, payload, signal) =>
        method === 'editMessageText'
          ? Promise.reject(new Error(refusal))
          : prev(method, payload, signal)
      );
      await c.feed(PLAYER, PLAYER, '/span', 'ally');
      await c.press(PLAYER, PLAYER, '/span 1', 'ally');
      expect(c.warned).toEqual([]);
      refusal = 'Bad Request: chat not found';
      await c.press(PLAYER, PLAYER, '/span 1', 'ally');
      expect(c.warned).toEqual(['span: answer failed: Error: Bad Request: chat not found']);
    });

    it('sends Markdown answers as HTML, and redraws them so', async () => {
      const c = chats(
        {
          span: (a) =>
            a.text('**b**', 'markdown', { buttons: [[{ label: 'b', action: '/span' }]] }),
        },
        allyOnly
      );
      await c.feed(PLAYER, PLAYER, '/span', 'ally');
      await c.press(PLAYER, PLAYER, '/span', 'ally');
      const edit = c.calls.find((x) => x.method === 'editMessageText');
      expect(edit?.payload).toMatchObject({ text: '<b>b</b>', parse_mode: 'HTML' });
    });

    it('leaves alone a tap that names no command, in another chat, or on no message', async () => {
      const c = allyChats();
      const seen: string[] = [];
      c.bot.on('callback_query:data', (ctx) => void seen.push(ctx.callbackQuery.data));
      await c.press(PLAYER, PLAYER, 'other', 'ally');
      await c.press(PLAYER, PLAYER, '/nothing', 'ally');
      await c.press(-100999, 1, '/span 1', 'ally');
      expect(seen).toEqual(['other', '/nothing']);
      expect(c.edits()).toEqual([]);
    });
  });

  it('reports an answer that fails', async () => {
    const c = chats({ map: () => Promise.reject(new Error('400: chat not found')) });
    await c.feed(GROUP, 1, '/map');
    await c.feed(PLAYER, PLAYER, '/map');
    expect(c.warned).toEqual([
      'map: answer failed: Error: 400: chat not found',
      'map: answer failed: Error: 400: chat not found',
    ]);
  });
});

describe('the owner’s commands', () => {
  /**
   * The owner's commands on a real switchboard: `/status` and `/kill` in the author's menu, `/opt`
   * hidden; `/map` the group's. `kill` answers in a new message even under a tap.
   */
  function owner() {
    const stub = stubBot();
    const switchboard = new Switchboard({
      api: stub.bot.api,
      topics: telegramTopics(AUTHOR),
      commands: {
        [AUTHOR_TOPIC]: [
          { command: 'status', description: 'Status' },
          { command: 'kill', description: 'Kill' },
        ],
      },
    });
    const ran: string[] = [];
    const warned: string[] = [];
    stub.bot.use(switchboard);
    const ownerOnly = (asker: Asker) => asker.owner === true;
    installPublicCommands(switchboard, stub.bot, {
      handlers: {
        status: (a) => (
          ran.push('status'),
          a.text('card', undefined, { buttons: [[{ label: 'Fast', action: 'opt:fast:on' }]] })
        ),
        kill: (a) => (ran.push('kill'), a.text('Killed', undefined, { keep: true })),
        opt: (a, r) => (ran.push(`opt ${r.args}`), a.text(`opt ${r.args}`)),
        map: (a) => (ran.push('map'), a.text('la mappa')),
      },
      allow: { status: ownerOnly, kill: ownerOnly, opt: ownerOnly },
      owner: new Set(['status', 'kill', 'opt']),
      authorId: AUTHOR,
      now: () => T0,
      warn: (l) => warned.push(l),
    });
    const feed = async (update: Parameters<typeof stub.bot.handleUpdate>[0]) => {
      await stub.bot.handleUpdate(update);
      await new Promise((r) => setTimeout(r, 10));
    };
    const sent = () => stub.calls.filter((c) => c.method === 'sendMessage');
    const edits = () => stub.calls.filter((c) => c.method === 'editMessageText');
    return { ...stub, switchboard, ran, warned, feed, sent, edits };
  }

  it('answers them in the author’s chat, not in reply, and a tap redraws or keeps', async () => {
    const o = owner();
    await o.feed(o.command(AUTHOR, AUTHOR, '/status'));
    expect(o.sent()[0]?.payload).toMatchObject({ chat_id: AUTHOR, text: 'card' });
    expect(o.sent()[0]?.payload['reply_parameters']).toBeUndefined();
    // The card's button, in its short form, runs the hidden command and redraws the card.
    const [data] = callbackData(o.calls);
    expect(data).toBe('~6:author-opt:fast:on');
    await o.feed(o.tap(AUTHOR, AUTHOR, data ?? '', 42));
    expect(o.edits()[0]?.payload).toMatchObject({ message_id: 42, text: 'opt fast:on' });
    // A kill tapped under a notice answers in a new message, the notice left as it is.
    await o.feed(o.tap(AUTHOR, AUTHOR, '~6:author-kill', 43));
    expect(o.edits()).toHaveLength(1);
    expect(o.sent().at(-1)?.payload).toMatchObject({ chat_id: AUTHOR, text: 'Killed' });
    // Typed by hand, a hidden one is answered through the switchboard all the same.
    await o.feed(o.command(AUTHOR, AUTHOR, '/opt slow:off'));
    expect(o.sent().at(-1)?.payload).toMatchObject({ chat_id: AUTHOR, text: 'opt slow:off' });
    expect(o.ran).toEqual(['status', 'opt fast:on', 'kill', 'opt slow:off']);
    expect(o.warned).toEqual([]);
  });

  it('refuses anyone but the author, even in the private chat, and says so', async () => {
    const o = owner();
    await o.feed(o.command(AUTHOR, 99, '/kill'));
    await o.feed(o.tap(AUTHOR, 99, '~6:author-kill'));
    expect(o.ran).toEqual([]);
    expect(o.warned).toEqual(['owner: Ada may not kill', 'owner: Ada may not kill']);
  });

  it('does nothing with them in the group or another chat, even from the author', async () => {
    const o = owner();
    for (const text of ['/kill', '/status', '/opt fast:on'])
      await o.feed(o.command(GROUP, AUTHOR, text));
    await o.feed(o.command(PLAYER, AUTHOR, '/kill'));
    await o.feed(o.tap(GROUP, AUTHOR, 'kill'));
    await o.feed(o.tap(PLAYER, AUTHOR, 'kill'));
    expect(o.ran).toEqual([]);
    await o.feed(o.command(GROUP, AUTHOR, '/map'));
    expect(o.ran).toEqual(['map']);
  });

  it('lists them in the author’s menu only, the hidden ones in none', () => {
    const command = (name: string, more: Partial<ChatCommand> = {}): ChatCommand => ({
      plugin: 'p',
      name,
      help: `${name} help`,
      aliases: [],
      owner: true,
      hidden: false,
      run: () => Promise.resolve(),
      ...more,
    });
    const s = surfaceOf(
      [
        command('status', { menu: 'not for the players' }),
        command('opt', { hidden: true }),
        command('map', {
          owner: false,
          menu: 'la mappa',
          where: { chats: [String(AUTHOR), String(GROUP)], privateChats: false },
        }),
      ],
      { author: AUTHOR }
    );
    expect(s.authorMenu.map((c) => c.command)).toEqual(['status', 'map']);
    expect([...s.chatMenus.keys()]).toEqual([String(GROUP)]);
    expect(s.privateMenu).toEqual([]);
    expect([...s.owner]).toEqual(['status', 'opt']);
  });
});

describe('the commands served by edges (D109)', () => {
  const command = (name: string, where?: ChatCommand['where']): ChatCommand => ({
    plugin: 'p',
    name,
    help: `${name} help`,
    menu: `${name} menu`,
    aliases: [],
    owner: false,
    hidden: false,
    run: () => Promise.resolve(),
    ...(where === undefined ? {} : { where }),
  });

  it('lists each in the menus of the chats its edge names, and answers it there alone', () => {
    const s = surfaceOf(
      [
        command('map', { chats: [String(GROUP)], privateChats: false }),
        command('dm', { chats: [], privateChats: true }),
        command('lobby', { chats: ['@other_lobby', '-100999'], privateChats: false }),
        command('plugins'),
      ],
      { author: AUTHOR }
    );
    expect(s.authorMenu.map((c) => c.command)).toEqual(['dm', 'plugins']);
    expect(s.privateMenu.map((c) => c.command)).toEqual(['dm']);
    expect(
      [...s.chatMenus].map(([chat, m]) => `${chat} ${m.map((c) => c.command).join()}`)
    ).toEqual([`${GROUP} map`, '@other_lobby lobby', '-100999 lobby']);
    const at = (name: string, chat: { id: number; type: string; username?: string }) =>
      s.served[name]?.(chat) === true;
    expect(at('map', { id: GROUP, type: 'supergroup' })).toBe(true);
    expect(at('map', { id: PLAYER, type: 'private' })).toBe(false);
    expect(at('dm', { id: PLAYER, type: 'private' })).toBe(true);
    expect(at('lobby', { id: -100555, type: 'supergroup', username: 'Other_Lobby' })).toBe(true);
    // The core's own: the author's chat alone.
    expect(at('plugins', { id: AUTHOR, type: 'private' })).toBe(true);
    expect(at('plugins', { id: PLAYER, type: 'private' })).toBe(false);
    expect(surfaceOf([command('plugins')]).authorMenu).toEqual([]);
  });

  it('answers in a chat served, with its id, and ignores the others', async () => {
    const stub = stubBot();
    const asked: string[] = [];
    const switchboard = new Switchboard({
      api: stub.bot.api,
      topics: telegramTopics(AUTHOR),
      commands: { [AUTHOR_TOPIC]: [] },
    });
    stub.bot.use(switchboard);
    installPublicCommands(switchboard, stub.bot, {
      handlers: { ping: (_a, r) => (asked.push(r.chat ?? '?'), Promise.resolve()) },
      served: { ping: (chat) => chat.id === -100999 || chat.id === AUTHOR },
      authorId: AUTHOR,
      now: () => T0,
    });
    for (const chat of [GROUP, -100999, PLAYER, AUTHOR])
      await stub.bot.handleUpdate(stub.command(chat, PLAYER, '/ping'));
    await stub.bot.handleUpdate(stub.tap(GROUP, PLAYER, '/ping'));
    await stub.bot.handleUpdate(stub.tap(-100999, PLAYER, '/ping'));
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(['-100999', String(AUTHOR), '-100999']);
  });
});

describe('chatMenus', () => {
  it('sets each other chat’s menu by its id or @username, in its chat scope', async () => {
    const calls: unknown[][] = [];
    const menus = chatMenus(
      {
        setMyCommands: (...args: unknown[]) => (calls.push(args), Promise.resolve(true)),
      } as never,
      new Map([
        ['-100999', PUBLIC_MENU],
        ['@other_lobby', PUBLIC_MENU],
      ])
    );
    expect(Object.entries(menus).map(([name, m]) => [name, m.chat])).toEqual([
      ['-100999', -100999],
      ['@other_lobby', '@other_lobby'],
    ]);
    for (const m of Object.values(menus)) await m.set();
    expect(calls).toEqual([
      [PUBLIC_MENU, { scope: { type: 'chat', chat_id: -100999 } }],
      [PUBLIC_MENU, { scope: { type: 'chat', chat_id: '@other_lobby' } }],
    ]);
  });
});

describe('registerPrivateMenu', () => {
  it("sets the private chats' menu to the public commands, and reports a refusal", async () => {
    const calls: unknown[][] = [];
    const lines: string[] = [];
    await registerPrivateMenu(
      { setMyCommands: (...args: unknown[]) => (calls.push(args), Promise.resolve(true)) } as never,
      PUBLIC_MENU,
      (l) => lines.push(l)
    );
    expect(calls).toEqual([[PUBLIC_MENU, { scope: { type: 'all_private_chats' } }]]);
    await registerPrivateMenu(
      { setMyCommands: () => Promise.reject(new Error('429')) } as never,
      PUBLIC_MENU,
      (l) => lines.push(l)
    );
    expect(lines).toEqual([
      'telegram: command menu of private chats set',
      'telegram: command menu of private chats failed: Error: 429',
    ]);
  });
});

describe('Throttle', () => {
  it('lets a sender without an id through on the chat limit alone, and forgets old senders', () => {
    const t = new Throttle();
    expect(t.allow(undefined, T0)).toBe(true);
    expect(t.allow(undefined, T0 + PER_CHAT_MS - 1)).toBe(false);
    expect(t.allow('1', T0 + PER_CHAT_MS)).toBe(true);
    expect(t.allow('2', T0 + PER_CHAT_MS + PER_USER_MS)).toBe(true);
    expect(t.allow('1', T0 + 2 * PER_CHAT_MS + PER_USER_MS)).toBe(true);
  });

  it('can do without the chat limit', () => {
    const t = new Throttle(PER_USER_MS, 0);
    expect(t.allow('1', T0)).toBe(true);
    expect(t.allow('2', T0)).toBe(true);
    expect(t.allow('1', T0 + 1)).toBe(false);
  });
});
