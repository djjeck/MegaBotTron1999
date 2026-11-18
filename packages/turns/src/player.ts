/**
 * The `player` (docs/bot-os-api.md §5, bot-os.md D134): one plugin, run as one node per game bot
 * that may be automated (P3, P17), in place of the turn actor. It plays its bot's commands, in a
 * simulated person's sittings, from the owner's account, in the private chat with its bot or in a
 * group its bot is in, as its edge names (D139): those its config names, or by default (D137)
 * every command its parser declares (`state.commands`) but an interactive one, in its parser's
 * order, each sent as one of its forms (D140): any of its names, bare (`/play`, `/quest`) or, in a
 * group, addressed to its bot (`/play@QuestBot`), those its entry's `forms` allow. Its ports:
 *
 * - `chat`, a chat-out output: one chat, **its edge's alone** (bot-os.md D97, D139: the one chat
 *   its edge names, the bot's `@username` or a group's id; the check refuses anything else), its
 *   commands those its edge allows; it reads no chat (D99);
 * - `parser`, a contract on its bot's parser (`state.ready`, `state.commands`, `state.bot`,
 *   `actions.sent`, D132, D137, D139), required, so that drift on the parser stops it: each
 *   command's readiness, its commands with their aliases and mechanics (D140), its bot's name, and
 *   the sends it tells it of;
 * - `attention`, its person (bot-os.md D133), required: the sittings it plays in, and the person's
 *   reaction time.
 *
 * **Given a sitting**, it plays, one at a time, each of its commands that is ready and that its
 * policy allows, in its order. The policy comes from the command's mechanics (D137): a turn,
 * whenever ready; a command whose success clears another's hold (a reset), only while that other is
 * held (cooling down); any other, whenever ready; a config's entry overrides it (`whileHeld`, or
 * `whenReady`). Each goes after the person's reaction time (its person's `react`:
 * a glance first, then the answer read, scaled to its length); after each live send it waits for
 * the answer its parser reads (up to two minutes), then looks again, so that a command an answer
 * unlocks, or one a reset makes ready again, is taken in the same sitting. A command it sent in
 * the sitting goes again only if it became ready again since (its readiness `since` after the
 * send), so that a dry run, or an answer that holds nothing, plays it once. In a sitting that
 * follows the owner's play (D138), or one they wrote during, or one in which another player of its
 * account sent a command (D139, D140), it first waits the same way for the answer to the last send
 * its parser has read none to: a bare command another sent in the group may have taken its bot's
 * turn too. Nothing ready, but a command of its due within `settleS` (D140), it waits for it rather
 * than leave. When nothing is left, it sleeps until the next sitting. **No schedule of its own:**
 * its person's sittings, its parser's readiness, and its outbox's `held` (D98) as the safety net,
 * are all it waits on.
 *
 * **The form, chosen by reach** (D140, `chat-group.ts`): the players of one account that send to
 * the same chat are a group. A form reaches the players of the group whose parser takes it (bare,
 * every one whose bot declares that name; addressed, its bot's alone), and is allowed only if each
 * of them would play its command now: in a sitting, the command ticked and its policy allowing it,
 * ready, and the form one its config allows. Of the forms allowed, the widest reach, the first in
 * order on a tie (its entry's `forms`, else its parser's names in order, every one bare, then every
 * one addressed).
 * **Before it picks, the group settles:** while a player the widest form reaches has a send no
 * answer came to yet (younger than the answer window), or its command will be ready within
 * `settleS` seconds, it waits (until then, at most the answer window in all), so that one bare
 * send covers them. It then picks and claims the players its form reaches in the same tick as its
 * send, so that none of them sends an overlapping form, and, sent, hands the send off to every
 * other player of its account, each telling its parser; those its form reached wait for their
 * bot's answer and send nothing over it.
 *
 * - Its person asks it, when a sitting is due, for the owner's latest play by hand its parser read
 *   (`ready`'s sends marked `byHand`, any command): the person's own sitting, which pushes the next
 *   simulated one back.
 * - Its next step in a sitting is the durable timer `play`, kept across restarts with the sitting
 *   (its store's `state`); one that came due more than `PLAY_GRACE_MS` before a start is dropped
 *   with the sitting.
 * - Through a dry-run chat-out edge (D64) each command is logged, nothing sent; through a live one,
 *   it waits for the account to be connected (its send refused `not connected`, it tries again
 *   each minute), and tells its parser each command sent with its message's id, so that the parser
 *   matches the bot's reply to it; and the other players of its account, each its own parser
 *   (D139, D140). A send refused (a cooldown its outbox holds, the retry-loop guard) or failed is
 *   not tried again in that sitting.
 * - It plays while its node runs and the instance is on; stopped (bot-os.md D64: drift on its
 *   parser, the owner's kill or stop, or its own safety stop, `kill`), it drops its sitting and
 *   plays no more until the owner clears the stop in the editor.
 *
 * It declares no chat command (two instances would clash on its name): its read `status` gives its
 * chat, its commands, its last play and its next (its next step in a sitting, else its person's
 * next sitting), which its node's widget and page (Plays) show (D112). Each step is published as
 * `player.step`, with its node's id, and printed; its plays go in the owner's summary (D92).
 */
import {
  type BotCommand,
  counted,
  definePlugin,
  type Plugin,
  type PluginContext,
  type SummaryWindow,
  Tally,
} from '@megabottron1999/core';
import { z } from 'zod';
import { type AttentionHandle, type Sitting } from '#src/attention.ts';
import {
  ChatGroups,
  type GroupMember,
  pickForm,
  type PlayerSend,
  widestReach,
} from '#src/chat-group.ts';
import {
  ANSWER_WINDOW_MS,
  commandOf,
  type Readiness,
  type TurnParserInterface,
} from './turn-parser.ts';

export const PLAYER = 'player';
/** The timer of its next step in a sitting. */
export const PLAY_TIMER = 'play';
/** How late a kept step may still run after a restart. */
export const PLAY_GRACE_MS = 10 * 60_000;
/** How often it looks for the answer to a send. */
export const ANSWER_POLL_MS = 5_000;
/** How long it waits for an answer before it looks again without one. */
export const ANSWER_WAIT_MS = ANSWER_WINDOW_MS;
/** How often a step waits for the account to connect. */
export const CONNECT_WAIT_MS = 60_000;
/** The most sends of one sitting: a guard against two commands that reset each other forever. */
export const MAX_SENDS_PER_SITTING = 20;
/** The members of its parser it uses (D132, D137). */
export const PLAYER_PARSER_MEMBERS = ['state.ready', 'state.commands', 'state.bot', 'actions.sent'];
/** The one chat it sends to (D97, D139): its bot's private chat, or a group's id. */
export const PLAYER_CHAT = String.raw`^(@\w{4,}|-\d+)$`;
/** How many seconds it waits by default for the group to settle before it picks a form (D140). */
export const DEFAULT_SETTLE_S = 10;

const COMMAND = /^\/\w+$/u;
const FORM = /^\/\w+(?:@\w+)?$/u;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** One command it plays, and, to override the policy its mechanics give, when (D137). */
const playSchema = z
  .object({
    command: z.string().regex(COMMAND, 'expected a command, as /play').describe('The command sent'),
    whileHeld: z
      .string()
      .regex(COMMAND, 'expected a command, as /play')
      .optional()
      .describe(
        'Played only while this command is held (cooling down); unset, as its mechanics say'
      ),
    whenReady: z
      .literal(true)
      .optional()
      .describe('Played whenever it is ready, whatever its mechanics say'),
    forms: z
      .array(z.string().regex(FORM, 'expected a form, as /play or /play@QuestBot'))
      .min(1)
      .optional()
      .describe(
        'The forms it may send it as, in order (D140): its names bare (/play), which in a group every bot that declares it takes, or addressed to its bot (/play@QuestBot); unset, every one: every name bare, then every name addressed (only in a group)'
      ),
    addressed: z
      .literal(true)
      .optional()
      .describe('Before D140: sent addressed to its bot alone; read as forms: [/play@<bot>]'),
  })
  .refine((p) => p.whileHeld === undefined || p.whenReady === undefined, {
    message: 'whileHeld or whenReady, not both',
  });

/**
 * A player's configuration: the commands it plays, each with its policy, in order; unset, the
 * defaults (D137): every command its parser declares but an interactive one, in its order.
 */
export const playerConfig = z.object({
  commands: z
    .array(playSchema)
    .optional()
    .describe(
      'The commands it plays, in this order, each when its parser says it is ready and its policy allows; unset, every command its parser declares but those that need you to answer. Its chat-out edge allows the forms it may send them as (the editor keeps it so)'
    ),
  settleS: z
    .number()
    .min(0)
    .default(DEFAULT_SETTLE_S)
    .describe(
      'How many seconds ahead it waits for a command of its, or of another player sending to the same chat, about to be ready, so that one bare command covers them all (D140)'
    ),
});
export type PlayerConfig = z.output<typeof playerConfig>;
/** A command it plays, with its policy resolved: only while `whileHeld` is held, or when ready. */
export interface Play {
  /** By its name in its parser's, when it declares it (an alias resolved, D140). */
  command: string;
  whileHeld?: string;
  /** The forms it may send it as, in order (D140); unset, all. */
  forms?: string[];
  /**
   * Before D140: addressed to its bot alone, under this name as its entry spells it (`/play`, sent
   * as `/play@QuestBot`), as `forms` would say.
   */
  addressed?: string;
}

/**
 * The policy a command's mechanics give it (D137): a turn, whenever ready (the bot's rest over);
 * one whose success clears another's hold (a reset), only while that other is held; any other,
 * whenever ready.
 */
export function derivedWhileHeld(c: BotCommand | undefined): string | undefined {
  if (c === undefined || c.turn === true) return undefined;
  return c.effects?.find((e) => e.clear === true && e.command !== c.command)?.command;
}

/**
 * What a player plays (D137), in order: its config's `commands`, each with its override or its
 * mechanics' policy and its forms; unset, each of `declared` but the interactive ones, in their
 * order. A command, or a policy's, named by an alias is named by its command's name (D140).
 */
export function playsOf(
  commands: PlayerConfig['commands'],
  declared: readonly BotCommand[]
): Play[] {
  const name = (c: string): string => commandOf(c, declared, '') ?? c;
  const find = (c: string): BotCommand | undefined => declared.find((d) => d.command === name(c));
  const play = (
    command: string,
    whileHeld: string | undefined,
    p?: { command: string; forms?: string[] | undefined; addressed?: true | undefined }
  ): Play => ({
    command,
    ...(whileHeld === undefined ? {} : { whileHeld }),
    ...(p?.forms === undefined ? {} : { forms: [...p.forms] }),
    ...(p?.addressed === true && p.forms === undefined ? { addressed: p.command } : {}),
  });
  if (commands === undefined)
    return declared
      .filter((d) => d.interactive !== true)
      .map((d) => play(d.command, derivedWhileHeld(d)));
  return commands.map((p) =>
    play(
      name(p.command),
      p.whenReady === true
        ? undefined
        : p.whileHeld === undefined
          ? derivedWhileHeld(find(p.command))
          : name(p.whileHeld),
      p
    )
  );
}

/**
 * The forms a player may send a play as, in order (D140): its entry's `forms` (those that are this
 * command of its bot's), else every name of the command bare, in its parser's order, then, in a
 * group, every name addressed to its bot, in the same order (a bot's own bare alias before an
 * addressed form); an entry from before D140 marked `addressed`, `/play@<bot>` alone.
 */
export function playForms(
  play: Play,
  declared: readonly BotCommand[],
  bot: string,
  group: boolean
): string[] {
  const d = declared.find((x) => same(x.command, play.command));
  const names = d === undefined ? [play.command] : [d.command, ...(d.aliases ?? [])];
  if (play.forms !== undefined)
    return play.forms.filter(
      (f) => commandOf(f, [{ command: names[0] as string, aliases: names }], bot) !== undefined
    );
  if (play.addressed !== undefined) return [`${play.addressed}@${bot}`];
  return [...names, ...(group ? names.map((n) => `${n}@${bot}`) : [])];
}

/** A sitting in progress, as it keeps it. */
interface InSitting {
  id: number;
  /** When it sent each command in this sitting. */
  sent: Record<string, number>;
  /** How many sends it made in it. */
  count: number;
  /** A live send whose answer it waits for. */
  waiting?: { command: string; t: number };
  /** Waiting for the group to settle before it picks a form for this command, since then (D140). */
  settling?: { command: string; since: number };
  /**
   * It follows the owner's play (D138), or another player of its account sent (D139, D140): at its
   * next look, it first waits for the answer to the last send its parser knows of, if it has read
   * none yet.
   */
  hand?: true;
}

export interface PlayerState {
  /** Its last send, in ms. */
  last?: number;
  sitting?: InSitting;
}

export interface PlayerStatus {
  chat: string;
  commands: string;
  last?: number;
  /** Its next step, else its person's next sitting, or what it does instead (D138). */
  next?: number | string;
}

const stepSchema = z.object({
  player: z.string(),
  chat: z.string(),
  event: z.enum(['sitting', 'sent', 'read', 'done', 'waiting', 'failed', 'stopped']),
  detail: z.string(),
});
export type PlayerStep = z.infer<typeof stepSchema>;

const clock = (t: number) => new Date(t).toISOString().slice(11, 16);

/** A player's line in the owner's summary: its bot, its state, its last and next play. */
export function playerSummary(id: string, state: string, s: PlayerStatus | undefined): string {
  const parts = [
    ...(s?.last === undefined ? [] : [`last ${clock(s.last)}`]),
    ...(typeof s?.next === 'number' ? [`next ${clock(s.next)}`] : []),
  ];
  const times = parts.length > 0 ? `, ${parts.join(', ')} UTC` : '';
  return `${s?.chat ?? id}: ${state}${times}${typeof s?.next === 'string' ? `, ${s.next}` : ''}`;
}

/** The player plugin, of which the wiring makes one node per bot. */
export function playerPlugin(): Plugin {
  // Its nodes' groups, by account and chat (D140): where they meet to pick a form and hand off a
  // send, in memory, for the instances of this registration alone.
  const groups = new ChatGroups();
  return definePlugin({
    manifest: {
      id: PLAYER,
      version: '0.1.0',
      kinds: ['actor'],
      description:
        "A game bot's commands, from the owner's account, in its private chat or a group, in a simulated person's sittings",
      config: playerConfig,
      // Its commands, a checklist of its parser's in the editor (D137), which its chat edge follows.
      configPlays: { key: 'commands', input: 'parser', output: 'chat' },
      summary: true,
      games: { registers: [PLAYER] },
      events: {
        [`${PLAYER}.step`]: stepSchema.describe(
          'A step of its sittings: one started, a command sent, its answer read, the sitting done, a wait, a failure or its stop'
        ),
      },
      inputs: {
        parser: {
          type: 'interface',
          members: PLAYER_PARSER_MEMBERS,
          help: "Its bot's parser: each command's readiness (the owner's plays by hand too), and the sends it tells it of",
        },
        attention: {
          type: 'attention',
          help: 'Its person: the sittings it plays in, and how fast they act',
        },
      },
      outputs: {
        chat: {
          type: 'chat-out',
          network: 'telegram',
          // Its edge names the one chat it plays in (D97): its bot's, or a group's (D139).
          single: { pattern: PLAYER_CHAT, expected: "its bot's @username, or a group's id" },
          help: "the owner's own account: the private chat with its bot, or a group its bot is in, the one chat its edge names, and the commands it plays",
        },
      },
      interface: {
        state: {
          status: {
            help: 'Its chat and commands, and its last and next play',
            output: z.object({
              chat: z.string().describe('Chat'),
              commands: z.string().describe('Commands'),
              last: z.number().optional().describe('Last play'),
              next: z.union([z.number(), z.string()]).optional().describe('Next play'),
            }),
          },
        },
      },
      // Its node's widget and page (bot-os.md D112): its next play on its card, its chat, its
      // commands and its last and next plays on its page, each node its own.
      widget: { show: 'until', read: 'status', path: 'next' },
      page: {
        title: 'Plays',
        sections: [
          { show: 'keyValue', read: 'status', label: 'Plays', fields: ['chat', 'commands'] },
          { show: 'until', read: 'status', path: 'last' },
          { show: 'until', read: 'status', path: 'next' },
        ],
      },
    },
    create: (ctx) => new Player(ctx, groups).instance(),
  });
}

/** One node: its sitting, its last play, and its hooks. */
class Player {
  private readonly ctx: PluginContext;
  private readonly c: PlayerConfig;
  /** The one chat its chat-out edge names (D97): its bot's private chat, or a group (D139). */
  private readonly chat: string;
  private state: PlayerState;
  private attention: AttentionHandle | undefined;
  private leave: (() => void) | undefined;
  /** Its account's players, by chat (D140). */
  private readonly groups: ChatGroups;
  private leaveGroup: (() => void) | undefined;
  /** Its node was stopped (D64): it plays no more until a restart after the owner clears it. */
  private stopped = false;
  private sending = false;
  /** Told once while it waits for the account. */
  private waitingAccount = false;
  /** Its parser's commands (D137), once read: its defaults, and its policies. */
  private declared: BotCommand[] | undefined;
  /** Its bot's username (D139), once read: an addressed form's suffix. */
  private bot: string | undefined;
  /** The commands its parser declares none of, told once. */
  private readonly unknown = new Set<string>();
  /** Its sends by how they went (`sent <command>`, `dry-run <command>`, `failed`). */
  private readonly plays: Tally;

  constructor(ctx: PluginContext, groups: ChatGroups) {
    this.ctx = ctx;
    this.groups = groups;
    this.c = ctx.config as PlayerConfig;
    this.chat = ctx.outbox('chat').chats()[0] ?? '';
    this.plays = new Tally(ctx.clock);
    this.state = ctx.store.read<PlayerState>('state') ?? {};
  }

  instance() {
    return {
      start: () => {
        this.ctx.summary?.contribute((w) => this.summaryLines(w));
        // Its parser's commands, its defaults and policies (D137), read once it runs.
        this.played();
        this.attention = this.ctx.attention<AttentionHandle>();
        this.leave = this.attention.join({
          sitting: (s) => this.begin(s),
          lastByHand: () => this.lastByHand(),
          inSitting: () => this.state.sitting !== undefined,
          again: () => this.again(),
        });
        this.leaveGroup = this.groups.join(
          this.ctx.id,
          this.ctx.outbox('chat').account,
          this.chat,
          this.member()
        );
        // A sitting kept without its next step (dropped as too late): it ended with the restart.
        if (this.state.sitting !== undefined && this.ctx.scheduler.get(PLAY_TIMER) === undefined)
          this.end('the sitting ended while it was down');
      },
      stop: () => {
        this.leave?.();
        this.leaveGroup?.();
      },
      onTimer: (name: string) => {
        if (name === PLAY_TIMER) void this.next();
      },
      pause: (reason: string) => {
        this.stopped = true;
        this.leave?.();
        this.drop(`stopped: ${reason}`);
      },
      off: () => this.drop('the bot is off'),
      on: () => {
        const next = this.status().next;
        return typeof next === 'number' ? `${this.chat}: next ${clock(next)} UTC` : undefined;
      },
      kill: () => {
        this.ctx.stop('safety stop');
        return `${this.chat}: stopped`;
      },
      interface: { state: { status: () => this.status() } },
    };
  }

  /**
   * The owner wrote during its sitting (D138): it waits, at its next look, for the answer to their
   * command, if any, then looks again at what is ready.
   */
  private again(): void {
    const sitting = this.state.sitting;
    if (sitting === undefined || !this.playing()) return;
    sitting.hand = true;
    this.keep();
  }

  /**
   * Another player of its account sent a command (D139, D140): its parser is told, and counts it
   * if it reaches its bot (a bare command in a group its bot is in); in a sitting, it waits at its
   * next look for that send's answer, so that it does not send its own over a turn just taken.
   */
  private heard(s: PlayerSend): void {
    try {
      this.parser().actions.sent({
        chat: s.chat,
        ...(s.id === undefined ? {} : { id: s.id }),
        t: s.t,
        command: s.text,
      });
    } catch {
      return;
    }
    this.again();
  }

  /**
   * The last send its parser knows of (the owner's by hand, or another player's, D139) that it has
   * read no answer to yet, if it was sent less than `ANSWER_WAIT_MS` ago: what a sitting that
   * follows their play waits for (D138).
   */
  private unanswered(ready: Record<string, Readiness>, now: number): number | undefined {
    let last: Readiness | undefined;
    for (const r of Object.values(ready))
      if (r.sent !== undefined && (last?.sent === undefined || r.sent.t > last.sent.t)) last = r;
    const sent = last?.sent;
    if (sent === undefined || now - sent.t >= ANSWER_WAIT_MS) return undefined;
    return last?.answer !== undefined && last.answer.t >= sent.t ? undefined : sent.t;
  }

  private status(): PlayerStatus {
    const step = this.ctx.scheduler.get(PLAY_TIMER);
    const next = step?.at ?? (this.playing() ? this.attention?.next() : undefined);
    return {
      chat: this.chat,
      commands: this.played()
        .map((x) => x.command)
        .join(', '),
      ...(this.state.last === undefined ? {} : { last: this.state.last }),
      ...(next === undefined ? {} : { next }),
    };
  }

  private playing(): boolean {
    return !this.stopped && !this.ctx.off();
  }

  private parser(): TurnParserInterface {
    return this.ctx.use<TurnParserInterface>('parser');
  }

  /**
   * What it plays (D137): its config's commands, or its parser's defaults, each with its policy.
   * Its parser's commands are read once, when first needed; while its parser cannot say (not
   * running), none.
   */
  private played(): Play[] {
    if (this.declared === undefined)
      try {
        this.declared = this.parser().state.commands();
      } catch {
        return playsOf(this.c.commands, []);
      }
    return playsOf(this.c.commands, this.declared);
  }

  /** Its bot's username (D139), read once from its parser; undefined while it cannot say. */
  private botName(): string | undefined {
    try {
      this.bot ??= this.parser().state.bot();
    } catch {
      return undefined;
    }
    return this.bot;
  }

  /** Its parser's readiness of each command; undefined while it cannot say. */
  private readyNow(): Record<string, Readiness> | undefined {
    try {
      return this.parser().state.ready();
    } catch {
      return undefined;
    }
  }

  /** The forms it may send `play` as, in order (D140): in a group, addressed ones too. */
  private formsOf(play: Play): string[] {
    const bot = this.botName();
    if (bot === undefined) return [];
    return playForms(play, this.declared ?? [], bot, !this.chat.startsWith('@'));
  }

  /** Its outbox holds `form` back now (D98). */
  private heldBack(form: string, now: number): boolean {
    const held = this.ctx.outbox('chat').held(this.chat, form);
    return held !== undefined && held.until > now;
  }

  /** Itself as its group sees it (D140). */
  private member(): GroupMember {
    return {
      id: this.ctx.id,
      takes: (form) => {
        const bot = this.botName();
        this.played();
        return bot === undefined ? undefined : commandOf(form, this.declared ?? [], bot);
      },
      wouldPlay: (command, form) => this.wouldPlay(command, form),
      dueWithin: (command, now, withinMs) => {
        const play = this.inPlay(command);
        const ready = this.readyNow();
        return play === undefined || ready === undefined
          ? undefined
          : this.due(play, ready, now, withinMs);
      },
      unanswered: (now) => {
        const ready = this.readyNow();
        return ready === undefined ? undefined : this.unanswered(ready, now);
      },
      heard: (s) => this.heard(s),
    };
  }

  /** Its play of `command`, if it is in a sitting and plays it (ticked). */
  private inPlay(command: string): Play | undefined {
    if (!this.playing() || this.state.sitting === undefined) return undefined;
    return this.played().find((p) => same(p.command, command));
  }

  /**
   * Whether it would play `command` now, sent as `form` (D140): in a sitting, ticked, its policy
   * allowing it, ready, not covered by another's send, and `form` one it may send, not held back.
   */
  private wouldPlay(command: string, form: string): boolean {
    const now = this.ctx.clock.now();
    const sitting = this.state.sitting;
    const play = this.inPlay(command);
    const ready = this.readyNow();
    if (sitting === undefined || play === undefined || ready === undefined) return false;
    if (sitting.count >= MAX_SENDS_PER_SITTING || !this.goes(play, ready, sitting)) return false;
    if (this.groups.covered(this.ctx.id, play.command, now)) return false;
    return this.formsOf(play).some((f) => same(f, form)) && !this.heldBack(form, now);
  }

  /**
   * When `play`, not ready now, will be, if its policy allows it and that is within `withinMs`;
   * else undefined (D140).
   */
  private due(
    play: Play,
    ready: Record<string, Readiness>,
    now: number,
    withinMs: number
  ): number | undefined {
    const r = ready[play.command];
    if (r === undefined || r.ready || r.until === undefined || r.until - now > withinMs)
      return undefined;
    if (play.whileHeld !== undefined && ready[play.whileHeld]?.ready !== false) return undefined;
    return r.until;
  }

  /** The owner's latest play by hand with its bot, as its parser read it (any command). */
  private lastByHand(): number | undefined {
    let ready: Record<string, Readiness>;
    try {
      ready = this.parser().state.ready();
    } catch {
      return undefined;
    }
    let latest: number | undefined;
    for (const r of Object.values(ready))
      if (r.sent?.byHand === true && (latest === undefined || r.sent.t > latest)) latest = r.sent.t;
    return latest;
  }

  private keep(): void {
    this.ctx.store.write('state', this.state);
  }

  /** A sitting starts: its first look after a glance. */
  private begin(s: Sitting): void {
    if (!this.playing() || this.state.sitting?.id === s.id) return;
    this.state.sitting = {
      id: s.id,
      sent: {},
      count: 0,
      ...(s.follow === true ? { hand: true as const } : {}),
    };
    this.keep();
    this.step('sitting', `#${s.id}`);
    this.arm(this.react());
  }

  private react(length?: number): number {
    return (this.attention as AttentionHandle).react(length === undefined ? {} : { length });
  }

  private arm(at: number): void {
    this.ctx.scheduler.at(PLAY_TIMER, at, { late: 'fire', graceMs: PLAY_GRACE_MS });
  }

  private drop(why: string): void {
    this.ctx.scheduler.cancel(PLAY_TIMER);
    if (this.state.sitting === undefined) return;
    this.end(why, 'stopped');
  }

  private end(why: string, event: 'done' | 'stopped' = 'done'): void {
    const id = this.state.sitting?.id;
    delete this.state.sitting;
    this.keep();
    this.step(event, `sitting #${String(id)} ${event === 'done' ? 'done' : 'dropped'}: ${why}`);
  }

  /**
   * Whether `play` goes now, whatever its form: its command ready, sent in this sitting only if
   * ready again since, and its policy's command held.
   */
  private goes(play: Play, ready: Record<string, Readiness>, sitting: InSitting): boolean {
    const r = ready[play.command];
    if (r === undefined || !r.ready) return false;
    const sent = sitting.sent[play.command];
    if (sent !== undefined && !(r.since !== undefined && r.since > sent)) return false;
    return play.whileHeld === undefined || ready[play.whileHeld]?.ready === false;
  }

  /**
   * Whether to wait before picking `play`'s form (D140): until when, while a player its widest
   * form reaches has a send not answered yet, or its command will be ready within `settleS`; at
   * most the answer window from the first wait. Undefined: it picks now.
   */
  private settle(play: Play, forms: string[], sitting: InSitting, now: number): number | undefined {
    const group = this.groups.group(this.ctx.id);
    const others = widestReach(forms, group).filter((r) => r.id !== this.ctx.id);
    let at: number | undefined;
    for (const r of others) {
      const m = group.find((x) => x.id === r.id) as GroupMember;
      const due = [
        m.unanswered(now) === undefined ? undefined : now + ANSWER_POLL_MS,
        m.dueWithin(r.command, now, this.c.settleS * 1000),
      ];
      for (const t of due) if (t !== undefined && (at === undefined || t < at)) at = t;
    }
    if (at === undefined) return undefined;
    if (sitting.settling?.command !== play.command)
      sitting.settling = { command: play.command, since: now };
    const until = sitting.settling.since + ANSWER_WAIT_MS;
    if (now >= until) return undefined;
    this.keep();
    return Math.min(Math.max(at, now + 1), until);
  }

  /** Its next step in a sitting: the answer awaited, else the next command ready, else done. */
  private async next(): Promise<void> {
    const sitting = this.state.sitting;
    if (!this.playing() || sitting === undefined || this.sending) return;
    const now = this.ctx.clock.now();
    let ready: Record<string, Readiness>;
    try {
      ready = this.parser().state.ready();
    } catch {
      this.end('its parser is not running');
      return;
    }
    const w = sitting.waiting;
    if (w !== undefined) {
      const answer = ready[w.command]?.answer;
      if (answer !== undefined && answer.t >= w.t) {
        delete sitting.waiting;
        this.keep();
        this.step('read', `${w.command}: ${answer.length} characters`);
        this.arm(this.react(answer.length));
      } else if (now - w.t < ANSWER_WAIT_MS) this.arm(now + ANSWER_POLL_MS);
      else {
        delete sitting.waiting;
        this.keep();
        this.arm(this.react());
      }
      return;
    }
    // Following the owner's play (D138): their command's answer first, as its parser reads it.
    if (sitting.hand === true) {
      if (this.unanswered(ready, now) !== undefined) {
        this.arm(now + ANSWER_POLL_MS);
        return;
      }
      delete sitting.hand;
      this.keep();
    }
    if (sitting.count >= MAX_SENDS_PER_SITTING) {
      this.end(`${MAX_SENDS_PER_SITTING} sends, the most in one`);
      return;
    }
    /** When to look again, if nothing goes now: a command due soon, or one another covers. */
    let later: number | undefined;
    const soon = (t: number): void => {
      if (later === undefined || t < later) later = t;
    };
    for (const play of this.played()) {
      if (ready[play.command] === undefined) {
        if (!this.unknown.has(play.command)) {
          this.unknown.add(play.command);
          this.step('failed', `its parser knows no ${play.command}: never played`);
        }
        continue;
      }
      if (!this.goes(play, ready, sitting)) {
        // About to be ready (D140): it waits for it rather than leave.
        const due = this.due(play, ready, now, this.c.settleS * 1000);
        if (due !== undefined) soon(due);
        continue;
      }
      // Another player's send covers it (D140): its hand-off comes, then its answer.
      if (this.groups.covered(this.ctx.id, play.command, now)) {
        soon(now + ANSWER_POLL_MS);
        continue;
      }
      const forms = this.formsOf(play).filter((f) => !this.heldBack(f, now));
      if (forms.length === 0) continue;
      const wait = this.settle(play, forms, sitting, now);
      if (wait !== undefined) {
        this.arm(wait);
        return;
      }
      const pick = pickForm(forms, this.groups.group(this.ctx.id));
      if (pick === undefined) continue;
      // Picked and claimed in the tick it is sent in: no other player sends over it.
      delete sitting.settling;
      this.groups.claim(this.ctx.id, pick.reach, now + ANSWER_WAIT_MS);
      await this.send(play, pick.form, sitting);
      return;
    }
    if (later !== undefined) {
      this.arm(Math.max(later, now + 1));
      return;
    }
    this.end('nothing left to play');
  }

  private async send(play: Play, text: string, sitting: InSitting): Promise<void> {
    const { command } = play;
    this.sending = true;
    try {
      const r = await this.ctx.outbox('chat').deliver(this.chat, text);
      const t = this.ctx.clock.now();
      // The account not connected (a dry run never waits for it, D64): it tries again shortly.
      if (r.outcome === 'refused' && r.reason === 'not connected') {
        if (!this.waitingAccount) this.step('waiting', "the owner's account is not connected");
        this.waitingAccount = true;
        this.arm(t + CONNECT_WAIT_MS);
        return;
      }
      this.waitingAccount = false;
      sitting.sent[command] = t;
      sitting.count++;
      if (r.outcome === 'sent' || r.outcome === 'dry-run') {
        this.state.last = t;
        this.plays.add(`${r.outcome} ${command}`);
        if (r.outcome === 'sent') {
          const id = r.id === undefined ? {} : { id: r.id };
          this.parser().actions.sent({ chat: this.chat, ...id, t, command: text });
          // The other players of its account hear it, each its own parser (D139, D140).
          this.groups.sent(this.ctx.id, { chat: this.chat, text, ...id, t });
          sitting.waiting = { command, t };
        }
        this.keep();
        this.step(
          'sent',
          r.outcome === 'sent'
            ? `${text}${r.id === undefined ? '' : ` #${r.id}`}`
            : `${text} (dry run)`
        );
        if (this.playing()) this.arm(r.outcome === 'sent' ? t + ANSWER_POLL_MS : this.react());
      } else {
        this.keep();
        this.plays.add('failed');
        this.step('failed', `${command}: ${r.reason ?? r.outcome}`);
        if (this.playing()) this.arm(this.react());
      }
    } finally {
      this.sending = false;
      this.groups.release(this.ctx.id);
    }
  }

  /**
   * Its plays in a summary's window, by command: `4 commands sent (/play 3, /daily 1), 1 failed`;
   * none, nothing.
   */
  private summaryLines(w: SummaryWindow): string[] {
    const by = (outcome: string): [string, number][] =>
      this.played()
        .map((p): [string, number] => [p.command, this.plays.count(`${outcome} ${p.command}`, w)])
        .filter(([, n]) => n > 0);
    const part = (outcome: string, words: string): string[] => {
      const each = by(outcome);
      const total = each.reduce((s, [, n]) => s + n, 0);
      return total === 0
        ? []
        : [
            `${counted(total, 'command')} ${words} (${each.map(([c, n]) => `${c} ${n}`).join(', ')})`,
          ];
    };
    const failed = this.plays.count('failed', w);
    const parts = [
      ...part('sent', 'sent'),
      ...part('dry-run', 'in a dry run'),
      ...(failed > 0 ? [`${failed} failed`] : []),
    ];
    return parts.length === 0 ? [] : [parts.join(', ')];
  }

  private step(event: PlayerStep['event'], detail: string): void {
    this.ctx.bus.publish(`${PLAYER}.step`, {
      player: this.ctx.id,
      chat: this.chat,
      event,
      detail,
    } satisfies PlayerStep);
    this.ctx.log.info(`${event}: ${detail}`);
  }
}
