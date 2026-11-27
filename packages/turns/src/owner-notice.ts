/**
 * The owner's notices, told (docs/bot-os-api.md §5, bot-os.md D91, #40): a node that hears what the
 * core and the plugins raise for the owner's attention (`ctx.notices`, §4.16) and tells the owner,
 * through its `chat` output, in **every chat its edges name** (D97: the edge is its only setting):
 * an edge to a `telegram-bot` and one to `irc` tell both. An edge that names no chat tells its
 * connector's owner's private chat (a `telegram-bot`'s `owner`, D95), which the editor writes on
 * the edge as it is drawn. Its sends are queued as any node's (`enqueue`, D73), so a dry-run edge
 * (a new one is) logs them and sends nothing (D64).
 *
 * **What it tells,** each kind on or off (`report`): the events a state node refused (`refused`,
 * D72), sends several nodes shared (`coalesced`, D73), a parser's drift that paused what acts on it
 * (`drift`, P5), the nodes a runtime stop made inactive (`cascade`, D65), the nodes failed (`failed`:
 * a crash, a script killed as hung, D81, D85, D87), the graph's warnings at the load (`warning`,
 * D89, D90), the nodes the send-queue watchdog paused (`stalled`, D93), the plugins' messages for
 * the owner (`told`, `ctx.notify`, D94), and the kinds plugins raise of their own (`other`).
 *
 * **The only node that reports to a chat** (D94): the core tells no chat itself. A plugin's
 * `ctx.notify` is a `told` notice, which it sends at once, each its own message, never grouped
 * (a plugin's prompt waits for nothing), with its buttons when its chat can run them (a
 * `telegram-bot`'s owner's chat, through its surface); text alone otherwise (IRC). Those heard as
 * the instance starts wait for the start notice's wait, and follow it.
 *
 * **Grouped and paced, per kind** (`pace`): a kind's first notice waits `gatherS` for others of its
 * kind, and two messages of one kind are at least `everyMin` apart; what comes meanwhile goes in
 * the next, one message (`refused 5 events in the last 10 min: …`), listing at most `maxLines`
 * items. A warning already told at the previous start is not told again.
 *
 * **By level** (D171, #90): a notice at or above `level` goes at once, at its kind's pace; one at
 * or above `digest.level` waits for **a digest**, daily at an hour in a time zone (or every
 * `everyMin`), with the summary lines of that level (D92, `ctx.summary`, §4.17), none when nothing
 * qualifies; the rest is dropped, recorded all the same and shown in its view. What waits and when
 * the last went are kept in its store, so that a restart neither loses nor repeats it. Per node,
 * `sources`, or the owner's `/verbose` and `/quiet` (kept in its store, `overrides`), set both
 * thresholds; a node told below the digest's level gets its summary lines every `verboseEveryMin`.
 *
 * **A start notice at each start** (`startNotice`, D92): the release and commit, the nodes running,
 * those that are not and why, and the graph's warnings; the failures and warnings heard before it
 * go in it, not in messages of their own. It is `info`, or `error` when a node failed to start.
 */
import {
  type Answer,
  atLeast,
  type Buttons,
  buttonsOf,
  type Clock,
  definePlugin,
  type InstanceSummary,
  type Level,
  levelOf,
  LEVELS,
  type Notice,
  type Plugin,
  type PluginContext,
  type Request,
  type StateView,
  type TimerHandle,
} from '@megabottron1999/core';
import { z } from 'zod';
import { addDays, localDate, zonedInstant } from './sittings.ts';

export const OWNER_NOTICE = 'owner-notice';

/** The store's document of the warnings told, so that a restart does not tell them again. */
export const WARNED_DOC = 'warned';

/** The store's document of its summaries: when it last sent one, and last looked. */
export const SUMMARY_DOC = 'summary';
export interface SummaryKept {
  /** When it last sent a summary: the next covers what happened since. */
  sentAt?: number;
  /** When it last looked, sent or not: the next look is a cadence later. */
  checkedAt?: number;
}

/** How long after every node has started the start notice waits, for a failure at the start. */
export const START_WAIT_MS = 10_000;

/** The kinds it groups and paces, by name; any other is `other`. */
export const PACED = [
  'refused',
  'coalesced',
  'drift',
  'cascade',
  'failed',
  'stalled',
  'unreachable',
  'warning',
  'other',
] as const;
export type Paced = (typeof PACED)[number];

/** The kinds it tells: those it paces, and the plugins' messages, told at once (`told`). */
export const REPORTED = [...PACED, 'told'] as const;
export type Reported = (typeof REPORTED)[number];

/** How a kind is paced: how long its first notice waits for others, and the least gap. */
export interface Pace {
  gatherS: number;
  everyMin: number;
}

/**
 * Each kind's pace by default: what needs acting on (a failure, a drift, a cascade, a node the
 * watchdog stopped) goes within seconds, at most every 5 minutes; a burst of refusals or coalesced sends within a minute, at
 * most every 10 or 30; the graph's warnings, once at the load.
 */
export const DEFAULT_PACE: Readonly<Record<Paced, Pace>> = {
  refused: { gatherS: 60, everyMin: 10 },
  coalesced: { gatherS: 60, everyMin: 30 },
  drift: { gatherS: 10, everyMin: 5 },
  cascade: { gatherS: 10, everyMin: 5 },
  failed: { gatherS: 10, everyMin: 5 },
  stalled: { gatherS: 10, everyMin: 5 },
  unreachable: { gatherS: 30, everyMin: 10 },
  warning: { gatherS: 30, everyMin: 60 },
  other: { gatherS: 60, everyMin: 10 },
};

const reportHelp: Record<Reported, string> = {
  refused: 'Events a state node refused (`<id>.refused`, D72)',
  coalesced: 'Sends several nodes shared, which may mean the graph duplicates logic (D73)',
  drift: "A parser's drift, and what it paused (P5)",
  cascade: 'Nodes a runtime stop made inactive (D65)',
  failed: 'Nodes that failed: a crash, a script killed as hung',
  stalled: 'Nodes stopped for sending a command again and again with no answer (D93)',
  unreachable:
    'Sends the network refused: a chat the connector cannot reach, such as a person who never started the bot (D95)',
  warning: "The graph's warnings at the load (D89)",
  other:
    'Notices of any other kind: a package or module that failed to load, an error nothing caught (D143), a plugin’s own',
  told: 'The plugins’ messages for the owner (`ctx.notify`), each at once, with its buttons where the chat can run them',
};

/** A notice's level (D171), as its config names one. */
const level = z.enum(LEVELS, { error: `expected a level: ${LEVELS.join(', ')}` });

/** Whether a time zone is one this process knows. */
const knownZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const paceSchema = z.object({
  gatherS: z.number().min(0).optional(),
  everyMin: z.number().min(0).optional(),
});

export const ownerNoticeConfig = z.object({
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
      Object.fromEntries(PACED.map((k) => [k, paceSchema.optional()])) as Record<
        Paced,
        z.ZodOptional<typeof paceSchema>
      >
    )
    .default(() => structuredClone(DEFAULT_PACE) as Record<Paced, Pace>)
    .describe(
      'Per kind: how many seconds its first notice waits for others (`gatherS`), and the least minutes between two of its messages (`everyMin`); a kind or a field left out keeps its default. A plugin’s message (`told`) is not paced: it goes at once'
    ),
  maxLines: z
    .number()
    .int()
    .min(1)
    .default(5)
    .describe('The most items one message lists; the rest are counted'),
  level: level
    .default('warning')
    .describe(
      'What it sends at once: notices of this level and above (debug, info, warning, error); the rest wait for the digest'
    ),
  digest: z
    .object({
      enabled: z.boolean().default(true).describe('A digest of what was not sent at once'),
      level: level
        .default('info')
        .describe('What the digest gathers: notices and summary lines of this level and above'),
      at: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'expected HH:MM, as 09:00')
        .default('09:00')
        .describe('When it goes each day, HH:MM in its timeZone'),
      timeZone: z
        .string()
        .default('UTC')
        .refine(knownZone, 'expected a time zone such as Europe/Rome or America/New_York')
        .describe('The time zone of its hour, and of the times its messages name'),
      everyMin: z
        .number()
        .int()
        .min(1)
        .max(7 * 24 * 60)
        .optional()
        .describe('Instead of once a day at its hour: every so many minutes'),
    })
    .default({ enabled: true, level: 'info', at: '09:00', timeZone: 'UTC' })
    .describe(
      'What waits: the notices below its level, and the plugins’ summary lines, in one message, none when nothing is there'
    ),
  sources: z
    .record(
      z.string().min(1),
      z.object({
        level: level.describe('Both its thresholds, at once and in the digest'),
        until: z.iso.datetime().optional().describe('Until when; none: for good'),
      })
    )
    .default({})
    .describe(
      'Per node: its notices’ thresholds, lower (more from it) or higher (less), as /verbose sets them for a while'
    ),
  verboseEveryMin: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(60)
    .describe(
      'While a node is told below the digest’s level (/verbose), every so many minutes its summary lines alone'
    ),
  summaryEveryMin: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60)
    .optional()
    .describe(
      'Deprecated (D171): read as the digest’s cadence (everyMin); 0 turns the digest off, 60 (the old default) is as if unset'
    ),
  startNotice: z
    .boolean()
    .default(true)
    .describe(
      'A message at each start: the release, the nodes running and those not, the graph’s warnings'
    ),
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
export const KINDS: Readonly<Record<Paced, KindSpec>> = {
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
  stalled: {
    byNode: false,
    title: (n) => `${plural(n, 'node')} stopped: their commands went unanswered`,
    item: (x) => {
      const count = x.detail?.['count'];
      return field(x, 'command') === '' || typeof count !== 'number'
        ? `${String(x.node)}: ${x.text}`
        : `${String(x.node)}: ${field(x, 'command')} to ${field(x, 'chat')}, ${plural(count, 'time')}`;
    },
  },
  unreachable: {
    byNode: false,
    title: (n) => `${plural(n, 'send')} could not reach their chat`,
    item: (x) => x.text,
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

/** What a paced notice is told as: its kind, or `other` (a `told` is not paced). */
export const reportedOf = (kind: string): Paced =>
  (PACED as readonly string[]).includes(kind) && kind !== 'other' ? (kind as Paced) : 'other';

/** `ms` in the owner's words: `40 s`, `10 min`, `2 h`, `2 h 30 min`. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 120) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/**
 * One message of a kind's notices (all of one kind), gathered since the first, at `now`: a single
 * notice as its own line; several as a title (by node, when the kind is) with their count and how
 * long they took, and their items, alike ones counted once, at most `maxLines`.
 */
export function wordNotices(
  kind: Paced,
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
  /** When its timer tells what it holds. */
  dueAt?: number | undefined;
  lastAt?: number;
}

/** What the desk holds, for the node's view: the notices waiting by kind, and its last tells. */
export interface DeskView {
  waiting: Partial<Record<Paced, { count: number; dueAt: number }>>;
  lastTold: Partial<Record<Reported, number>>;
}

interface DeskOptions {
  clock: Clock;
  pace(kind: Paced): Pace;
  maxLines: number;
  /** Tells one message of a kind, made of `notices`. */
  tell(kind: Paced, text: string, notices: readonly Notice[]): void;
}

/**
 * Its notices gathered by kind and told at each kind's pace: a kind's first notice arms a timer at
 * the later of its gather and its least gap since its last message, which tells all it holds then.
 */
export class NoticeDesk {
  private readonly pending = new Map<Paced, Pending>();
  private readonly o: DeskOptions;

  constructor(options: DeskOptions) {
    this.o = options;
  }

  add(kind: Paced, notice: Notice): void {
    let p = this.pending.get(kind);
    if (p === undefined) this.pending.set(kind, (p = { notices: [] }));
    p.notices.push(notice);
    if (p.timer !== undefined) return;
    const { gatherS, everyMin } = this.o.pace(kind);
    const now = this.o.clock.now();
    const due = Math.max(now + gatherS * 1000, (p.lastAt ?? -Infinity) + everyMin * 60_000);
    p.dueAt = due;
    p.timer = this.o.clock.setTimeout(() => this.flush(kind), due - now);
  }

  /** What waits, by kind, and when each kind last told. */
  view(): DeskView {
    const v: DeskView = { waiting: {}, lastTold: {} };
    for (const [kind, p] of this.pending) {
      if (p.notices.length > 0 && p.dueAt !== undefined)
        v.waiting[kind] = { count: p.notices.length, dueAt: p.dueAt };
      if (p.lastAt !== undefined) v.lastTold[kind] = p.lastAt;
    }
    return v;
  }

  /** Tells what a kind holds now, in one message. */
  flush(kind: Paced): void {
    const p = this.pending.get(kind);
    if (p === undefined) return;
    p.timer = p.dueAt = undefined;
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
      p.timer = p.dueAt = undefined;
    }
  }
}

/** A section's lines, as a message words them: one on the title's line, several listed. */
function wordSection(title: string, lines: readonly string[], maxLines: number): string[] {
  if (lines.length === 1) return [`${title}: ${String(lines[0])}`];
  const shown = lines.slice(0, maxLines).map((l) => `- ${l}`);
  if (lines.length > maxLines) shown.push(`- and ${lines.length - maxLines} more`);
  return [`${title}:`, ...shown];
}

/** The digest as it runs (D171): its config, with a saved `summaryEveryMin` read into it. */
export interface DigestPlan {
  enabled: boolean;
  level: Level;
  /** Minutes after midnight, in its time zone, when it goes each day. */
  atMin: number;
  timeZone: string;
  /** Instead of once a day: every so many minutes. */
  everyMin?: number;
}

/**
 * The digest a config asks for (D171): its `digest`, a saved `summaryEveryMin` (the summary it
 * replaces) read into it: `0`, none; `60`, the old default an editor wrote out, as if unset (the
 * daily digest); any other, its cadence, unless the digest names one.
 */
export function digestOf(c: Pick<OwnerNoticeConfig, 'digest' | 'summaryEveryMin'>): DigestPlan {
  const d = c.digest;
  const [h = 0, m = 0] = d.at.split(':').map(Number);
  const old = c.summaryEveryMin;
  const everyMin = d.everyMin ?? (old === undefined || old === 0 || old === 60 ? undefined : old);
  return {
    enabled: d.enabled && old !== 0,
    level: d.level,
    atMin: h * 60 + m,
    timeZone: d.timeZone,
    ...(everyMin === undefined ? {} : { everyMin }),
  };
}

/** When the digest next goes after `from`: its cadence on, or the next day's hour. */
export function nextDigest(from: number, d: DigestPlan): number {
  if (d.everyMin !== undefined) return from + d.everyMin * 60_000;
  const day = localDate(from, d.timeZone);
  const today = zonedInstant(day, d.atMin, d.timeZone);
  return today > from ? today : zonedInstant(addDays(day, 1), d.atMin, d.timeZone);
}

/** A time in the owner's words, in its zone: `27 Nov 2026, 14:30 (America/New_York)`. */
export function when(t: number, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);
  return `${text} (${timeZone})`;
}

/** A duration as `/verbose` takes it, `30m`, `2h`, `1d`, `1h30m`, in ms; undefined for none. */
export function durationOf(text: string): number | undefined {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/u.exec(text.trim().toLowerCase());
  if (m === null || m.slice(1).every((x) => x === undefined)) return undefined;
  const [d = 0, h = 0, min = 0] = m.slice(1).map((x) => Number(x ?? 0));
  const ms = ((d * 24 + h) * 60 + min) * 60_000;
  return ms > 0 ? ms : undefined;
}

/** The store's document of the overrides `/verbose` set (D171), by node. */
export const OVERRIDES_DOC = 'overrides';
/** A node's override: both its thresholds, until when (none: until `/quiet`). */
export interface Override {
  level: Level;
  until?: number;
}

/**
 * The store's document of the digest's waiting notices (D171), the latest `DIGEST_KEPT`, and how
 * many older ones were not kept.
 */
export const DIGEST_DOC = 'digest';
export const DIGEST_KEPT = 500;
/** A notice waiting for the digest, as kept. */
export interface Waiting {
  kind: string;
  level: Level;
  t: number;
  node?: string;
  text: string;
  detail?: Readonly<Record<string, unknown>>;
}
export interface DigestKept {
  waiting: Waiting[];
  dropped: number;
}

/**
 * A digest (D171): its window, the notices that waited by kind (a kind's several as one message
 * would word them), how many older ones were not kept, then the summary's lines at its level.
 */
export function wordDigest(
  waiting: readonly Waiting[],
  dropped: number,
  sections: readonly { title: string; lines: readonly string[] }[],
  window: { since: number; until: number; sinceStart: boolean },
  maxLines: number
): string {
  const head = window.sinceStart
    ? `Digest since the start, ${span(window.until - window.since)} ago:`
    : `Digest of the last ${span(window.until - window.since)}:`;
  const byKind = new Map<string, Waiting[]>();
  for (const w of waiting) byKind.set(w.kind, [...(byKind.get(w.kind) ?? []), w]);
  const notices = [...byKind].map(([kind, list]) => {
    if (kind === 'start') {
      const last = list.at(-1) as Waiting;
      const line = last.text.split('\n')[0] ?? '';
      return list.length === 1 ? line : `Started ${list.length} times, last: ${line}`;
    }
    if (kind === 'override') return list.map((w) => w.text).join('\n');
    const asNotices = list.map((w) => ({ ...w })) as Notice[];
    return wordNotices(reportedOf(kind), asNotices, window.until, maxLines);
  });
  return [
    head,
    ...notices,
    ...(dropped > 0 ? [`And ${plural(dropped, 'older notice')} not kept`] : []),
    ...sections.flatMap((s) => wordSection(s.title, s.lines, maxLines)),
  ].join('\n');
}

/** What a start notice says of the graph's warnings: those new, and those told before. */
export interface StartWarnings {
  fresh: readonly string[];
  told: number;
}

/**
 * A start notice: the release and commit, the nodes running (at most `maxLines` named), those not
 * with their state and why, and the graph's warnings, the new ones listed.
 */
export function wordStart(
  instance: InstanceSummary,
  warnings: StartWarnings | undefined,
  maxLines: number
): string {
  const commit = instance.commit === undefined ? '' : ` (${instance.commit.slice(0, 7)})`;
  const out = [instance.version === undefined ? 'Started' : `Started ${instance.version}${commit}`];
  const running = instance.nodes.filter((n) => n.state === 'running').map((n) => n.id);
  const named = running.slice(0, maxLines);
  if (running.length > maxLines) named.push(`and ${running.length - maxLines} more`);
  out.push(
    running.length === 0
      ? 'No node running'
      : `${plural(running.length, 'node')} running: ${named.join(', ')}`
  );
  const down = instance.nodes
    .filter((n) => n.state !== 'running')
    .map((n) => `${n.id}: ${n.state}${n.reason === undefined ? '' : ` (${n.reason})`}`);
  if (down.length > 0) out.push(...wordSection('Not running', down, maxLines));
  if (warnings !== undefined && warnings.fresh.length > 0)
    out.push(
      ...wordSection(
        `The graph warns (${warnings.fresh.length} new${warnings.told > 0 ? `, ${warnings.told} told before` : ''})`,
        warnings.fresh,
        maxLines
      )
    );
  else if (warnings !== undefined && warnings.told > 0)
    out.push(`The graph warns of ${plural(warnings.told, 'thing')} told before`);
  return out.join('\n');
}

/** A message of its that did not go to a chat (D95), for its panel. */
interface NotSent {
  t: number;
  account: string;
  chat: string;
  reason: string;
}

/** Whether a notice is about the node itself: it would tell of its own sends, in a loop. */
function ownNotice(n: Notice, id: string): boolean {
  const others = n.detail?.['with'];
  return n.node === id || (Array.isArray(others) && others.includes(id));
}

/** How many recent notices its view shows, of every level. */
export const RECENT_KEPT = 100;

/** What became of a notice it heard (D171): sent at once, kept for the digest, or neither. */
export type Fate = 'sent' | 'digest' | 'dropped';

/** What its view shows (bot-os.md D72): the state its schema describes, for the viewer's labels. */
const viewState = z.object({
  levels: z
    .object({
      now: z.string().describe('Sent at once'),
      digest: z.string().describe('In the digest'),
      digestNext: z.number().optional().describe('Next digest'),
    })
    .describe('Levels (D171)'),
  overrides: z
    .array(
      z.object({
        node: z.string().describe('Node'),
        level: z.string().describe('Level'),
        until: z.number().optional().describe('Until'),
        from: z.string().describe('Set by'),
      })
    )
    .describe('Per node'),
  recent: z
    .array(
      z.object({
        t: z.number().describe('When'),
        level: z.string().describe('Level'),
        kind: z.string().describe('Kind'),
        node: z.string().optional().describe('Node'),
        text: z.string().describe('Notice'),
        fate: z.string().describe('Then'),
      })
    )
    .describe('Recent notices, every level, newest first'),
  waiting: z
    .object(
      Object.fromEntries(
        PACED.map((k) => [
          k,
          z
            .object({
              count: z.number().describe('Notices'),
              dueAt: z.number().describe('Told at'),
            })
            .optional(),
        ])
      )
    )
    .describe('Waiting to be told'),
  lastTold: z
    .object(Object.fromEntries(REPORTED.map((k) => [k, z.number().optional()])))
    .describe('Last told, by kind'),
  startNotice: z.enum(['waiting', 'sent', 'off']).describe('Start notice'),
  digest: z
    .object({
      waiting: z.number().describe('Notices waiting'),
      sentAt: z.number().optional().describe('Last sent'),
      checkedAt: z.number().optional().describe('Last looked'),
    })
    .describe('Digest'),
  warnings: z.array(z.string()).describe("The graph's warnings at this start"),
  notSent: z
    .array(
      z.object({
        t: z.number().describe('When'),
        account: z.string().describe('Account'),
        chat: z.string().describe('Chat'),
        reason: z.string().describe('Why'),
      })
    )
    .optional()
    .describe(
      'Its last message not sent, per chat (D95): its own failures are never told, only shown here'
    ),
});
const VIEW_SCHEMA = z.toJSONSchema(viewState, { io: 'output', unrepresentable: 'any' });

/** The owner-notice plugin: one node, or one per place the owner is told. */
export function ownerNoticePlugin(): Plugin {
  return definePlugin({
    manifest: {
      id: OWNER_NOTICE,
      kinds: ['stats'],
      description:
        'The one node that reports to a chat: what needs the owner’s attention at once (warnings and errors by default), the rest in a daily digest, the plugins’ messages with their buttons, and a notice at each start',
      config: ownerNoticeConfig,
      notices: true,
      summary: true,
      outputs: {
        chat: {
          type: 'chat-out',
          // An edge per connector, each telling the chats it names; none named, the owner's.
          many: true,
          owner: true,
          help: "The accounts it tells the owner through, each in the chats its edge names: a telegram-bot (no chat named: the owner's private chat), irc",
        },
      },
      interface: {
        commands: {
          notices: {
            help: 'What it sends at once and what waits for the digest, each node set apart, and the next digest',
            owner: true,
          },
          verbose: {
            help: 'Sends a node’s notices from a lower level (debug by default), for a while if given: /verbose lore-state info for 2h',
            args: '<node> [debug|info|warning|error] [for <30m|2h|1d>]',
            owner: true,
          },
          quiet: {
            help: 'Ends what /verbose set for a node',
            args: '<node>',
            owner: true,
          },
        },
      },
    },
    create: (ctx: PluginContext) => {
      const c = ctx.config as OwnerNoticeConfig;
      const plan = digestOf(c);
      const told = new Set(ctx.store.read<string[]>(WARNED_DOC) ?? []);
      const warned: string[] = [];
      let unsubscribe: (() => void) | undefined;
      /** The failures and warnings heard before the start notice, which it tells; none once sent. */
      let atStart: Notice[] | undefined = c.startNotice ? [] : undefined;
      let startTimer: TimerHandle | undefined;
      let digestTimer: TimerHandle | undefined;
      let digestDueAt: number | undefined;
      let verboseTimer: TimerHandle | undefined;
      let verboseSince: number | undefined;
      let expiryTimer: TimerHandle | undefined;
      /** When it last told the owner anything. */
      let toldAt: number | undefined;
      /** When it last told a plugin's message. */
      let lastToldNow: number | undefined;
      /** The plugins' messages heard as the instance starts, told after the start's wait. */
      let held: Notice[] | undefined = [];
      let kept: SummaryKept = ctx.store.read<SummaryKept>(SUMMARY_DOC) ?? {};
      const digestKept = ctx.store.read<DigestKept>(DIGEST_DOC) ?? { waiting: [], dropped: 0 };
      const overrides = new Map(
        Object.entries(ctx.store.read<Record<string, Override>>(OVERRIDES_DOC) ?? {})
      );
      /** The overrides whose end the digest has said, so that it says each once. */
      const ended = new Set<string>();
      const recent: (Waiting & { fate: Fate })[] = [];
      const summary = (): NonNullable<PluginContext['summary']> => {
        if (ctx.summary === undefined) throw new Error('no summary: its manifest declares it');
        return ctx.summary;
      };
      const now = (): number => ctx.clock.now();
      /** The graph's override of a node, while it runs: its `sources` entry, until its end. */
      const sourceOf = (node: string): Override | undefined => {
        const s = Object.hasOwn(c.sources, node) ? c.sources[node] : undefined;
        if (s === undefined) return undefined;
        const until = s.until === undefined ? undefined : Date.parse(s.until);
        return until !== undefined && until <= now()
          ? undefined
          : { level: s.level, ...(until === undefined ? {} : { until }) };
      };
      /** A node's override in force: a command's, else the graph's. */
      const overrideOf = (node: string | undefined): Override | undefined => {
        if (node === undefined) return undefined;
        const o = overrides.get(node);
        return o !== undefined && (o.until === undefined || o.until > now()) ? o : sourceOf(node);
      };
      /** A notice's thresholds, at once and in the digest: its node's override's, else the config's. */
      const thresholds = (node: string | undefined): { now: Level; digest: Level } => {
        const o = overrideOf(node);
        return o === undefined
          ? { now: c.level, digest: plan.level }
          : { now: o.level, digest: o.level };
      };
      /**
       * Its last message that did not go, per account and chat, for its panel and card (D95): never
       * told, no loop; the chat's next message that goes clears it. `''`: it had nowhere to send.
       */
      const notSent = new Map<string, NotSent>();
      /**
       * One message, through its single send path, to every chat its edges name (D97): queued, so
       * that a dry-run edge sends nothing.
       */
      const send = (kind: string, text: string, count: number, buttons?: Buttons): void => {
        const outs = ctx.outboxes('chat');
        // Each edge's chats; one that names none, its connector's owner's (a telegram-bot's).
        const targets = outs.flatMap((out) => out.chats().map((chat) => ({ out, chat })));
        if (targets.length === 0) {
          const reason =
            outs.length === 0
              ? 'no edge: draw one from its chat output to a connector'
              : 'no chat: name one on its edge (its connector has no owner)';
          notSent.set('', { t: now(), account: '', chat: '', reason });
          ctx.log.warn(`not told (${reason}): ${text}`);
          return;
        }
        notSent.delete('');
        toldAt = now();
        for (const { out, chat } of targets) {
          ctx.record(`${OWNER_NOTICE}.told`, { kind, count, chat, text });
          const key = `${out.account} ${chat}`;
          const queued = out.enqueue(chat, text, buttons === undefined ? undefined : { buttons });
          void queued.then((r) => {
            if (r.outcome === 'sent' || r.outcome === 'dry-run') {
              notSent.delete(key);
              return;
            }
            const reason = r.reason === undefined ? r.outcome : `${r.outcome}: ${r.reason}`;
            if (r.outcome !== 'cancelled')
              notSent.set(key, { t: now(), account: out.account, chat, reason });
            ctx.log.warn(`not told in ${chat} (${reason}): ${text}`);
          });
        }
      };
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
        tell: (kind, text, notices) => send(kind, text, notices.length),
      });
      /** A notice kept for the digest (D171), the latest `DIGEST_KEPT`, the older counted. */
      const keep = (w: Waiting): void => {
        digestKept.waiting.push(w);
        while (digestKept.waiting.length > DIGEST_KEPT) {
          digestKept.waiting.shift();
          digestKept.dropped += 1;
        }
        ctx.store.write(DIGEST_DOC, digestKept);
      };
      const waitingOf = (n: Notice): Waiting => ({
        kind: n.kind,
        level: levelOf(n),
        t: n.t,
        ...(n.node === undefined ? {} : { node: n.node }),
        text: n.text,
        ...(n.detail === undefined ? {} : { detail: n.detail }),
      });
      /** What it heard, for its view, newest first. */
      const saw = (w: Waiting, fate: Fate): void => {
        recent.unshift({ ...w, fate });
        recent.length = Math.min(recent.length, RECENT_KEPT);
      };
      /** A plugin's message, at once, with its buttons; none while the instance is off (P8). */
      const tellNow = (n: Notice): void => {
        if (ctx.off()) return;
        lastToldNow = now();
        send('told', n.text, 1, buttonsOf(n));
      };
      /**
       * Where a notice goes by its level (D171): at once at or above its node's threshold, into the
       * digest at or above the digest's, nowhere below.
       */
      const route = (n: Notice): Fate => {
        const level = levelOf(n);
        const t = thresholds(n.node);
        if (atLeast(level, t.now)) return 'sent';
        return plan.enabled && atLeast(level, t.digest) ? 'digest' : 'dropped';
      };
      const hear = (n: Notice): void => {
        if (ownNotice(n, ctx.id)) return;
        sweep();
        const w = waitingOf(n);
        if (n.kind === 'told') {
          if (!c.report.told) return saw(w, 'dropped');
          const fate = route(n);
          saw(w, fate);
          if (fate === 'digest') keep(w);
          if (fate !== 'sent') return;
          if (held !== undefined) held.push(n);
          else tellNow(n);
          return;
        }
        const kind = reportedOf(n.kind);
        if (n.kind === 'warning') warned.push(n.text);
        // Before the start notice, a failure or a warning is its news, not a message of its own.
        if (atStart !== undefined && (n.kind === 'failed' || n.kind === 'warning')) {
          atStart.push(n);
          return saw(w, 'sent');
        }
        if (n.kind === 'warning' && told.has(n.text)) return saw(w, 'dropped');
        if (!c.report[kind]) return saw(w, 'dropped');
        const fate = route(n);
        saw(w, fate);
        if (fate === 'sent') desk.add(kind, n);
        else if (fate === 'digest') keep(w);
      };
      /** The start's wait is over: the start notice, then the plugins' messages held meanwhile. */
      const afterStart = (): void => {
        startTimer = undefined;
        if (atStart !== undefined) tellStart();
        const waiting = held ?? [];
        held = undefined;
        for (const n of waiting) tellNow(n);
      };
      /**
       * The start notice (D171): an error, sent at once, when an enabled node failed or did not
       * load; else info, which the digest holds.
       */
      const tellStart = (): void => {
        const heard = atStart ?? [];
        atStart = undefined;
        const texts = [...new Set(heard.filter((n) => n.kind === 'warning').map((n) => n.text))];
        const warnings = c.report.warning
          ? {
              fresh: texts.filter((w) => !told.has(w)),
              told: texts.filter((w) => told.has(w)).length,
            }
          : undefined;
        const instance = summary().instance();
        const text = wordStart(instance, warnings, c.maxLines);
        const failed = instance.nodes.some((n) => n.state === 'failed' || n.state === 'unloaded');
        const n: Notice = { kind: 'start', t: now(), level: failed ? 'error' : 'info', text };
        const fate = route(n);
        saw(waitingOf(n), fate);
        if (fate === 'sent') send('start', text, 1);
        else if (fate === 'digest') keep(waitingOf(n));
      };
      /** The summary's lines in a window, each section at its node's digest level (D171). */
      const linesIn = (
        window: { since: number; until: number },
        at: (node: string | undefined) => Level | undefined
      ): { title: string; lines: string[] }[] =>
        summary()
          .collect(window)
          .flatMap((sec) => {
            const min = at(sec.node);
            if (min === undefined) return [];
            const lines = sec.lines.filter((l) => atLeast(l.level, min)).map((l) => l.text);
            return lines.length === 0 ? [] : [{ title: sec.title, lines }];
          });
      /** The digest (D171): what waited, and the summary's lines at its level; none when empty. */
      const tellDigest = (): void => {
        sweep();
        const at = now();
        const startedAt = summary().instance().startedAt ?? at;
        const since = Math.max(kept.sentAt ?? startedAt, startedAt);
        const window = { since, until: at };
        const sections = linesIn(window, (node) => thresholds(node).digest);
        const waiting = digestKept.waiting.splice(0);
        const dropped = digestKept.dropped;
        digestKept.dropped = 0;
        if (waiting.length > 0 || dropped > 0 || sections.length > 0) {
          send(
            'digest',
            wordDigest(
              waiting,
              dropped,
              sections,
              { ...window, sinceStart: (kept.sentAt ?? -Infinity) < startedAt },
              c.maxLines
            ),
            waiting.length + sections.length
          );
          kept = { sentAt: at, checkedAt: at };
        } else kept = { ...kept, checkedAt: at };
        ctx.store.write(DIGEST_DOC, digestKept);
        ctx.store.write(SUMMARY_DOC, kept);
        armDigest(at);
      };
      const armDigest = (from: number): void => {
        ctx.clock.clearTimeout(digestTimer);
        digestTimer = undefined;
        digestDueAt = undefined;
        if (!plan.enabled) return;
        const due = nextDigest(from, plan);
        digestDueAt = due;
        digestTimer = ctx.clock.setTimeout(tellDigest, Math.max(0, due - now()));
      };
      /** The nodes told below the digest's level (`/verbose`): their summary lines on a short cadence. */
      const verboseNodes = (): [string, Level][] => {
        const nodes = new Set([...overrides.keys(), ...Object.keys(c.sources)]);
        return [...nodes].flatMap((node): [string, Level][] => {
          const o = overrideOf(node);
          return o !== undefined && !atLeast(o.level, plan.level) ? [[node, o.level]] : [];
        });
      };
      /** A short report of the verbose nodes' summary lines (D171), every `verboseEveryMin`. */
      const tellVerbose = (): void => {
        verboseTimer = undefined;
        sweep();
        const nodes = new Map(verboseNodes());
        if (nodes.size === 0) {
          verboseSince = undefined;
          return;
        }
        const at = now();
        const since = verboseSince ?? at - c.verboseEveryMin * 60_000;
        const sections = linesIn({ since, until: at }, (node) =>
          node === undefined ? undefined : nodes.get(node)
        );
        verboseSince = at;
        if (sections.length > 0)
          send(
            'verbose',
            [
              `Detail of ${[...nodes.keys()].join(', ')}, the last ${span(at - since)}:`,
              ...sections.flatMap((sec) => wordSection(sec.title, sec.lines, c.maxLines)),
            ].join('\n'),
            sections.length
          );
        armVerbose();
      };
      const armVerbose = (): void => {
        if (verboseTimer !== undefined || verboseNodes().length === 0) return;
        verboseSince ??= now();
        verboseTimer = ctx.clock.setTimeout(tellVerbose, c.verboseEveryMin * 60_000);
      };
      /**
       * The overrides that ended (D171): each said once in the digest (`lore-state back to
       * warning`), a command's taken out of the store; then a timer at the next end.
       */
      const sweep = (): void => {
        const at = now();
        let changed = false;
        const ends = (node: string, until: number | undefined): void => {
          if (until === undefined || until > at || ended.has(`${node} ${until}`)) return;
          ended.add(`${node} ${until}`);
          const o = overrideOf(node);
          keep({
            kind: 'override',
            level: 'info',
            t: until,
            node,
            text: `${node} back to ${o === undefined ? c.level : o.level}`,
          });
        };
        for (const [node, o] of [...overrides]) {
          if (o.until === undefined || o.until > at) continue;
          overrides.delete(node);
          changed = true;
          ends(node, o.until);
        }
        for (const [node, s] of Object.entries(c.sources))
          if (s.until !== undefined) ends(node, Date.parse(s.until));
        if (changed) ctx.store.write(OVERRIDES_DOC, Object.fromEntries(overrides));
        ctx.clock.clearTimeout(expiryTimer);
        expiryTimer = undefined;
        const next = [
          ...[...overrides.values()].map((o) => o.until),
          ...Object.values(c.sources).map((s) =>
            s.until === undefined ? undefined : Date.parse(s.until)
          ),
        ]
          .filter((u): u is number => u !== undefined && u > at)
          .sort((a, b) => a - b)[0];
        if (next !== undefined) expiryTimer = ctx.clock.setTimeout(sweep, next - at);
      };
      const zone = plan.timeZone;
      /** The levels, the overrides and the next digest, as `/notices` says them. */
      const levelsText = (): string => {
        sweep();
        const lines = [
          `At once: ${c.level} and above.`,
          plan.enabled
            ? `Digest: ${plan.level} and above, ${
                plan.everyMin === undefined
                  ? `daily at ${c.digest.at} (${zone})`
                  : `every ${span(plan.everyMin * 60_000)}`
              }; next ${digestDueAt === undefined ? 'not planned' : when(digestDueAt, zone)}.`
            : 'Digest: off.',
        ];
        const nodes = [...new Set([...overrides.keys(), ...Object.keys(c.sources)])].sort();
        const set = nodes.flatMap((node) => {
          const o = overrideOf(node);
          if (o === undefined) return [];
          const by = overrides.has(node) ? '/verbose' : 'the graph';
          return [
            `- ${node}: ${o.level}${o.until === undefined ? '' : ` until ${when(o.until, zone)}`} (${by})`,
          ];
        });
        if (set.length > 0) lines.push('Per node:', ...set);
        const verbose = verboseNodes();
        if (verbose.length > 0)
          lines.push(
            `Detail of ${verbose.map(([n]) => n).join(', ')} every ${span(c.verboseEveryMin * 60_000)}.`
          );
        return lines.join('\n');
      };
      const nodeIds = (): string[] =>
        summary()
          .instance()
          .nodes.map((n) => n.id);
      const commands = {
        notices: { run: async (answer: Answer) => answer.text(levelsText()) },
        verbose: {
          run: async (answer: Answer, request: Request) => {
            const words = request.args.split(/\s+/u).filter((w) => w !== '');
            const [node, ...rest] = words;
            if (node === undefined)
              return answer.text('Which node? /verbose <node> [level] [for <duration>]');
            if (!nodeIds().includes(node)) return answer.text(`No node ${node}.`);
            let lvl: Level = 'debug';
            let ms: number | undefined;
            for (let i = 0; i < rest.length; i++) {
              const w = (rest[i] as string).toLowerCase();
              if ((LEVELS as readonly string[]).includes(w)) lvl = w as Level;
              else if (w === 'for') {
                ms = durationOf(rest[i + 1] ?? '');
                if (ms === undefined)
                  return answer.text(
                    `Not a duration: ${rest[i + 1] ?? '(none)'}. Say 30m, 2h, 1d or 1h30m.`
                  );
                i++;
              } else
                return answer.text(
                  `Not a level or a duration: ${w}. Levels: ${LEVELS.join(', ')}; a duration: for 2h.`
                );
            }
            const until = ms === undefined ? undefined : now() + ms;
            overrides.set(node, { level: lvl, ...(until === undefined ? {} : { until }) });
            ctx.store.write(OVERRIDES_DOC, Object.fromEntries(overrides));
            sweep();
            armVerbose();
            const detail = atLeast(lvl, plan.level)
              ? ''
              : ` Its summary lines every ${span(c.verboseEveryMin * 60_000)}.`;
            return answer.text(
              `${node}: ${lvl} and above at once, ${
                until === undefined ? 'until /quiet' : `until ${when(until, zone)}`
              }.${detail}`
            );
          },
        },
        quiet: {
          run: async (answer: Answer, request: Request) => {
            const node = request.args.trim();
            if (node === '') return answer.text('Which node? /quiet <node>');
            const had = overrides.delete(node);
            ctx.store.write(OVERRIDES_DOC, Object.fromEntries(overrides));
            sweep();
            const graph = sourceOf(node);
            const back = graph === undefined ? c.level : graph.level;
            return answer.text(
              had
                ? `${node} back to ${back}${graph === undefined ? '' : ' (the graph’s sources)'}.`
                : graph === undefined
                  ? `${node} has no /verbose set.`
                  : `${node} has no /verbose set; the graph’s sources keep it at ${graph.level}.`
            );
          },
        },
      };
      /** What it holds now, for the node panel's viewer and its card (D72). */
      const view = (): StateView => ({
        schema: VIEW_SCHEMA,
        state: {
          levels: {
            now: c.level,
            digest: plan.enabled ? plan.level : 'off',
            ...(digestDueAt === undefined ? {} : { digestNext: digestDueAt }),
          },
          overrides: [...new Set([...overrides.keys(), ...Object.keys(c.sources)])].flatMap(
            (node) => {
              const o = overrideOf(node);
              return o === undefined
                ? []
                : [
                    {
                      node,
                      level: o.level,
                      ...(o.until === undefined ? {} : { until: o.until }),
                      from: overrides.has(node) ? '/verbose' : 'graph',
                    },
                  ];
            }
          ),
          recent: recent.map(({ detail: _, ...r }) => r),
          ...desk.view(),
          ...(lastToldNow === undefined
            ? {}
            : { lastTold: { ...desk.view().lastTold, told: lastToldNow } }),
          startNotice: atStart !== undefined ? 'waiting' : c.startNotice ? 'sent' : 'off',
          digest: { waiting: digestKept.waiting.length, ...kept },
          warnings: warned,
          ...(notSent.size === 0 ? {} : { notSent: [...notSent.values()] }),
        },
        ...(toldAt === undefined ? {} : { updatedAt: toldAt }),
        pin: ['notSent', 'waiting', 'recent'],
      });
      /** Its card's line: the notices waiting to be told, if any. */
      const waitingLine = (): string | undefined => {
        const n = Object.values(desk.view().waiting).reduce((sum, w) => sum + w.count, 0);
        const waiting = n === 0 ? undefined : `${n} ${n === 1 ? 'notice' : 'notices'} waiting`;
        const last = [...notSent.values()].sort((a, b) => b.t - a.t)[0];
        const failed =
          last === undefined
            ? undefined
            : notSent.size === 1
              ? `not sent${last.chat === '' ? '' : ` to ${last.chat}`}: ${last.reason}`
              : `not sent to ${notSent.size} chats, last ${last.chat}: ${last.reason}`;
        return [failed, waiting].filter((x) => x !== undefined).join('; ') || undefined;
      };
      return {
        start() {
          const notices = ctx.notices;
          if (notices === undefined) throw new Error('no notices: its manifest declares them');
          unsubscribe = notices.subscribe(hear);
          // The load's warnings, heard first: kept, so that the next start tells only new ones.
          ctx.store.write(WARNED_DOC, warned);
          // The next digest after the last look, kept across a restart; one missed, in a minute.
          const at = now();
          if (plan.enabled) {
            const due = nextDigest(kept.checkedAt ?? at, plan);
            digestDueAt = due > at ? due : at + 60_000;
            digestTimer = ctx.clock.setTimeout(tellDigest, digestDueAt - at);
          }
          sweep();
          armVerbose();
        },
        ready() {
          // Every node has started: what the start notice says, once a failure at the start is in,
          // and the plugins' messages held, once its connector has had the time to connect.
          startTimer = ctx.clock.setTimeout(afterStart, START_WAIT_MS);
        },
        stop() {
          unsubscribe?.();
          unsubscribe = undefined;
          desk.stop();
          for (const t of [startTimer, digestTimer, verboseTimer, expiryTimer])
            ctx.clock.clearTimeout(t);
          startTimer = digestTimer = verboseTimer = expiryTimer = digestDueAt = undefined;
        },
        commands,
        view: { read: view, summary: waitingLine },
      };
    },
  });
}
