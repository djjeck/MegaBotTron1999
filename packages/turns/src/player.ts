/**
 * The `player` (docs/bot-os-api.md §5, bot-os.md D134): one plugin, run as one node per game bot
 * that may be automated (P3, P17), in place of the turn actor. It plays the commands its config
 * names, in a simulated person's sittings, from the owner's account, in the private chat with its
 * bot. Its ports:
 *
 * - `chat`, a chat-out output: its bot's private chat, **its edge's alone** (bot-os.md D97: the one
 *   chat its edge names, the bot's `@username`; the check refuses anything else), its commands
 *   those its edge allows; it reads no chat (D99);
 * - `parser`, a contract on its bot's parser (`state.ready`, `actions.sent`, D132), required, so
 *   that drift on the parser stops it: each command's readiness, and the sends it tells it of;
 * - `attention`, its person (bot-os.md D133), required: the sittings it plays in, and the person's
 *   reaction time.
 *
 * **Given a sitting**, it plays, one at a time, each configured command that is ready and that its
 * policy allows (`when ready`, or only while another command is held: a reset only while the turn
 * rests), in its config's order, each after the person's reaction time (its person's `react`:
 * a glance first, then the answer read, scaled to its length); after each live send it waits for
 * the answer its parser reads (up to two minutes), then looks again, so that a command an answer
 * unlocks, or one a reset makes ready again, is taken in the same sitting. A command it sent in
 * the sitting goes again only if it became ready again since (its readiness `since` after the
 * send), so that a dry run, or an answer that holds nothing, plays it once. When nothing is left,
 * it sleeps until the next sitting. **No schedule of its own:** its person's sittings, its
 * parser's readiness, and its outbox's `held` (D98) as the safety net, are all it waits on.
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
 *   matches the bot's reply to it. A send refused (a cooldown its outbox holds, the retry-loop
 *   guard) or failed is not tried again in that sitting.
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
  counted,
  definePlugin,
  type Plugin,
  type PluginContext,
  type SummaryWindow,
  Tally,
} from '@megabottron1999/core';
import { z } from 'zod';
import { type AttentionHandle, type Sitting } from '#src/attention.ts';
import { ANSWER_WINDOW_MS, type Readiness, type TurnParserInterface } from './turn-parser.ts';

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
/** The members of its parser it uses (D132). */
export const PLAYER_PARSER_MEMBERS = ['state.ready', 'actions.sent'];

const COMMAND = /^\/\w+$/u;

/** One command it plays, and when. */
const playSchema = z.object({
  command: z.string().regex(COMMAND, 'expected a command, as /play').describe('The command sent'),
  whileHeld: z
    .string()
    .regex(COMMAND, 'expected a command, as /play')
    .optional()
    .describe(
      'Played only while this command is held (a reset, only while the turn rests); unset, whenever it is ready'
    ),
});

/** A player's configuration: the commands it plays, each with its policy, in order. */
export const playerConfig = z.object({
  commands: z
    .array(playSchema)
    .min(1)
    .default(() => [{ command: '/play' }])
    .describe(
      "The commands it plays, in this order, each when its parser says it is ready and its policy allows; the chat-out edge must allow each (its bot's commands)"
    ),
});
export type PlayerConfig = z.output<typeof playerConfig>;

/** A sitting in progress, as it keeps it. */
interface InSitting {
  id: number;
  /** When it sent each command in this sitting. */
  sent: Record<string, number>;
  /** How many sends it made in it. */
  count: number;
  /** A live send whose answer it waits for. */
  waiting?: { command: string; t: number };
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
  next?: number;
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
    ...(s?.next === undefined ? [] : [`next ${clock(s.next)}`]),
  ];
  return `${s?.chat ?? id}: ${state}${parts.length > 0 ? `, ${parts.join(', ')} UTC` : ''}`;
}

/** The player plugin, of which the wiring makes one node per bot. */
export function playerPlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: PLAYER,
      version: '0.1.0',
      kinds: ['actor'],
      description:
        "A game bot's commands, from the owner's account, in its private chat, in a simulated person's sittings",
      config: playerConfig,
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
          // Its edge names its bot's chat, the one it plays in (D97).
          single: { pattern: String.raw`^@\w{4,}$`, expected: "its bot's @username" },
          help: "the owner's own account: the private chat with its bot, the one chat its edge names, and the commands it plays",
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
              next: z.number().optional().describe('Next play'),
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
    create: (ctx) => new Player(ctx).instance(),
  });
}

/** One node: its sitting, its last play, and its hooks. */
class Player {
  private readonly ctx: PluginContext;
  private readonly c: PlayerConfig;
  /** Its bot's private chat, the one its chat-out edge names (D97). */
  private readonly chat: string;
  private state: PlayerState;
  private attention: AttentionHandle | undefined;
  private leave: (() => void) | undefined;
  /** Its node was stopped (D64): it plays no more until a restart after the owner clears it. */
  private stopped = false;
  private sending = false;
  /** Told once while it waits for the account. */
  private waitingAccount = false;
  /** The commands its parser declares none of, told once. */
  private readonly unknown = new Set<string>();
  /** Its sends by how they went (`sent <command>`, `dry-run <command>`, `failed`). */
  private readonly plays: Tally;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.c = ctx.config as PlayerConfig;
    this.chat = ctx.outbox('chat').chats()[0] ?? '';
    this.plays = new Tally(ctx.clock);
    this.state = ctx.store.read<PlayerState>('state') ?? {};
  }

  instance() {
    return {
      start: () => {
        this.ctx.summary?.contribute((w) => this.summaryLines(w));
        this.attention = this.ctx.attention<AttentionHandle>();
        this.leave = this.attention.join({
          sitting: (s) => this.begin(s),
          lastByHand: () => this.lastByHand(),
        });
        // A sitting kept without its next step (dropped as too late): it ended with the restart.
        if (this.state.sitting !== undefined && this.ctx.scheduler.get(PLAY_TIMER) === undefined)
          this.end('the sitting ended while it was down');
      },
      stop: () => this.leave?.(),
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
        return next === undefined ? undefined : `${this.chat}: next ${clock(next)} UTC`;
      },
      kill: () => {
        this.ctx.stop('safety stop');
        return `${this.chat}: stopped`;
      },
      interface: { state: { status: () => this.status() } },
    };
  }

  private status(): PlayerStatus {
    const step = this.ctx.scheduler.get(PLAY_TIMER);
    const next = step?.at ?? (this.playing() ? this.attention?.next() : undefined);
    return {
      chat: this.chat,
      commands: this.c.commands.map((x) => x.command).join(', '),
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
    this.state.sitting = { id: s.id, sent: {}, count: 0 };
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
   * Whether `play` goes now: its command ready, sent in this sitting only if ready again since, its
   * policy's command held, and its outbox not holding it back.
   */
  private allowed(
    play: PlayerConfig['commands'][number],
    ready: Record<string, Readiness>,
    sitting: InSitting,
    now: number
  ): boolean {
    const r = ready[play.command];
    if (r === undefined) {
      if (!this.unknown.has(play.command)) {
        this.unknown.add(play.command);
        this.step('failed', `its parser knows no ${play.command}: never played`);
      }
      return false;
    }
    if (!r.ready) return false;
    const sent = sitting.sent[play.command];
    if (sent !== undefined && !(r.since !== undefined && r.since > sent)) return false;
    if (play.whileHeld !== undefined && ready[play.whileHeld]?.ready !== false) return false;
    const held = this.ctx.outbox('chat').held(this.chat, play.command);
    return held === undefined || held.until <= now;
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
    const play =
      sitting.count >= MAX_SENDS_PER_SITTING
        ? undefined
        : this.c.commands.find((p) => this.allowed(p, ready, sitting, now));
    if (play === undefined) {
      this.end(
        sitting.count >= MAX_SENDS_PER_SITTING
          ? `${MAX_SENDS_PER_SITTING} sends, the most in one`
          : 'nothing left to play'
      );
      return;
    }
    await this.send(play.command, sitting);
  }

  private async send(command: string, sitting: InSitting): Promise<void> {
    this.sending = true;
    try {
      const r = await this.ctx.outbox('chat').deliver(this.chat, command);
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
          this.parser().actions.sent({
            chat: this.chat,
            ...(r.id === undefined ? {} : { id: r.id }),
            t,
            command,
          });
          sitting.waiting = { command, t };
        }
        this.keep();
        this.step(
          'sent',
          r.outcome === 'sent'
            ? `${command}${r.id === undefined ? '' : ` #${r.id}`}`
            : `${command} (dry run)`
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
    }
  }

  /**
   * Its plays in a summary's window, by command: `4 commands sent (/play 3, /daily 1), 1 failed`;
   * none, nothing.
   */
  private summaryLines(w: SummaryWindow): string[] {
    const by = (outcome: string): [string, number][] =>
      this.c.commands
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
