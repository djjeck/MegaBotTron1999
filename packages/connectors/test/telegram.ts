/**
 * A real grammY `Bot` whose Bot API calls never leave the process, for the switchboard's tests: an
 * API transformer records each call and answers it, and `update` feeds the bot a command or a
 * button tap as Telegram would deliver it.
 */
import { Bot } from 'grammy';
import { type Update, type UserFromGetMe } from 'grammy/types';

export const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'example-bot',
  username: 'ExampleBot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  can_manage_bots: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  supports_join_request_queries: false,
};

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** The bot, the calls it made, and builders of the updates it can be fed. */
export function stubBot() {
  const bot = new Bot('123456:test-token', { botInfo: BOT_INFO });
  const calls: ApiCall[] = [];
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    // A photo comes back in its sizes, the largest last, each with Telegram's file id.
    const result =
      method === 'sendMessage'
        ? { message_id: ++messageId, date: 0 }
        : method === 'sendPhoto'
          ? {
              message_id: ++messageId,
              date: 0,
              photo: [{ file_id: `thumb-${messageId}` }, { file_id: `photo-${messageId}` }],
            }
          : true;
    return { ok: true, result } as never;
  });
  let updateId = 0;
  const chatOf = (chatId: number) =>
    chatId > 0
      ? { id: chatId, type: 'private', first_name: 'Ada' }
      : { id: chatId, type: 'supergroup', title: 'The Lobby' };
  /** A `/command` typed in `chatId` by user `from`, with the username given if any. */
  const command = (chatId: number, from: number, text: string, username?: string): Update =>
    ({
      update_id: ++updateId,
      message: {
        message_id: ++messageId,
        date: 0,
        chat: chatOf(chatId),
        from: { id: from, is_bot: false, first_name: 'Ada', ...(username && { username }) },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
      },
    }) as unknown as Update;
  /**
   * A tap on a button whose callback data is `data`, on message `message` in `chatId`, by user
   * `from`, with the username given if any.
   */
  const tap = (
    chatId: number,
    from: number,
    data: string,
    message = 42,
    username?: string
  ): Update =>
    ({
      update_id: ++updateId,
      callback_query: {
        id: `cbq${updateId}`,
        from: { id: from, is_bot: false, first_name: 'Ada', ...(username && { username }) },
        chat_instance: 'x',
        data,
        message: { message_id: message, date: 0, chat: chatOf(chatId) },
      },
    }) as unknown as Update;
  return { bot, calls, command, tap };
}

/** The callback data of every button in the calls' inline keyboards. */
export function callbackData(calls: readonly ApiCall[]): string[] {
  return calls.flatMap(({ payload }) => {
    const markup = payload['reply_markup'] as
      { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
  });
}
