import { Core, definePlugin, type Inbound, VirtualClock } from '@megabottron1999/core';
import { secretsWith } from '@megabottron1999/core/test/secrets.ts';
import { describe, expect, it } from 'vitest';
import {
  type GramClient,
  type RawMessage,
  type UserCredentials,
} from '#src/transport/telegram-user.ts';
import { readWarnings } from '#test/monitors.ts';
import { telegramUserPlugin, userCredentials } from './telegram-user.ts';

const USER = {
  telegram_user_api_id: '123456',
  telegram_user_api_hash: '0123456789abcdef0123456789abcdef',
  telegram_user_session: '1BQANOTAREALSESSION',
};
const GROUP = '-1001000000001';

/** A parser reading the account's chats as its edge says. */
function reader(heard: (m: Inbound) => void) {
  return definePlugin({
    manifest: {
      id: 'reader',
      version: '0.1.0',
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
    addEventHandler: () => {},
    getMessages: () => Promise.resolve([]),
    downloadMedia: () => Promise.resolve(undefined),
  };
}

describe('the telegram-user plugin', () => {
  it('makes its client from its secrets, and its connector from its chats', async () => {
    const made: UserCredentials[] = [];
    const core = new Core({
      clock: new VirtualClock(),
      config: { 'telegram-user': { chats: [GROUP, '@quiz_bot'] } },
      secrets: secretsWith(USER),
    });
    core.register(telegramUserPlugin({ self: 'alice', client: (c) => (made.push(c), client()) }));
    await core.start();
    expect(made).toEqual([
      { apiId: 123456, apiHash: USER.telegram_user_api_hash, session: USER.telegram_user_session },
    ]);
    const connector = core.connector('telegram-user');
    expect(connector?.account).toBe('telegram:alice');
    await new Promise((r) => setImmediate(r));
    expect(connector?.status().state).toBe('connected');
    await core.stop();
    expect(connector?.status().state).toBe('closed');
  });

  it('runs on its node’s account, from its config alone', async () => {
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith(USER),
      graph: {
        version: 2,
        nodes: [
          {
            id: 'me',
            plugin: 'telegram-user',
            account: 'telegram:bob',
            config: { chats: ['@quiz_bot'] },
          },
        ],
        edges: [],
      },
    });
    core.register(telegramUserPlugin({ client }));
    await core.start();
    expect(core.connector('me')?.account).toBe('telegram:bob');
    expect(telegramUserPlugin().manifest.account).toBe('telegram:owner');
    await core.stop();
  });

  it('monitors the chats of its config, or every chat: the check warns of one read beside (D89)', () => {
    const plugin = telegramUserPlugin({ self: 'alice', client });
    expect(readWarnings(plugin, undefined, ['@QuestBot'])).toEqual([]);
    expect(
      readWarnings(plugin, { chats: [GROUP, '@questbot'] }, ['@QuestBot', '@DiceBot'])
    ).toEqual([
      `node quest: input port chat reads @DiceBot, which conn does not monitor (its chats: ${GROUP}, @questbot) (edge conn → quest.chat)`,
    ]);
  });

  it('refuses a chat that is neither a group id nor a username', () => {
    const core = new Core({
      clock: new VirtualClock(),
      config: { 'telegram-user': { chats: ['lobby'] } },
      secrets: secretsWith(USER),
    });
    core.register(telegramUserPlugin({ self: 'alice', client }));
    expect(() => core.load()).toThrow('expected a group id (-100…) or a @username');
  });

  it('monitors every chat without chats, each reader hearing its edge’s senders', async () => {
    const heard: string[] = [];
    let deliver: ((e: { message: RawMessage }) => Promise<void>) | undefined;
    const c = client();
    c.addEventHandler = (h) => (deliver = h);
    const core = new Core({
      clock: new VirtualClock(),
      secrets: secretsWith(USER),
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
          version: '0.1.0',
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
      secrets: secretsWith(USER),
      documents: { tg: { 'last-seen': { [GROUP]: 1 } } },
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
    c.getMessages = (_, { limit, offsetId }) =>
      Promise.resolve(
        Array.from({ length: limit }, (_x, i) => ({
          id: offsetId - 1 - i,
          date: 1,
          message: 'hi',
          getSender: () => Promise.resolve({ username: 'QuestBot' }),
          getChat: () => Promise.resolve(undefined),
        }))
      );
    const core = new Core({
      clock,
      secrets: secretsWith(USER),
      record: (r) => records.push(r),
      documents: { tg: { 'last-seen': { [GROUP]: 1 } } },
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

  it('fails the account on credentials that are not, naming each', () => {
    expect(() =>
      userCredentials(
        (n) =>
          ({ telegram_user_api_id: '0', telegram_user_api_hash: 'xyz', telegram_user_session: '' })[
            n
          ]
      )
    ).toThrow(
      'telegram_user_api_id is not an API id; telegram_user_api_hash is not 32 hex digits; telegram_user_session is empty'
    );
  });
});
