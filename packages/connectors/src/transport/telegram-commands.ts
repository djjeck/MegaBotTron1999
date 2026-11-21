/**
 * The chat surface of the plugins' commands (docs/bot-os-api.md §2, P11) on a Telegram bot: the
 * commands the graph's commands edges from this bot serve (`core.served(node)`, bot-os.md D109),
 * each registered in the menus of the chats its edge names and answered there alone: in the
 * author's private chat, the switchboard's one topic, and in the other chats it names (every
 * private chat, with `privateChats`), groups included, which the switchboard passes on to a grammY
 * handler after it. A command no edge serves in a chat is neither listed nor answered there; the core's own,
 * the owner's controls, are answered in the author's chat. Each command has one handler, which
 * answers in reply to the command whatever the chat, with the text typed after it and the chat's
 * id. The switchboard delivers a command as `/ping` or `/ping@ExampleBot`, never one addressed to
 * another bot, and grammY's command filter does the same in the other chats.
 *
 * A command may have aliases (its manifest's `aliases`), answered as the command is, with its throttles, in the
 * same chats. They are not in any menu, since the switchboard's commands are its menus and Telegram
 * refuses a whole menu over a name longer than 32 characters; so the switchboard passes them on too,
 * and the handler after it answers them in every chat. A command left out of a chat's menu is
 * passed on and answered the same way: a command with no
 * `menu` for the players, is in the author's menu only, and answered in a group all the same.
 *
 * A command may be answered only to some (`allow`): to the senders its check lets through, by their
 * Telegram id or username, in every chat; anyone else is ignored without a word, and not counted by
 * the throttles. The author is the instance's owner (`Asker.owner`).
 *
 * Throttles keep a chat from filling with answers, each command its own: in a group, one answer
 * per user a minute and one every 10 s, each group its own; in another user's private chat, one
 * per user a minute; the author's chat has none. The rest are ignored without a word. The throttles keep the senders' ids
 * in memory only, never on disk or in a log line.
 *
 * A handler may ask for its answer to be deleted from a group after a while
 * (`deleteInGroupAfterMs`); a private chat, the author's included, keeps it. The timer is in memory
 * only, so an answer pending deletion when the bot stops stays.
 *
 * An answer may carry buttons, each the command to run again (`/report 8`, any of its names): a tap
 * runs it, with the same check (`allow`) on whoever tapped but no throttle, and redraws the answer in
 * place, its deletion from a group counted again from the tap. The buttons of an answer sent
 * through the switchboard are its own (`button` events, which the remote leaves alone: they start
 * with `/`); those sent through the Bot API carry the command as their callback data, which the
 * switchboard passes on.
 */
import {
  type Answer,
  type AnswerOptions,
  type Asker,
  type ChatCommand,
  type CommandPhoto,
  inScope,
  photoFilename,
  type Request,
  tapOf,
  type TextFormat,
} from '@megabottron1999/core';
import { type Api, type Bot, InputFile } from 'grammy';
import { type Command, markdownToTelegramHtml, type Switchboard } from 'grammy-switchboard';
import { AUTHOR_TOPIC, type ChatMenu } from './telegram-switchboard.ts';

export const PER_USER_MS = 60_000;
export const PER_CHAT_MS = 10_000;

/**
 * Schedules `remove` of the answer `key` (its chat and message) as `options` ask, in place of any
 * deletion of it scheduled before.
 */
type Expire = (
  options: AnswerOptions | undefined,
  key: string,
  remove: () => Promise<unknown>
) => void;

/** The handler of each public command, by command. */
export type Handlers = Readonly<
  Record<string, (answer: Answer, request: Request) => Promise<void>>
>;

/** A chat a command is asked in, as Telegram gives it. */
export interface ChatRef {
  id: number;
  type: string;
  username?: string;
}

/** Whether a command is served in a chat (bot-os.md D109), by command. */
export type Served = Readonly<Record<string, (chat: ChatRef) => boolean>>;

/** The surface of the commands served (`core.served(node)`), as the switchboard takes it. */
export interface Surface {
  handlers: Handlers;
  /** Where each is answered: the chats its edge names; the core's, the author's chat alone. */
  served: Served;
  allow: Readonly<Record<string, (asker: Asker) => boolean>>;
  /** Each alias, with the command it stands for. */
  aliases: Readonly<Record<string, string>>;
  /** The owner's commands: answered in the author's chat only. */
  owner: ReadonlySet<string>;
  /** Every private chat's menu but the author's: those served in every private chat. */
  privateMenu: readonly Command[];
  /** The author's menu: every command served there but the hidden ones, in the owner's words. */
  authorMenu: readonly Command[];
  /** The menus of the other chats an edge names, by the chat as it names it. */
  chatMenus: ReadonlyMap<string, readonly Command[]>;
}

/** A chat's names, as an edge may name it (D96): its id, and its `@username` if it has one. */
const namesOf = (chat: ChatRef): string[] => [
  String(chat.id),
  ...(chat.username === undefined ? [] : [`@${chat.username}`]),
];

/**
 * The switchboard's view of the commands served, in their order, with the author's private chat
 * (`author`) where it is known: each command answered where its edge says (`where`), the core's own
 * (none) in the author's chat alone.
 */
export function surfaceOf(
  commands: readonly ChatCommand[],
  chats: { author?: number } = {}
): Surface {
  const handlers: Record<string, Handlers[string]> = {};
  const allow: Record<string, (asker: Asker) => boolean> = {};
  const aliases: Record<string, string> = {};
  const served: Record<string, (chat: ChatRef) => boolean> = {};
  for (const c of commands) {
    handlers[c.name] = (answer, request) => c.run(answer, request);
    if (c.allow !== undefined) allow[c.name] = c.allow;
    for (const alias of c.aliases) aliases[alias] = c.name;
    const where = c.where;
    served[c.name] =
      where === undefined
        ? (chat) => chat.id === chats.author
        : (chat) => inScope(where, { names: namesOf(chat), private: chat.type === 'private' });
  }
  const at = (chat: ChatRef) => (c: ChatCommand) => served[c.name]?.(chat) === true;
  const players = (c: ChatCommand): boolean => c.menu !== undefined && !c.owner && !c.hidden;
  const menu = (list: readonly ChatCommand[]): Command[] =>
    list.map((c) => ({ command: c.name, description: c.menu ?? c.help }));
  const author = chats.author === undefined ? undefined : { id: chats.author, type: 'private' };
  const known = new Set([String(chats.author)]);
  const chatMenus = new Map<string, Command[]>();
  for (const c of commands)
    for (const chat of c.where?.chats ?? [])
      if (!known.has(chat) && players(c) && !chatMenus.get(chat)?.some((x) => x.command === c.name))
        chatMenus.set(chat, [...(chatMenus.get(chat) ?? []), ...menu([c])]);
  return {
    handlers,
    served,
    allow,
    aliases,
    owner: new Set(commands.filter((c) => c.owner).map((c) => c.name)),
    privateMenu: menu(commands.filter((c) => players(c) && c.where?.privateChats === true)),
    authorMenu:
      author === undefined
        ? []
        : commands.flatMap((c) =>
            c.hidden || !at(author)(c) ? [] : [{ command: c.name, description: c.help }]
          ),
    chatMenus,
  };
}

/** A photo as the Bot API takes it: by its file id, or uploaded. */
export const media = (photo: CommandPhoto): string | InputFile =>
  typeof photo === 'string' ? photo : new InputFile(photo.data, photoFilename(photo));

/**
 * A photo's caption as the Bot API takes it (bot-os.md D150): Markdown as Telegram HTML, as a
 * text's; plain as written; none, nothing.
 */
export const captionOf = (
  caption: string | undefined,
  format: TextFormat | undefined
): { caption?: string; parse_mode?: 'HTML' } =>
  caption === undefined
    ? {}
    : format === 'markdown'
      ? { caption: markdownToTelegramHtml(caption), parse_mode: 'HTML' }
      : { caption };

export interface PublicCommandsOptions {
  handlers: Handlers;
  /** Other names of the commands, each with the command it stands for. */
  aliases?: Readonly<Record<string, string>>;
  /** The commands answered only to some, each with who may ask it; the rest, to anyone. */
  allow?: Readonly<Record<string, (asker: Asker) => boolean>>;
  /** The owner's commands: answered in the author's chat only, never in reply. */
  owner?: ReadonlySet<string>;
  /**
   * Where each command is answered (bot-os.md D109): a command it does not name, in every group,
   * the author's chat and every private chat, as before the edges.
   */
  served?: Served;
  /** The author's private chat: no throttle there. */
  authorId: number;
  now: () => number;
  /** Runs `fn` in `ms`: an unreferenced `setTimeout` by default, which never keeps the bot up. */
  schedule?: (ms: number, fn: () => void) => void;
  /** Where a failed answer, or a failed deletion, is reported. */
  warn?: (line: string) => void;
}

/** In memory only: when each sender, and the chat, were last answered. */
export class Throttle {
  private readonly users = new Map<string, number>();
  private chat = Number.NEGATIVE_INFINITY;
  private readonly perUserMs: number;
  private readonly perChatMs: number;

  constructor(perUserMs = PER_USER_MS, perChatMs = PER_CHAT_MS) {
    this.perUserMs = perUserMs;
    this.perChatMs = perChatMs;
  }

  /** Whether to answer now, counting the answer if so. */
  allow(user: string | undefined, now: number): boolean {
    if (now - this.chat < this.perChatMs) return false;
    const last = user === undefined ? undefined : this.users.get(user);
    if (last !== undefined && now - last < this.perUserMs) return false;
    this.chat = now;
    if (user !== undefined) {
      // Forget whoever can ask again, so the map stays small.
      for (const [u, t] of this.users) if (now - t >= this.perUserMs) this.users.delete(u);
      this.users.set(user, now);
    }
    return true;
  }
}

/**
 * Answers the public commands. Call it after `bot.use(switchboard)`: the handler of the other
 * private chats sees only what the switchboard passed on.
 */
export function installPublicCommands(
  switchboard: Pick<Switchboard, 'on' | 'send' | 'edit' | 'delete'>,
  bot: Pick<Bot, 'command' | 'on'>,
  o: PublicCommandsOptions
): void {
  const warn = o.warn ?? ((line: string) => console.log(line));
  const schedule = o.schedule ?? ((ms: number, fn: () => void) => void setTimeout(fn, ms).unref());
  // The latest deletion scheduled of each answer, so that a tap counts it again.
  const pending = new Map<string, object>();
  const expire =
    (command: string, inAGroup: boolean): Expire =>
    (options, key, remove) => {
      if (!inAGroup || options?.deleteInGroupAfterMs === undefined) return;
      const token = {};
      pending.set(key, token);
      schedule(options.deleteInGroupAfterMs, () => {
        if (pending.get(key) !== token) return;
        pending.delete(key);
        remove().catch((err: unknown) => warn(`${command}: delete failed: ${String(err)}`));
      });
    };
  const allowed = (command: string, asker: Asker | undefined): boolean => {
    const check = o.allow?.[command];
    return check === undefined || (asker !== undefined && check(asker));
  };
  const servedIn = (command: string, chat: ChatRef): boolean => {
    const check = o.served?.[command];
    return check === undefined
      ? isGroup(chat) || chat.id === o.authorId || chat.type === 'private'
      : check(chat);
  };
  /** The chat of the switchboard's topic: the author's. */
  const authorChat: ChatRef = { id: o.authorId, type: 'private' };
  const run = (command: string, answer: Answer, args: string, chat: number): void => {
    o.handlers[command]?.(answer, { args: args.trim(), chat: String(chat) }).catch((err: unknown) =>
      warn(`${command}: answer failed: ${String(err)}`)
    );
  };
  // Each group's throttles its own, by group and command, made as they are first needed.
  const inGroups = new Map<string, Throttle>();
  const inGroup = (chat: number, command: string): Throttle => {
    const key = `${chat} ${command}`;
    const t = inGroups.get(key) ?? new Throttle();
    inGroups.set(key, t);
    return t;
  };
  const inPrivate = new Map<string, Throttle>();
  for (const command of Object.keys(o.handlers))
    inPrivate.set(command, new Throttle(PER_USER_MS, 0));
  // Every name of every command: its own, and its aliases.
  const names: Record<string, string> = {};
  for (const command of Object.keys(o.handlers)) names[command] = command;
  for (const [alias, command] of Object.entries(o.aliases ?? {}))
    if (Object.hasOwn(o.handlers, command)) names[alias] = command;
  const isOwner = (command: string): boolean => o.owner?.has(command) === true;
  /**
   * A button's command and what follows it, if it names one of ours: typed (`/report 8`), or in
   * short (`opt:fast:on`, `kill`), as the owner's are (`tapOf`).
   */
  const tapped = (action: string): { command: string; args: string } | undefined => {
    const t = tapOf(action);
    const command = t === undefined ? undefined : names[t.name];
    return command === undefined ? undefined : { command, args: t?.args ?? '' };
  };

  /** Answers in the switchboard's topic (the author's chat), in reply to `replyTo` if given. */
  const inTopic = (topic: string, replyTo: number | undefined, command: string): Answer => {
    // The author's chat keeps its answers.
    const remove = expire(command, false);
    return {
      text: async (text, format, options) => {
        const sent = await switchboard.send({
          topic,
          text,
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(format && { format }),
          ...(options?.buttons && { buttons: options.buttons }),
        });
        for (const messageId of sent.messageIds)
          remove(options, `${topic}:${messageId}`, () => switchboard.delete({ topic, messageId }));
      },
      photo: async (photo, caption, format) =>
        (
          await switchboard.send({
            topic,
            photo: media(photo),
            ...(caption === undefined ? {} : { text: caption }),
            ...(caption !== undefined && format && { format }),
            ...(replyTo === undefined ? {} : { replyTo }),
          })
        ).fileIds[0],
    };
  };

  // The commands in the menu of the switchboard's topic, the author's chat.
  switchboard.on('command', (e, ctx) => {
    if (!Object.hasOwn(o.handlers, e.command)) return;
    if (e.topic !== AUTHOR_TOPIC) return;
    // Served there by an edge (D109), or not answered.
    const chat = authorChat;
    if (!servedIn(e.command, chat)) return;
    if (!allowed(e.command, askerOf(ctx.from, o.authorId))) {
      if (isOwner(e.command))
        warn(`owner: ${e.from?.name ?? 'someone unknown'} may not ${e.command}`);
      return;
    }
    // The owner's are answered as notices are, not in reply.
    run(
      e.command,
      inTopic(e.topic, isOwner(e.command) ? undefined : e.messageId, e.command),
      e.args,
      chat.id
    );
  });

  // A tap on the buttons of an answer sent through the switchboard: redrawn in place.
  switchboard.on('button', (e, ctx) => {
    const t = tapped(e.action);
    const { topic, messageId } = e;
    if (t === undefined || messageId === undefined) return;
    if (topic !== AUTHOR_TOPIC) return;
    const chat = authorChat;
    if (!servedIn(t.command, chat)) return;
    if (!allowed(t.command, askerOf(ctx.from, o.authorId))) {
      if (isOwner(t.command))
        warn(`owner: ${e.from?.name ?? 'someone unknown'} may not ${e.action}`);
      return;
    }
    const remove = expire(t.command, false);
    run(
      t.command,
      redraw(async (text, format, options) => {
        // A new message, the one tapped left as it is (a kill under a notice).
        if (options?.keep === true) {
          await switchboard.send({
            topic,
            text,
            ...(format && { format }),
            ...(options.buttons && { buttons: options.buttons }),
          });
          return;
        }
        await unlessUnchanged(
          switchboard.edit({
            topic,
            messageId,
            text,
            ...(format && { format }),
            buttons: options?.buttons ?? [],
          })
        );
        remove(options, `${topic}:${messageId}`, () => switchboard.delete({ topic, messageId }));
      }),
      t.args,
      chat.id
    );
  });

  // The rest, which the switchboard passes on: every command in the other chats, and in its own
  // chats the aliases and the commands left out of their menu; each where it is served (D109).
  for (const [name, command] of Object.entries(names)) {
    bot.command(name, (ctx) => {
      const chat = ctx.chat.id;
      const asker = askerOf(ctx.from, o.authorId);
      const group = isGroup(ctx.chat);
      if (!servedIn(command, ctx.chat as ChatRef)) return;
      if (isOwner(command) && chat !== o.authorId) return;
      if (!allowed(command, asker)) return;
      if (group) {
        if (!inGroup(chat, command).allow(asker?.id, o.now())) return;
      } else if (chat !== o.authorId) {
        if (inPrivate.get(command)?.allow(asker?.id, o.now()) !== true) return;
      }
      run(
        command,
        // The owner's, typed out of the menu (a card's button by hand), as the menu's are answered:
        // through the switchboard, whose buttons come back to it.
        isOwner(command)
          ? inTopic(AUTHOR_TOPIC, undefined, command)
          : inChat(ctx.api, chat, ctx.msg.message_id, expire(command, group)),
        ctx.match,
        chat
      );
    });
  }

  // A tap on the buttons of an answer sent through the Bot API, which the switchboard passed on.
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    // Only a typed command travels as the Bot API's data; the owner's buttons are the switchboard's.
    const t = data.startsWith('/') ? tapped(data) : undefined;
    const message = ctx.callbackQuery.message;
    if (t === undefined || message === undefined || isOwner(t.command)) return next();
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (
      !servedIn(t.command, message.chat as ChatRef) ||
      !allowed(t.command, askerOf(ctx.from, o.authorId))
    )
      return;
    const chat = message.chat.id;
    const remove = expire(t.command, isGroup(message.chat));
    run(
      t.command,
      redraw(async (text, format, options) => {
        const html = format === 'markdown';
        await unlessUnchanged(
          ctx.api.editMessageText(
            chat,
            message.message_id,
            html ? markdownToTelegramHtml(text) : text,
            {
              ...(html && { parse_mode: 'HTML' as const }),
              reply_markup: keyboard(options?.buttons),
            }
          )
        );
        remove(options, `${chat}:${message.message_id}`, () =>
          ctx.api.deleteMessage(chat, message.message_id)
        );
      }),
      t.args,
      chat
    );
  });
}

/** Whether a chat is a group's (a basic group or a supergroup). */
export const isGroup = (chat: { type: string }): boolean =>
  chat.type === 'group' || chat.type === 'supergroup';

/** An answer to a tap: its text redraws the message tapped; a photo is not redrawn. */
function redraw(text: Answer['text']): Answer {
  return { text, photo: () => Promise.resolve(undefined) };
}

/** An edit, where Telegram's refusal to redraw a message as it already is is no failure. */
async function unlessUnchanged(edit: Promise<unknown>): Promise<void> {
  try {
    await edit;
  } catch (err) {
    if (!String(err).includes('message is not modified')) throw err;
  }
}

/** Buttons as the Bot API takes them, each carrying its command as its callback data. */
function keyboard(buttons: AnswerOptions['buttons']): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: (buttons ?? []).map((row) =>
      row.map((b) => ({ text: b.label, callback_data: b.action }))
    ),
  };
}

/** Who sent an update, as `allow` reads it, the author as the owner; nobody for a channel post. */
function askerOf(
  from: { id: number; username?: string } | undefined,
  authorId: number
): Asker | undefined {
  if (from === undefined) return undefined;
  return {
    id: String(from.id),
    ...(from.username === undefined ? {} : { username: from.username }),
    ...(from.id === authorId ? { owner: true } : {}),
  };
}

/**
 * Sets the `/` menu of every private chat (Telegram's `all_private_chats` scope) to the commands
 * served in every private chat (empty when none is, D109); the author's chat keeps its own, whose
 * chat scope comes first. Called once the bot is connected; a refusal is reported and left until
 * the next start of polling.
 */
export async function registerPrivateMenu(
  api: Pick<Api, 'setMyCommands'>,
  menu: readonly Command[],
  log: (line: string) => void
): Promise<void> {
  try {
    await api.setMyCommands([...menu], { scope: { type: 'all_private_chats' } });
    log('telegram: command menu of private chats set');
  } catch (e) {
    log(`telegram: command menu of private chats failed: ${String(e)}`);
  }
}

/**
 * The `/` menu of each other chat an edge serves commands in (D109), beside the author's (the
 * switchboard's), its groups' included (D128): Telegram's `chat` scope, by the chat as the edge
 * names it (an id, or a group's `@username`), set by `CommandMenus`, which retries a refusal (the
 * bot not yet in the group) and sets it again when the bot joins; its commands are answered all
 * the same.
 */
export function chatMenus(
  api: Pick<Api, 'setMyCommands'>,
  menus: ReadonlyMap<string, readonly Command[]>
): Record<string, ChatMenu> {
  return Object.fromEntries(
    [...menus].map(([chat, menu]): [string, ChatMenu] => {
      const id = /^-?\d+$/u.test(chat) ? Number(chat) : chat;
      return [
        chat,
        {
          chat: id,
          set: () => api.setMyCommands([...menu], { scope: { type: 'chat', chat_id: id } }),
        },
      ];
    })
  );
}

/** Answers in a chat outside the switchboard's topics, through the Bot API. */
function inChat(api: Api, chatId: number, replyTo: number, expire: Expire): Answer {
  const reply = { reply_parameters: { message_id: replyTo } };
  return {
    text: async (text, format, options) => {
      const sent =
        format === 'markdown'
          ? await api.sendMessage(chatId, markdownToTelegramHtml(text), {
              ...reply,
              parse_mode: 'HTML',
              ...(options?.buttons && { reply_markup: keyboard(options.buttons) }),
            })
          : await api.sendMessage(chatId, text, {
              ...reply,
              ...(options?.buttons && { reply_markup: keyboard(options.buttons) }),
            });
      expire(options, `${chatId}:${sent.message_id}`, () =>
        api.deleteMessage(chatId, sent.message_id)
      );
    },
    photo: async (photo, caption, format) =>
      (
        await api.sendPhoto(chatId, media(photo), { ...reply, ...captionOf(caption, format) })
      ).photo.at(-1)?.file_id,
  };
}
