/**
 * A Telegram bot as a chat surface of the core (docs/bot-os-api.md §2, §4.11): the
 * `telegram-bot` connector answers the plugins' commands its commands edges serve (bot-os.md
 * D109), and the owner's with their cards and buttons, on the bot it holds. Once the core serves
 * it the commands (`serve`), it makes the switchboard
 * (packages/connectors/src/transport/telegram-switchboard.ts), with the owner's private chat
 * as its `author` topic and the group, if any, as `group`; it answers each command in the chats its
 * edge names (packages/connectors/src/transport/telegram-commands.ts), keeps each chat's menu
 * to the commands served there (`CommandMenus`, the private chats' and the other chats', again once
 * connected), and only then lets the bot poll, so that no update arrives before its handlers. It reports nothing on its own (bot-os.md
 * D94): a message with buttons a node sends to the owner's chat through the connector (an
 * `owner-notice` telling a plugin's `ctx.notify`) goes through its switchboard (`send`), so that a
 * tap runs the owner's command as a card's does.
 */
import {
  type Buttons,
  type ChatCommand,
  type ChatSurface,
  type CommandButton,
  type ConnectorStatus,
  type TextFormat,
} from '@megabottron1999/core';
import { type Bot } from 'grammy';
import { type Logger, type Switchboard } from 'grammy-switchboard';
import {
  installPublicCommands,
  registerChatMenus,
  registerPrivateMenu,
  surfaceOf,
} from './telegram-commands.ts';
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
  /** The way back to the owner's main card, at the foot of the core's cards (its config's). */
  home?: CommandButton;
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
  readonly home?: CommandButton;
  private readonly o: TelegramSurfaceOptions;
  private listen: () => void = () => {};
  private switchboardIs: (s: Switchboard) => void = () => {};
  private readonly switchboard: Promise<Switchboard>;
  private menus: CommandMenus | undefined;
  private served = false;

  constructor(o: TelegramSurfaceOptions) {
    this.o = o;
    if (o.home !== undefined) this.home = o.home;
    this.listening = new Promise<void>((r) => (this.listen = r));
    this.switchboard = new Promise<Switchboard>((r) => (this.switchboardIs = r));
  }

  serve(commands: readonly ChatCommand[]): void {
    if (this.served) return;
    this.served = true;
    const { bot, owner, group, log } = this.o;
    const surface = surfaceOf(commands, {
      author: owner,
      ...(group === undefined ? {} : { group }),
    });
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
      served: surface.served,
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
      void registerPrivateMenu(bot.api, surface.privateMenu, log);
      void registerChatMenus(bot.api, surface.chatMenus, log);
    });
    this.switchboardIs(switchboard);
    this.listen();
  }

  /**
   * Sends to the owner's chat with buttons, through the switchboard, whose taps run the owner's
   * commands; once served. Rejects as the switchboard does.
   */
  async send(text: string, buttons: Buttons, format?: TextFormat): Promise<{ id?: string }> {
    const sent = await (
      await this.switchboard
    ).send({
      topic: AUTHOR_TOPIC,
      text,
      ...(format === undefined ? {} : { format }),
      buttons: buttons.map((row) => [...row]),
    });
    const id = sent.messageIds[0];
    return id === undefined ? {} : { id: String(id) };
  }

  /** Stops the menus' retries. */
  stop(): void {
    this.menus?.stop();
  }
}
