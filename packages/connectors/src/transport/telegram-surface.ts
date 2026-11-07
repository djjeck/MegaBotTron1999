/**
 * A Telegram bot as a chat surface of the core (docs/bot-os-api.md §2, §4.11): the
 * `telegram-bot` connector answers the plugins' commands and carries the owner's notices, on the
 * bot it holds. Once the core serves it the commands (`serve`), it makes the switchboard
 * (packages/connectors/src/transport/telegram-switchboard.ts), with the owner's private chat
 * as its `author` topic and the group, if any, as `group`; it answers the commands there and
 * in every other private chat (packages/connectors/src/transport/telegram-commands.ts),
 * keeps the menus registered (`CommandMenus`, again once connected), and only then lets the bot
 * poll, so that no update arrives before its handlers. The owner's notices (`tell`) go to the
 * owner's chat in order (packages/connectors/src/transport/telegram-notifier.ts); those told
 * before `serve` wait for the switchboard.
 */
import {
  type Buttons,
  type ChatCommand,
  type ChatSurface,
  type ConnectorStatus,
} from '@megabottron1999/core';
import { type Bot } from 'grammy';
import { type Logger, type Switchboard } from 'grammy-switchboard';
import { installPublicCommands, registerPrivateMenu, surfaceOf } from './telegram-commands.ts';
import { telegramNotify } from './telegram-notifier.ts';
import {
  AUTHOR_TOPIC,
  CommandMenus,
  createSwitchboard,
  telegramTopics,
  watchMembership,
} from './telegram-switchboard.ts';

export interface TelegramSurfaceOptions {
  bot: Bot;
  /** The owner's Telegram user id: the owner's private chat, and the only one the owner's answer. */
  owner: number;
  /** The game's group, for its players' commands. */
  group?: number;
  log: (line: string) => void;
  now: () => number;
  /** Hears the connector's status: the menus are set again each time it connects. */
  onStatus: (listener: (s: ConnectorStatus) => void) => void;
}

/** The switchboard's logger, on the connector's log. */
export function loggerOf(log: (line: string) => void): Logger {
  const line = (level: string, message: string, fields?: Record<string, unknown>): void =>
    log(`${level}${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`);
  return {
    info: (m, f) => line('', m, f),
    warn: (m, f) => line('warning: ', m, f),
    error: (m, f) => line('error: ', m, f),
  };
}

export class TelegramSurface implements ChatSurface {
  /** Resolved once served: polling waits for it. */
  readonly listening: Promise<void>;
  private readonly o: TelegramSurfaceOptions;
  private listen: () => void = () => {};
  private switchboardIs: (s: Switchboard) => void = () => {};
  private readonly switchboard: Promise<Switchboard>;
  private readonly notify: (text: string, buttons?: Buttons) => void;
  private menus: CommandMenus | undefined;
  private served = false;

  constructor(o: TelegramSurfaceOptions) {
    this.o = o;
    this.listening = new Promise<void>((r) => (this.listen = r));
    this.switchboard = new Promise<Switchboard>((r) => (this.switchboardIs = r));
    this.notify = telegramNotify({
      switchboard: {
        send: async (m) => (await this.switchboard).send(m),
        edit: async (m) => (await this.switchboard).edit(m),
      },
      topic: AUTHOR_TOPIC,
      warn: o.log,
    });
  }

  serve(commands: readonly ChatCommand[]): void {
    if (this.served) return;
    this.served = true;
    const { bot, owner, group, log } = this.o;
    const surface = surfaceOf(commands);
    const switchboard = createSwitchboard({
      api: bot.api,
      authorId: owner,
      authorCommands: surface.authorMenu,
      ...(group === undefined ? {} : { groupId: group, groupCommands: surface.publicMenu }),
      logger: loggerOf(log),
    });
    // The command menus: set once connected, again when the bot joins a chat, and retried if
    // refused.
    const menus = new CommandMenus({ switchboard, topics: telegramTopics(owner, group), log });
    this.menus = menus;
    watchMembership(bot, menus);
    bot.use(switchboard);
    installPublicCommands(switchboard, bot, {
      handlers: surface.handlers,
      allow: surface.allow,
      aliases: surface.aliases,
      owner: surface.owner,
      ...(group === undefined ? {} : { groupId: group }),
      authorId: owner,
      now: this.o.now,
      warn: log,
    });
    this.o.onStatus((s) => {
      if (s.state !== 'connected') return;
      menus.registerAll();
      void registerPrivateMenu(bot.api, surface.publicMenu, log);
    });
    this.switchboardIs(switchboard);
    this.listen();
  }

  tell(text: string, buttons?: Buttons): void {
    this.notify(text, buttons);
  }

  /** Stops the menus' retries. */
  stop(): void {
    this.menus?.stop();
  }
}
