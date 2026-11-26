import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import {
  AUTHOR_TOPIC,
  CommandMenus,
  telegramTopics,
  watchMembership,
} from './telegram-switchboard.ts';

describe('telegramTopics', () => {
  it("is the author's private chat, whose chat id is the author's user id", () => {
    expect(telegramTopics(4242)).toEqual({ [AUTHOR_TOPIC]: { chatId: 4242 } });
  });
});

describe('CommandMenus', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * Menus of the author's chat, a group by id and one by `@username`; Telegram refuses the groups'
   * while `outside` is true.
   */
  function menus() {
    const state = { outside: true };
    const set: string[] = [];
    const log: string[] = [];
    const menu = (name: string, chat: number | string, group = true) => ({
      chat,
      set: async () => {
        if (group && state.outside) throw new Error('400: Bad Request: chat not found');
        set.push(name);
      },
    });
    const m = new CommandMenus({
      menus: {
        author: menu('author', 4242, false),
        group: menu('group', -100123),
        '@guild_hall': menu('@guild_hall', '@Guild_Hall'),
      },
      log: (l) => log.push(l),
    });
    return { m, state, set, log };
  }

  it('retries a menu Telegram refused, a minute later and then less often, until it is set', async () => {
    vi.useFakeTimers();
    const { m, state, set, log } = menus();
    m.registerAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toEqual(['author']);
    expect(log).toContain(
      'telegram: command menu of group failed, retrying in 1 min: Error: 400: Bad Request: chat not found'
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.at(-1)).toMatch(/retrying in 2 min/u);
    state.outside = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(set).toEqual(['author', 'group', '@guild_hall']);
    expect(log.at(-1)).toBe('telegram: command menu of @guild_hall set');
    // Set: no more tries.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(set).toEqual(['author', 'group', '@guild_hall']);
    m.stop();
  });

  it("sets a chat's menus at once when the bot joins it, and stops its retries", async () => {
    vi.useFakeTimers();
    const { m, state, set } = menus();
    m.registerAll();
    await vi.advanceTimersByTimeAsync(0);
    state.outside = false;
    m.joined({ id: -100123 });
    m.joined({ id: -999 });
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toEqual(['author', 'group']);
    // A group named by its @username, found by it.
    m.joined({ id: -100456, username: 'guild_hall' });
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toEqual(['author', 'group', '@guild_hall']);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(set).toEqual(['author', 'group', '@guild_hall']);
    m.stop();
  });
});

describe('watchMembership', () => {
  it('tells the menus when the bot is added to a chat, and nothing else', async () => {
    const { bot } = stubBot();
    const joined: unknown[] = [];
    watchMembership(bot, { joined: (chat) => void joined.push(chat) });
    const update = (status: string, id: number) =>
      bot.handleUpdate({
        update_id: id,
        my_chat_member: {
          chat: { id: -100123, type: 'supergroup', title: 'The Lobby', username: 'lobby' },
          from: { id: 4242, is_bot: false, first_name: 'Ada' },
          date: 0,
          old_chat_member: { status: 'left', user: BOT_INFO },
          new_chat_member: { status, user: BOT_INFO },
        },
      } as never);
    await update('member', 1);
    await update('kicked', 2);
    await update('administrator', 3);
    const lobby = { id: -100123, username: 'lobby' };
    expect(joined).toEqual([lobby, lobby]);
  });
});
