/**
 * The owner's notices, told (docs/bot-os-api.md §5, bot-os.md D91, #40): a node that hears what the
 * core and the plugins raise for the owner's attention (`ctx.notices`, §4.16) and tells the owner,
 * through its `chat` output, in its `chat`: a `telegram-bot` node to the owner's private chat, or
 * `irc` to a nick or a channel. Its sends are queued as any node's (`enqueue`, D73), so a dry-run
 * edge (a new one is) logs them and sends nothing (D64).
 *
 * **What it tells,** each kind on or off (`report`): the events a state node refused (`refused`,
 * D72), sends several nodes shared (`coalesced`, D73), a parser's drift that paused what acts on it
 * (`drift`, P5), the nodes a runtime stop made inactive (`cascade`, D65), the nodes failed (`failed`:
 * a crash, a script killed as hung, D81, D85, D87), the graph's warnings at the load (`warning`,
 * D89, D90), and the kinds plugins raise of their own (`other`).
 *
 * **Grouped and paced, per kind** (`pace`): a kind's first notice waits `gatherS` for others of its
 * kind, and two messages of one kind are at least `everyMin` apart; what comes meanwhile goes in
 * the next, one message (`refused 5 events in the last 10 min: …`), listing at most `maxLines`
 * items. A warning already told at the previous start is not told again.
 *
 * **What comes next builds on it** (D91): the owner's periodic summary (#46) is another message of
 * this node, sent through `tell` on its own timer, its lines from the plugins; a send-queue watchdog
 * (#41) raises its own notice kind from the outbox (`OutboxOptions.notice`), which this node tells
 * as `other` until it gets a `KINDS` entry of its own.
 */
import {
  type Clock,
  definePlugin,
  type Notice,
  type Plugin,
  type PluginContext,
  type TimerHandle,
} from '@megabottron1999/core';
import { z } from 'zod';

export const OWNER_NOTICE = 'owner-notice';

/** The store's document of the warnings told, so that a restart does not tell them again. */
export const WARNED_DOC = 'warned';

/** The kinds it tells by name; any other is `other`. */
export const REPORTED = [
  'refused',
  'coalesced',
  'drift',
  'cascade',
  'failed',
  'warning',
  'other',
] as const;
export type Reported = (typeof REPORTED)[number];

/** How a kind is paced: how long its first notice waits for others, and the least gap. */
export interface Pace {
  gatherS: number;
  everyMin: number;
}

/**
 * Each kind's pace by default: what needs acting on (a failure, a drift, a cascade) goes within
 * seconds, at most every 5 minutes; a burst of refusals or coalesced sends within a minute, at
 * most every 10 or 30; the graph's warnings, once at the load.
 */
export const DEFAULT_PACE: Readonly<Record<Reported, Pace>> = {
  refused: { gatherS: 60, everyMin: 10 },
  coalesced: { gatherS: 60, everyMin: 30 },
  drift: { gatherS: 10, everyMin: 5 },
  cascade: { gatherS: 10, everyMin: 5 },
  failed: { gatherS: 10, everyMin: 5 },
  warning: { gatherS: 30, everyMin: 60 },
  other: { gatherS: 60, everyMin: 10 },
};

const reportHelp: Record<Reported, string> = {
  refused: 'Events a state node refused (`<id>.refused`, D72)',
  coalesced: 'Sends several nodes shared, which may mean the graph duplicates logic (D73)',
  drift: "A parser's drift, and what it paused (P5)",
  cascade: 'Nodes a runtime stop made inactive (D65)',
  failed: 'Nodes that failed: a crash, a script killed as hung',
  warning: "The graph's warnings at the load (D89)",
  other: 'Notices of any other kind, raised by plugins',
};

const paceSchema = z.object({
  gatherS: z.number().min(0).optional(),
  everyMin: z.number().min(0).optional(),
});

export const ownerNoticeConfig = z.object({
  chat: z
    .string()
    .min(1)
    .describe(
      "The chat it tells the owner in, as its chat edge sends to it: the owner's private chat with the bot (their user id), an IRC nick or #channel"
    ),
  report: z
    .object(
      Object.fromEntries(
        REPORTED.map((k) => [k, z.boolean().default(true).describe(reportHelp[k])])
      ) as Record<Reported, z.ZodDefault<z.ZodBoolean>>
    )
    .default(() => Object.fromEntries(REPORTED.map((k) => [k, true])) as Record<Reported, true>)
    .describe('What it tells, by kind'),
  pace: z
    .object(
      Object.fromEntries(REPORTED.map((k) => [k, paceSchema.optional()])) as Record<
        Reported,
        z.ZodOptional<typeof paceSchema>
      >
    )
    .default(() => structuredClone(DEFAULT_PACE) as Record<Reported, Pace>)
    .describe(
      'Per kind: how many seconds its first notice waits for others (`gatherS`), and the least minutes between two of its messages (`everyMin`); a kind or a field left out keeps its default'
    ),
  maxLines: z
    .number()
    .int()
    .min(1)
    .default(5)
    .describe('The most items one message lists; the rest are counted'),
});
export type OwnerNoticeConfig = z.output<typeof ownerNoticeConfig>;

/** How a kind's message reads: its notices grouped by node, or all as one list. */
interface KindSpec {
  byNode: boolean;
  /** The title of `n` notices (of `node`, when by node). */
  title(n: number, node: string | undefined): string;
  /** One item; items alike are counted once (`×3`). */
  item(notice: Notice): string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const field = (n: Notice, key: string): string => {
  const v = n.detail?.[key];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : '';
};
const after = (text: string, prefix: string): string =>
  text.startsWith(prefix) ? text.slice(prefix.length) : text;

/** The kinds it knows how to word; any other is worded as `other`. */
export const KINDS: Readonly<Record<Reported, KindSpec>> = {
  refused: {
    byNode: true,
    title: (n, node) => `${String(node)} refused ${plural(n, 'event')}`,
    item: (x) => `${field(x, 'event') || '?'}: ${field(x, 'reason')}`,
  },
  coalesced: {
    byNode: true,
    title: (n, node) =>
      `${String(node)} shared ${plural(n, 'send')} with other nodes (the graph may duplicate logic)`,
    item: (x) =>
      `${JSON.stringify(field(x, 'text'))} to ${field(x, 'chat')}, with ${field(x, 'with')}`,
  },
  drift: {
    byNode: false,
    title: (n) => (n === 1 ? 'Drift' : `Drift, ${n} times`),
    item: (x) => x.text,
  },
  cascade: {
    byNode: false,
    title: (n) => `${plural(n, 'node')} made inactive by a stop`,
    item: (x) => `${String(x.node)}: ${field(x, 'reason') || after(x.text, `${String(x.node)} `)}`,
  },
  failed: {
    byNode: false,
    title: (n) => `${plural(n, 'node')} failed`,
    item: (x) => `${String(x.node)}: ${field(x, 'reason') || x.text}`,
  },
  warning: {
    byNode: false,
    title: (n) => `The graph warns (${n})`,
    item: (x) => x.text,
  },
  other: {
    byNode: false,
    title: (n) => plural(n, 'notice'),
    item: (x) => `${x.kind}: ${x.text}`,
  },
};

/** What a notice is told as: its kind, or `other`. */
export const reportedOf = (kind: string): Reported =>
  (REPORTED as readonly string[]).includes(kind) && kind !== 'other' ? (kind as Reported) : 'other';

/** `ms` in the owner's words: `40 s`, `10 min`, `2 h`. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
}

/**
 * One message of a kind's notices (all of one kind), gathered since the first, at `now`: a single
 * notice as its own line; several as a title (by node, when the kind is) with their count and how
 * long they took, and their items, alike ones counted once, at most `maxLines`.
 */
export function wordNotices(
  kind: Reported,
  notices: readonly Notice[],
  now: number,
  maxLines: number
): string {
  const first = notices[0];
  if (first === undefined) return '';
  if (notices.length === 1) return first.text;
  const spec = KINDS[kind];
  const since = now - first.t >= 60_000 ? ` in the last ${span(now - first.t)}` : '';
  const groups = new Map<string | undefined, Notice[]>();
  for (const n of notices) {
    const key = spec.byNode ? n.node : undefined;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  return [...groups]
    .map(([node, group]) => {
      const counts = new Map<string, number>();
      for (const n of group) {
        const item = spec.item(n);
        counts.set(item, (counts.get(item) ?? 0) + 1);
      }
      const items = [...counts].map(([item, c]) => `- ${item}${c > 1 ? ` (×${c})` : ''}`);
      const shown = items.slice(0, maxLines);
      if (items.length > shown.length) shown.push(`- and ${items.length - shown.length} more`);
      return [`${spec.title(group.length, node)}${since}:`, ...shown].join('\n');
    })
    .join('\n');
}

/** A kind's notices waiting to be told, and when it last told. */
interface Pending {
  notices: Notice[];
  timer?: TimerHandle | undefined;
  lastAt?: number;
}

interface DeskOptions {
  clock: Clock;
  pace(kind: Reported): Pace;
  maxLines: number;
  /** Tells one message of a kind, made of `notices`. */
  tell(kind: Reported, text: string, notices: readonly Notice[]): void;
}

/**
 * Its notices gathered by kind and told at each kind's pace: a kind's first notice arms a timer at
 * the later of its gather and its least gap since its last message, which tells all it holds then.
 */
export class NoticeDesk {
  private readonly pending = new Map<Reported, Pending>();
  private readonly o: DeskOptions;

  constructor(options: DeskOptions) {
    this.o = options;
  }

  add(kind: Reported, notice: Notice): void {
    let p = this.pending.get(kind);
    if (p === undefined) this.pending.set(kind, (p = { notices: [] }));
    p.notices.push(notice);
    if (p.timer !== undefined) return;
    const { gatherS, everyMin } = this.o.pace(kind);
    const now = this.o.clock.now();
    const due = Math.max(now + gatherS * 1000, (p.lastAt ?? -Infinity) + everyMin * 60_000);
    p.timer = this.o.clock.setTimeout(() => this.flush(kind), due - now);
  }

  /** Tells what a kind holds now, in one message. */
  flush(kind: Reported): void {
    const p = this.pending.get(kind);
    if (p === undefined) return;
    p.timer = undefined;
    const notices = p.notices.splice(0);
    if (notices.length === 0) return;
    const now = this.o.clock.now();
    p.lastAt = now;
    this.o.tell(kind, wordNotices(kind, notices, now, this.o.maxLines), notices);
  }

  /** Every timer dropped, what waits untold: the node stops. */
  stop(): void {
    for (const p of this.pending.values()) {
      this.o.clock.clearTimeout(p.timer);
      p.timer = undefined;
    }
  }
}

/** Whether a notice is about the node itself: it would tell of its own sends, in a loop. */
function ownNotice(n: Notice, id: string): boolean {
  const others = n.detail?.['with'];
  return n.node === id || (Array.isArray(others) && others.includes(id));
}

/** The owner-notice plugin: one node, or one per place the owner is told. */
export function ownerNoticePlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: OWNER_NOTICE,
      version: '0.1.0',
      kinds: ['stats'],
      description:
        'Tells the owner what needs attention: refused events, coalesced sends, drift, cascades, failures, warnings',
      config: ownerNoticeConfig,
      notices: true,
      outputs: {
        chat: {
          type: 'chat-out',
          help: "The account it tells the owner through: a telegram-bot to the owner's private chat, or irc",
        },
      },
    },
    create: (ctx: PluginContext) => {
      const c = ctx.config as OwnerNoticeConfig;
      const told = new Set(ctx.store.read<string[]>(WARNED_DOC) ?? []);
      const warned: string[] = [];
      let unsubscribe: (() => void) | undefined;
      const desk = new NoticeDesk({
        clock: ctx.clock,
        maxLines: c.maxLines,
        pace: (kind) => {
          const own = c.pace[kind] ?? {};
          return {
            gatherS: own.gatherS ?? DEFAULT_PACE[kind].gatherS,
            everyMin: own.everyMin ?? DEFAULT_PACE[kind].everyMin,
          };
        },
        tell: (kind, text, notices) => {
          ctx.record(`${OWNER_NOTICE}.told`, { kind, count: notices.length, chat: c.chat, text });
          const queued = ctx.outbox('chat').enqueue(c.chat, text);
          void queued.then((r) => {
            if (r.outcome === 'refused' || r.outcome === 'expired' || r.outcome === 'cancelled')
              ctx.log.warn(
                `not told (${r.outcome}${r.reason === undefined ? '' : `: ${r.reason}`}): ${text}`
              );
          });
        },
      });
      const hear = (n: Notice): void => {
        if (ownNotice(n, ctx.id)) return;
        const kind = reportedOf(n.kind);
        if (n.kind === 'warning') {
          warned.push(n.text);
          if (told.has(n.text)) return;
        }
        if (!c.report[kind]) return;
        desk.add(kind, n);
      };
      return {
        start() {
          const notices = ctx.notices;
          if (notices === undefined) throw new Error('no notices: its manifest declares them');
          unsubscribe = notices.subscribe(hear);
          // The load's warnings, heard first: kept, so that the next start tells only new ones.
          ctx.store.write(WARNED_DOC, warned);
        },
        stop() {
          unsubscribe?.();
          unsubscribe = undefined;
          desk.stop();
        },
      };
    },
  });
}
