import {
  Core,
  definePlugin,
  type FetchPhoto,
  type Inbound,
  NEEDS_LOGIN,
  parseManifest,
  VirtualClock,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeletedMessage } from 'telegram/events/DeletedMessage.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { type NewMessage } from 'telegram/events/index.js';
import { describe, expect, it } from 'vitest';
import {
  type GramClient,
  type RawMessage,
  type UserCredentials,
} from '#src/transport/telegram-user.ts';
import { type UserLoginClient } from '#src/transport/user-login.ts';
import { readWarnings } from '#test/monitors.ts';
import { telegramUserPlugin } from './telegram-user.ts';

/** A login kept in the connector's store (D116, D118): made up. */
const LOGIN = {
  apiId: 123456,
  apiHash: '0123456789abcdef0123456789abcdef',
  session: '1BQANOTAREALSESSION',
};
/** The store of a connector instance logged in, by its id. */
const loggedIn = (id: string, docs: Record<string, unknown> = {}) => ({
  [id]: { login: LOGIN, ...docs },
});
const GROUP = '-1001000000001';

/** A parser reading the account's chats as its edge says. */
function reader(heard: (m: Inbound) => void) {
  return definePlugin({
    manifest: {
      id: 'reader',
      kinds: ['parser'],
      description: 'reader',
      inputs: { chat: { type: 'chat-in', network: 'telegram' } },
    },
    create: (ctx) => {
      ctx.connector('chat').onMessage(heard);
      return {};
    },
  });
}

function client(): GramClient {
  return {
    connect: () => Promise.resolve(true),
    disconnect: () => Promise.resolve(),
    getDialogs: () => Promise.resolve([]),
    getInputEntity: (id) => Promise.resolve({ peer: id }),
    getMe: () => Promise.resolve({ username: 'alice' }),
    sendMessage: () => Promise.resolve({ id: 1 }),
    uploadFile: () => Promise.reject(new Error('no upload here')),
    sendFile: () => Promise.reject(new Error('no file here')),
    addEventHandler: () => {},
    getMessages: () => Promise.resolve([]),
    downloadMedia: () => Promise.resolve(undefined),
  };
}

describe('the telegram-user plugin', () => {
  it('makes its client from its kept login, and its connector from its chats', async () => {
    const made: UserCredentials[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      config: {
        'telegram-user': {
          chats: [GROUP, '@quiz_bot'],
          unansweredAt: 4,
          unansweredAtBy: { '/give': 0 },
        },
      },
      documents: loggedIn('telegram-user'),
    });
    core.register(telegramUserPlugin({ client: (c) => (made.push(c), client()) }));
    await core.start();
    expect(made).toEqual([LOGIN]);
    const connector = core.connector('telegram-user');
    expect(connector?.account).toBe('telegram:owner');
    expect(connector?.limits).toEqual({
      commandIntervalMs: 0,
      unansweredAt: 4,
      unansweredAtBy: { '/give': 0 },
    });
    await new Promise((r) => setImmediate(r));
    expect(connector?.status().state).toBe('connected');
    await core.stop();
    expect(connector?.status().state).toBe('closed');
  });

  it('runs on its node’s account, by its id unless it names one (D119), from its config alone', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      documents: { ...loggedIn('me'), ...loggedIn('mine') },
      graph: {
        version: 2,
        nodes: [
          {
            id: 'me',
            plugin: 'telegram-user',
            account: 'telegram:bob',
            config: { chats: ['@quiz_bot'] },
          },
          { id: 'mine', plugin: 'telegram-user' },
        ],
        edges: [],
      },
    });
    core.register(telegramUserPlugin({ client }));
    await core.start();
    expect(core.connector('me')?.account).toBe('telegram:bob');
    expect(core.connector('mine')?.account).toBe('telegram:mine');
    expect(telegramUserPlugin().manifest.account).toBe('telegram:owner');
    await core.stop();
  });

  it('monitors the chats of its config, or every chat: the check warns of one read beside (D89, D90)', () => {
    const plugin = telegramUserPlugin({ client });
    expect(readWarnings(plugin, undefined, ['@QuestBot'])).toEqual([]);
    // Its connector not running, a chat named otherwise cannot be told: not warned of.
    expect(
      readWarnings(plugin, { chats: [GROUP, '@questbot'] }, ['@QuestBot', '@DiceBot'])
    ).toEqual([]);
    // Running, it knows each chat's names: the same chat by id or @username is heard.
    const names = (chat: string) =>
      ({
        '@questbot': ['5000001', '@QuestBot'],
        '5000001': ['5000001', '@QuestBot'],
        [GROUP]: [GROUP],
      })[chat.toLowerCase()];
    expect(
      readWarnings(plugin, { chats: [GROUP, '5000001'] }, ['@QuestBot', '@DiceBot'], names)
    ).toEqual([
      `node quest: input port chat reads @DiceBot, which conn does not monitor (its chats: ${GROUP}, 5000001) (edge conn → quest.chat)`,
    ]);
  });

  it('monitors every chat without chats, each reader hearing its edge’s senders', async () => {
    const heard: string[] = [];
    let deliver: ((e: { message: RawMessage }) => Promise<void>) | undefined;
    const c = client();
    c.addEventHandler = (
      h: (event: never) => Promise<void>,
      builder: NewMessage | DeletedMessage
    ) => {
      // The messages' handler; the edits' (D144) and the deletions' (D158) are others.
      if (!(builder instanceof EditedMessage) && !(builder instanceof DeletedMessage))
        deliver = h as typeof deliver;
    };
    const core = new Core({
      clock: new VirtualClock(),
      documents: loggedIn('tg'),
      graph: {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'telegram-user' },
          { id: 'reader', plugin: 'reader' },
        ],
        edges: [{ from: 'tg.chat', to: 'reader.chat', reads: '*', senders: ['@QuestBot'] }],
      },
    });
    core.register(
      telegramUserPlugin({ client: () => c }),
      definePlugin({
        manifest: {
          id: 'reader',
          kinds: ['parser'],
          description: 'reader',
          inputs: { chat: { type: 'chat-in', network: 'telegram' } },
        },
        create: (ctx) => {
          ctx.connector('chat').onMessage((m) => heard.push(`${m.chat} ${m.text}`));
          return {};
        },
      })
    );
    await core.start();
    await new Promise((r) => setImmediate(r));
    const said = (sender: string): RawMessage => ({
      id: 3,
      date: 1,
      message: `/play ${sender}`,
      chatId: { toString: () => GROUP },
      getSender: () => Promise.resolve({ username: sender }),
      getChat: () => Promise.resolve(undefined),
    });
    await deliver?.({ message: said('QuestBot') });
    await deliver?.({ message: said('bob') });
    expect(heard).toEqual([`${GROUP} /play QuestBot`]);
    await core.stop();
  });

  it('hears a chat its config names by id through an edge naming it by @username, unwarned (D90)', async () => {
    const heard: string[] = [];
    let deliver: ((e: { message: RawMessage }) => Promise<void>) | undefined;
    const c = client();
    c.addEventHandler = (
      h: (event: never) => Promise<void>,
      builder: NewMessage | DeletedMessage
    ) => {
      // The messages' handler; the edits' (D144) and the deletions' (D158) are others.
      if (!(builder instanceof EditedMessage) && !(builder instanceof DeletedMessage))
        deliver = h as typeof deliver;
    };
    c.getDialogs = () =>
      Promise.resolve([
        {
          id: { toString: () => '5000001' },
          isUser: true,
          entity: { username: 'QuestBot', bot: true },
          message: { id: 1 },
        },
      ]);
    const graph = (reads: string[]) => ({
      version: 2 as const,
      nodes: [
        { id: 'tg', plugin: 'telegram-user', config: { chats: ['5000001'] } },
        { id: 'reader', plugin: 'reader' },
      ],
      edges: [{ from: 'tg.chat', to: 'reader.chat', reads }],
    });
    const core = new Core({
      clock: new VirtualClock(),
      documents: loggedIn('tg'),
      graph: graph(['@questbot']),
    });
    core.register(
      telegramUserPlugin({ client: () => c }),
      reader((m) => heard.push(`${m.chat} ${m.text}`))
    );
    await core.start();
    await new Promise((r) => setImmediate(r));
    await deliver?.({
      message: {
        id: 3,
        date: 1,
        message: '/play',
        chatId: { toString: () => '5000001' },
        isPrivate: true,
        getSender: () => Promise.resolve({ username: 'QuestBot' }),
        getChat: () => Promise.resolve({ username: 'QuestBot' }),
      },
    });
    expect(heard).toEqual(['5000001 /play']);
    expect(core.check(graph(['@questbot'])).warnings).toEqual([]);
    expect(core.check(graph(['@DiceBot'])).warnings?.map((w) => w.text)).toEqual([
      'node reader: input port chat reads @DiceBot, which tg does not monitor (its chats: 5000001) (edge tg.chat → reader.chat)',
    ]);
    await core.stop();
  });

  it('catches up on the chats its readers read, through their filters, from its store', async () => {
    const heard: string[] = [];
    const clock = new VirtualClock(3_600_000);
    const said = (id: number, sender: string): RawMessage => ({
      id,
      date: 1,
      message: `/play ${sender}`,
      getSender: () => Promise.resolve({ username: sender }),
      getChat: () => Promise.resolve(undefined),
    });
    const c = client();
    c.getDialogs = () =>
      Promise.resolve([
        { id: { toString: () => GROUP }, inputEntity: { peer: GROUP }, message: { id: 4 } },
      ]);
    c.getMessages = () =>
      Promise.resolve([said(4, 'bob'), said(3, 'QuestBot'), said(2, 'QuestBot')]);
    const core = new Core({
      clock,
      documents: loggedIn('tg', { 'last-seen': { [GROUP]: 1 } }),
      graph: {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'telegram-user' },
          { id: 'reader', plugin: 'reader' },
        ],
        edges: [{ from: 'tg.chat', to: 'reader.chat', reads: [GROUP], senders: ['@QuestBot'] }],
      },
    });
    core.register(
      telegramUserPlugin({ client: () => c }),
      reader((m) => heard.push(`${m.id} ${m.text} ${m.missed} ${m.playback}`))
    );
    await core.start();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      clock.advance(1000);
    }
    await new Promise((r) => setImmediate(r));
    expect(heard).toEqual(['2 /play QuestBot true true', '3 /play QuestBot true true']);
    await core.stop();
  });

  it('warns of a catch-up that hit its cap, in its log and the event log', async () => {
    const clock = new VirtualClock();
    const records: unknown[] = [];
    const c = client();
    c.getDialogs = () =>
      Promise.resolve([
        { id: { toString: () => GROUP }, inputEntity: { peer: GROUP }, message: { id: 2000 } },
      ]);
    c.getMessages = (_, params) =>
      Promise.resolve(
        Array.from({ length: 'limit' in params ? params.limit : 0 }, (_x, i) => ({
          id: ('offsetId' in params ? params.offsetId : 0) - 1 - i,
          date: 1,
          message: 'hi',
          getSender: () => Promise.resolve({ username: 'QuestBot' }),
          getChat: () => Promise.resolve(undefined),
        }))
      );
    const core = new Core({
      clock,
      record: (r) => records.push(r),
      documents: loggedIn('tg', { 'last-seen': { [GROUP]: 1 } }),
      graph: {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'telegram-user' },
          { id: 'reader', plugin: 'reader' },
        ],
        edges: [{ from: 'tg.chat', to: 'reader.chat', reads: '*' }],
      },
    });
    let heard = 0;
    core.register(
      telegramUserPlugin({ client: () => c }),
      reader(() => heard++)
    );
    await core.start();
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setImmediate(r));
      clock.advance(1000);
    }
    expect(heard).toBe(1000);
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'telegram-user.catch-up', chat: GROUP, fetched: 1000 })
    );
    await core.stop();
  });
});

/** A plugin that asks a connector's node for a message's photo, through its interface (D151). */
function asker(plugin: string, asked: unknown[], request: { chat: string; message: string }) {
  return definePlugin({
    manifest: {
      id: 'postcard',
      kinds: ['agent'],
      description: 'Keeps the pictures of the rooms',
      inputs: { tg: { type: 'interface', plugin, members: ['actions.photo'] } },
    },
    create: (ctx) => ({
      async start() {
        const { actions } = ctx.use<{ actions: { photo: FetchPhoto } }>('tg');
        asked.push(await actions.photo(request));
      },
    }),
  });
}

describe('the telegram-user plugin’s photo (D151)', () => {
  it('offers photo on its interface: a plugin bound to it fetches a message’s photo', async () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    const c = client();
    c.getMessages = () =>
      Promise.resolve([
        {
          id: 42,
          date: 1,
          message: 'Room 4',
          media: {
            className: 'MessageMediaPhoto',
            photo: { sizes: [{ className: 'PhotoSize', w: 800, h: 600, size: 4 }] },
          },
          getSender: () => Promise.resolve(undefined),
          getChat: () => Promise.resolve(undefined),
        },
      ]);
    c.downloadMedia = () => Promise.resolve(JPEG);
    const asked: unknown[] = [];
    const logs: string[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      config: { 'telegram-user': { chats: [GROUP] } },
      documents: loggedIn('telegram-user'),
      print: (l) => void logs.push(l),
    });
    core.register(
      telegramUserPlugin({ client: () => c }),
      asker('telegram-user', asked, { chat: GROUP, message: '42' })
    );
    expect(parseManifest(telegramUserPlugin().manifest).outputs['interface']).toMatchObject({
      members: ['actions.photo'],
    });
    await core.start();
    expect(asked).toEqual([
      { ok: true, media: { data: JPEG, mime: 'image/jpeg', width: 800, height: 600 } },
    ]);
    // Logged with its caller and its size, never its bytes.
    expect(
      logs.some((l) => l.includes(`photo of message 42 in ${GROUP}, for postcard: 4 bytes`))
    ).toBe(true);
    await core.stop();
  });

  it('refuses it, with why, while it needs a login', async () => {
    const asked: unknown[] = [];
    const core = new Core({ clock: new VirtualClock() });
    core.register(
      telegramUserPlugin(),
      asker('telegram-user', asked, { chat: GROUP, message: '1' })
    );
    await core.start();
    expect(asked).toEqual([{ ok: false, error: 'not logged in' }]);
    await core.stop();
  });
});

describe('the telegram-user plugin’s login (D116)', () => {
  const data = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-user-'));

  it('refuses on a second node the account a first one is logged in as, naming it (D121)', async () => {
    const ended: unknown[] = [];
    const scan = (): UserLoginClient => ({
      connect: () => Promise.resolve(true),
      disconnect: () => Promise.resolve(),
      signInUser: () => Promise.reject(new Error('no')),
      signInUserWithQrCode: async (_api, p) => {
        await p.qrCode?.({ token: Buffer.from('code'), expires: 30 });
        return { username: 'alice', id: 5000001 };
      },
      invoke: (r) => (ended.push(r), Promise.resolve(true)),
    });
    const core = new Core({
      clock: new VirtualClock(),
      documents: {
        mine: { login: { ...LOGIN, as: '@alice', user: '5000001' } },
        again: { login: { apiId: LOGIN.apiId, apiHash: LOGIN.apiHash } },
      },
      graph: {
        version: 2,
        nodes: [
          { id: 'mine', plugin: 'telegram-user' },
          { id: 'again', plugin: 'telegram-user' },
        ],
        edges: [],
      },
    });
    core.register(telegramUserPlugin({ client, loginClient: scan }));
    await core.start();
    await core.controls.loginAct('again', 'qr', {});
    await new Promise((r) => setImmediate(r));
    expect(core.controls.login('again')).toMatchObject({
      value: {
        status: 'needed',
        error: expect.stringContaining('logged in on the node mine already') as unknown,
      },
    });
    expect(ended).toHaveLength(1);
    await core.stop();
  });
  const keep = (dir: string, doc: unknown) => {
    fs.mkdirSync(path.join(dir, 'instances', 'telegram-user'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'instances', 'telegram-user', 'login.json'),
      JSON.stringify(doc)
    );
  };

  it('runs without a login, needing one, and logs in from its node', async () => {
    const core = new Core({ clock: new VirtualClock() });
    const fakeLogin = (): UserLoginClient => ({
      connect: () => Promise.resolve(true),
      disconnect: () => Promise.resolve(),
      signInUser: () => Promise.reject(new Error('no')),
      signInUserWithQrCode: () => Promise.reject(new Error('no')),
    });
    core.register(
      telegramUserPlugin({ client: () => expect.fail('no client'), loginClient: fakeLogin })
    );
    await core.start();
    expect(core.state('telegram-user')?.state).toBe('running');
    expect(core.connector('telegram-user')?.status()).toMatchObject({
      state: 'closed',
      phase: NEEDS_LOGIN,
    });
    expect(core.controls.login('telegram-user')).toMatchObject({
      value: { status: 'needed', step: { title: 'Your app’s API id and hash' } },
    });
    const saved = await core.controls.loginAct('telegram-user', 'api', {
      apiId: String(LOGIN.apiId),
      apiHash: LOGIN.apiHash,
    });
    expect(saved).toMatchObject({ value: { step: { title: 'Log in to Telegram' } } });
    expect(await core.controls.loginAct('telegram-user', 'qr', {})).toMatchObject({
      value: { status: 'needed', error: 'no' },
    });
    await core.stop();
  });

  it('runs on its store’s session, and logs out on Telegram too', async () => {
    const dir = data();
    keep(dir, { apiId: 7654321, apiHash: LOGIN.apiHash, session: '1BQSTORED' });
    const made: UserCredentials[] = [];
    let out = 0;
    const core = new Core({ clock: new VirtualClock(), dataDir: dir });
    core.register(
      telegramUserPlugin({
        client: (c) => (
          made.push(c),
          { ...client(), invoke: () => (out++, Promise.resolve(true)) }
        ),
      })
    );
    await core.start();
    expect(made).toEqual([{ apiId: 7654321, apiHash: LOGIN.apiHash, session: '1BQSTORED' }]);
    await new Promise((r) => setImmediate(r));
    expect(core.controls.login('telegram-user')).toMatchObject({
      value: { status: 'done', source: 'store', as: '@alice' },
    });
    // Logged out: on Telegram too; it needs a login again, its API pair kept.
    expect(await core.controls.loginAct('telegram-user', 'logout', {})).toMatchObject({
      value: { status: 'needed', restart: true, step: { title: 'Log in to Telegram' } },
    });
    expect(out).toBe(1);
    expect(core.connector('telegram-user')?.status()).toMatchObject({ phase: NEEDS_LOGIN });
    await core.stop();
  });
});
