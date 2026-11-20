/**
 * Chat commands (docs/bot-os-api.md §2 `interface.commands`, P11). A plugin declares its commands
 * in its manifest (name, help, arguments, aliases, and the description of the players' menus) and
 * its instance offers a handler for each. A chat surface serves only those a commands edge of the
 * graph serves from its connector (bot-os.md D109: no edge, no chat command): the core gives it
 * them (`core.served(node)`), each with where it is answered (`where`, the edge's chats) and the
 * edge's senders and dry run held by the core, and the surface registers each in the menus of the
 * chats it is served in and answers it there, in reply to whoever asked.
 *
 * The answer goes to the asker in the chat asked (D29), within the edge: the core records each
 * (`core.send`, its origin `command /name`) and, on a dry-run edge, logs it and sends nothing.
 * What a plugin sends on its own goes through the outbox, within its chat-out edges (§4.6, P10).
 *
 * The types are the network's least: a text, plain or Markdown, with buttons that each run a
 * command again; a photo, as bytes or by the id the network gave it once sent. Nothing in here
 * knows of any network.
 */
import { type TextFormat } from './outbox.ts';

/**
 * A button under an answer or a notification: tapping it runs `action`, a command, again. The
 * action is the command as typed (`/report 8`), or in short, `name:args` (`opt:fast:on`, the
 * command `opt` with `fast:on`) or a bare name (`kill`): the owner's buttons are short, to fit the
 * networks' limits (Telegram's 64 bytes) (`tapOf` reads both).
 */
export interface CommandButton {
  label: string;
  action: string;
}

/** Rows of buttons. */
export type Buttons = readonly (readonly CommandButton[])[];

export interface AnswerOptions {
  /** In a group, deletes the answer this long after it was sent; private chats keep it. */
  deleteInGroupAfterMs?: number;
  /** Rows of buttons, each a command to run again, which redraws the answer in place. */
  buttons?: Buttons;
  /**
   * Answering a tap, sends a new message and leaves the one tapped as it is, rather than redrawing
   * it (the outcome of a kill tapped under a notification).
   */
  keep?: boolean;
}

/** The command a button's action runs, and the text after it (`tapOf('opt:fast:on')`). */
export function tapOf(action: string): { name: string; args: string } | undefined {
  const typed = /^\/(\w+)(?:\s+(.*))?$/su.exec(action);
  if (typed !== null) return { name: typed[1] ?? '', args: typed[2] ?? '' };
  const short = /^(\w+)(?::(.*))?$/su.exec(action);
  if (short !== null) return { name: short[1] ?? '', args: short[2] ?? '' };
  return undefined;
}

/** A photo to send: its bytes and a file name, or the network's id of one sent before. */
export type CommandPhoto = string | { data: Uint8Array; filename: string };

/**
 * The longest caption a photo may carry (bot-os.md D150): Telegram's, 1024 characters, counted as
 * written (UTF-16 code units, Markdown's marks included). A longer one is refused before sending.
 */
export const CAPTION_MAX = 1024;

/** Why a photo's caption cannot go (longer than `CAPTION_MAX`); undefined when it can. */
export function captionRefusal(caption: string | undefined): string | undefined {
  return caption !== undefined && caption.length > CAPTION_MAX
    ? `a caption of ${caption.length} characters, over the ${CAPTION_MAX} a photo may carry`
    : undefined;
}

/**
 * A photo as the log names it, never its bytes: `[photo <filename>]`, or `[photo]` by the network's
 * id.
 */
export function photoLabel(photo: CommandPhoto): string {
  return typeof photo === 'string' ? '[photo]' : `[photo ${photo.filename}]`;
}

/** How a handler answers, in reply to the command, in the chat it came from. */
export interface Answer {
  /** Sends `text`, plain unless `format` says it is Markdown. */
  text(text: string, format?: TextFormat, options?: AnswerOptions): Promise<void>;
  /**
   * Sends a photo, with `caption` under it if given, plain unless `format` says it is Markdown (a
   * caption over `CAPTION_MAX` is refused, thrown, before sending); the network's id for the photo,
   * if it gives one, to send it again by.
   */
  photo(photo: CommandPhoto, caption?: string, format?: TextFormat): Promise<string | undefined>;
}

/** What was asked: the text typed after the command, trimmed. */
export interface Request {
  args: string;
  /** The chat it was asked in, as its connector names it (a Telegram chat's id), when known. */
  chat?: string;
}

/** Where a chat surface answers a command (bot-os.md D109), as its commands edge says. */
export interface CommandScope {
  /** The chats it is answered in, as the connector names them (an id, a `@username`). */
  chats: readonly string[];
  /** Every private chat with the account too. */
  privateChats: boolean;
}

/** Who asked: the network's id and username, and whether it is the instance's owner. */
export interface Asker {
  id: string;
  username?: string;
  owner?: boolean;
}

/** A command's handler, as a plugin's instance offers it. */
export interface CommandHandler {
  run(answer: Answer, request: Request): Promise<void>;
  /** Whether `asker` may ask it; anyone, if not given. Anyone else is ignored without a word. */
  allow?(asker: Asker): boolean;
}

/** A command of a running plugin, as the core lists it for the chat surface. */
export interface ChatCommand extends CommandHandler {
  plugin: string;
  name: string;
  /** What it does, in the owner's words (the owner's menu, the UI, the agents). */
  help: string;
  args?: string;
  /** Other names it answers to, in no menu. */
  aliases: readonly string[];
  /** Its description in the players' menus, in their language; not listed there without one. */
  menu?: string;
  /** The owner's alone: answered to the owner only, in the owner's chat. */
  owner: boolean;
  /** In no menu: a button's action, or typed by hand. */
  hidden: boolean;
  /**
   * Where a surface answers it (D109), as the commands edge that serves it says; none: the core's
   * own, the owner's controls, answered in the owner's chat alone.
   */
  where?: CommandScope;
}

/** Whether `chat`, by its names (an id, a `@username`) and kind, is in `scope` (D109). */
export function inScope(
  scope: CommandScope,
  chat: { names: readonly string[]; private: boolean }
): boolean {
  if (scope.privateChats && chat.private) return true;
  const names = chat.names.map((n) => n.toLowerCase());
  return scope.chats.some((c) => names.includes(c.toLowerCase()));
}
