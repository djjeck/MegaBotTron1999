/**
 * The base turn-actor (docs/bot-os-api.md §5): one plugin, run as one instance per game bot
 * that may be automated (P3, P17), each bound by its ports to the private
 * chat with its bot (it only sends there) and to its bot's parser. An instance sends its `command`
 * (by default `/play`; set it to the bot's own turn command) to its bot's chat, from the owner's
 * account, at a person's pace. **Its bot's chat is its edge's alone** (bot-os.md D97): the one chat
 * its chat-out edge sends to, the bot's `@username` (the check refuses anything else); its config
 * names none. It reads no chat (D99): what it knows of the chat, its parser tells it:
 *
 * - its planner (packages/turns/src/schedule.ts) counts from the owner's last turn with the
 *   bot: its own, or one sent by hand in that chat (from any device), which its parser knows
 *   (`state.lastTurn`) and it reads at its start and when its turn is due, planning afresh from a
 *   newer one; the last one is kept in its store (`state`), so a restart never sends sooner; with
 *   no recent turn, it sends within a few minutes, each instance at its own moment;
 * - before it sends, it asks its parser whether the bot rests (`state.rest`: its rest after a
 *   turn, 30 minutes after a fight lost, a "too soon"), and its outbox what holds its command back
 *   (`held`, D98: the bot's cooldown as an answer said it, the retry-loop guard), and if anything
 *   does, it waits it out, coming back a few minutes after;
 * - its next send is the durable timer `turn`, kept across restarts; one that came due while the
 *   client was down for more than `PLAN_GRACE_MS` is dropped, and it plans afresh;
 * - it plays while its node runs and the bot is on; stopped (bot-os.md D64: drift on its parser,
 *   which it requires, the owner's kill or stop, or its own safety stop, `kill`), it drops its plan
 *   and plays no more until the owner clears the stop in the editor;
 * - through a dry-run chat-out edge (D64) its turns are logged, nothing sent; through a live one,
 *   it waits for the account to be connected (its send refused `not connected`), and tells its
 *   parser each turn sent, so the parser matches the bot's reply to it;
 * - a send refused as its command rests (D98) is planned again when it may go; any other failed
 *   send, two minutes later.
 *
 * It declares no chat command (two instances would clash on its name): the owner's `/plugins <id>`
 * gives each its state, and its read `status` its last and next send. It keeps nothing in
 * its factory's closure: everything hangs off its instance (§2.1). Each step is published as
 * `turn-actor.step`, with the instance's id, and printed.
 */
import {
  counted,
  definePlugin,
  type Plugin,
  type PluginContext,
  type SummaryWindow,
  Tally,
} from '@megabottron1999/core';
import { Rng } from '@megabottron1999/core/rng.ts';
import { z } from 'zod';
import { DEFAULT_SCHEDULE, hash, type Plan, Planner, scheduleProblem } from '#src/schedule.ts';
import { TURN_PARSER_MEMBERS, type TurnParserInterface } from './turn-parser.ts';

export const TURN_ACTOR = 'turn-actor';
/** The timer of the next turn. */
export const TURN_TIMER = 'turn';
/** How late a kept plan may still fire after a restart. */
export const PLAN_GRACE_MS = 10 * 60_000;
/** How long a failed send waits before the next try. */
export const RETRY_MS = 2 * 60_000;
/** How often a turn due waits for the account to connect. */
export const CONNECT_WAIT_MS = 60_000;
/** The turn command when the configuration names none: a placeholder, since each bot has its own. */
export const DEFAULT_TURN_COMMAND = '/play';

/**
 * The planner's pace (packages/turns/src/schedule.ts), each field with its default
 * (`DEFAULT_SCHEDULE`) in the schema itself, so that the editor shows it; a schedule left out is
 * the defaults whole. The whole is checked as the planner needs it (`scheduleProblem`).
 */
const D = DEFAULT_SCHEDULE;
const scheduleShape = z
  .object({
    minGapMin: z
      .number()
      .default(D.minGapMin)
      .describe(
        'The shortest interval between two turns, in minutes: 15 at least, the bots’ own rest'
      ),
    maxGapMin: z
      .number()
      .default(D.maxGapMin)
      .describe('The longest interval between two turns, in minutes, not under minGapMin'),
    skipChance: z
      .number()
      .default(D.skipChance)
      .describe('The chance that a turn is forgotten, from 0 to under 1'),
    bedtime: z
      .string()
      .default(D.bedtime)
      .describe(
        'When it goes to sleep, HH:MM on the clock of timeZone: no turn from bedtime until wake'
      ),
    wake: z
      .string()
      .default(D.wake)
      .describe(
        'When it wakes up, HH:MM on the clock of timeZone, not equal to bedtime; earlier than bedtime means the next morning (bedtime 23:00, wake 07:00)'
      ),
    jitterMin: z
      .number()
      .default(D.jitterMin)
      .describe('How far bedtime and wake may each move, either way, in minutes'),
    wakeDelayMaxMin: z
      .number()
      .default(D.wakeDelayMaxMin)
      .describe('The most extra minutes after waking before the first turn'),
    timeZone: z
      .string()
      .default(D.timeZone)
      .describe('The time zone of bedtime and wake, an IANA name such as Europe/Rome'),
  })
  .superRefine((s, ctx) => {
    const problem = scheduleProblem(s);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  });

/** An instance's configuration: where it plays, what it sends, and its pace. */
export const turnActorConfig = z.object({
  command: z
    .string()
    .regex(/^\/\w+$/u, 'expected a command')
    .default(DEFAULT_TURN_COMMAND)
    .describe('Its turn command, sent to the bot'),
  schedule: scheduleShape
    .default(() => ({ ...DEFAULT_SCHEDULE }))
    .describe('Its pace: the interval between turns, and the night'),
  nightSalt: z
    .string()
    .default('')
    .describe(
      'The night’s salt: the instances with the same one sleep the same nights (one person); empty, every instance’s'
    ),
  seed: z
    .number()
    .int()
    .optional()
    .describe('The seed of its draws; unset, drawn from the clock and its id'),
});
export type TurnActorConfig = z.output<typeof turnActorConfig>;

export interface TurnActorState {
  /** the owner's last turn with the bot, in ms. */
  last?: number;
}

export interface TurnStatus {
  chat: string;
  command: string;
  last?: number;
  next?: number;
}

const stepSchema = z.object({
  actor: z.string(),
  chat: z.string(),
  event: z.enum(['planned', 'sent', 'seen', 'rest', 'waiting', 'failed', 'stopped']),
  detail: z.string(),
});
export type TurnStep = z.infer<typeof stepSchema>;

const clock = (t: number) => new Date(t).toISOString().slice(11, 16);

/** An instance's line in the owner's summary: its bot, its state, its last and next turn. */
export function turnSummary(id: string, state: string, s: TurnStatus | undefined): string {
  const parts = [
    ...(s?.last === undefined ? [] : [`last ${clock(s.last)}`]),
    ...(s?.next === undefined ? [] : [`next ${clock(s.next)}`]),
  ];
  return `${s?.chat ?? id}: ${state}${parts.length > 0 ? `, ${parts.join(', ')} UTC` : ''}`;
}

/** The turn-actor plugin, of which the wiring makes one instance per bot (`withInstances`). */
export function turnActorPlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: TURN_ACTOR,
      version: '0.1.0',
      kinds: ['actor'],
      description:
        "A game bot's turn, from the owner's account, in its private chat, at a person's pace",
      config: turnActorConfig,
      // Its turns since the last summary, for the owner (bot-os.md D92).
      summary: true,
      games: { registers: [TURN_ACTOR] },
      events: {
        [`${TURN_ACTOR}.step`]: stepSchema.describe(
          'A step of its plan: a turn planned, sent, seen sent by hand, a rest, a wait, a failure or its stop'
        ),
      },
      inputs: {
        parser: {
          type: 'interface',
          members: TURN_PARSER_MEMBERS,
          help: "Its bot's parser: the bot's rest, the owner's last turn (by hand too), and the turns it sent",
        },
      },
      outputs: {
        chat: {
          type: 'chat-out',
          network: 'telegram',
          // Its edge names its bot's chat, the one it plays in (D97).
          single: { pattern: String.raw`^@\w{4,}$`, expected: "its bot's @username" },
          help: "the owner's own account: the private chat with its bot, the one chat its edge names, and its turn command only",
        },
      },
      interface: {
        state: {
          status: {
            help: 'Its chat and command, and its last and next turn',
            output: z.object({
              chat: z.string(),
              command: z.string(),
              last: z.number().optional(),
              next: z.number().optional(),
            }),
          },
        },
      },
    },
    create: (ctx) => new TurnActor(ctx).instance(),
  });
}

/** One instance: its plan, its last turn, and its hooks. */
class TurnActor {
  private readonly ctx: PluginContext;
  private readonly c: TurnActorConfig;
  /** Its bot's private chat, the one its chat-out edge names (D97). */
  private readonly chat: string;
  private readonly planner: Planner;
  private last: number | undefined;
  private plan: Plan | undefined;
  /** Its node was stopped (D64): it plays no more until a restart after the owner clears it. */
  private stopped = false;
  private sending = false;
  /** Told once while it waits for the account. */
  private waiting = false;
  /** Its turns by how they went (`sent`, `dry-run`, `by hand`, `failed`), for the summary. */
  private readonly turns: Tally;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.c = ctx.config as TurnActorConfig;
    this.chat = ctx.outbox('chat').chats()[0] ?? '';
    this.turns = new Tally(ctx.clock);
    const seed = this.c.seed ?? (ctx.clock.now() ^ hash(ctx.id)) >>> 0;
    this.planner = new Planner(this.c.schedule, new Rng(seed), this.c.nightSalt);
    this.last = ctx.store.read<TurnActorState>('state')?.last;
    this.plan = ctx.scheduler.get(TURN_TIMER)?.payload as Plan | undefined;
  }

  instance() {
    return {
      start: () => {
        this.ctx.summary?.contribute((w) => this.summaryLines(w));
        if (this.byHand() && this.plan !== undefined) this.replan();
        this.settle();
      },
      onTimer: (name: string) => {
        if (name === TURN_TIMER) void this.due();
      },
      // Its node stopped, whatever stopped it.
      pause: (reason: string) => {
        this.stopped = true;
        this.drop(`stopped: ${reason}`);
      },
      off: () => this.drop('the bot is off'),
      on: () => {
        this.settle();
        return this.plan === undefined
          ? undefined
          : `${this.chat}: next ${clock(this.plan.at)} UTC`;
      },
      // Its safety stop: its node stopped, until the owner clears it in the editor.
      kill: () => {
        this.ctx.stop('safety stop');
        return `${this.chat}: stopped`;
      },
      interface: { state: { status: () => this.status() } },
    };
  }

  private status(): TurnStatus {
    return {
      chat: this.chat,
      command: this.c.command,
      ...(this.last === undefined ? {} : { last: this.last }),
      ...(this.plan === undefined ? {} : { next: this.plan.at }),
    };
  }

  /**
   * A turn the owner sent by hand in the chat, from any device, since its last, as its parser
   * knows it (D99): it counts from it. Whether there was one.
   */
  private byHand(): boolean {
    const turn = this.ctx.use<TurnParserInterface>('parser').state.lastTurn();
    if (turn === undefined || (this.last !== undefined && turn.t <= this.last)) return false;
    this.remember(turn.t);
    this.turns.add('by hand');
    this.step('seen', `sent by hand at ${clock(turn.t)}`);
    return true;
  }

  /** Whether it plays now: its node not stopped, the bot not off. */
  private playing(): boolean {
    return !this.stopped && !this.ctx.off();
  }

  /** Plans if it plays and has no plan; drops the plan if it does not play. */
  private settle(): void {
    if (!this.playing()) this.drop('stopped');
    else if (this.plan === undefined) this.replan();
  }

  /**
   * Plans from the last turn; a plan "at once" (no recent turn: a fresh start, a long pause) comes
   * up to a few minutes later instead, so that the instances do not all send in the same second.
   */
  private replan(): void {
    const now = this.ctx.clock.now();
    const plan = this.planner.next(this.last, now);
    this.setPlan(plan.at <= now ? this.planner.after(now) : plan);
  }

  private drop(why: string): void {
    if (this.plan === undefined) return;
    this.plan = undefined;
    this.ctx.scheduler.cancel(TURN_TIMER);
    this.step('stopped', `plan dropped: ${why}`);
  }

  private setPlan(plan: Plan, event: 'planned' | 'rest' = 'planned', why?: string): void {
    this.plan = plan;
    this.ctx.scheduler.at(TURN_TIMER, plan.at, {
      payload: plan,
      late: 'fire',
      graceMs: PLAN_GRACE_MS,
    });
    const notes = [
      ...(why === undefined ? [] : [why]),
      ...(plan.skipped > 0 ? [`${plan.skipped} turn${plan.skipped > 1 ? 's' : ''} forgotten`] : []),
      ...(plan.afterSleep ? ['after the night'] : []),
    ];
    this.step(event, `${clock(plan.at)} UTC${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
  }

  /**
   * What holds its turn back now, the longest: the bot's rest as its parser read it, or what its
   * outbox holds its command back for (D98: a cooldown an answer said, the retry-loop guard).
   */
  private resting(now: number): { until: number; why: string } | undefined {
    const rest = this.ctx.use<TurnParserInterface>('parser').state.rest();
    const held = this.ctx.outbox('chat').held(this.chat, this.c.command);
    const holds = [
      ...(rest !== undefined && rest.until > now ? [rest] : []),
      ...(held !== undefined && held.until > now ? [{ until: held.until, why: held.reason }] : []),
    ];
    return holds.sort((a, b) => b.until - a.until)[0];
  }

  /** Its plan is due: plans afresh from a turn sent by hand, waits for a rest, or sends. */
  private async due(): Promise<void> {
    const plan = this.plan;
    this.plan = undefined;
    if (!this.playing() || this.sending) return;
    if (this.byHand()) {
      this.replan();
      return;
    }
    const now = this.ctx.clock.now();
    const rest = this.resting(now);
    if (rest !== undefined) {
      this.setPlan(this.planner.after(rest.until), 'rest', `${this.chat} rests: ${rest.why}`);
      return;
    }
    this.sending = true;
    try {
      const r = await this.ctx.outbox('chat').deliver(this.chat, this.c.command);
      const t = this.ctx.clock.now();
      // The account not connected (a dry run never waits for it, D64): it tries again shortly.
      if (r.outcome === 'refused' && r.reason === 'not connected') {
        if (!this.waiting) this.step('waiting', "the owner's account is not connected");
        this.waiting = true;
        this.plan = plan ?? { at: t, skipped: 0, afterSleep: false };
        this.ctx.scheduler.after(TURN_TIMER, CONNECT_WAIT_MS, {
          payload: this.plan,
          late: 'fire',
          graceMs: PLAN_GRACE_MS,
        });
        return;
      }
      this.waiting = false;
      if (r.outcome === 'sent' || r.outcome === 'dry-run') {
        if (r.outcome === 'sent')
          this.ctx
            .use<TurnParserInterface>('parser')
            .actions.sent({ chat: this.chat, ...(r.id === undefined ? {} : { id: r.id }), t });
        this.remember(t);
        this.turns.add(r.outcome);
        this.step(
          'sent',
          r.outcome === 'sent'
            ? `${this.c.command}${r.id === undefined ? '' : ` #${r.id}`}`
            : `${this.c.command} (dry run)`
        );
        if (this.playing()) this.replan();
      } else {
        this.turns.add('failed');
        this.step('failed', r.reason ?? r.outcome);
        // Refused as its command rests (D98): again when it may go, else a little later.
        const at = r.retryAt !== undefined && r.retryAt > t ? r.retryAt : t + RETRY_MS;
        if (this.playing())
          this.setPlan({ at, skipped: 0, afterSleep: false }, 'planned', 'a retry');
      }
    } finally {
      this.sending = false;
    }
  }

  private remember(t: number): void {
    this.last = t;
    this.ctx.store.write('state', { last: t } satisfies TurnActorState);
  }

  /** Its turns in a summary's window: `3 turns sent, 1 by hand, 1 failed`; none, nothing. */
  private summaryLines(w: SummaryWindow): string[] {
    const n = (key: string): number => this.turns.count(key, w);
    const parts = [
      ...(n('sent') > 0 ? [`${counted(n('sent'), 'turn')} sent`] : []),
      ...(n('dry-run') > 0 ? [`${counted(n('dry-run'), 'turn')} in a dry run`] : []),
      ...(n('by hand') > 0 ? [`${n('by hand')} by hand`] : []),
      ...(n('failed') > 0 ? [`${n('failed')} failed`] : []),
    ];
    return parts.length === 0 ? [] : [parts.join(', ')];
  }

  private step(event: TurnStep['event'], detail: string): void {
    this.ctx.bus.publish(`${TURN_ACTOR}.step`, {
      actor: this.ctx.id,
      chat: this.chat,
      event,
      detail,
    } satisfies TurnStep);
    this.ctx.log.info(`${event}: ${detail}`);
  }
}
