/**
 * Each command's readiness, reduced from its parser's events (docs/bot-os-api.md §5, bot-os.md
 * D141): when each of a bot's commands may be played again, whether it is unlocked, whether a
 * reset ended its wait. A parser says what its bot said (its sends, its answers, the waits they
 * state, what they announce); the game's **mechanics**, declared here, say what that means:
 *
 * - a **cooldown** (`cooldownMin`): held that long after a success;
 * - an **announced unlock** (`unlock`): held from the start and after each success, until the bot
 *   announces it (its parser's `unlocks`: a message matching its vocabulary's `announcedBy`, or a
 *   reading naming it), for `forMin` minutes if given;
 * - a **reset at set times** (`resetsAt`): held after a success until the next of some wall-clock
 *   times of day in a time zone (a shop whose items change at midnight), whoever's use it was;
 * - **effects** (`effects`): at its success, another command's hold ended (`clear`, a reset) or
 *   shortened (`shortenMin`); the turn's hold is the bot's rest;
 * - **interactive** (`interactive: true`): it needs the person to answer or choose (a minigame, a
 *   shop), which a player cannot play blindly; a fact for the player and the editor, tracked as any
 *   other.
 *
 * `ReadinessModel` is the reusable reducer: its section (`readiness`) of a state, kept as any state
 * plugin keeps its state (`src/state-plugin.ts`: in its store, caught up from the event log after a
 * restart), its pure `reduce` of the parser's events, and `ready`, each command's readiness now. A
 * game's state plugin takes it (`StateSpec.readiness`) and folds the facts it knows besides (a ban,
 * a resource spent) into the section with the model's own steps (`hold`, `succeed`, `unlock`,
 * `lock`), in its reducer; `readinessPlugin` (`src/state-plugin.ts`) is the generic state for a
 * game with none. Either
 * offers the contract a player binds to (`READINESS_MEMBERS`): `state.ready`, `state.commands`,
 * `state.bot`, and `actions.sent`, which it hands to its parser to pair the send's answer.
 */
import { type BotCommand, type BusEvent } from '@megabottron1999/core';
import { z } from 'zod';
import { addDays, clockMinutes, localDate, zonedInstant } from '#src/sittings.ts';
import {
  type BotVocabulary,
  type CommandEffect,
  commandOf,
  type SentCommand,
  type TurnOutcome,
  vocabularyCommands,
  vocabularyProblem,
} from '#src/turn-parser.ts';

/**
 * A command's mechanics, as its game declares them on its state's side (bot-os.md D132, D141):
 * data, in generic terms, from which its readiness is reduced.
 */
export interface CommandMechanics {
  /** Usable once per period after a success, in minutes (a daily command's: 1440). */
  cooldownMin?: number;
  /**
   * Usable only once announced: held from the start and after each success, until its parser
   * publishes it in `unlocks`; then for `forMin` minutes if given, else until its next success.
   */
  unlock?: { forMin?: number };
  /**
   * Usable again at set wall-clock times (D165): after a success, held until the first of `times`
   * (`HH:MM`) after it, in `timeZone` (an IANA name). With a cooldown, the later hold wins.
   */
  resetsAt?: ResetsAt;
  /** What its success does to other commands' holds (by name or alias). */
  effects?: readonly CommandEffect[];
  /**
   * It needs the person to answer or choose (a minigame, a shop; bot-os.md D137): a player plays it
   * only when its config names it.
   */
  interactive?: true;
}

/** The wall-clock times a command is usable again at (D165). */
export interface ResetsAt {
  times: readonly string[];
  timeZone: string;
}

/** What is wrong with `r`, or undefined if nothing. */
export function resetsAtProblem(r: ResetsAt): string | undefined {
  if (r.times.length === 0) return 'resetsAt.times must name at least one time';
  const bad = r.times.find((t) => clockMinutes(t) === undefined);
  if (bad !== undefined) return `resetsAt.times: ${bad} is not HH:MM`;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: r.timeZone });
  } catch {
    return `resetsAt: unknown timeZone ${r.timeZone}`;
  }
  return undefined;
}

/** The first of `r`'s times strictly after `t`. */
export function nextReset(r: ResetsAt, t: number): number {
  const today = localDate(t, r.timeZone);
  let next = Infinity;
  for (const days of [-1, 0, 1, 2])
    for (const time of r.times) {
      const at = zonedInstant(addDays(today, days), clockMinutes(time) as number, r.timeZone);
      if (at > t && at < next) next = at;
    }
  return next;
}

/** What a readiness state is built from: its parser's id and vocabulary, and the mechanics. */
export interface ReadinessSpec {
  /** Its parser: its id (the namespace of the events it reduces) and its bot's vocabulary. */
  parser: BotVocabulary & { id: string };
  /** The bot's other commands' mechanics, by name (never the turn's: its hold is the rest). */
  mechanics?: Readonly<Record<string, CommandMechanics>>;
}

/**
 * A command's readiness (bot-os.md D132): ready, since when (none: since ever, as far as its state
 * knows); or held, until when (none: until the bot unlocks it) and why. With its last send, by
 * hand (the owner's, from any device) or a player's, and the last answer read to it, with its
 * length in characters.
 */
export interface Readiness {
  ready: boolean;
  since?: number;
  until?: number;
  why?: string;
  sent?: { t: number; byHand: boolean };
  answer?: { t: number; length: number };
}

/** The contract a player binds to (docs/bot-os-api.md §2.1, bot-os.md D141). */
export interface ReadinessInterface {
  state: {
    ready(): Record<string, Readiness>;
    /** Its bot's commands, the turn first, with their aliases and mechanics (D137, D140). */
    commands(): BotCommand[];
    /** Its bot's username, without `@`: a command addressed to it is `/play@<bot>` (D139). */
    bot(): string;
  };
  /** A send of a player's, handed to its parser, which pairs its answer (D98, D139). */
  actions: { sent(sent: SentCommand): void };
}

/** The members of the contract, as an input names them. */
export const READINESS_MEMBERS = ['state.ready', 'state.commands', 'state.bot', 'actions.sent'];

/** The section of a state that keeps it. */
export const READINESS_SECTION = 'readiness';

/**
 * A hold a game folds in from facts its parser's events alone do not tell (a ban): on every
 * command, or those it names, until then (none: until it is lifted), and why.
 */
export interface CommandHold {
  until?: number;
  why: string;
  commands?: string[];
}

const commandStateSchema = z.object({
  sent: z.object({ t: z.number(), byHand: z.boolean() }).optional(),
  answer: z.object({ t: z.number(), length: z.number() }).optional(),
  readyAt: z.number().optional(),
  why: z.string().optional(),
  unlocked: z.object({ at: z.number(), until: z.number().optional() }).optional(),
});
/** A command's state, as the section keeps it. */
export type CommandState = z.output<typeof commandStateSchema>;

const sectionSchema = z
  .object({
    commands: z.record(z.string(), commandStateSchema),
    holds: z.record(
      z.string(),
      z.object({
        until: z.number().optional(),
        why: z.string(),
        commands: z.array(z.string()).optional(),
      })
    ),
  })
  .describe(
    "Each command's last send and answer, until when it is held and why, and when it was unlocked; the game's own holds"
  );
/** The section a state keeps: each command's state, by name, and the game's holds, by key. */
export type ReadinessState = z.output<typeof sectionSchema>;

const COMMAND = /^\/\w+$/u;

/** Why the bot rests after `o`, in the owner's words. */
export function whyOf(o: TurnOutcome): string {
  if (o.kind === 'nothing' && o.reason !== undefined)
    return o.reason === 'cooldown' ? 'it said too soon' : o.reason;
  return 'its rest after a turn';
}

/** A "too soon": no success, the wait it states holding the command. */
const tooSoon = (o: TurnOutcome): boolean => o.kind === 'nothing' && o.reason === 'cooldown';

/** The reusable readiness reducer of one bot's commands (bot-os.md D141). */
export class ReadinessModel {
  /** Its parser's id: the namespace of the events it reduces. */
  readonly parser: string;
  readonly bot: string;
  /** The turn's name. */
  readonly turn: string;
  /** Its bot's commands, the turn first, with their aliases and mechanics, as a manifest says. */
  readonly declared: BotCommand[];
  /** The event types it reduces. */
  readonly consumes: string[];
  readonly schema = sectionSchema;
  private readonly names: { command: string; aliases: string[] }[];
  private readonly mechanics: Readonly<Record<string, CommandMechanics>>;

  constructor(spec: ReadinessSpec) {
    const v = spec.parser;
    const fail = (why: string): never => {
      throw new Error(`readiness of ${v.id}: ${why}`);
    };
    const problem = vocabularyProblem(v);
    if (problem !== undefined) fail(problem);
    this.parser = v.id;
    this.bot = v.bot;
    this.names = vocabularyCommands(v);
    this.turn = this.names[0]?.command as string;
    this.mechanics = spec.mechanics ?? {};
    for (const [command, m] of Object.entries(this.mechanics)) {
      if (!COMMAND.test(command)) fail(`${command} is not a command, as /daily`);
      if (command.toLowerCase() === this.turn.toLowerCase())
        fail(`${command} is the turn: its readiness is the rest's`);
      if (v.commands?.[command] === undefined)
        fail(`${command} is not one of its parser's commands (by its name)`);
      if (m.cooldownMin !== undefined && !(m.cooldownMin > 0))
        fail(`${command}: cooldownMin must be over 0`);
      if (m.unlock?.forMin !== undefined && !(m.unlock.forMin > 0))
        fail(`${command}: unlock.forMin must be over 0`);
      const reset = m.resetsAt === undefined ? undefined : resetsAtProblem(m.resetsAt);
      if (reset !== undefined) fail(`${command}: ${reset}`);
      for (const effect of m.effects ?? []) {
        if (this.name(effect.command) === undefined)
          fail(
            `${command}: its effect names ${effect.command}, not one of its commands or aliases`
          );
        if (effect.clear !== true && !((effect.shortenMin ?? 0) > 0))
          fail(
            `${command}: an effect clears its command's hold or shortens it (shortenMin over 0)`
          );
      }
    }
    for (const [command, w] of Object.entries(v.commands ?? {}))
      if (w.announcedBy !== undefined && this.mechanics[command]?.unlock === undefined)
        fail(`${command} is announced (announcedBy), but its mechanics have no unlock`);
    this.declared = this.commandsOf(v);
    this.consumes = ['sent', 'turn', 'answer', 'reply'].map((t) => `${v.id}.${t}`);
  }

  /** A command by its name, of any spelling, or an alias's (D140); undefined if none such. */
  name(command: string): string | undefined {
    return commandOf(command, this.names, this.bot);
  }

  /** A fresh section: nothing known. */
  initial(): ReadinessState {
    return { commands: {}, holds: {} };
  }

  /** The section after an event of its parser's; any other, the same section. Pure. */
  reduce(state: ReadinessState, event: BusEvent): ReadinessState {
    const kind = event.type.startsWith(`${this.parser}.`)
      ? event.type.slice(this.parser.length + 1)
      : undefined;
    if (kind === undefined || !['sent', 'turn', 'answer', 'reply'].includes(kind)) return state;
    const s = structuredClone(state);
    const t = event.t;
    if (kind === 'sent') {
      const c = this.name(String(event['command']));
      if (c === undefined) return state;
      const was = (s.commands[c] ??= {});
      if (was.sent === undefined || t >= was.sent.t)
        was.sent = { t, byHand: event['byHand'] === true };
      return s;
    }
    const named = kind === 'turn' ? this.turn : this.name(String(event['command'] ?? ''));
    const answer = event['answer'] as { length: number } | undefined;
    if (named !== undefined && answer !== undefined)
      (s.commands[named] ??= {}).answer = { t, length: answer.length };
    const outcome = event['outcome'] as TurnOutcome | undefined;
    if (named !== undefined && outcome !== undefined && outcome.kind !== 'unknown') {
      const retryAt = event['retryAt'] as number | undefined;
      if (named === this.turn) {
        const was = (s.commands[named] ??= {});
        if (retryAt !== undefined && (was.readyAt === undefined || retryAt > was.readyAt)) {
          was.readyAt = retryAt;
          was.why = whyOf(outcome);
        }
      } else if (tooSoon(outcome)) {
        if (retryAt !== undefined) this.held(s, named, retryAt, 'it said too soon');
      } else this.succeeded(s, named, t, retryAt, outcome);
    }
    for (const u of (event['unlocks'] as string[] | undefined) ?? []) this.unlocked(s, u, t);
    const effects = (event['effects'] as CommandEffect[] | undefined) ?? [];
    this.apply(s, effects, t, named ?? 'an answer');
    return s;
  }

  /**
   * A success of `command` at `t`, as a game's own events tell it (bot-os.md D141): its cooldown,
   * its unlock used up, its effects. Pure.
   */
  succeed(state: ReadinessState, command: string, t: number): ReadinessState {
    const c = this.name(command);
    if (c === undefined || c === this.turn) return state;
    const s = structuredClone(state);
    this.succeeded(s, c, t, undefined, undefined);
    return s;
  }

  /** `command` unlocked at `t` (an unlockable command's), as a game's own events tell it. Pure. */
  unlock(state: ReadinessState, command: string, t: number): ReadinessState {
    const s = structuredClone(state);
    this.unlocked(s, command, t);
    return s;
  }

  /**
   * `command`'s unlock withdrawn: the bot said it is not available after all (an unlockable
   * command's). Pure.
   */
  lock(state: ReadinessState, command: string): ReadinessState {
    const c = this.name(command);
    if (c === undefined || state.commands[c]?.unlocked === undefined) return state;
    const s = structuredClone(state);
    delete (s.commands[c] as CommandState).unlocked;
    return s;
  }

  /** A game's hold set under `key` (a ban), or lifted when `hold` is undefined. Pure. */
  hold(state: ReadinessState, key: string, hold: CommandHold | undefined): ReadinessState {
    if (hold === undefined && !Object.hasOwn(state.holds, key)) return state;
    const s = structuredClone(state);
    if (hold === undefined) delete s.holds[key];
    else
      s.holds[key] = {
        ...(hold.until === undefined ? {} : { until: hold.until }),
        why: hold.why,
        ...(hold.commands === undefined
          ? {}
          : { commands: hold.commands.map((c) => this.name(c) ?? c) }),
      };
    return s;
  }

  /** Each command's readiness at `now`, by name, the turn first (bot-os.md D132). */
  ready(state: ReadinessState, now: number): Record<string, Readiness> {
    return Object.fromEntries(
      this.names.map(({ command }) => [command, this.readiness(state, command, now)])
    );
  }

  private readiness(state: ReadinessState, c: string, now: number): Readiness {
    const s = state.commands[c] ?? {};
    const seen = {
      ...(s.sent === undefined ? {} : { sent: s.sent }),
      ...(s.answer === undefined ? {} : { answer: s.answer }),
    };
    let r: Readiness;
    const unlock = c === this.turn ? undefined : this.mechanics[c]?.unlock;
    if (unlock !== undefined && s.unlocked === undefined)
      r = { ready: false, why: 'waits for an unlock', ...seen };
    else if (unlock !== undefined && s.unlocked?.until !== undefined && s.unlocked.until <= now)
      r = { ready: false, why: 'its unlock lapsed', ...seen };
    else if (s.readyAt !== undefined && s.readyAt > now)
      r = { ready: false, until: s.readyAt, why: s.why ?? 'held', ...seen };
    else {
      const since = Math.max(s.readyAt ?? -Infinity, s.unlocked?.at ?? -Infinity);
      r = { ready: true, ...(Number.isFinite(since) ? { since } : {}), ...seen };
    }
    // The game's holds over it (a ban), told over its own hold but one that ends later: a command
    // waiting for its unlock is held by a ban all the same, and says so.
    for (const h of Object.values(state.holds)) {
      if (h.commands !== undefined && !h.commands.includes(c)) continue;
      if (h.until !== undefined && h.until <= now) continue;
      if (!r.ready && r.until !== undefined && h.until !== undefined && r.until >= h.until)
        continue;
      r = {
        ready: false,
        ...(h.until === undefined ? {} : { until: h.until }),
        why: h.why,
        ...seen,
      };
    }
    return r;
  }

  /** Held until `until`, and why. */
  private held(s: ReadinessState, c: string, until: number, why: string): void {
    const was = (s.commands[c] ??= {});
    was.readyAt = until;
    was.why = why;
  }

  /** A success of `c` at `t`: its cooldown (or the wait the bot stated), its unlock used, its effects. */
  private succeeded(
    s: ReadinessState,
    c: string,
    t: number,
    retryAt: number | undefined,
    outcome: TurnOutcome | undefined
  ): void {
    const m = this.mechanics[c] ?? {};
    const cooldown = m.cooldownMin === undefined ? undefined : t + m.cooldownMin * 60_000;
    const reset = m.resetsAt === undefined ? undefined : nextReset(m.resetsAt, t);
    // The latest of its cooldown, its reset and the bot's wait holds it.
    if (reset !== undefined && (cooldown ?? -Infinity) < reset && (retryAt ?? -Infinity) < reset)
      this.held(s, c, reset, 'waits for its reset');
    else if (cooldown !== undefined && (retryAt === undefined || cooldown > retryAt))
      this.held(s, c, cooldown, 'its cooldown');
    else if (retryAt !== undefined)
      this.held(s, c, retryAt, outcome === undefined ? 'held' : whyOf(outcome));
    if (m.unlock !== undefined && s.commands[c]?.unlocked !== undefined)
      delete (s.commands[c] as CommandState).unlocked;
    this.apply(s, m.effects ?? [], t, c);
  }

  /** `command` unlocked at `t`, by an announcement (D132): for an unlockable command only. */
  private unlocked(s: ReadinessState, command: string, t: number): void {
    const c = this.name(command);
    const unlock = c === undefined ? undefined : this.mechanics[c]?.unlock;
    if (c === undefined || unlock === undefined) return;
    (s.commands[c] ??= {}).unlocked = {
      at: t,
      ...(unlock.forMin === undefined ? {} : { until: t + unlock.forMin * 60_000 }),
    };
  }

  /** Effects on holds at `t` (D132): each command's hold ended or shortened. */
  private apply(s: ReadinessState, effects: readonly CommandEffect[], t: number, by: string): void {
    for (const effect of effects) {
      const c = this.name(effect.command);
      const was = c === undefined ? undefined : s.commands[c];
      if (was?.readyAt === undefined || was.readyAt <= t) continue;
      was.readyAt =
        effect.clear === true ? t : Math.max(t, was.readyAt - (effect.shortenMin ?? 0) * 60_000);
      was.why = `${was.why ?? 'held'}, cut by ${by}`;
    }
  }

  /**
   * Its commands as a manifest declares them (bot-os.md D137, D140): the turn first, its first
   * turn command its name and the others its aliases, then the others in the vocabulary's order,
   * each with its aliases and mechanics, copied field by field; an effect naming an alias names its
   * command.
   */
  private commandsOf(v: BotVocabulary): BotCommand[] {
    const aliasesOf = (a: readonly string[]) => (a.length === 0 ? {} : { aliases: [...a] });
    const [turn, ...others] = this.names;
    return [
      { command: this.turn, ...aliasesOf(turn?.aliases ?? []), turn: true as const },
      ...others.map(({ command, aliases }): BotCommand => {
        const m = this.mechanics[command] ?? {};
        const pattern = v.commands?.[command]?.announcedBy;
        const effects = (m.effects ?? []).map((e) => ({
          command: this.name(e.command) ?? e.command,
          ...(e.clear === true ? { clear: true as const } : {}),
          ...(e.shortenMin === undefined ? {} : { shortenMin: e.shortenMin }),
        }));
        return {
          command,
          ...aliasesOf(aliases),
          ...(m.cooldownMin === undefined ? {} : { cooldownMin: m.cooldownMin }),
          ...(m.resetsAt === undefined
            ? {}
            : { resetsAt: { times: [...m.resetsAt.times], timeZone: m.resetsAt.timeZone } }),
          ...(m.unlock === undefined
            ? {}
            : {
                unlock: {
                  ...(pattern === undefined ? {} : { pattern }),
                  ...(m.unlock.forMin === undefined ? {} : { forMin: m.unlock.forMin }),
                },
              }),
          ...(effects.length === 0 ? {} : { effects }),
          ...(m.interactive === true ? { interactive: true as const } : {}),
        };
      }),
    ];
  }
}
