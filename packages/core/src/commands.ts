/**
 * Chat commands (docs/bot-os-api.md §2 `interface.commands`, P11). A plugin declares its commands
 * in its manifest (name, help, arguments, aliases, and the description of the players' menus) and
 * its instance offers a handler for each; the core lists them (`core.commands()`) for the chat
 * surface, which registers them in its menus and answers them, in reply to whoever asked.
 *
 * The answer is the surface's, as a page of the web UI is: a plugin's handler says what to answer,
 * and the surface sends it where the command came from. What a plugin sends on its own goes through
 * the outbox, in its mode (§4.6, P10).
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

/** How a handler answers, in reply to the command, in the chat it came from. */
export interface Answer {
  /** Sends `text`, plain unless `format` says it is Markdown. */
  text(text: string, format?: TextFormat, options?: AnswerOptions): Promise<void>;
  /** Sends a photo; the network's id for it, if it gives one, to send it again by. */
  photo(photo: CommandPhoto): Promise<string | undefined>;
}

/** What was asked: the text typed after the command, trimmed. */
export interface Request {
  args: string;
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
}
