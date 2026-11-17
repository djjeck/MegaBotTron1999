/**
 * `attention` (docs/bot-os-api.md §5, bot-os.md D134): a simulated person, one node per person (or
 * per account). It holds, once, what every turn actor held on its own: when the person comes back
 * (a gap between a minimum and a maximum, a chance to forget, nights off in a time zone, a seed:
 * packages/turns/src/sittings.ts), and how fast they act within a sitting (their reaction time:
 * reading an answer, scaled to its length, now and then longer). It starts **sittings**, given to
 * the players bound to its `attention` output (bot-os.md D133), so that the bots one person plays
 * share their sittings and gameplay comes in bursts, as a person's does.
 *
 * - Its players join it at their start (`AttentionHandle.join`, through `ctx.attention`), each
 *   with how to start a sitting and how to tell the person's last play by hand.
 * - **The owner's own play counts as a sitting by the real person:** when a sitting is due, it
 *   asks each of its players for the latest play by hand its parser read (`ready`'s sends marked
 *   `byHand`: a turn, or any other command, from any device); one newer than its last sitting is a
 *   sitting of the person's own, logged `seen`, and the next simulated one is planned a gap after
 *   it, none played now. So the bot plays only once the owner has been away longer than their pace
 *   (D99, D129, now for every bot of the person at once). It asks again once every node has
 *   started (`ready`), so that a restart after the owner played does not play at once.
 * - A sitting due while the person is still busy with the last (a reaction reserved past now) waits
 *   a gap after that.
 * - **Reaction:** a player asks when the person acts next (`react`), after reading `length`
 *   characters; it reserves that moment, so that the players of one person act one after the
 *   other, never in the same second.
 * - Its next sitting is the durable timer `sitting`, kept across restarts (dropped if it came due
 *   more than `SITTING_GRACE_MS` before a start: it plans afresh); its last sitting is kept in its
 *   store (`state`), so a restart never sits sooner.
 * - It plays while its node runs and the instance is on; stopped (its own safety stop, `kill`, or
 *   the owner's), it drops its plan, and its players are inactive with it (a required input).
 *
 * Its read `status` gives its players, its last sitting and its next, which its node's widget (its
 * next sitting, on its card) and page (Sittings) show (D112). Each step is published as
 * `attention.step`, with its node's id. It knows no game and sends nothing.
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
import { DEFAULT_SCHEDULE, hash, type Plan, Planner, scheduleProblem } from '#src/sittings.ts';

export const ATTENTION = 'attention';
/** The timer of the next sitting. */
export const SITTING_TIMER = 'sitting';
/** How late a kept sitting may still start after a restart. */
export const SITTING_GRACE_MS = 10 * 60_000;

/** A sitting, as its players are given it. */
export interface Sitting {
  /** Its number, one more each sitting of this person. */
  id: number;
  start: number;
}

/** A player, as it joins its person. */
export interface AttentionPlayer {
  /** A sitting starts: it plays what is ready, then waits for the next. */
  sitting(s: Sitting): void;
  /** The person's latest play by hand it knows of (its parser's), in ms; none: undefined. */
  lastByHand(): number | undefined;
}

/** What a player has of its person (`ctx.attention`, bot-os.md D133). */
export interface AttentionHandle {
  /** Joins its sittings; the function returned leaves them. */
  join(player: AttentionPlayer): () => void;
  /**
   * When the person acts next, after reading `length` characters (an answer; none: a glance), as
   * of now: that moment, reserved, so that the next one asked comes after it.
   */
  react(o?: { length?: number }): number;
  /** The next sitting planned, if any. */
  next(): number | undefined;
}

const D = DEFAULT_SCHEDULE;

/** How fast the person acts within a sitting, each field with its default. */
const reactionShape = z
  .object({
    minS: z.number().min(0).default(2).describe('The least seconds before acting, a glance'),
    maxS: z.number().min(0).default(8).describe('The most seconds before acting, a glance'),
    perCharMs: z
      .number()
      .min(0)
      .default(40)
      .describe('Milliseconds more per character of the answer read (40: 25 characters a second)'),
    longChance: z
      .number()
      .min(0)
      .max(1)
      .default(0.1)
      .describe('The chance that the person takes longer, distracted'),
    longMaxS: z.number().min(0).default(60).describe('The most seconds a longer one adds'),
  })
  .refine((r) => r.maxS >= r.minS, { message: 'maxS must not be under minS', path: ['maxS'] });

/** An `attention` node's configuration: the person's pace and nights, and their reactions. */
export const attentionConfig = z
  .object({
    minGapMin: z
      .number()
      .default(D.minGapMin)
      .describe('The shortest interval between two sittings, in minutes (1 at least)'),
    maxGapMin: z
      .number()
      .default(D.maxGapMin)
      .describe('The longest interval between two sittings, in minutes, not under minGapMin'),
    skipChance: z
      .number()
      .default(D.skipChance)
      .describe('The chance that a sitting is forgotten, from 0 to under 1'),
    wake: z
      .string()
      .default(D.wake)
      .describe(
        'When they wake up, HH:MM on the clock of timeZone: no sitting from bedtime until then'
      ),
    bedtime: z
      .string()
      .default(D.bedtime)
      .describe(
        'When they go to sleep, HH:MM on the clock of timeZone, not equal to wake; a wake earlier than it is the next morning (wake 07:00, bedtime 23:00)'
      ),
    jitterMin: z
      .number()
      .default(D.jitterMin)
      .describe('How far wake and bedtime may each move, either way, in minutes'),
    wakeDelayMaxMin: z
      .number()
      .default(D.wakeDelayMaxMin)
      .describe('The most extra minutes after waking before the first sitting'),
    timeZone: z
      .string()
      .default(D.timeZone)
      .describe('The time zone of wake and bedtime, an IANA name such as Europe/Rome'),
    reaction: reactionShape
      .default(() => reactionShape.parse({}))
      .describe('How fast they act within a sitting'),
    seed: z
      .number()
      .int()
      .optional()
      .describe('The seed of its draws; unset, drawn from the clock and its id'),
  })
  .superRefine((c, ctx) => {
    const problem = scheduleProblem(c);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  });
export type AttentionConfig = z.output<typeof attentionConfig>;

/** What it keeps: its last sitting (the person's by hand too) and the last one's number. */
export interface AttentionState {
  last?: { t: number; byHand: boolean };
  sittings?: number;
}

export interface AttentionStatus {
  players: number;
  last?: number;
  byHand?: boolean;
  next?: number;
}

const stepSchema = z.object({
  attention: z.string(),
  event: z.enum(['planned', 'sitting', 'seen', 'busy', 'stopped']),
  detail: z.string(),
});
export type AttentionStep = z.infer<typeof stepSchema>;

const clock = (t: number) => new Date(t).toISOString().slice(11, 16);

/** The `attention` plugin, one node per person. */
export function attentionPlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: ATTENTION,
      version: '0.1.0',
      kinds: ['actor'],
      description:
        'A simulated person: when they sit down to play, how fast they act, for the players bound to it',
      config: attentionConfig,
      summary: true,
      games: { registers: [ATTENTION] },
      events: {
        [`${ATTENTION}.step`]: stepSchema.describe(
          'A step of its plan: a sitting planned, started, seen played by hand, put off while busy, or its stop'
        ),
      },
      outputs: {
        attention: {
          type: 'attention',
          help: 'Its sittings and its pace, for each player bound to it: one person, many bots',
        },
      },
      interface: {
        state: {
          status: {
            help: 'Its players, and its last and next sitting',
            output: z.object({
              players: z.number().describe('Players'),
              last: z.number().optional().describe('Last sitting'),
              byHand: z.boolean().optional().describe('By hand'),
              next: z.number().optional().describe('Next sitting'),
            }),
          },
        },
      },
      widget: { show: 'until', read: 'status', path: 'next' },
      page: {
        title: 'Sittings',
        sections: [
          { show: 'keyValue', read: 'status', label: 'Person', fields: ['players', 'byHand'] },
          { show: 'until', read: 'status', path: 'last' },
          { show: 'until', read: 'status', path: 'next' },
        ],
      },
    },
    create: (ctx) => new Attention(ctx).instance(),
  });
}

/** One person: its plan, its players, and its hooks. */
class Attention {
  private readonly ctx: PluginContext;
  private readonly c: AttentionConfig;
  private readonly planner: Planner;
  private readonly rng: Rng;
  private readonly players = new Map<string, AttentionPlayer>();
  private last: AttentionState['last'];
  private sittings: number;
  private plan: Plan | undefined;
  /** Until when the person is busy: the last reaction reserved. */
  private busyUntil = 0;
  private stopped = false;
  /** Its sittings by how they went (`sat`, `by hand`), for the summary. */
  private readonly tally: Tally;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.c = ctx.config as AttentionConfig;
    const seed = this.c.seed ?? (ctx.clock.now() ^ hash(ctx.id)) >>> 0;
    this.rng = new Rng(seed);
    // Its nights drawn from their date and its id: a restart keeps them.
    this.planner = new Planner(this.c, new Rng(seed ^ 0x5bd1e995), ctx.id);
    const kept = ctx.store.read<AttentionState>('state');
    this.last = kept?.last;
    this.sittings = kept?.sittings ?? 0;
    this.tally = new Tally(ctx.clock);
    this.plan = ctx.scheduler.get(SITTING_TIMER)?.payload as Plan | undefined;
  }

  instance() {
    return {
      start: () => {
        this.ctx.summary?.contribute((w) => this.summaryLines(w));
        this.settle();
      },
      // Every player has joined: the owner's play while it was down counts.
      ready: () => {
        if (this.byHand() && this.plan !== undefined) this.replan();
      },
      onTimer: (name: string) => {
        if (name === SITTING_TIMER) this.due();
      },
      pause: (reason: string) => {
        this.stopped = true;
        this.drop(`stopped: ${reason}`);
      },
      off: () => this.drop('the bot is off'),
      on: () => {
        this.settle();
        return this.plan === undefined
          ? undefined
          : `${this.ctx.id}: next sitting ${clock(this.plan.at)} UTC`;
      },
      kill: () => {
        this.ctx.stop('safety stop');
        return `${this.ctx.id}: stopped`;
      },
      attention: (node: string): AttentionHandle => ({
        join: (player) => {
          this.players.set(node, player);
          return () => {
            if (this.players.get(node) === player) this.players.delete(node);
          };
        },
        react: (o = {}) => this.react(o.length ?? 0),
        next: () => this.plan?.at,
      }),
      interface: { state: { status: () => this.status() } },
    };
  }

  private status(): AttentionStatus {
    return {
      players: this.players.size,
      ...(this.last === undefined ? {} : { last: this.last.t, byHand: this.last.byHand }),
      ...(this.plan === undefined ? {} : { next: this.plan.at }),
    };
  }

  private playing(): boolean {
    return !this.stopped && !this.ctx.off();
  }

  private settle(): void {
    if (!this.playing()) this.drop('stopped');
    else if (this.plan === undefined) this.replan();
  }

  /** The person's next reaction, after reading `length` characters: reserved. */
  private react(length: number): number {
    const r = this.c.reaction;
    let ms = (r.minS + this.rng.next() * (r.maxS - r.minS)) * 1000 + length * r.perCharMs;
    if (this.rng.chance(r.longChance)) ms += this.rng.next() * r.longMaxS * 1000;
    const at = Math.max(this.ctx.clock.now(), this.busyUntil) + Math.round(ms);
    this.busyUntil = at;
    return at;
  }

  /**
   * The owner's latest play by hand, as its players' parsers read it, if newer than its last
   * sitting: a sitting of the real person's, kept as its last. Whether there was one.
   */
  private byHand(): boolean {
    let latest: number | undefined;
    for (const p of this.players.values()) {
      const t = p.lastByHand();
      if (t !== undefined && (latest === undefined || t > latest)) latest = t;
    }
    if (latest === undefined || (this.last !== undefined && latest <= this.last.t)) return false;
    this.remember({ t: latest, byHand: true });
    this.tally.add('by hand');
    this.step('seen', `played by hand at ${clock(latest)}`);
    return true;
  }

  /** Plans from the last sitting; one "at once" comes a few minutes later instead. */
  private replan(from = this.last?.t): void {
    const now = this.ctx.clock.now();
    const plan = this.planner.next(from, now);
    this.setPlan(plan.at <= now ? this.planner.after(now) : plan);
  }

  private drop(why: string): void {
    if (this.plan === undefined) return;
    this.plan = undefined;
    this.ctx.scheduler.cancel(SITTING_TIMER);
    this.step('stopped', `plan dropped: ${why}`);
  }

  private setPlan(plan: Plan, event: 'planned' | 'busy' = 'planned'): void {
    this.plan = plan;
    this.ctx.scheduler.at(SITTING_TIMER, plan.at, {
      payload: plan,
      late: 'fire',
      graceMs: SITTING_GRACE_MS,
    });
    const notes = [
      ...(event === 'busy' ? ['still busy'] : []),
      ...(plan.skipped > 0
        ? [`${plan.skipped} sitting${plan.skipped > 1 ? 's' : ''} forgotten`]
        : []),
      ...(plan.afterSleep ? ['after the night'] : []),
    ];
    this.step(event, `${clock(plan.at)} UTC${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
  }

  /** A sitting is due: the owner's own play puts it off, a busy person too; else it starts. */
  private due(): void {
    this.plan = undefined;
    if (!this.playing()) return;
    if (this.byHand()) {
      this.replan();
      return;
    }
    const now = this.ctx.clock.now();
    if (this.busyUntil > now) {
      const plan = this.planner.next(this.busyUntil, now);
      this.setPlan(plan.at <= now ? this.planner.after(now) : plan, 'busy');
      return;
    }
    this.sittings++;
    this.remember({ t: now, byHand: false });
    this.tally.add('sat');
    const sitting: Sitting = { id: this.sittings, start: now };
    this.step('sitting', `#${sitting.id}, ${counted(this.players.size, 'player')}`);
    for (const p of [...this.players.values()]) p.sitting(sitting);
    if (this.playing()) this.replan();
  }

  private remember(last: NonNullable<AttentionState['last']>): void {
    this.last = last;
    this.ctx.store.write('state', { last, sittings: this.sittings } satisfies AttentionState);
  }

  /** Its sittings in a summary's window: `5 sittings, 2 by hand`; none, nothing. */
  private summaryLines(w: SummaryWindow): string[] {
    const sat = this.tally.count('sat', w);
    const hand = this.tally.count('by hand', w);
    if (sat === 0 && hand === 0) return [];
    return [[counted(sat, 'sitting'), ...(hand > 0 ? [`${hand} by hand`] : [])].join(', ')];
  }

  private step(event: AttentionStep['event'], detail: string): void {
    this.ctx.bus.publish(`${ATTENTION}.step`, {
      attention: this.ctx.id,
      event,
      detail,
    } satisfies AttentionStep);
    this.ctx.log.info(`${event}: ${detail}`);
  }
}
