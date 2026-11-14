/**
 * A `telegram-bot`'s deny list (bot-os.md D100): the people and bots whose commands in a group it
 * drops before any plugin sees them, its chat surface included, picked by the owner among its
 * chats (by user id, or a `@username` where only that is known). A private chat is unaffected, and
 * so is the owner, whom no list denies. Each drop is counted and recorded; it is silent unless the
 * owner set a one-line reply, sent at most once per person every `DENY_REPLY_MS`, so that a person
 * who spams the commands cannot make the bot spam back.
 */
import { type Message } from 'grammy/types';
import { Throttle } from './telegram-commands.ts';

/** How often a denied person is answered, at most: once every 10 minutes. */
export const DENY_REPLY_MS = 10 * 60_000;

/** A command dropped, as recorded (`telegram-bot.denied`) and counted. */
export interface Denied {
  /** The group, by id, and its title where Telegram gave it. */
  chat: string;
  chatTitle?: string;
  /** Whom it denied, as its list names them. */
  sender: string;
  /** The command, without its arguments (`/roll`), or a button's action. */
  command: string;
  /** Whether it answered with its reply line. */
  replied: boolean;
}

/** What it has denied since it started, for the node's view and its card. */
export interface DenyCount {
  count: number;
  last?: Denied & { t: number };
}

/** A name compared as Telegram does: without case, and without a leading `@`. */
const plain = (s: string): string => s.trim().replace(/^@/u, '').toLowerCase();

export interface DenyListOptions {
  /** The people and bots denied, by user id or `@username`. */
  deny: readonly string[];
  /** The owner's user id: never denied. */
  owner?: number | undefined;
  /** The line it answers a denied command with; none: silent. */
  reply?: string | undefined;
  now: () => number;
}

export class DenyList {
  private readonly names: ReadonlyMap<string, string>;
  private readonly o: DenyListOptions;
  private readonly replies = new Throttle(DENY_REPLY_MS, 0);
  private counted: DenyCount = { count: 0 };

  constructor(o: DenyListOptions) {
    this.o = o;
    this.names = new Map(o.deny.map((d) => [plain(d), d]));
  }

  /**
   * The entry of the list that denies `from` in `chat`, as the list names it; undefined in a private
   * chat or a channel, for the owner, or anyone not on it.
   */
  denies(
    chat: { type: string },
    from: { id: number; username?: string } | undefined
  ): string | undefined {
    if (from === undefined || this.names.size === 0) return undefined;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return undefined;
    if (from.id === this.o.owner) return undefined;
    return (
      this.names.get(String(from.id)) ??
      (from.username === undefined ? undefined : this.names.get(plain(from.username)))
    );
  }

  /** Whether to answer `sender` with the reply line now, counting the answer if so. */
  replyTo(sender: string): string | undefined {
    const line = this.o.reply;
    if (line === undefined || !this.replies.allow(sender, this.o.now())) return undefined;
    return line;
  }

  /** A drop, counted. */
  count(d: Denied): void {
    this.counted = { count: this.counted.count + 1, last: { ...d, t: this.o.now() } };
  }

  /** What it has denied since it started. */
  denied(): DenyCount {
    return structuredClone(this.counted);
  }
}

/**
 * The command a message starts with, without its arguments (`/roll`), if it is one for this bot:
 * `/roll` or `/roll@ExampleBot`, not one addressed to another bot (`/roll@OtherBot`).
 */
export function commandOf(
  m: Pick<Message, 'text' | 'entities'>,
  me: string | undefined
): string | undefined {
  const first = m.entities?.[0];
  if (m.text === undefined || first?.type !== 'bot_command' || first.offset !== 0) return undefined;
  const [name, to] = m.text.slice(0, first.length).split('@');
  if (to !== undefined && me !== undefined && to.toLowerCase() !== me.toLowerCase())
    return undefined;
  return name;
}
