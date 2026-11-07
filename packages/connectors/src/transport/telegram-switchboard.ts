/**
 * The instance's Telegram bot, run in-process with grammY:
 * the bot itself is the `telegram-bot` connector's
 * (packages/connectors/src/transport/telegram-bot.ts), which holds its token. One
 * `Switchboard` (grammy-switchboard) is installed on it, with no store (every button carries itself
 * inline) and commands only (no plain messages).
 *
 * Its topics: `author`, the private chat with the author, whose chat id is the author's Telegram
 * user id. Notifications, the remote's buttons and its commands go there only. `group`, a
 * Telegram group when one is configured (the group has no forum topics, so no thread id), with its
 * public commands only (packages/connectors/src/transport/telegram-commands.ts); the remote
 * acts only on the author's topic (the core's owner's controls,
 * packages/core/src/controls.ts), and no button is ever sent to the group.
 */
import { type Api, type Bot } from 'grammy';
import { type Command, type Logger, Switchboard, type Topic } from 'grammy-switchboard';

/** The author's private chat with the bot. */
export const AUTHOR_TOPIC = 'author';

/** The game's group, for its public commands. */
export const GROUP_TOPIC = 'group';

/** The bot's topics: the author's private chat, and the game's group if any; neither has a thread. */
export function telegramTopics(authorId: number, groupId?: number): Record<string, Topic> {
  return {
    [AUTHOR_TOPIC]: { chatId: authorId },
    ...(groupId === undefined ? {} : { [GROUP_TOPIC]: { chatId: groupId } }),
  };
}

/**
 * The most bytes an action can have for a button of `topic` sent without a ref to fit inline, from
 * the switchboard's wire format v1 (`~<topic bytes>:<topic>-<action>`, at most 64 bytes).
 */
export function maxActionBytes(topic: string): number {
  const bytes = Buffer.byteLength(topic);
  return 64 - `~${bytes}:`.length - bytes - '-'.length;
}

export interface SwitchboardOptions {
  api: Api;
  authorId: number;
  /** The author's `/` commands: the remote's. */
  authorCommands: readonly Command[];
  /** The game's group, and its public commands. */
  groupId?: number;
  groupCommands?: readonly Command[];
  logger?: Logger;
}

/** The switchboard, with its topics and their commands; installed with `bot.use(...)`. */
export function createSwitchboard(o: SwitchboardOptions): Switchboard {
  return new Switchboard({
    api: o.api,
    topics: telegramTopics(o.authorId, o.groupId),
    commands: {
      [AUTHOR_TOPIC]: o.authorCommands,
      ...(o.groupId === undefined ? {} : { [GROUP_TOPIC]: o.groupCommands ?? [] }),
    },
    ...(o.logger === undefined ? {} : { logger: o.logger }),
  });
}

const FIRST_MENU_RETRY_MS = 60_000;
const MAX_MENU_RETRY_MS = 3_600_000;

/**
 * Keeps each topic's `/` menu registered. A chat's menu can only be set once the bot is in the chat
 * (Telegram answers "chat not found" before), so a failure is retried after a minute, doubling up
 * to an hour, until it succeeds; and when the bot is added to a chat (`joined`, from its
 * `my_chat_member` update), that chat's menus are set at once.
 */
export class CommandMenus {
  private readonly o: {
    switchboard: Pick<Switchboard, 'registerCommandMenu'>;
    topics: Readonly<Record<string, Topic>>;
    log: (line: string) => void;
  };
  private readonly retries = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; ms: number }
  >();

  constructor(o: CommandMenus['o']) {
    this.o = o;
  }

  /** Sets every topic's menu, once the bot is connected. */
  registerAll(): void {
    for (const topic of Object.keys(this.o.topics)) void this.register(topic);
  }

  /** The bot was added to `chatId`: its topics' menus, now. */
  joined(chatId: number): void {
    for (const [topic, t] of Object.entries(this.o.topics))
      if (t.chatId === chatId) void this.register(topic);
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
      await this.o.switchboard.registerCommandMenu(topic);
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
    if (status === 'member' || status === 'administrator') menus.joined(ctx.chat.id);
    await next();
  });
}
