/**
 * The outbox (docs/bot-os-api.md §4.6, bot-os.md §3): one per account, and every send leaves
 * through it. It runs its checks in a fixed order, each refusal
 * with its reason:
 *
 * 1. the caller's own refusal, if it gives one (a game's grammar: not one of its commands);
 * 2. the sender's reach: the chats its chat-out edges send to, and the commands, by their first
 *    word; an edge that is `dryRun` (bot-os.md D64) lets the send through as a dry run, which stops
 *    before the network and is logged as sent;
 * 3. why the sender cannot send now: stopped by the core (a safety stop, drift, the owner), or not
 *    running;
 * 4. a flood wait the network asked for (Telegram's `FLOOD_WAIT`), which holds the account;
 * 5. the account's rate: at least `minIntervalMs` between two sends and at most `maxPerHour` in
 *    any hour, dry runs counted;
 * 6. the connector, which may not be connected: a queued live send waits while its account
 *    connects (bot-os.md D108), up to its deadline or `CONNECT_WAIT_MS`.
 *
 * A **watchdog** (bot-os.md D93) stands before a live send of a node that waits for answers (an
 * actor, to a chat a parser reads): the sends of one command (its first word), by one node, to one
 * chat, that went without any event read from that chat before the next, are counted; past the
 * connector's threshold (`unansweredAt`, per command `unansweredAtBy`), the node is paused as drift
 * pauses (P5) and a `stalled` notice is raised. Dry runs are never counted.
 *
 * **Command answers** (bot-os.md D98, #59, `answers.ts`): a live send of a command that a parser
 * reading its chat declares an answer for waits for that answer; a queued one settles with it
 * (`answer`: `ok`, `refused`, or `unanswered` past its window). The retry-loop guard backs off a
 * node whose command keeps being refused for the same reason (a queued send waits it out, an
 * immediate one is refused). The outbox keeps no game's cooldown (bot-os.md D142): when a command
 * may be played is a state's readiness, which a sender that cares binds to.
 *
 * Every attempt is logged (`core.send`), with its outcome. `send` sends now or refuses, for actors
 * that time their sends to the second; `enqueue` waits its turn within the limits; `deliver` sends
 * now or refuses, as `send` does, and waits for the network's answer (Telegram's), with the sent
 * message's id, or `failed` with why if the network refused it.
 *
 * **A photo** (bot-os.md D150) goes as a text does, each of the three taking one (`PhotoSend`: a
 * `Media`, D153, or the network's id of one sent before, a caption, the message it answers) where they take
 * a text, through the same checks but those of a command: it has no first word, so an edge that
 * names its commands lets it through only if it, or its output, says `photos`; no watchdog, no
 * answer waited for, no command's interval, never coalesced. A caption over `CAPTION_MAX`, bytes no
 * image of `PHOTO_MIMES` or not of the type they say (`photoRefusal`), and a connector that cannot
 * send photos (no `deliverPhoto`) refuse it at once. It is logged by its label (its type and its
 * bytes' count) and its caption's length, never its bytes; it answers the network's id of the photo sent
 * (`photo`), to send it again by.
 *
 * **A send the network refuses** (bot-os.md D95), whichever way it went: a queued or immediate send
 * goes through the connector's `deliver` where it has one, so its answer comes back to the outbox
 * rather than to the container's log alone. A refusal (not a flood wait, which holds the account)
 * is recorded (`core.send-failed`: the account, the nodes, the chat, the reason) and raised as an
 * `unreachable` notice per node, its reason in the owner's words (`unreachableHint`), but for a
 * node that tells the owner itself (`quiet`: `owner-notice`, no loop); a queued send settles
 * `failed`, with why.
 */
import { z } from 'zod';
import {
  Answers,
  type BackoffView,
  type CommandAnswer,
  firstWord,
  type Hold,
  type Pending,
  type ReadAnswer,
} from './answers.ts';
import { type Clock, type TimerHandle } from './clock.ts';
import { type Buttons, type CommandPhoto, photoLabel, photoRefusal } from './commands.ts';
import { type Connector } from './connector.ts';
import { type Notice } from './notices.ts';

/**
 * How a sender's send goes (bot-os.md D64): `dry-run` when every edge that lets it through is a dry
 * run, logged as sent and never sent; `live` otherwise.
 */
export type SendMode = 'dry-run' | 'live';

/** An account's limits, below the network's own; one not given does not limit. */
export interface Limits {
  minIntervalMs?: number;
  maxPerHour?: number;
  /**
   * The least time between two sends of one command in one chat that a queued send waits for
   * (bot-os.md D73), where the edge names none for it; none: 0.
   */
  commandIntervalMs?: number;
  /**
   * How many sends of one command, by one node, to one chat, may go unanswered in a row before the
   * node is paused (bot-os.md D93); 0: never. None: `DEFAULT_UNANSWERED_AT`.
   */
  unansweredAt?: number;
  /** The same, per command (by first word), over `unansweredAt`; 0 turns a command's off. */
  unansweredAtBy?: Readonly<Record<string, number>>;
}

/** How many sends of a command may go unanswered in a row by default (bot-os.md D93). */
export const DEFAULT_UNANSWERED_AT = 10;

export type SendResult = {
  text: string;
  outcome: 'sent' | 'dry-run' | 'refused';
  reason?: string;
  /** Refused as the retry-loop guard backs its node off (D98, D142): when it may go again. */
  retryAt?: number;
};

/**
 * A photo to send (bot-os.md D150): a `Media` (D153), or the network's id of one sent before
 * (`CommandPhoto`); the words under it, plain unless `SendOptions.format` says Markdown, at
 * most `CAPTION_MAX` characters; and the network's id of a message in that chat it answers.
 */
export interface PhotoSend {
  photo: CommandPhoto;
  caption?: string;
  replyTo?: string;
}

/** What a send carries: a text, or a photo. */
export type Outgoing = string | PhotoSend;

/** A send's text as results and the log give it: the text, or the photo's label, never its bytes. */
const textOf = (m: Outgoing): string => (typeof m === 'string' ? m : photoLabel(m.photo));

/** A send that waited for the network's answer (`deliver`): its id, or why it failed there. */
export type DeliverResult = {
  text: string;
  outcome: SendResult['outcome'] | 'failed';
  reason?: string;
  /** The network's id of the message sent. */
  id?: string;
  /** A photo's: the network's id of the photo sent, to send it again by (D150). */
  photo?: string;
  /** Refused as the retry-loop guard backs its node off (D98, D142): when it may go again. */
  retryAt?: number;
};

/** An attempt, as the log keeps it. */
export type SendRecord = DeliverResult & {
  type: 'core.send';
  t: number;
  plugin: string;
  account: string;
  chat: string;
  /** Who in the plugin asked: `strategy`, `control`, … */
  origin: string;
  mode: SendMode;
  /** The other nodes a coalesced queued send went for (bot-os.md D73). */
  with?: string[];
  /** A photo's caption's length, in characters (D150); its text, the photo's label. */
  caption?: number;
};

/** Thrown by a connector's `send` when the network asks to wait: the account holds that long. */
export class FloodWait extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`flood wait of ${Math.round(ms / 1000)} s`);
    this.ms = ms;
  }
}

/**
 * A connector's default interval between two queued sends of one command in one chat (bot-os.md
 * D73), a field of its config: where a chat-out edge names none for a command.
 */
export const commandIntervalS = z
  .number()
  .min(0)
  .default(0)
  .describe(
    'The least seconds between two queued sends of one command in one chat, where the edge names none (0: only the account’s pace)'
  );

/**
 * A connector's send-queue watchdog (bot-os.md D93), fields of its config beside
 * `commandIntervalS`: how many sends of one command, by one node, to one chat, may go without an
 * answer in a row before that node is paused; and the same per command.
 */
export const unansweredAt = z
  .number()
  .int()
  .min(0)
  .default(DEFAULT_UNANSWERED_AT)
  .describe(
    'How many sends of one command, by one node, to one chat, may go without any event read from that chat before the next, before the node is stopped (0: never)'
  );
export const unansweredAtBy = z
  .record(z.string().min(1), z.number().int().min(0))
  .optional()
  .describe(
    'The same per command, by its first word, such as { "/inventory": 3 }; 0 turns a command’s off'
  );

/**
 * What one edge lets a sender send: its chats, and its commands by first word (none: any text);
 * `dryRun`, logged as sent and never sent (bot-os.md D64).
 */
export interface Reach {
  sends: readonly string[];
  commands?: readonly string[] | undefined;
  /**
   * The least seconds between two sends of a command (by first word) in one chat, for a queued
   * send (bot-os.md D73); a command not named: the connector's `commandIntervalMs`.
   */
  minIntervalS?: Readonly<Record<string, number>> | undefined;
  dryRun?: boolean | undefined;
  /**
   * It lets photos through (bot-os.md D150) where it names its `commands`: a photo has no first
   * word. An edge that names none lets them through anyway.
   */
  photos?: boolean | undefined;
}

/** What the outbox knows of a sender: its reach on this account's connector, and a stop. */
export interface SenderPolicy {
  /**
   * The chats it may send to, and the commands (by first word), of each edge that binds it to this
   * account (§2.1); undefined: anything, for real.
   */
  reach?: Reach | readonly Reach[] | undefined;
  /** Why it cannot send now (`stopped: …`, `not running (…)`), if it cannot. */
  held?: string | undefined;
}

export interface OutboxOptions {
  account: string;
  /** The account's connector, while it runs. */
  connector: () => Connector | undefined;
  /** The account's limits; none: no rate limit. */
  limits?: () => Limits | undefined;
  clock: Clock;
  /** What the outbox knows of a sender, at each send: through its output `port`, if one is named. */
  policy?: (plugin: string, port?: string) => SenderPolicy;
  /** Where every attempt, and every step of the queue, goes: the event log. */
  record?: (r: SendRecord | QueueRecord | SendFailedRecord) => void;
  /**
   * What the owner should hear of (bot-os.md D91): a send coalesced across nodes (`coalesced`),
   * raised as a notice; and a node its watchdog paused (`stalled`, D93).
   */
  notice?: (n: Omit<Notice, 't'>) => void;
  /**
   * Whether a sender's sends to a chat wait for an answer (bot-os.md D93): it acts, and a node that
   * publishes events reads that chat. None: no send is watched.
   */
  watch?: (plugin: string, chat: string) => boolean;
  /**
   * Whether a node tells the owner itself (`owner-notice`, D95): a send of its that the network
   * refuses is recorded, never raised as a notice, which it would send again.
   */
  quiet?: (plugin: string) => boolean;
  /** A chat's title, as the connector knows it, for the owner's words (D95). */
  title?: (chat: string) => string | undefined;
  /** Pauses a node whose sends went unanswered (D93), with why: the core's stop. */
  pause?: (plugin: string, reason: string) => void;
  /**
   * How long a live send of a command (its first word) to a chat waits for its answer (bot-os.md
   * D98): a parser that reads the chat declares one; undefined: no answer is waited for.
   */
  expects?: (chat: string, command: string) => number | undefined;
  /**
   * Where the account's connection is (bot-os.md D108): `connected`; `connecting`, its connector
   * about to start, starting, or running and (re)connecting, so that a queued live send waits for
   * it; `down`, no connector running (stopped, disabled, failed), so that it is refused at once.
   * None: never waited for.
   */
  connection?: () => 'connected' | 'connecting' | 'down';
}

export interface SendOptions {
  /** Who in the plugin asks; the plugin's id if not given. */
  origin?: string;
  /** The caller's own reason to refuse it, logged as every attempt is. */
  refuse?: string;
  /**
   * The text is Markdown (`deliver` only): a connector that formats sends it formatted (Telegram's
   * as HTML), any other as written.
   */
  format?: TextFormat;
  /**
   * The chat-out output it goes through (the core's handles set it, `ctx.outbox(port)`): only that
   * output's edge reaches, and makes it a dry run or not; none: every edge to this account.
   */
  port?: string;
  /**
   * Rows of buttons, each a command a tap runs (bot-os.md D94, `owner-notice` telling a `told`
   * notice): a connector that can run them in that chat sends them, any other the text alone. A
   * queued send with buttons is never coalesced.
   */
  buttons?: Buttons;
}

/** How a text is written: Markdown, or plain when not said. */
export type TextFormat = 'markdown';

/** A plugin's way out through one account's outbox. */
export interface OutboxHandle {
  readonly account: string;
  readonly plugin: string;
  /**
   * How it sends now: `dry-run` when every edge that binds it to this account is a dry run, `live`
   * otherwise.
   */
  mode(): SendMode;
  /** Sends a text, or a photo (D150), now, or refuses with why. */
  send(chat: string, message: Outgoing, options?: SendOptions): SendResult;
  /**
   * Queues a send (bot-os.md D73): in its turn, spaced within the account's limits and its
   * command's interval in that chat, coalesced with the same text another node has waiting for the
   * same chat (never a photo), and dropped if its `cancel` holds before it goes. Awaited, its
   * outcome, with a photo's id once sent.
   */
  enqueue(chat: string, message: Outgoing, options?: QueueOptions): QueuedSend;
  /**
   * Sends now or refuses, and waits for the network's answer: the message's id, and a photo's
   * (`photo`), to send it again by.
   */
  deliver(chat: string, message: Outgoing, options?: SendOptions): Promise<DeliverResult>;
  /**
   * What holds its sends of `command` (a first word) to `chat` back now (bot-os.md D98, D142): the
   * retry-loop guard, until when, and why; never a game's cooldown, which is a state's. Undefined:
   * nothing does.
   */
  held(chat: string, command: string): Hold | undefined;
  /**
   * The account's owner's own chat, where its connector has one (a telegram-bot's `owner`).
   * Undefined while the connector does not run.
   */
  owner(): string | undefined;
  /**
   * The chats it may send to (bot-os.md D97): those its edges name, or, for an edge that names
   * none from an output that sends to the owner's (`owner`), the owner's chat while the connector
   * runs. A node whose edge is its only setting (owner-notice, the player) sends there.
   */
  chats(): string[];
}

/** An event as a cancel tests it: the bus's, `{ type, t, ...payload }`. */
export interface CancelEvent {
  type: string;
  t: number;
  [field: string]: unknown;
}

/**
 * When a queued send is dropped before it goes (bot-os.md D73), each condition enough: an event of
 * `on` (a type or a namespace the node hears) whose fields equal `when` (dotted paths, as a
 * reaction's; a list at a path matches a value it contains) and pass `test`, a plugin's own; or
 * the time: `deadline` (ms), or `withinMs` from now, after which it expires.
 */
export interface CancelWhen {
  on?: string | readonly string[];
  when?: Readonly<Record<string, unknown>>;
  test?: (event: CancelEvent) => boolean;
  deadline?: number;
  withinMs?: number;
}

export interface QueueOptions extends SendOptions {
  cancel?: CancelWhen;
}

/**
 * What came of a queued send: the send's outcome (`failed`: the network refused it, D95), or
 * dropped before it went.
 */
export type QueueOutcome = SendResult['outcome'] | 'failed' | 'cancelled' | 'expired';

export interface QueuedResult {
  text: string;
  outcome: QueueOutcome;
  reason?: string;
  /** Refused as the retry-loop guard backs its node off: when it may go again. */
  retryAt?: number;
  /** A photo sent: the network's id of it, to send it again by (D150). */
  photo?: string;
  /** The event that cancelled it. */
  event?: CancelEvent;
  /**
   * What the game answered (bot-os.md D98): for a live send of a command a parser declares an
   * answer for, once it came, or `unanswered` past its window.
   */
  answer?: CommandAnswer;
}

/**
 * A queued send's handle (bot-os.md D73): awaited (or `result`), its outcome; `status()` now;
 * `cancel()` drops it if it still waits (true then).
 */
export interface QueuedSend extends PromiseLike<QueuedResult> {
  readonly id: number;
  readonly result: Promise<QueuedResult>;
  status(): 'waiting' | QueueOutcome;
  cancel(reason?: string): boolean;
}

/** A step of the queue, as the log keeps it (`core.queue`). */
export type QueueRecord = {
  type: 'core.queue';
  t: number;
  account: string;
  plugin: string;
  chat: string;
  text: string;
  event: 'queued' | 'coalesced' | QueueOutcome;
  reason?: string;
  /** The event that cancelled it, by type. */
  by?: string;
};

/** A send the network refused (bot-os.md D95), as the log keeps it (`core.send-failed`). */
export type SendFailedRecord = {
  type: 'core.send-failed';
  t: number;
  account: string;
  /** The nodes it went for (several, coalesced). */
  plugins: string[];
  chat: string;
  /** The chat's title, where the connector knows it. */
  title?: string;
  text: string;
  /** The network's words. */
  reason: string;
  /** What it means, in the owner's words, and what to do. */
  hint: string;
};

/**
 * A network's refusal of a send, in the owner's words (bot-os.md D95): what it means, and what to
 * do; the network's own words when they say nothing known.
 */
export function unreachableHint(reason: string): string {
  const r = reason.toLowerCase();
  if (/bot was blocked/u.test(r)) return 'the person blocked the bot';
  if (/user is deactivated|input_user_deactivated/u.test(r)) return 'that account was deleted';
  if (/kicked|not a member|user_not_participant|channel_private/u.test(r))
    return 'it is not a member of that chat: add it again, or pick another chat';
  if (/not enough rights|have no rights|chat_write_forbidden|chat_admin_required/u.test(r))
    return 'it may not post in that chat: give it the right to send there';
  if (/chat not found|peer_id_invalid|username_not_occupied|username_invalid|input entity/u.test(r))
    return 'it cannot find that chat: a person must message it first (a bot: /start), a group or channel must add it; pick the chat again in its picker';
  if (/only to its channel/u.test(r)) return reason;
  return `refused: ${reason}`;
}

/** A queued send, as the owner sees it (the connector's panel, `GET /plugins/<id>/queue`). */
export interface QueueEntryView {
  chat: string;
  text: string;
  command: string;
  queuedAt: number;
  /** When it may go at the earliest: its command's interval, and the account's pace. */
  waitingUntil: number;
  intervalS: number;
  /** Each node that asked for it (several, coalesced), with its conditions. */
  nodes: {
    plugin: string;
    origin: string;
    cancel?: { on?: string[]; when?: Record<string, unknown>; test?: boolean; deadline?: number };
  }[];
}

/**
 * The sends coalesced since the instance started (bot-os.md D73), which may say that two nodes
 * duplicate a piece of logic: how many times a node joined another's waiting send, and each pair
 * of nodes that shared one, with how many times.
 */
export interface CoalescedView {
  count: number;
  pairs: { nodes: [string, string]; count: number }[];
}

/** One node's share of a queued send. */
interface Member {
  id: number;
  plugin: string;
  options: SendOptions;
  cancel?: CancelWhen;
  deadline?: number;
  intervalMs: number;
  status: 'waiting' | QueueOutcome;
  /** Its handle has settled. */
  done: boolean;
  settle: (r: QueuedResult) => void;
  timer?: TimerHandle;
}

/** A send waiting in its chat's queue: one text, for one or more nodes, or one node's photo. */
interface Waiting {
  chat: string;
  /** Its text, or a photo's label. */
  text: string;
  /** A photo's (D150): what goes. */
  photo?: PhotoSend;
  /** Its first word; `''` for a photo, which is no command. */
  command: string;
  queuedAt: number;
  members: Member[];
  /** Since when it waits for the account to connect (D108), while it does. */
  connectingSince?: number;
}

/** The sends of one command, by one node, to one chat, gone unanswered in a row (D93). */
interface Unanswered {
  plugin: string;
  chat: string;
  command: string;
  /** Sends that went without an answer before the next. */
  count: number;
  /** The last send waits for its answer still. */
  open: boolean;
}

const HOUR = 3_600_000;

/**
 * How long a queued live send with no deadline waits for its account to connect (bot-os.md D108),
 * before it is refused `not connected`; one with a deadline waits until it.
 */
export const CONNECT_WAIT_MS = 5 * 60_000;
/** How often a queue that waits for its account to connect looks again. */
export const CONNECT_POLL_MS = 1000;

export class Outbox {
  readonly account: string;
  private readonly o: OutboxOptions;
  /** Times of the sends (and dry runs) in the last hour. */
  private recent: number[] = [];
  /** No send before this: a flood wait. */
  private heldUntil = Number.NEGATIVE_INFINITY;
  /** What waits, in the order queued: each chat's queue, side by side (bot-os.md D73). */
  private waitingList: Waiting[] = [];
  /** When each command was last sent in each chat (`<chat> <command>`), dry runs counted. */
  private readonly lastSent = new Map<string, number>();
  private members = 0;
  private timer: TimerHandle | undefined;
  /** The sends coalesced since it was made: how many, and per pair of nodes (`[a, b]`, as JSON). */
  private merges = 0;
  private readonly mergedPairs = new Map<string, number>();
  /** The watchdog's counts (D93), by `[plugin, chat, command]` as JSON, the chat without case. */
  private readonly unanswered = new Map<string, Unanswered>();
  /** The queue is being pumped: a pump asked meanwhile (a pause dropping a node's sends) waits. */
  private pumping = false;
  /** The sends waiting for their answers, and the guard (D98). */
  private readonly answers: Answers;

  constructor(options: OutboxOptions) {
    this.account = options.account;
    this.o = options;
    this.answers = new Answers({
      account: options.account,
      clock: options.clock,
      ...(options.notice === undefined ? {} : { notice: options.notice }),
      // An answer that did not come is a send unanswered for the watchdog, now (D93).
      unanswered: (plugins, chat, command) => {
        for (const plugin of plugins) {
          const u = this.unanswered.get(this.unansweredKey(plugin, chat, command));
          if (u?.open !== true) continue;
          u.count += 1;
          u.open = false;
        }
      },
    });
  }

  /** The way out for one plugin, through its output `port` if named (every edge otherwise). */
  as(plugin: string, port?: string): OutboxHandle {
    const via = (o: SendOptions): SendOptions => (port === undefined ? o : { ...o, port });
    return {
      account: this.account,
      plugin,
      mode: () => this.modeOf(plugin, port),
      send: (chat, text, options = {}) => this.send(plugin, chat, text, via(options)),
      enqueue: (chat, text, options = {}) => this.enqueue(plugin, chat, text, via(options)),
      deliver: (chat, text, options = {}) => this.deliver(plugin, chat, text, via(options)),
      owner: () => this.o.connector()?.owner?.(),
      chats: () => this.chatsOf(plugin, port),
      held: (chat, command) => this.answers.held(plugin, chat, firstWord(command)),
    };
  }

  /** The chats a sender's edges let it send to on this account, each once (`OutboxHandle.chats`). */
  private chatsOf(plugin: string, port?: string): string[] {
    const reaches = this.reachesOf(this.o.policy?.(plugin, port)) ?? [];
    return [...new Set(reaches.flatMap((r) => r.sends))];
  }

  /** How many sends wait in the queue (a coalesced one once). */
  get waiting(): number {
    return this.waitingList.length;
  }

  send(plugin: string, chat: string, message: Outgoing, options: SendOptions = {}): SendResult {
    const v = this.check(plugin, chat, message, options);
    const result =
      'refused' in v
        ? v.refused
        : (this.holdOf(plugin, chat, message, v.dryRun) ??
          this.attempt(chat, message, v.dryRun, options, [plugin]).result);
    this.sent(chat, message, result);
    if (result.outcome === 'sent' && typeof message === 'string') {
      this.went(plugin, chat, message);
      this.expect([plugin], chat, message);
    }
    this.log(plugin, chat, options, result, v.mode, [], message);
    return result;
  }

  /**
   * What holds a command's send back now: the guard (D98), and for a live one the watchdog (D93).
   * A photo is no command: nothing.
   */
  private holdOf(
    plugin: string,
    chat: string,
    message: Outgoing,
    dryRun: boolean
  ): SendResult | undefined {
    if (typeof message !== 'string') return undefined;
    return (
      this.resting(plugin, chat, message) ??
      (dryRun ? undefined : this.stalled(plugin, chat, message))
    );
  }

  /**
   * A send held back now (D98): the guard backs its node off; refused with why and when it may go
   * again.
   */
  private resting(plugin: string, chat: string, text: string): SendResult | undefined {
    const hold = this.answers.held(plugin, chat, firstWord(text));
    if (hold === undefined) return undefined;
    const s = Math.ceil((hold.until - this.o.clock.now()) / 1000);
    return { text, outcome: 'refused', reason: `${hold.reason}, ${s} s more`, retryAt: hold.until };
  }

  /** A live send that waits for its answer, if a parser of its chat declares one (D98). */
  private expect(plugins: readonly string[], chat: string, text: string): Pending | undefined {
    const command = firstWord(text);
    const ms = this.o.expects?.(chat, command);
    return ms === undefined ? undefined : this.answers.expect(plugins, chat, command, ms);
  }

  /**
   * An answer read from a message of `chat` (by any of its names, D90), declared by the parser
   * that read it (D98): the send it answers settled, whose nodes' sends of the command are
   * answered for the watchdog too (D93).
   */
  answered(
    m: { chat: string; aliases?: readonly string[] | undefined; replyTo?: string | undefined },
    read: ReadAnswer
  ): void {
    const paired = this.answers.answered([m.chat, ...(m.aliases ?? [])], m.replyTo, read);
    if (paired === undefined) return;
    for (const plugin of paired.plugins)
      this.unanswered.delete(this.unansweredKey(plugin, paired.chat, paired.command));
  }

  /** A node's commands the retry-loop guard holds back (D98), for `GET /status`. */
  backoffs(plugin: string): BackoffView[] {
    return this.answers.backoffs(plugin);
  }

  /** Notes when a command went (or went as a dry run), for its interval (D73); a photo is none. */
  private sent(chat: string, message: Outgoing, r: { outcome: string }): void {
    if (typeof message === 'string' && (r.outcome === 'sent' || r.outcome === 'dry-run'))
      this.lastSent.set(`${chat} ${firstWord(message)}`, this.o.clock.now());
  }

  /** How a sender sends now (`OutboxHandle.mode`). */
  private modeOf(plugin: string, port?: string): SendMode {
    const reaches = this.reachesOf(this.o.policy?.(plugin, port));
    return reaches !== undefined && reaches.length > 0 && reaches.every((r) => r.dryRun === true)
      ? 'dry-run'
      : 'live';
  }

  /** A sender's reaches on this account, as its policy gives them; undefined: anything. */
  private reachesOf(policy: SenderPolicy | undefined): readonly Reach[] | undefined {
    const reach = policy?.reach;
    if (reach === undefined) return undefined;
    return Array.isArray(reach) ? reach : [reach as Reach];
  }

  /**
   * Sends now or refuses, as `send` does, and waits for the network: through the connector's
   * `deliver` where it has one (its `send` otherwise). The rate counts the send when it leaves, so
   * that two at once keep to the limits; a `FloodWait` holds the account and refuses it, any other
   * rejection is `failed` with why. Logged once, with the outcome.
   */
  async deliver(
    plugin: string,
    chat: string,
    message: Outgoing,
    options: SendOptions = {}
  ): Promise<DeliverResult> {
    const text = textOf(message);
    const photo = typeof message === 'string' ? undefined : message;
    const v = this.check(plugin, chat, message, options);
    let result: DeliverResult =
      'refused' in v
        ? v.refused
        : (this.holdOf(plugin, chat, message, v.dryRun) ??
          this.admit(text, v.dryRun) ?? { text, outcome: 'sent' });
    let pending: Pending | undefined;
    if (result.outcome === 'sent') {
      const connector = this.o.connector();
      const now = this.o.clock.now();
      const unable = photo === undefined ? undefined : this.photoless(connector);
      if (unable !== undefined) result = { text, outcome: 'refused', reason: unable };
      else if (photo === undefined && connector?.deliver === undefined)
        result = this.attempt(chat, text, false, options, [plugin]).result;
      else if (connector?.status().state !== 'connected')
        result = { text, outcome: 'refused', reason: 'not connected' };
      else {
        this.recent.push(now);
        // Waiting before the network acks it: the bot may answer first. A photo waits for none.
        pending = photo === undefined ? this.expect([plugin], chat, text) : undefined;
        try {
          const sent = await this.transmit(connector, chat, message, options, true);
          result = {
            text,
            outcome: 'sent',
            ...(sent.id === undefined ? {} : { id: sent.id }),
            ...(sent.photo === undefined ? {} : { photo: sent.photo }),
          };
          if (sent.id !== undefined) pending?.identify(sent.id);
        } catch (e) {
          pending?.drop();
          if (e instanceof FloodWait) {
            this.heldUntil = this.o.clock.now() + e.ms;
            result = { text, outcome: 'refused', reason: e.message };
          } else {
            result = {
              text,
              outcome: 'failed',
              reason: e instanceof Error ? e.message : String(e),
            };
            this.unreachable([plugin], chat, text, result.reason ?? '');
          }
        }
      }
    }
    this.sent(chat, message, result);
    if (result.outcome === 'sent' && photo === undefined) {
      this.went(plugin, chat, text);
      // Sent by the connector's `send`, with no answer of the network's to wait for first.
      if (pending === undefined) this.expect([plugin], chat, text);
    }
    this.log(plugin, chat, options, result, v.mode, [], message);
    return result;
  }

  /** Why the account cannot send a photo (D150): its connector does not run, or has no way to. */
  private photoless(connector: Connector | undefined): string | undefined {
    if (connector === undefined) return 'not connected';
    return connector.deliverPhoto === undefined ? `${this.account} cannot send photos` : undefined;
  }

  /**
   * A send through the connector, awaited: a text through its `deliver` (its `format` only where
   * `format` says, as `deliver` alone sends it formatted), a photo through its `deliverPhoto`.
   */
  private transmit(
    connector: Connector,
    chat: string,
    message: Outgoing,
    options: SendOptions,
    format: boolean
  ): Promise<{ id?: string; photo?: string }> {
    if (typeof message === 'string') {
      const extra = {
        ...(!format || options.format === undefined ? {} : { format: options.format }),
        ...(options.buttons === undefined ? {} : { buttons: options.buttons }),
      };
      return (connector.deliver as NonNullable<Connector['deliver']>).call(
        connector,
        chat,
        message,
        Object.keys(extra).length === 0 ? undefined : extra
      );
    }
    const extra = {
      ...(message.caption === undefined ? {} : { caption: message.caption }),
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    };
    return (connector.deliverPhoto as NonNullable<Connector['deliverPhoto']>).call(
      connector,
      chat,
      message.photo,
      Object.keys(extra).length === 0 ? undefined : extra
    );
  }

  /**
   * What the chat's parsers read, from a message of `chat` (its `aliases` too, D90) they published
   * an event for (bot-os.md D93): every send to it waits for an answer no more, and the counts of
   * its unanswered sends start again.
   */
  heard(m: { chat: string; aliases?: readonly string[] | undefined }): void {
    const names = new Set([m.chat, ...(m.aliases ?? [])].map((c) => c.toLowerCase()));
    for (const [key, u] of this.unanswered)
      if (names.has(u.chat.toLowerCase())) this.unanswered.delete(key);
  }

  private unansweredKey(plugin: string, chat: string, text: string): string {
    return JSON.stringify([plugin, chat.toLowerCase(), firstWord(text)]);
  }

  /** The threshold of a command (D93): the connector's for it, else its own, else the default. */
  private unansweredAt(command: string): number {
    const limits = this.o.limits?.();
    return limits?.unansweredAtBy?.[command] ?? limits?.unansweredAt ?? DEFAULT_UNANSWERED_AT;
  }

  /**
   * The watchdog (D93), before a live send of a node watched: its sends of the command to the chat
   * unanswered so far (the last one, still waiting, among them); at the threshold the node is paused
   * and a `stalled` notice raised, and the send refused with why. Undefined: it may go.
   */
  private stalled(plugin: string, chat: string, text: string): SendResult | undefined {
    if (this.o.watch?.(plugin, chat) !== true) return undefined;
    const key = this.unansweredKey(plugin, chat, text);
    const u = this.unanswered.get(key);
    if (u === undefined) return undefined;
    const count = u.count + (u.open ? 1 : 0);
    const at = this.unansweredAt(u.command);
    if (at <= 0 || count < at) return undefined;
    this.unanswered.delete(key);
    const reason = `stalled: ${count} sends of ${u.command} to ${chat} went unanswered`;
    this.o.pause?.(plugin, reason);
    this.o.notice?.({
      kind: 'stalled',
      node: plugin,
      text: `${plugin} sent ${u.command} to ${chat} ${count} times with no answer read from it; stopped until you clear the stop in the editor`,
      detail: { account: this.account, chat, command: u.command, count, reason },
    });
    return { text, outcome: 'refused', reason: `stopped: ${reason}` };
  }

  /**
   * A live send of a node watched went (D93): it waits for its answer, and the one before it, if
   * still waiting, is counted unanswered.
   */
  private went(plugin: string, chat: string, text: string): void {
    if (this.o.watch?.(plugin, chat) !== true) return;
    const key = this.unansweredKey(plugin, chat, text);
    const u = this.unanswered.get(key);
    if (u === undefined)
      this.unanswered.set(key, { plugin, chat, command: firstWord(text), count: 0, open: true });
    else {
      // The last one went without an answer before this one.
      if (u.open) u.count += 1;
      u.open = true;
    }
  }

  /**
   * Queues a send (bot-os.md D73). Refused at once, as `send` refuses, what can never go now. The
   * same text waiting for the same chat, anywhere in the queue, takes this node too if another
   * node queued it (coalesced: one send, a handle each); a node's own same send again is a send of
   * its own.
   * It goes in its turn: the oldest send whose command's interval in its chat has passed since that
   * command last went (the edges', the connector's by default), within the account's pace; a send
   * of another command does not wait behind it. Until then, its cancel may drop it. A photo (D150)
   * is never coalesced, and waits for no command's interval.
   */
  enqueue(plugin: string, chat: string, message: Outgoing, options: QueueOptions = {}): QueuedSend {
    const text = textOf(message);
    const photo = typeof message === 'string' ? undefined : message;
    const { cancel, ...sendOptions } = options;
    const id = ++this.members;
    let settle!: (r: QueuedResult) => void;
    const result = new Promise<QueuedResult>((r) => (settle = r));
    const member: Member = {
      id,
      plugin,
      options: sendOptions,
      ...(cancel === undefined ? {} : { cancel }),
      intervalMs: 0,
      status: 'waiting',
      done: false,
      settle: (r) => {
        if (member.done) return;
        member.done = true;
        member.status = r.outcome;
        if (member.timer !== undefined) this.o.clock.clearTimeout(member.timer);
        settle(r);
      },
    };
    const handle: QueuedSend = {
      id,
      result,
      status: () => member.status,
      cancel: (reason = 'cancelled by its node') => this.cancelQueued(id, reason),
      then: (onDone, onFail) => result.then(onDone, onFail),
    };
    // What can never go now waits for nothing: refused at once.
    const v = this.check(plugin, chat, message, sendOptions);
    if ('refused' in v) {
      this.log(plugin, chat, sendOptions, v.refused, v.mode, [], message);
      member.settle(v.refused);
      return handle;
    }
    member.intervalMs = photo === undefined ? this.intervalOf(plugin, chat, text, sendOptions) : 0;
    const deadline =
      cancel?.withinMs === undefined
        ? cancel?.deadline
        : Math.min(cancel.deadline ?? Infinity, this.o.clock.now() + cancel.withinMs);
    if (deadline !== undefined) member.deadline = deadline;
    // Coalesced with the same text for the same chat, wherever it waits, but only another node's:
    // a node's own repeated send (buying an item twice) stays a send of its own.
    // A send with buttons stays its own: its buttons are its sender's; and so does a photo.
    const same =
      sendOptions.buttons === undefined && photo === undefined
        ? this.waitingList.find(
            (w) =>
              w.chat === chat &&
              w.text === text &&
              w.photo === undefined &&
              !w.members.some((m) => m.plugin === plugin || m.options.buttons !== undefined)
          )
        : undefined;
    if (same === undefined)
      this.waitingList.push({
        chat,
        text,
        ...(photo === undefined ? {} : { photo }),
        command: photo === undefined ? firstWord(text) : '',
        queuedAt: this.o.clock.now(),
        members: [member],
      });
    else {
      this.merges += 1;
      for (const other of new Set(same.members.map((m) => m.plugin))) {
        const key = JSON.stringify([other, plugin].sort());
        this.mergedPairs.set(key, (this.mergedPairs.get(key) ?? 0) + 1);
      }
      same.members.push(member);
      const others = [...new Set(same.members.map((m) => m.plugin))].filter((p) => p !== plugin);
      this.o.notice?.({
        kind: 'coalesced',
        node: plugin,
        text: `${plugin} queued ${JSON.stringify(text)} to ${chat}, as ${others.join(', ')} had: sent once`,
        detail: { account: this.account, chat, text, with: others },
      });
    }
    this.queueLog(plugin, chat, text, same === undefined ? 'queued' : 'coalesced');
    if (deadline !== undefined)
      member.timer = this.o.clock.setTimeout(
        () => this.drop(id, { text, outcome: 'expired', reason: 'its deadline passed' }),
        Math.max(0, deadline - this.o.clock.now())
      );
    this.pump();
    return handle;
  }

  /**
   * Drops one node's share of a queued send if it still waits (its handle's `cancel`, or the core
   * for an event of its `cancel.on`): cancelled, with why and the event. False if it went already.
   */
  cancelQueued(id: number, reason: string, event?: CancelEvent): boolean {
    const w = this.waitingList.find((x) => x.members.some((m) => m.id === id));
    if (w === undefined) return false;
    return this.drop(id, {
      text: w.text,
      outcome: 'cancelled',
      reason,
      ...(event === undefined ? {} : { event }),
    });
  }

  /** Drops what a node queued (it stopped, or the instance stops): cancelled, with why. */
  dropQueued(plugin: string | undefined, reason: string): void {
    for (const w of [...this.waitingList])
      for (const m of [...w.members])
        if (plugin === undefined || m.plugin === plugin)
          this.drop(m.id, { text: w.text, outcome: 'cancelled', reason });
  }

  /** What waits, in order, as the owner sees it. */
  pending(): QueueEntryView[] {
    const pace = this.o.clock.now() + this.wait();
    return this.waitingList.map((w) => ({
      chat: w.chat,
      text: w.text,
      command: w.command,
      queuedAt: w.queuedAt,
      waitingUntil: Math.max(pace, this.readyAt(w)),
      intervalS: this.intervalMsOf(w) / 1000,
      nodes: w.members.map((m) => {
        const c = m.cancel;
        const on = c?.on === undefined ? undefined : typeof c.on === 'string' ? [c.on] : [...c.on];
        return {
          plugin: m.plugin,
          origin: m.options.origin ?? m.plugin,
          ...(c === undefined ||
          (on === undefined && c.test === undefined && m.deadline === undefined)
            ? {}
            : {
                cancel: {
                  ...(on === undefined ? {} : { on }),
                  ...(c.when === undefined ? {} : { when: { ...c.when } }),
                  ...(c.test === undefined ? {} : { test: true }),
                  ...(m.deadline === undefined ? {} : { deadline: m.deadline }),
                },
              }),
        };
      }),
    }));
  }

  /** The sends coalesced since it was made, and the pairs of nodes that shared them, most first. */
  coalesced(): CoalescedView {
    const pairs = [...this.mergedPairs]
      .map(([key, count]) => ({ nodes: JSON.parse(key) as [string, string], count }))
      .sort((x, y) => y.count - x.count || x.nodes.join(' ').localeCompare(y.nodes.join(' ')));
    return { count: this.merges, pairs };
  }

  /** A member settled before its send went: out of its send, logged, and the queue moves on. */
  private drop(id: number, r: QueuedResult): boolean {
    const w = this.waitingList.find((x) => x.members.some((m) => m.id === id));
    const m = w?.members.find((x) => x.id === id);
    if (w === undefined || m === undefined) return false;
    w.members = w.members.filter((x) => x !== m);
    if (w.members.length === 0) this.waitingList = this.waitingList.filter((x) => x !== w);
    m.settle(r);
    this.queueLog(m.plugin, w.chat, w.text, r.outcome, r.reason, r.event?.type);
    this.pump();
    return true;
  }

  /**
   * A sender's interval for a command in a chat (D73): the longest its edges that let it send it
   * name, else the connector's default.
   */
  private intervalOf(plugin: string, chat: string, text: string, options: SendOptions): number {
    const word = firstWord(text);
    const named = (this.reachesOf(this.o.policy?.(plugin, options.port)) ?? [])
      .filter((r) => r.sends.includes(chat))
      .flatMap((r) => (r.minIntervalS?.[word] === undefined ? [] : [r.minIntervalS[word] * 1000]));
    return named.length > 0 ? Math.max(...named) : (this.o.limits?.()?.commandIntervalMs ?? 0);
  }

  private intervalMsOf(w: Waiting): number {
    return Math.max(0, ...w.members.map((m) => m.intervalMs));
  }

  /**
   * When a waiting send's command may go again in its chat: its interval since it last went, and
   * what holds it back (D98: a node's guard; for a coalesced one, the longest).
   */
  private readyAt(w: Waiting): number {
    const last = this.lastSent.get(`${w.chat} ${w.command}`);
    return Math.max(
      last === undefined ? Number.NEGATIVE_INFINITY : last + this.intervalMsOf(w),
      ...w.members.map(
        (m) => this.answers.held(m.plugin, w.chat, w.command)?.until ?? Number.NEGATIVE_INFINITY
      )
    );
  }

  /** Sends the oldest send whose command's interval has passed, when the account may; again. */
  private pump(): void {
    // A pump asked while one runs (a pause dropping a node's sends as one goes) is the running one's.
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.pumpNow();
    } finally {
      this.pumping = false;
    }
  }

  private pumpNow(): void {
    if (this.timer !== undefined) this.o.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (;;) {
      if (this.waitingList.length === 0) return;
      const now = this.o.clock.now();
      const pace = this.wait();
      // While the account connects, a live send waits for it, a dry run does not (D108).
      const connecting = this.o.connection?.() === 'connecting';
      const blocked = (w: Waiting): boolean => connecting && this.goesLive(w);
      for (const w of this.waitingList)
        if (!blocked(w)) delete w.connectingSince;
        else w.connectingSince ??= now;
      if (this.connectWaitOver(now)) continue;
      const next = this.waitingList.find((w) => !blocked(w) && this.readyAt(w) <= now);
      if (pace > 0 || next === undefined) {
        const soonest = Math.min(
          ...this.waitingList.map((w) =>
            blocked(w) ? Math.max(this.readyAt(w), now + CONNECT_POLL_MS) : this.readyAt(w)
          )
        );
        const ms = Math.max(pace, soonest - now, 0);
        this.timer = this.o.clock.setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, ms);
        return;
      }
      this.issue(next);
    }
  }

  /** Whether a waiting send would go live for any of its nodes now (not only as a dry run). */
  private goesLive(w: Waiting): boolean {
    return w.members.some((m) => {
      const v = this.check(m.plugin, w.chat, w.photo ?? w.text, m.options);
      return !('refused' in v) && !v.dryRun;
    });
  }

  /**
   * The shares of a send that waited `CONNECT_WAIT_MS` for the account to connect with no deadline
   * of their own (D108): refused `not connected`, logged as a refused send. Whether any was.
   */
  private connectWaitOver(now: number): boolean {
    let any = false;
    for (const w of [...this.waitingList]) {
      if (w.connectingSince === undefined || now < w.connectingSince + CONNECT_WAIT_MS) continue;
      for (const m of w.members.filter((x) => x.deadline === undefined)) {
        const refused: SendResult = {
          text: w.text,
          outcome: 'refused',
          reason: `not connected: waited ${CONNECT_WAIT_MS / 60_000} min for the connection`,
        };
        const message = w.photo ?? w.text;
        this.log(
          m.plugin,
          w.chat,
          m.options,
          refused,
          this.check(m.plugin, w.chat, message, m.options).mode,
          [],
          message
        );
        this.drop(m.id, refused);
        any = true;
      }
    }
    return any;
  }

  /**
   * A waiting send goes: each node's checks again (one refused is told so, and the others go),
   * then one send, for real if any of them sends through a live edge, else a dry run; logged once
   * (`core.send`, with the other nodes it went for), and each node told.
   */
  private issue(w: Waiting): void {
    this.waitingList = this.waitingList.filter((x) => x !== w);
    const message = w.photo ?? w.text;
    const going: { m: Member; dryRun: boolean; mode: SendMode }[] = [];
    for (const m of w.members) {
      const v = this.check(m.plugin, w.chat, message, m.options);
      // A live share of a node its watchdog pauses now (D93) is refused, as a stop's would be.
      const refused =
        'refused' in v
          ? v.refused
          : v.dryRun || w.photo !== undefined
            ? undefined
            : this.stalled(m.plugin, w.chat, w.text);
      if (refused !== undefined) {
        this.log(m.plugin, w.chat, m.options, refused, v.mode, [], message);
        m.settle(refused);
        this.queueLog(m.plugin, w.chat, w.text, 'refused', refused.reason);
      } else if (!('refused' in v)) going.push({ m, dryRun: v.dryRun, mode: v.mode });
    }
    const lead = going.find((g) => !g.dryRun) ?? going[0];
    if (lead === undefined) return;
    const live = [...new Set(going.filter((g) => !g.dryRun).map((g) => g.m.plugin))];
    const { result, answer } = this.attempt(w.chat, message, lead.dryRun, lead.m.options, live);
    // It waits for the game's answer from now (D98): the bot may answer before the network acks.
    const pending =
      result.outcome === 'sent' && live.length > 0 && w.photo === undefined
        ? this.expect(live, w.chat, w.text)
        : undefined;
    void answer?.then((a) => {
      if (a.failed !== undefined) pending?.drop();
      else if (a.id !== undefined) pending?.identify(a.id);
    });
    this.sent(w.chat, message, result);
    const others = [
      ...new Set(going.filter((g) => g.m.plugin !== lead.m.plugin).map((g) => g.m.plugin)),
    ];
    this.log(lead.m.plugin, w.chat, lead.m.options, result, lead.mode, others, message);
    for (const g of going) {
      const outcome = result.outcome === 'sent' && g.dryRun ? 'dry-run' : result.outcome;
      if (outcome === 'sent' && w.photo === undefined) this.went(g.m.plugin, w.chat, w.text);
      const settle = (a: { failed?: string; photo?: string } | undefined): void => {
        const failed = a?.failed;
        const reason = failed ?? result.reason;
        const r: QueuedResult = {
          text: w.text,
          outcome: failed === undefined ? outcome : 'failed',
          ...(reason === undefined ? {} : { reason }),
          ...(a?.photo === undefined ? {} : { photo: a.photo }),
        };
        this.queueLog(g.m.plugin, w.chat, w.text, r.outcome, reason);
        if (r.outcome !== 'sent' || pending === undefined) {
          g.m.settle(r);
          return;
        }
        // Sent, and its handle waits for the game's answer (D98).
        g.m.status = 'sent';
        pending.wait((x) => g.m.settle({ ...r, answer: x }));
      };
      // A live share settles once the network answers (D95); a dry run, at once.
      if (answer === undefined || outcome !== 'sent') settle(undefined);
      else void answer.then(settle);
    }
  }

  private queueLog(
    plugin: string,
    chat: string,
    text: string,
    event: QueueRecord['event'],
    reason?: string,
    by?: string
  ): void {
    this.o.record?.({
      type: 'core.queue',
      t: this.o.clock.now(),
      account: this.account,
      plugin,
      chat,
      text,
      event,
      ...(reason === undefined ? {} : { reason }),
      ...(by === undefined ? {} : { by }),
    });
  }

  /** How long until the account may send again. */
  private wait(): number {
    const now = this.o.clock.now();
    this.recent = this.recent.filter((t) => now - t < HOUR);
    const limits = this.o.limits?.();
    const last = this.recent.at(-1);
    const first = this.recent[0];
    return Math.max(
      0,
      this.heldUntil - now,
      limits?.minIntervalMs === undefined || last === undefined
        ? 0
        : last + limits.minIntervalMs - now,
      limits?.maxPerHour === undefined ||
        first === undefined ||
        this.recent.length < limits.maxPerHour
        ? 0
        : first + HOUR - now
    );
  }

  /**
   * Why a send cannot go whatever the clock (the caller, the reach, the mode, a stop); or, when it
   * may, whether it is a dry run. With the mode it is logged in.
   */
  private check(
    plugin: string,
    chat: string,
    message: Outgoing,
    options: SendOptions
  ): ({ refused: SendResult } | { dryRun: boolean }) & { mode: SendMode } {
    const text = textOf(message);
    const photo = typeof message === 'string' ? undefined : message;
    const policy = this.o.policy?.(plugin, options.port) ?? {};
    const reaches = this.reachesOf(policy);
    const word = text.split(/\s/u, 1)[0] ?? '';
    // The edges that let it send this: through a live one, it goes for real (D64). A photo has no
    // first word: an edge that names its commands lets it through only if it says photos (D150).
    const through = reaches?.filter(
      (r) =>
        r.sends.includes(chat) &&
        (r.commands === undefined ||
          (photo === undefined ? r.commands.includes(word) : r.photos === true))
    );
    const dryRun =
      through !== undefined && through.length > 0 && through.every((r) => r.dryRun === true);
    const mode: SendMode = dryRun ? 'dry-run' : 'live';
    const refuse = (reason: string) => ({
      refused: { text, outcome: 'refused' as const, reason },
      mode,
    });
    if (options.refuse !== undefined) return refuse(options.refuse);
    if (reaches !== undefined) {
      if (!reaches.some((r) => r.sends.includes(chat)))
        return refuse(`${plugin} does not send to ${chat}`);
      if (through?.length === 0)
        return refuse(
          photo === undefined
            ? `${word} is not among ${plugin}'s commands`
            : `a photo is not among ${plugin}'s commands: its edge or output must say photos`
        );
    }
    if (photo !== undefined) {
      const why = photoRefusal(photo.photo, photo.caption);
      if (why !== undefined) return refuse(why);
      const connector = this.o.connector();
      if (connector !== undefined && connector.deliverPhoto === undefined)
        return refuse(`${this.account} cannot send photos`);
    }
    if (policy.held !== undefined) return refuse(policy.held);
    return { dryRun, mode };
  }

  /**
   * The checks against the clock: a flood wait, the rate, and a dry run (counted, and not sent).
   * The refusal or the dry run; undefined to send.
   */
  private admit(text: string, dryRun: boolean): SendResult | undefined {
    const refuse = (reason: string): SendResult => ({ text, outcome: 'refused', reason });
    const now = this.o.clock.now();
    if (now < this.heldUntil)
      return refuse(`flood wait, ${Math.ceil((this.heldUntil - now) / 1000)} s more`);
    this.recent = this.recent.filter((t) => now - t < HOUR);
    const limits = this.o.limits?.();
    const last = this.recent.at(-1);
    if (limits !== undefined) {
      if (
        limits.minIntervalMs !== undefined &&
        last !== undefined &&
        now - last < limits.minIntervalMs
      )
        return refuse('too soon');
      if (limits.maxPerHour !== undefined && this.recent.length >= limits.maxPerHour)
        return refuse('hourly limit');
    }
    if (dryRun) {
      this.recent.push(now);
      return { text, outcome: 'dry-run' };
    }
    return undefined;
  }

  /**
   * A send the checks allow, against the clock and the network: through the connector's `deliver`
   * where it has one, whose refusal comes back (`answer`, its reason; D95) and is told for
   * `plugins`, the nodes it goes for live; its `send` otherwise.
   */
  private attempt(
    chat: string,
    message: Outgoing,
    dryRun: boolean,
    options: SendOptions,
    plugins: readonly string[]
  ): {
    result: SendResult;
    answer?: Promise<{ failed?: string; id?: string; photo?: string }>;
  } {
    const text = textOf(message);
    const refuse = (reason: string): SendResult => ({ text, outcome: 'refused', reason });
    const admitted = this.admit(text, dryRun);
    if (admitted !== undefined) return { result: admitted };
    const now = this.o.clock.now();
    const connector = this.o.connector();
    const photo = typeof message === 'string' ? undefined : message;
    // A photo goes through `deliverPhoto` alone (D150).
    const unable = photo === undefined ? undefined : this.photoless(connector);
    if (unable !== undefined) return { result: refuse(unable) };
    if (connector !== undefined && (photo !== undefined || connector.deliver !== undefined)) {
      if (connector.status().state !== 'connected') return { result: refuse('not connected') };
      this.recent.push(now);
      const answer = this.transmit(connector, chat, message, options, false).then(
        ({ id, photo: sent }) => ({
          ...(id === undefined ? {} : { id }),
          ...(sent === undefined ? {} : { photo: sent }),
        }),
        (e: unknown) => {
          if (e instanceof FloodWait) {
            this.heldUntil = this.o.clock.now() + e.ms;
            return { failed: e.message };
          }
          const reason = e instanceof Error ? e.message : String(e);
          this.unreachable(plugins, chat, text, reason);
          return { failed: reason };
        }
      );
      return { result: { text, outcome: 'sent' }, answer };
    }
    const { buttons } = options;
    let sent: boolean;
    try {
      sent =
        (buttons === undefined
          ? connector?.send(chat, text)
          : connector?.send(chat, text, { buttons })) ?? false;
    } catch (e) {
      if (!(e instanceof FloodWait)) throw e;
      this.heldUntil = now + e.ms;
      return { result: refuse(e.message) };
    }
    if (!sent) return { result: refuse('not connected') };
    this.recent.push(now);
    return { result: { text, outcome: 'sent' } };
  }

  /**
   * A send the network refused (D95): recorded (`core.send-failed`), and an `unreachable` notice
   * for each node it went for, but those that tell the owner themselves (`quiet`).
   */
  private unreachable(
    plugins: readonly string[],
    chat: string,
    text: string,
    reason: string
  ): void {
    const title = this.o.title?.(chat);
    const hint = unreachableHint(reason);
    this.o.record?.({
      type: 'core.send-failed',
      t: this.o.clock.now(),
      account: this.account,
      plugins: [...plugins],
      chat,
      ...(title === undefined ? {} : { title }),
      text,
      reason,
      hint,
    });
    const named = title === undefined || title === chat ? chat : `${title} (${chat})`;
    for (const plugin of plugins)
      if (this.o.quiet?.(plugin) !== true)
        this.o.notice?.({
          kind: 'unreachable',
          node: plugin,
          text: `${plugin} could not send to ${named} through ${this.account}: ${hint}`,
          detail: { account: this.account, chat, reason },
        });
  }

  private log(
    plugin: string,
    chat: string,
    options: SendOptions,
    result: DeliverResult,
    mode: SendMode,
    coalesced: readonly string[] = [],
    message: Outgoing = result.text
  ): void {
    const caption = typeof message === 'string' ? undefined : message.caption;
    this.o.record?.({
      type: 'core.send',
      t: this.o.clock.now(),
      plugin,
      account: this.account,
      chat,
      origin: options.origin ?? plugin,
      mode,
      ...result,
      ...(coalesced.length === 0 ? {} : { with: [...coalesced] }),
      // A photo's caption by its length alone (D150); the photo by its label, never its bytes.
      ...(caption === undefined ? {} : { caption: caption.length }),
    });
  }
}
