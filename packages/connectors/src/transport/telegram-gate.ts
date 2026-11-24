/**
 * A `telegram-bot`'s gate (bot-os.md D128, which replaced D100's deny list): whom and where it
 * works for, the connector's outer check, before any plugin, commands edge or chat surface sees an
 * update. **Groups:** any group it is added to, but those it blocks; or only the groups it lists.
 * In a group it does not work in, nothing goes further: no command is answered (each one recorded),
 * and no message reaches a reader. **People:** anyone, but those it blocks; or only the people it
 * lists; in any chat, a group's or a private one. A person it does not work for has their commands
 * and taps dropped (each one recorded, and answered with the owner's reply line if any, at most
 * once per person every `DENY_REPLY_MS`), while what they say still reaches the readers: a module
 * may read another bot's messages that no one lets command it. Its owner is always allowed, listed
 * or not. Each list names a chat as its connector does: by id, or by `@username` where only that is
 * known, compared without case.
 */
import { type Message } from 'grammy/types';
import { isGroup, Throttle, unmarkedOf } from './telegram-commands.ts';

/** How often a person refused is answered, at most: once every 10 minutes. */
export const DENY_REPLY_MS = 10 * 60_000;

/** A command dropped, as recorded (`telegram-bot.denied`) and counted. */
export interface Denied {
  /** The chat, by id, and its title where Telegram gave it. */
  chat: string;
  chatTitle?: string;
  /** Whom it refused: as its list names them, or by `@username` (else id) when not listed. */
  sender: string;
  /** Why: a group it does not work in, or a person it does not work for. */
  by: 'group' | 'person';
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

/** Whom or where it works: only those listed (`only`), or any but those blocked (`block`). */
export interface GateRule {
  only?: readonly string[] | undefined;
  block?: readonly string[] | undefined;
}

export interface GateOptions {
  groups?: GateRule;
  people?: GateRule;
  /** The owner's user id: always allowed. */
  owner?: number | undefined;
  /** The line it answers a person refused with; none: silent. */
  reply?: string | undefined;
  now: () => number;
}

/** A name compared as Telegram does: without case, and without a leading `@`. */
const plain = (s: string): string => s.trim().replace(/^@/u, '').toLowerCase();

/** A list by its names compared, each with the entry as written. */
const index = (names: readonly string[] | undefined): ReadonlyMap<string, string> | undefined =>
  names === undefined ? undefined : new Map(names.map((n) => [plain(n), n]));

/** A rule's lists, indexed. */
interface Rule {
  only?: ReadonlyMap<string, string> | undefined;
  block?: ReadonlyMap<string, string> | undefined;
}

const ruleOf = (r: GateRule | undefined): Rule => ({
  only: index(r?.only),
  block: index(r?.block),
});

/** Who or what a rule refuses, by its names (an id, a `@username`): its entry, or its name. */
function refused(rule: Rule, names: readonly string[]): string | undefined {
  const hit = (list: ReadonlyMap<string, string>): string | undefined => {
    for (const n of names) {
      const entry = list.get(plain(n));
      if (entry !== undefined) return entry;
    }
    return undefined;
  };
  if (rule.only !== undefined)
    return hit(rule.only) === undefined ? (names.at(-1) ?? names[0]) : undefined;
  return rule.block === undefined ? undefined : hit(rule.block);
}

export class Gate {
  private readonly groups: Rule;
  private readonly people: Rule;
  private readonly o: GateOptions;
  private readonly replies = new Throttle(DENY_REPLY_MS, 0);
  private counted: DenyCount = { count: 0 };

  constructor(o: GateOptions) {
    this.o = o;
    this.groups = ruleOf(o.groups);
    this.people = ruleOf(o.people);
  }

  /** Whether it refuses anything at all: without, it need not be asked. */
  get active(): boolean {
    return [this.groups, this.people].some((r) => r.only !== undefined || r.block !== undefined);
  }

  /**
   * The group's name if it does not work in `chat`: a group it blocks (as its list names it), or
   * one not on its list (by `@username`, else id); undefined in any other chat.
   */
  refusesGroup(chat: {
    id: number;
    type: string;
    username?: string | undefined;
  }): string | undefined {
    if (!isGroup(chat)) return undefined;
    return refused(this.groups, [
      String(chat.id),
      ...(chat.username === undefined ? [] : [`@${chat.username}`]),
    ]);
  }

  /**
   * The person's name if it does not work for `from`: one it blocks (as its list names them), or
   * one not on its list (by `@username`, else id); never its owner, nor an update from no one.
   */
  refusesPerson(
    from: { id: number; username?: string | undefined } | undefined
  ): string | undefined {
    if (from === undefined || from.id === this.o.owner) return undefined;
    return refused(this.people, [
      String(from.id),
      ...(from.username === undefined ? [] : [`@${from.username}`]),
    ]);
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
 * `/roll` or `/roll@ExampleBot`, not one addressed to another bot (`/roll@OtherBot`); or one of the
 * aliases Telegram does not mark as commands (`unmarked`, in lower case, D162), typed so.
 */
export function commandOf(
  m: Pick<Message, 'text' | 'entities'>,
  me: string | undefined,
  unmarked: ReadonlySet<string> = new Set()
): string | undefined {
  const first = m.entities?.[0];
  if (m.text === undefined) return undefined;
  if (first?.type !== 'bot_command' || first.offset !== 0) {
    const u = unmarkedOf(m, unmarked, me);
    return u === undefined ? undefined : `/${u.name}`;
  }
  const [name, to] = m.text.slice(0, first.length).split('@');
  if (to !== undefined && me !== undefined && to.toLowerCase() !== me.toLowerCase())
    return undefined;
  return name;
}
