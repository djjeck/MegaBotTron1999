/**
 * A player's commands as a checklist (bot-os.md D137): the commands of the parser its `parser`
 * edge binds (its `botCommands`, in its order, the turns first), which it plays, when, and a
 * sentence each saying what the player will do with it. The policy is the player's own
 * (`packages/turns/src/player.ts`, `playsOf`), restated here since the UI imports the core's types
 * alone: a turn, whenever ready (the bot's rest over); a command whose success clears another's hold
 * (a reset), only while that other is held (cooling down); any other, whenever ready; an entry's
 * `whileHeld` or `whenReady` overrides it. Its config unset, every command but an interactive one.
 *
 * The editor keeps the player's chat-out edge allowing the commands it plays (`followPlays`), so
 * that the owner never keeps a second list in step by hand.
 */
import type { BotCommand, Graph, GraphNode, PluginView } from '#src/ui/api.ts';
import { endOf } from './draft.ts';

/** An entry of a player's `commands`, as its config writes it. */
export interface PlayEntry {
  command: string;
  whileHeld?: string;
  whenReady?: true;
}

/** A command's policy: whenever ready (`undefined`), or only while another is held. */
export type Policy = string | undefined;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const samePolicy = (a: Policy, b: Policy): boolean =>
  a === undefined || b === undefined ? a === b : same(a, b);

/** The policy a command's mechanics give it: a reset, only while what it clears is held. */
export function derivedPolicy(c: BotCommand): Policy {
  if (c.turn === true) return undefined;
  return c.effects?.find((e) => e.clear === true && !same(e.command, c.command))?.command;
}

/** A config's `commands`, as entries, if it is a list of them; anything else, unset. */
export function entriesOf(value: unknown): PlayEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (e): e is PlayEntry =>
      typeof e === 'object' && e !== null && typeof (e as PlayEntry).command === 'string'
  );
}

/** One row of the checklist: its command, whether it is played, and its policy. */
export interface PlayRow {
  command: BotCommand;
  played: boolean;
  /** Its policy in force: its override, else its mechanics'. */
  policy: Policy;
  /** Its policy overridden by its entry. */
  overridden: boolean;
}

/**
 * The checklist's rows, in the parser's order: each declared command, played if the config names
 * it (unset: every one but an interactive one), with its policy.
 */
export function playRows(value: unknown, declared: readonly BotCommand[]): PlayRow[] {
  const entries = entriesOf(value);
  return declared.map((command) => {
    const derived = derivedPolicy(command);
    if (entries === undefined)
      return { command, played: command.interactive !== true, policy: derived, overridden: false };
    const entry = entries.find((e) => same(e.command, command.command));
    const policy = entry?.whenReady === true ? undefined : (entry?.whileHeld ?? derived);
    return {
      command,
      played: entry !== undefined,
      policy,
      overridden:
        entry !== undefined && (entry.whenReady === true || entry.whileHeld !== undefined),
    };
  });
}

/** The entries of a config naming commands its parser declares none of: kept as they are. */
export function unknownEntries(value: unknown, declared: readonly BotCommand[]): PlayEntry[] {
  return (entriesOf(value) ?? []).filter((e) => !declared.some((d) => same(d.command, e.command)));
}

/**
 * The config's `commands` the rows make: unset when they are the defaults (every command but an
 * interactive one, no override), so that the player follows its parser; else the list, in the
 * parser's order, each override written only where it differs from the mechanics, with `extra`
 * (entries of commands the parser does not declare) after them.
 */
export function rowsValue(
  rows: readonly PlayRow[],
  extra: readonly PlayEntry[] = []
): PlayEntry[] | undefined {
  const entries = rows
    .filter((r) => r.played)
    .map((r): PlayEntry => {
      const derived = derivedPolicy(r.command);
      if (samePolicy(r.policy, derived)) return { command: r.command.command };
      return r.policy === undefined
        ? { command: r.command.command, whenReady: true }
        : { command: r.command.command, whileHeld: r.policy };
    });
  const defaults =
    extra.length === 0 &&
    rows.every((r) => r.played === (r.command.interactive !== true)) &&
    entries.every((e) => e.whileHeld === undefined && e.whenReady === undefined);
  return defaults ? undefined : [...entries, ...extra];
}

/** The commands a player plays, in order: its config's, or its defaults. */
export function playedCommands(value: unknown, declared: readonly BotCommand[]): string[] {
  const entries = entriesOf(value);
  if (entries === undefined)
    return declared.filter((d) => d.interactive !== true).map((d) => d.command);
  return entries.map((e) => e.command);
}

/** A number of minutes in words: `30 minutes`, `1 hour`, `24 hours`, `90 minutes`. */
export function duration(min: number): string {
  if (min >= 60 && min % 60 === 0) {
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${min} minute${min === 1 ? '' : 's'}`;
}

/**
 * What the player will do with a command, in one short sentence, composed from parts (D137): what
 * it is (`a turn`, `needs you to answer`, `activated by “…”, for 30 minutes`), then the policy in
 * force (`played whenever the bot's rest is over`, `played whenever ready`, `played while active`,
 * `played if /x is cooling down`, or `not played`, `by default` for an interactive command the
 * defaults leave out), then, when played, what a success does (`then cooling down for 24 hours`;
 * `ends its cool-down`, `ends /x's cool-down`, `shortens /x's cool-down by 5 minutes`).
 *
 * - `/play`, a turn: "a turn: played whenever the bot's rest is over"
 * - `/coffee`, a reset of `/play`: "played if /play is cooling down; ends its cool-down"
 * - `/chest`, unlocked: "activated by “A chest appears!”, for 30 minutes: played while active"
 * - `/daily`: "played whenever ready, then cooling down for 24 hours"
 * - `/shop`, interactive, by default: "needs you to answer: not played by default"
 */
export function playSentence(
  row: Pick<PlayRow, 'command' | 'played' | 'policy'>,
  /** The config is unset: what is not played is left out by default. */
  defaults = false
): string {
  const c = row.command;
  const what: string[] = [];
  if (c.turn === true) what.push('a turn');
  if (c.interactive === true) what.push('needs you to answer');
  if (c.unlock !== undefined) {
    const by =
      c.unlock.pattern === undefined
        ? 'activated by the bot'
        : `activated by “${c.unlock.pattern}”`;
    what.push(c.unlock.forMin === undefined ? by : `${by}, for ${duration(c.unlock.forMin)}`);
  }
  let how: string;
  if (!row.played) how = defaults ? 'not played by default' : 'not played';
  else {
    const when =
      c.unlock !== undefined
        ? 'played while active'
        : c.turn === true
          ? "played whenever the bot's rest is over"
          : 'played whenever ready';
    how =
      row.policy === undefined
        ? when
        : c.unlock !== undefined
          ? `${when}, if ${row.policy} is cooling down`
          : `played if ${row.policy} is cooling down`;
    if (c.cooldownMin !== undefined) how += `, then cooling down for ${duration(c.cooldownMin)}`;
    const effects = (c.effects ?? []).flatMap((e) => {
      const whose =
        row.policy !== undefined && same(e.command, row.policy) ? 'its' : `${e.command}'s`;
      if (e.clear === true) return [`ends ${whose} cool-down`];
      if (e.shortenMin !== undefined)
        return [`shortens ${whose} cool-down by ${duration(e.shortenMin)}`];
      return [];
    });
    if (effects.length > 0) how += `; ${effects.join(' and ')}`;
  }
  return what.length === 0 ? how : `${what.join(', ')}: ${how}`;
}

/**
 * The commands of the parser a node's `input` binds (D137), as its plugin declares them; none
 * while no edge binds it, or its parser declares none.
 */
export function boundCommands(
  g: Graph,
  node: string,
  input: string,
  viewOf: (n: GraphNode) => PluginView | undefined
): BotCommand[] | undefined {
  const edge = g.edges.find((e) => e.to === `${node}.${input}`);
  if (edge === undefined) return undefined;
  const parser = g.nodes.find((n) => n.id === endOf(edge.from).node);
  const commands = parser === undefined ? undefined : viewOf(parser)?.botCommands;
  return commands === undefined || commands.length === 0 ? undefined : commands;
}

/**
 * The node whose checklist a chat-out edge leaving `from` follows (D137): its own, when its plugin
 * declares one over that output and its parser's commands are known; else undefined.
 */
export function followedBy(
  g: Graph,
  from: string,
  viewOf: (n: GraphNode) => PluginView | undefined
): string | undefined {
  const { node, port } = endOf(from);
  const n = g.nodes.find((x) => x.id === node);
  const plays = n === undefined ? undefined : viewOf(n)?.configPlays;
  if (n === undefined || plays === undefined || plays.output !== port) return undefined;
  return boundCommands(g, n.id, plays.input, viewOf) === undefined ? undefined : n.id;
}

/**
 * The graph with each player's chat-out edges allowing exactly the commands it plays (D137), from
 * its checklist and its parser's commands; a player whose parser is unknown is left as it is. The
 * same graph when nothing changes.
 */
export function followPlays(g: Graph, viewOf: (n: GraphNode) => PluginView | undefined): Graph {
  let out = g;
  for (const n of g.nodes) {
    const plays = viewOf(n)?.configPlays;
    if (plays === undefined) continue;
    const declared = boundCommands(g, n.id, plays.input, viewOf);
    if (declared === undefined) continue;
    const commands = playedCommands(n.config?.[plays.key], declared);
    const from = `${n.id}.${plays.output}`;
    if (
      !out.edges.some(
        (e) =>
          e.from === from &&
          (e.type === undefined || e.type === 'chat-out') &&
          (e.commands === undefined ||
            e.commands.length !== commands.length ||
            e.commands.some((c, i) => c !== commands[i]))
      )
    )
      continue;
    out = {
      ...out,
      edges: out.edges.map((e) => {
        if (e.from !== from || (e.type !== undefined && e.type !== 'chat-out')) return e;
        // A command no longer played takes its spacing with it.
        const kept = Object.entries(e.minIntervalS ?? {}).filter(([c]) => commands.includes(c));
        const { minIntervalS: _, ...rest } = e;
        return {
          ...rest,
          commands: [...commands],
          ...(kept.length === 0 ? {} : { minIntervalS: Object.fromEntries(kept) }),
        };
      }),
    };
  }
  return out;
}
