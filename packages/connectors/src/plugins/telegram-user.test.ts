import { Core, VirtualClock } from '@megabottron1999/core';
import { secretsWith } from '@megabottron1999/core/test/secrets.ts';
import { describe, expect, it } from 'vitest';
import { type GramClient, type UserCredentials } from '#src/transport/telegram-user.ts';
import { telegramUserPlugin, userCredentials } from './telegram-user.ts';

const USER = {
  telegram_user_api_id: '123456',
  telegram_user_api_hash: '0123456789abcdef0123456789abcdef',
  telegram_user_session: '1BQANOTAREALSESSION',
};
const GROUP = '-1001000000001';

function client(): GramClient {
  return {
    connect: () => Promise.resolve(true),
    disconnect: () => Promise.resolve(),
    getDialogs: () => Promise.resolve([]),
    getInputEntity: (id) => Promise.resolve({ peer: id }),
    getMe: () => Promise.resolve({ username: 'alice' }),
    sendMessage: () => Promise.resolve({ id: 1 }),
    addEventHandler: () => {},
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
        version: 1,
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

  it('refuses a chat that is neither a group id nor a username', () => {
    const core = new Core({
      clock: new VirtualClock(),
      config: { 'telegram-user': { chats: ['lobby'] } },
      secrets: secretsWith(USER),
    });
    core.register(telegramUserPlugin({ self: 'alice', client }));
    expect(() => core.load()).toThrow('expected a group id (-100…) or a @username');
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
