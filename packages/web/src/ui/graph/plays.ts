/**
 * A player's commands as a checklist (bot-os.md D137): the commands of the parser its `parser`
 * edge binds (its `botCommands`, in its order, the turns first), which it plays, when, and a
 * sentence each saying what the player will do with it. The policy is the player's own
 * (`packages/turns/src/player.ts`, `playsOf`), restated here since the UI imports the core's types
 * alone: a turn, whenever ready (the bot's rest over); a command whose success clears another's hold
 * (a reset), only while that other is held (cooling down); any other, whenever ready; an entry's
 * `whileHeld` or `whenReady` overrides it. Its config unset, every command but an interactive one.
 *
 * One row per command, whatever its aliases (D140). Its **forms** are each of its names (its own,
 * then its `aliases`) bare (`/play`), then, in a group, addressed to its bot (`/play@QuestBot`, the
 * parser's `botUsername`, D139): in a group, a bare name reaches every bot there that declares it,
 * an addressed one only its own. Each form has its tick, all ticked by default (the entry's `forms`
 * unset); the player sends a command as the ticked form that reaches the most bots, each of which
 * would play it then, the first in order on a tie. An entry of D139's, `addressed: true`, reads as
 * its one addressed form.
 *
 * The editor keeps the player's chat-out edge allowing the forms it may send (`followPlays`), so
 * that the owner never keeps a second list in step by hand.
 */
import type { BotCommand, Graph, GraphNode, PluginView } from '#src/ui/api.ts';
import { endOf } from './draft.ts';

/** An entry of a player's `commands`, as its config writes it. */
export interface PlayEntry {
  command: string;
  whileHeld?: string;
  whenReady?: true;
  /** The forms it may be sent as, in order (D140); unset, every one. */
  forms?: string[];
  /** D139's: addressed to its bot alone, as `forms: ['/play@QuestBot']` says now. */
  addressed?: true;
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

/** One row of the checklist: its command, whether it is played, its policy, and its forms. */
export interface PlayRow {
  command: BotCommand;
  played: boolean;
  /** Its policy in force: its override, else its mechanics'. */
  policy: Policy;
  /** Its policy overridden by its entry. */
  overridden: boolean;
  /** The forms it may be sent as, in order (D140); unset, every one. */
  forms?: string[];
  /** D139's entry, addressed to its bot, while its bot is not known to say its form. */
  addressed?: true;
}

/** A command's names (D140): its own, then its aliases. */
export function namesOf(c: Pick<BotCommand, 'command' | 'aliases'>): string[] {
  return [c.command, ...(c.aliases ?? [])];
}

/** Whether a command, of its names, is `name` (D140). */
const isNamed = (c: BotCommand, name: string): boolean => namesOf(c).some((n) => same(n, name));

/**
 * A command's forms, in order (D140): each of its names bare, then, in a group, addressed to its
 * bot. Where it sends unknown, its names.
 */
export function formsOf(c: BotCommand, place?: PlayPlace): string[] {
  return namesOf(c).flatMap((n) => (place?.group === true ? [n, `${n}@${place.bot}`] : [n]));
}

/**
 * The forms a row lists, each with its tick (D140): its command's forms, and any other its entry
 * allows (an addressed one in its bot's private chat).
 */
export function listedForms(row: Pick<PlayRow, 'command' | 'forms'>, place?: PlayPlace): string[] {
  const all = formsOf(row.command, place);
  return [...all, ...(row.forms ?? []).filter((f) => !all.some((a) => same(a, f)))];
}

/**
 * The checklist's rows, in the parser's order: each declared command, played if the config names
 * it, by its name or an alias (unset: every one but an interactive one), with its policy and its
 * forms; D139's `addressed` read as its one addressed form where its bot is known.
 */
export function playRows(value: unknown, declared: readonly BotCommand[], bot?: string): PlayRow[] {
  const entries = entriesOf(value);
  return declared.map((command) => {
    const derived = derivedPolicy(command);
    if (entries === undefined)
      return { command, played: command.interactive !== true, policy: derived, overridden: false };
    const entry = entries.find((e) => isNamed(command, e.command));
    const policy = entry?.whenReady === true ? undefined : (entry?.whileHeld ?? derived);
    const legacy = entry?.addressed === true && entry.forms === undefined;
    const forms =
      entry?.forms ?? (legacy && bot !== undefined ? [`${entry.command}@${bot}`] : undefined);
    return {
      command,
      played: entry !== undefined,
      policy,
      overridden:
        entry !== undefined && (entry.whenReady === true || entry.whileHeld !== undefined),
      ...(forms === undefined ? {} : { forms: [...forms] }),
      ...(legacy && bot === undefined ? { addressed: true as const } : {}),
    };
  });
}

/** The entries of a config naming commands its parser declares none of: kept as they are. */
export function unknownEntries(value: unknown, declared: readonly BotCommand[]): PlayEntry[] {
  return (entriesOf(value) ?? []).filter((e) => !declared.some((d) => isNamed(d, e.command)));
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
      const form =
        r.forms !== undefined
          ? { forms: [...r.forms] }
          : r.addressed === true
            ? { addressed: true as const }
            : {};
      if (samePolicy(r.policy, derived)) return { command: r.command.command, ...form };
      return r.policy === undefined
        ? { command: r.command.command, whenReady: true, ...form }
        : { command: r.command.command, whileHeld: r.policy, ...form };
    });
  const defaults =
    extra.length === 0 &&
    rows.every((r) => r.played === (r.command.interactive !== true)) &&
    entries.every(
      (e) =>
        e.whileHeld === undefined &&
        e.whenReady === undefined &&
        e.forms === undefined &&
        e.addressed === undefined
    );
  return defaults ? undefined : [...entries, ...extra];
}

/**
 * The forms a player may send its commands as, in order (D140): of each command it plays (its
 * config's, or its defaults), its entry's `forms`, else every form where it sends; D139's
 * `addressed`, `/play@QuestBot`, when its parser names its bot.
 */
export function playedCommands(
  value: unknown,
  declared: readonly BotCommand[],
  place?: PlayPlace
): string[] {
  const entries = entriesOf(value);
  if (entries === undefined)
    return declared.filter((d) => d.interactive !== true).flatMap((d) => formsOf(d, place));
  return entries.flatMap((e) => {
    if (e.forms !== undefined) return e.forms;
    if (e.addressed === true && place !== undefined) return [`${e.command}@${place.bot}`];
    const d = declared.find((x) => isNamed(x, e.command));
    return d === undefined ? [e.command] : formsOf(d, place);
  });
}

/**
 * Where a player sends (D139): in a group, when its one chat is not its bot's private chat; and
 * its bot's name, for an addressed command. Undefined without a parser naming its bot.
 */
export interface PlayPlace {
  bot: string;
  group: boolean;
}

/**
 * How a command is sent, in words, for its sentence (D139, D140): of its forms allowed, the one
 * that plays it for the most ready bots at once; its one form, which bots take it; bare under its
 * own name in its bot's private chat, nothing.
 */
export function formWords(
  row: Pick<PlayRow, 'command' | 'forms'>,
  place: PlayPlace
): string | undefined {
  const forms = row.forms ?? formsOf(row.command, place);
  const [form] = forms;
  if (form === undefined) return undefined;
  if (forms.length > 1)
    return place.group
      ? `sent as the form that plays ${row.command.turn === true ? 'the most ready turns' : 'it for the most ready bots'} at once`
      : `sent as ${form}`;
  if (form.includes('@')) return `sent as ${form}, which only @${place.bot} takes`;
  if (place.group) return `sent as ${form}, which every bot in the group that declares it takes`;
  return same(form, row.command.command) ? undefined : `sent as ${form}`;
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
  row: Pick<PlayRow, 'command' | 'played' | 'policy' | 'forms'>,
  /** The config is unset: what is not played is left out by default. */
  defaults = false,
  /** Where it sends, to say how a command goes (D139); unknown, nothing said. */
  place?: PlayPlace
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
    const form = place === undefined ? undefined : formWords(row, place);
    if (form !== undefined) how += `; ${form}`;
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
 * Where a node's player sends (D139): its parser's bot (that its `input` binds) and whether the
 * one chat of its `output`'s edge is a group (not the bot's private chat; none named yet, a
 * group's form is not offered). Undefined while its parser names no bot.
 */
export function playPlace(
  g: Graph,
  node: string,
  plays: { input: string; output: string },
  viewOf: (n: GraphNode) => PluginView | undefined
): PlayPlace | undefined {
  const bot = boundBot(g, node, plays.input, viewOf);
  if (bot === undefined) return undefined;
  const chat = g.edges.find((e) => e.from === `${node}.${plays.output}`)?.sends?.[0];
  return { bot, group: chat !== undefined && chat.toLowerCase() !== `@${bot}`.toLowerCase() };
}

/** The bot of the parser a node's `input` binds (D139), as its plugin names it. */
export function boundBot(
  g: Graph,
  node: string,
  input: string,
  viewOf: (n: GraphNode) => PluginView | undefined
): string | undefined {
  const edge = g.edges.find((e) => e.to === `${node}.${input}`);
  const parser =
    edge === undefined ? undefined : g.nodes.find((n) => n.id === endOf(edge.from).node);
  return parser === undefined ? undefined : viewOf(parser)?.botUsername;
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
    const place = playPlace(g, n.id, plays, viewOf);
    const commands = playedCommands(n.config?.[plays.key], declared, place);
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
