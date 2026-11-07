import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_INFO, stubBot } from '#test/telegram.ts';
import {
  AUTHOR_TOPIC,
  CommandMenus,
  GROUP_TOPIC,
  maxActionBytes,
  telegramTopics,
  watchMembership,
} from './telegram-switchboard.ts';

describe('telegramTopics', () => {
  it("is the author's private chat, whose chat id is the author's user id", () => {
    expect(telegramTopics(4242)).toEqual({ [AUTHOR_TOPIC]: { chatId: 4242 } });
  });

  it("adds the game's group, which has no forum topics, when there is one", () => {
    expect(telegramTopics(4242, -100123)).toEqual({
      [AUTHOR_TOPIC]: { chatId: 4242 },
      [GROUP_TOPIC]: { chatId: -100123 },
    });
  });
});

describe('maxActionBytes', () => {
  it("leaves the room the wire format's prefix doesn't take", () => {
    // `~6:author-` is 10 bytes of 64.
    expect(maxActionBytes('author')).toBe(54);
    expect(maxActionBytes('x'.repeat(10))).toBe(64 - '~10:'.length - 10 - 1);
  });
});

describe('CommandMenus', () => {
  afterEach(() => vi.useRealTimers());

  /** Menus over a switchboard that refuses the group's chat while `outside` is true. */
  function menus() {
    const state = { outside: true };
    const set: string[] = [];
    const log: string[] = [];
    const m = new CommandMenus({
      switchboard: {
        registerCommandMenu: async (topic) => {
          if (topic === 'group' && state.outside)
            throw new Error('400: Bad Request: chat not found');
          set.push(topic);
        },
      },
      topics: telegramTopics(4242, -100123),
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
    expect(log.at(-1)).toBe(
      'telegram: command menu of group failed, retrying in 1 min: Error: 400: Bad Request: chat not found'
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.at(-1)).toMatch(/retrying in 2 min/u);
    state.outside = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(set).toEqual(['author', 'group']);
    expect(log.at(-1)).toBe('telegram: command menu of group set');
    // Set: no more tries.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(set).toEqual(['author', 'group']);
    m.stop();
  });

  it("sets a chat's menus at once when the bot joins it, and stops its retries", async () => {
    vi.useFakeTimers();
    const { m, state, set } = menus();
    m.registerAll();
    await vi.advanceTimersByTimeAsync(0);
    state.outside = false;
    m.joined(-100123);
    m.joined(-999);
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toEqual(['author', 'group']);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(set).toEqual(['author', 'group']);
  });
});

describe('watchMembership', () => {
  it('tells the menus when the bot is added to a chat, and nothing else', async () => {
    const { bot } = stubBot();
    const joined: number[] = [];
    watchMembership(bot, { joined: (id) => void joined.push(id) });
    const update = (status: string, id: number) =>
      bot.handleUpdate({
        update_id: id,
        my_chat_member: {
          chat: { id: -100123, type: 'supergroup', title: 'The Lobby' },
          from: { id: 4242, is_bot: false, first_name: 'Ada' },
          date: 0,
          old_chat_member: { status: 'left', user: BOT_INFO },
          new_chat_member: { status, user: BOT_INFO },
        },
      } as never);
    await update('member', 1);
    await update('kicked', 2);
    await update('administrator', 3);
    expect(joined).toEqual([-100123, -100123]);
  });
});
