/**
 * Command answers (docs/bot-os-api.md §4.6, bot-os.md D98, #59): what a game bot answered to a
 * node's own command, so that a node learns that its command was refused, and why, rather than
 * retrying something the game will not allow.
 *
 * - **Declared by the parsers:** a parser's manifest lists, in `answers`, which of its own events
 *   answer which commands (by first word), when (`when`, `unless`: fields of the payload), with
 *   which status (`ok`, `refused`), reason (fixed, or read from the payload) and `retryAt` (read
 *   from the payload: when the command may go again). The shell knows no game: it reads only what
 *   the declaration names.
 * - **Paired by the core:** an event a parser publishes while the core hands it a message of a chat
 *   (as the send-queue watchdog hears one, D93), which a declaration matches, answers the send of
 *   one of its commands to that chat that waits for an answer: the one the message replies to, else
 *   the oldest. A send waits for an answer when a running parser that reads its chat declares one
 *   for its command; past its window (`withinS`), it is `unanswered`, and the owner told once
 *   (an `unanswered` notice, D107) until that node's command is answered in that chat. A
 *   declaration names only the commands that can draw its event: the oldest waiting send of any of
 *   them takes it, a send the bot ignores included.
 * - **Kept here, per account:** the sends waiting, the cooldowns each answer's `retryAt` sets (per
 *   chat and command, for every command of its declaration, `holds`), and the retry-loop guard,
 *   which backs off a node whose command keeps being refused for the same reason.
 *
 * In memory, best effort: nothing is kept across a restart, where a node decides again from its
 * state.
 */
import { z } from 'zod';
import { type Clock, type TimerHandle } from './clock.ts';
import { type Notice } from './notices.ts';
import { holds, valueAt } from './paths.ts';

/** How long a send waits for its answer by default, in seconds. */
export const DEFAULT_ANSWER_WITHIN_S = 120;
/** How many refusals in a row, for the same reason, start the retry-loop guard. */
export const GUARD_AT = 3;
/** The guard's first hold, doubled at each refusal more, up to `GUARD_MAX_MS`. */
export const GUARD_BASE_MS = 60_000;
export const GUARD_MAX_MS = 3_600_000;

/** A command's first word, as the reach, the intervals and the answers name it. */
export const firstWord = (text: string): string => text.split(/\s/u, 1)[0] ?? '';

/**
 * One of a parser's answers (its manifest's `answers`): an event of its own that answers some
 * commands, when its payload holds `when` and not `unless`, with a status, a reason and when the
 * command may go again. The first of a parser's declarations that matches an event is its answer.
 */
export const answerSchema = z.strictObject({
  /** The event type, one of its own `events`. */
  event: z.string().min(1),
  /** The commands it answers, by first word (`/give`). */
  commands: z.array(z.string().min(1)).min(1),
  /** Fields of the payload, by dotted path, that it holds (as a cancel's `when`). */
  when: z.record(z.string().min(1), z.unknown()).optional(),
  /** Fields of the payload by which it is not this answer, every one of them holding. */
  unless: z.record(z.string().min(1), z.unknown()).optional(),
  status: z.enum(['ok', 'refused']),
  /** Its reason: `cooldown`, `missing`, `invalid`, or a game's own. */
  reason: z.string().min(1).optional(),
  /** The dotted path of the payload that holds its reason (a string), over `reason`. */
  reasonFrom: z.string().min(1).optional(),
  /** The dotted path of the payload that holds when the command may go again (a time in ms). */
  retryAtFrom: z.string().min(1).optional(),
  /**
   * The commands a `retryAt` holds back in that chat (a group sharing a cooldown); its `commands`
   * by default.
   */
  holds: z.array(z.string().min(1)).min(1).optional(),
  /** How long the bot takes to answer, at the most, in seconds. */
  withinS: z.number().positive().default(DEFAULT_ANSWER_WITHIN_S),
});
export type AnswerDeclaration = z.output<typeof answerSchema>;
export type AnswerDeclarationInput = z.input<typeof answerSchema>;

/** What the game answered to a send, as `await enqueue(…)` gives it (`QueuedResult.answer`). */
export interface CommandAnswer {
  /** `unanswered`: no answer within its window. */
  status: 'ok' | 'refused' | 'unanswered';
  reason?: string;
  /** When the command may go again, if the bot said. */
  retryAt?: number;
  /** The event that answered it: `{ type, t, …payload }`. */
  event?: { type: string; t: number; [field: string]: unknown };
}

/** An event read as an answer: what it answers, and the answer. */
export interface ReadAnswer {
  commands: readonly string[];
  holds: readonly string[];
  answer: CommandAnswer;
}

/** The answer an event is, by the first declaration that matches it; undefined if none does. */
export function readAnswer(
  declarations: readonly AnswerDeclaration[],
  type: string,
  payload: Readonly<Record<string, unknown>>,
  t: number
): ReadAnswer | undefined {
  const d = declarations.find(
    (x) =>
      x.event === type &&
      holds(payload, x.when) &&
      (x.unless === undefined || !holds(payload, x.unless))
  );
  if (d === undefined) return undefined;
  const from = d.reasonFrom === undefined ? undefined : valueAt(payload, d.reasonFrom);
  const reason = typeof from === 'string' && from !== '' ? from : d.reason;
  const at = d.retryAtFrom === undefined ? undefined : valueAt(payload, d.retryAtFrom);
  return {
    commands: d.commands,
    holds: d.holds ?? d.commands,
    answer: {
      status: d.status,
      ...(reason === undefined ? {} : { reason }),
      ...(typeof at === 'number' && Number.isFinite(at) ? { retryAt: at } : {}),
      event: { ...payload, type, t },
    },
  };
}

/** How long a send of `command` waits for its answer, by the declarations that answer it. */
export function answerWindowMs(
  declarations: readonly AnswerDeclaration[],
  command: string
): number | undefined {
  const within = declarations.filter((d) => d.commands.includes(command)).map((d) => d.withinS);
  return within.length === 0 ? undefined : Math.max(...within) * 1000;
}

/** A node held back by the retry-loop guard, as `GET /status` shows it. */
export interface BackoffView {
  account: string;
  chat: string;
  command: string;
  /** The reason it was refused for, so many times in a row. */
  reason: string;
  count: number;
  /** Held until then. */
  until: number;
}

/** What holds a send back: a cooldown (the bot's) or the guard (the node's), until when. */
export interface Hold {
  until: number;
  /** `cooldown: <reason>`, or `backed off: …`. */
  reason: string;
}

/** A send waiting for its answer. */
export interface Pending {
  readonly plugins: readonly string[];
  readonly chat: string;
  readonly command: string;
  /** The network's id of the message, once known: an answer replying to it is its. */
  identify(id: string): void;
  /** Hears its answer (or `unanswered`), once. */
  wait(fn: (a: CommandAnswer) => void): void;
  /** Waits no more, unsettled: the network refused the send. */
  drop(): void;
}

interface PendingEntry {
  plugins: string[];
  chat: string;
  command: string;
  id?: string;
  waiters: ((a: CommandAnswer) => void)[];
  timer?: TimerHandle;
  done: boolean;
  /** Its answer, once settled with one. */
  answer?: CommandAnswer;
}

interface Guard {
  account: string;
  chat: string;
  command: string;
  reason: string;
  count: number;
  until: number;
}

export interface AnswersOptions {
  account: string;
  clock: Clock;
  notice?: (n: Omit<Notice, 't'>) => void;
  /** A send's answer did not come in its window (for the watchdog, D93). */
  unanswered?: (plugins: readonly string[], chat: string, command: string) => void;
}

const lower = (s: string): string => s.toLowerCase();
const guardKey = (plugin: string, chat: string, command: string): string =>
  JSON.stringify([plugin, lower(chat), command]);
const coolKey = (chat: string, command: string): string => `${lower(chat)} ${command}`;

/** One account's answers: its sends waiting, its cooldowns, and its guard. */
export class Answers {
  private readonly o: AnswersOptions;
  private pending: PendingEntry[] = [];
  /** Until when a command rests in a chat (`<chat> <command>`, the chat without case), and why. */
  private readonly cool = new Map<string, { until: number; reason: string }>();
  private readonly guards = new Map<string, Guard>();
  /** The nodes' commands told unanswered (D107), by `guardKey`, until one of them is answered. */
  private readonly silent = new Set<string>();

  constructor(o: AnswersOptions) {
    this.o = o;
  }

  /** A live send that waits for its answer for `withinMs`, then is `unanswered`. */
  expect(plugins: readonly string[], chat: string, command: string, withinMs: number): Pending {
    const e: PendingEntry = { plugins: [...plugins], chat, command, waiters: [], done: false };
    this.pending.push(e);
    e.timer = this.o.clock.setTimeout(() => {
      this.settle(e, { status: 'unanswered' });
      this.o.unanswered?.(e.plugins, chat, command);
      for (const plugin of e.plugins) this.tellUnanswered(plugin, chat, command, withinMs);
    }, withinMs);
    return {
      plugins: e.plugins,
      chat,
      command,
      identify: (id) => {
        e.id = id;
      },
      wait: (fn) => {
        if (!e.done) e.waiters.push(fn);
        else if (e.answer !== undefined) fn(e.answer);
      },
      drop: () => this.settle(e, undefined),
    };
  }

  private settle(e: PendingEntry, a: CommandAnswer | undefined): void {
    if (e.done) return;
    e.done = true;
    if (a !== undefined) e.answer = a;
    this.o.clock.clearTimeout(e.timer);
    this.pending = this.pending.filter((x) => x !== e);
    if (a !== undefined) for (const w of e.waiters) w(a);
  }

  /**
   * An answer read from a message of a chat (by any of its `names`, without case), replying to
   * `replyTo` if it does: its `retryAt` holds its commands back in that chat; it settles the send
   * it answers (the one it replies to, else the oldest of its commands to that chat), whose nodes
   * the guard counts. The send it answered, if any.
   */
  answered(
    names: readonly string[],
    replyTo: string | undefined,
    read: ReadAnswer
  ): { plugins: readonly string[]; chat: string; command: string } | undefined {
    const now = this.o.clock.now();
    const { answer } = read;
    const known = new Set(names.map(lower));
    if (answer.retryAt !== undefined && answer.retryAt > now)
      for (const name of known)
        for (const command of read.holds) {
          const key = coolKey(name, command);
          const was = this.cool.get(key);
          if (was === undefined || was.until < answer.retryAt)
            this.cool.set(key, { until: answer.retryAt, reason: answer.reason ?? answer.status });
        }
    const ours = this.pending.filter(
      (p) => known.has(lower(p.chat)) && read.commands.includes(p.command)
    );
    // A reply answers the send it replies to, or one whose message's id is not known; else the
    // oldest.
    const e =
      replyTo === undefined
        ? ours[0]
        : (ours.find((p) => p.id === replyTo) ?? ours.find((p) => p.id === undefined));
    if (e === undefined) return undefined;
    this.settle(e, answer);
    for (const plugin of e.plugins) {
      this.silent.delete(guardKey(plugin, e.chat, e.command));
      this.guard(plugin, e.chat, e.command, answer);
    }
    return { plugins: e.plugins, chat: e.chat, command: e.command };
  }

  /**
   * A node's send that no answer came for in its window (D107): the owner is told once, with an
   * `unanswered` notice, until a send of that command by that node to that chat is answered; a bot
   * that ignores a command there (a game's command it takes only in a group) is then seen.
   */
  private tellUnanswered(plugin: string, chat: string, command: string, withinMs: number): void {
    const key = guardKey(plugin, chat, command);
    if (this.silent.has(key)) return;
    this.silent.add(key);
    this.o.notice?.({
      kind: 'unanswered',
      node: plugin,
      text: `${plugin} sent ${command} to ${chat} and read no answer to it within ${Math.round(withinMs / 1000)} s: the bot may ignore it there`,
      detail: { account: this.o.account, chat, command, withinS: withinMs / 1000 },
    });
  }

  /**
   * The retry-loop guard: an `ok` clears a node's count; a refusal for the reason of the last one
   * adds to it (a cooldown with its `retryAt` aside: the cooldown holds it back already), and from
   * `GUARD_AT` in a row the node's sends of that command to that chat are held back, longer at
   * each, and the owner told once.
   */
  private guard(plugin: string, chat: string, command: string, a: CommandAnswer): void {
    const key = guardKey(plugin, chat, command);
    if (a.status === 'ok') {
      this.guards.delete(key);
      return;
    }
    if (a.status !== 'refused' || a.retryAt !== undefined) return;
    const reason = a.reason ?? 'refused';
    const was = this.guards.get(key);
    const count = was !== undefined && was.reason === reason ? was.count + 1 : 1;
    const now = this.o.clock.now();
    const ms =
      count < GUARD_AT ? 0 : Math.min(GUARD_BASE_MS * 2 ** (count - GUARD_AT), GUARD_MAX_MS);
    this.guards.set(key, {
      account: this.o.account,
      chat,
      command,
      reason,
      count,
      until: now + ms,
    });
    if (count === GUARD_AT)
      this.o.notice?.({
        kind: 'backoff',
        node: plugin,
        text: `${plugin} sent ${command} to ${chat} ${count} times, refused each time (${reason}): held back, longer at each refusal more`,
        detail: { account: this.o.account, chat, command, reason, count },
      });
  }

  /** What holds a node's send of `command` to `chat` back now, the longest; undefined: nothing. */
  held(plugin: string, chat: string, command: string): Hold | undefined {
    const now = this.o.clock.now();
    const cool = this.cool.get(coolKey(chat, command));
    const g = this.guards.get(guardKey(plugin, chat, command));
    const holds: Hold[] = [
      ...(cool !== undefined && cool.until > now
        ? [{ until: cool.until, reason: `cooldown: ${cool.reason}` }]
        : []),
      ...(g !== undefined && g.until > now
        ? [
            {
              until: g.until,
              reason: `backed off: refused ${g.count} times in a row (${g.reason})`,
            },
          ]
        : []),
    ];
    return holds.sort((x, y) => y.until - x.until)[0];
  }

  /** A node's commands the guard counts refusals of, as `GET /status` shows them. */
  backoffs(plugin: string): BackoffView[] {
    return [...this.guards]
      .filter(([key, g]) => (JSON.parse(key) as string[])[0] === plugin && g.count >= GUARD_AT)
      .map(([, g]) => ({ ...g }));
  }
}
