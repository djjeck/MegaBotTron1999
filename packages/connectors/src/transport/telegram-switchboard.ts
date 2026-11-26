/**
 * The instance's Telegram bot, run in-process with grammY:
 * the bot itself is the `telegram-bot` connector's
 * (packages/connectors/src/transport/telegram-bot.ts), which holds its token. One
 * `Switchboard` (grammy-switchboard) is installed on it, with no store (every button carries itself
 * inline) and commands only (no plain messages).
 *
 * Its one topic: `author`, the private chat with the author, whose chat id is the author's Telegram
 * user id. Notifications, the remote's buttons and its commands go there only (the core's owner's
 * controls, packages/core/src/controls.ts). Every other chat, its groups included (bot-os.md
 * D128), the switchboard passes on to the handlers after it
 * (packages/connectors/src/transport/telegram-commands.ts).
 */
import { type Api, type Bot } from 'grammy';
import { type Command, type Logger, Switchboard, type Topic } from 'grammy-switchboard';

/** The author's private chat with the bot. */
export const AUTHOR_TOPIC = 'author';

/** The bot's topics: the author's private chat, which has no thread. */
export function telegramTopics(authorId: number): Record<string, Topic> {
  return { [AUTHOR_TOPIC]: { chatId: authorId } };
}

export interface SwitchboardOptions {
  api: Api;
  authorId: number;
  /** The author's `/` commands: the remote's. */
  authorCommands: readonly Command[];
  logger?: Logger;
}

/** The switchboard, with its topics and their commands; installed with `bot.use(...)`. */
export function createSwitchboard(o: SwitchboardOptions): Switchboard {
  return new Switchboard({
    api: o.api,
    topics: telegramTopics(o.authorId),
    commands: { [AUTHOR_TOPIC]: o.authorCommands },
    ...(o.logger === undefined ? {} : { logger: o.logger }),
  });
}

const FIRST_MENU_RETRY_MS = 60_000;
const MAX_MENU_RETRY_MS = 3_600_000;

/** A chat's `/` menu: the chat (an id, or a group's `@username`), and the way to set it. */
export interface ChatMenu {
  chat: number | string;
  set: () => Promise<unknown>;
}

/**
 * Keeps each chat's `/` menu registered, by name (the author's topic, `author`, and each other
 * chat as its commands edge names it). A chat's menu can only be set once the bot is in the chat
 * (Telegram answers "chat not found" before), so a failure is retried after a minute, doubling up
 * to an hour, until it succeeds; and when the bot is added to a chat (`joined`, from its
 * `my_chat_member` update), that chat's menus are set at once.
 */
export class CommandMenus {
  private readonly o: {
    menus: Readonly<Record<string, ChatMenu>>;
    log: (line: string) => void;
  };
  private readonly retries = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; ms: number }
  >();

  constructor(o: CommandMenus['o']) {
    this.o = o;
  }

  /** Sets every chat's menu, once the bot is connected. */
  registerAll(): void {
    for (const name of Object.keys(this.o.menus)) void this.register(name);
  }

  /** The bot was added to `chat`: its menus, by its id or its `@username`, now. */
  joined(chat: { id: number; username?: string }): void {
    const handle = chat.username === undefined ? undefined : `@${chat.username}`.toLowerCase();
    for (const [name, m] of Object.entries(this.o.menus))
      if (m.chat === chat.id || (typeof m.chat === 'string' && m.chat.toLowerCase() === handle))
        void this.register(name);
  }

  /** Stops the retries. */
  stop(): void {
    for (const { timer } of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  private async register(topic: string): Promise<void> {
    const pending = this.retries.get(topic);
    if (pending !== undefined) clearTimeout(pending.timer);
    try {
      await this.o.menus[topic]?.set();
      this.retries.delete(topic);
      this.o.log(`telegram: command menu of ${topic} set`);
    } catch (e) {
      const ms =
        pending === undefined ? FIRST_MENU_RETRY_MS : Math.min(pending.ms * 2, MAX_MENU_RETRY_MS);
      const timer = setTimeout(() => void this.register(topic), ms);
      timer.unref?.();
      this.retries.set(topic, { timer, ms });
      this.o.log(
        `telegram: command menu of ${topic} failed, retrying in ${ms / 60_000} min: ${String(e)}`
      );
    }
  }
}

/**
 * Tells `menus` when the bot is added to a chat: its `my_chat_member` updates, which carry no
 * message, so this sees nothing of what is said in a group.
 */
export function watchMembership(bot: Pick<Bot, 'on'>, menus: Pick<CommandMenus, 'joined'>): void {
  bot.on('my_chat_member', async (ctx, next) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'member' || status === 'administrator')
      menus.joined({
        id: ctx.chat.id,
        ...('username' in ctx.chat && ctx.chat.username !== undefined
          ? { username: ctx.chat.username }
          : {}),
      });
    await next();
  });
}
