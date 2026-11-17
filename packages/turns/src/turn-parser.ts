/**
 * The base of the game bots' parser plugins (docs/bot-os-api.md §5): one plugin per bot, each
 * made by `turnParserPlugin` from its bot's grammar, which knows the game (the shell does not: a
 * reading's outcome is the grammar's, of any shape with a `kind` and a `bot`). Each reads,
 * through the owner's account (`telegram-user`), the private chat with its bot and, optionally, a
 * group, and:
 *
 * - knows the owner's turns: its game's turn commands (`spec.turnCommands`, a fact of the game, not
 *   of a node's config: bot-os.md D70) that the owner sends by hand (from any device, which the
 *   account sees), and those its player sends (told through `actions.sent`, since the account
 *   never sees its own sends come back); and, the same way, the sends of the game's other commands
 *   its spec declares (`spec.commands`, bot-os.md D132);
 * - tells which of its bot's messages answer one: a reply to it, or, in the private chat, where
 *   every message is the owner's, the first message within two minutes of it;
 * - publishes what it reads as `<id>.turn`, the outcome of a turn (marked `playback` when the
 *   message was history: missed while down, bot-os.md D83), or `<id>.answer`, that of another
 *   command it declares; and reports to drift (P5) a message it claims and cannot read, which
 *   pauses the player that requires it past the threshold;
 * - offers `state.rest`: until when its bot rests, as its last answer said (the bot's rest after a
 *   turn, or the wait of a "too soon"); `state.lastTurn`: the owner's last turn, by hand or its
 *   player's, in the private chat or the group alike (a turn is a turn, bot-os.md D129); and
 *   `state.ready` (D132): each command's readiness, ready since when, or held until when and why,
 *   with its last send (by hand or not) and its last answer; the turn commands' from the rest, the
 *   others' from their mechanics (a cooldown after a success, an unlock the bot announces, a
 *   success's effect on another command's hold);
 * - declares its `<id>.turn` an answer to its turn commands (bot-os.md D98): `refused` with
 *   `cooldown` for a "too soon", `ok` for any other outcome read (not an unread one), each with its
 *   `retryAt` (the rest it starts), so that a turn queued by any node settles with what the bot
 *   answered, and the outbox holds the next one back until the bot's rest is over; its
 *   `<id>.answer` the same way to each of its other commands, and both with the holds an effect set
 *   (`holds`, D132), so that a reset ends the outbox's cooldown too.
 *
 * It keeps nothing in its factory's closure: everything hangs off its instance (§2.1). It resumes
 * from its own records (bot-os.md D62): the owner's recent turns, its bot's rest and its commands'
 * state, kept in its store as they change, and never re-reads the chat; what was said while the
 * instance was down comes from the connector's catch-up, once, as missed messages (`playback`,
 * `missed`), which it reads as any other.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  type AnswerDeclarationInput,
  counted,
  definePlugin,
  type Inbound,
  type InboundDocument,
  ME,
  type Plugin,
  Tally,
} from '@megabottron1999/core';
import { z } from 'zod';

/** A message of the bot, as its grammar reads it. */
export interface BotMessage {
  /** Its text, as the bot wrote it: a file's caption, `''` without one. */
  text: string;
  /**
   * The file it carries, if any (bot-os.md D82): a text file's `text` with it, under the limit,
   * such as the bot's export of the player's state; any other's name, type and size only.
   */
  document?: InboundDocument;
  /** In the private chat with the bot, where everything is the owner's. */
  private: boolean;
  /** It answers one of the owner's turns (a reply to it, or the first after it in private). */
  answers: boolean;
  /**
   * The command it answers, as the spec names it (a turn command, or one of `spec.commands`),
   * when it answers one (bot-os.md D132).
   */
  command?: string;
  /** It replies to a message, whichever (a turn of a device the account missed, or another command). */
  replies: boolean;
  /** the owner's username, without `@`, once the account knows it. */
  self: string | undefined;
}

/**
 * A turn's outcome, as its grammar reads it: its kind (`nothing` for a turn that brought nothing,
 * with the `reason`, such as `cooldown` for a "too soon"), its bot, and whatever else it says.
 */
export interface TurnOutcome {
  kind: string;
  bot: string;
  reason?: string;
}

/**
 * What a command's success does to another command's hold (bot-os.md D132): ends it (`clear`, a
 * reset: the command is ready at once) or takes `shortenMin` minutes off it.
 */
export interface CommandEffect {
  /** The command whose hold it changes, by first word: a turn command, or one of the spec's. */
  command: string;
  clear?: true;
  shortenMin?: number;
}

/**
 * A command's mechanics, as its game's grammar declares them (bot-os.md D132): data, in generic
 * terms, from which its parser tracks when it is ready.
 */
export interface CommandMechanics {
  /** Usable once per period after a success, in minutes (a daily command's: 1440). */
  cooldownMin?: number;
  /**
   * Usable only once announced: held from the start and after each success, until a message of the
   * bot (in private, or answering the owner) matches `pattern` (a regular expression on its text,
   * as written: case counts) or a reading names it in its `unlocks`; then for `forMin` minutes if
   * given, else until its next success.
   */
  unlock?: { pattern?: string; forMin?: number };
  /** What its success does to other commands' holds. */
  effects?: readonly CommandEffect[];
}

/**
 * What a grammar makes of a message: read, claimed and unread, or not its business. A reading may
 * say what the message announces (bot-os.md D132): the commands it unlocks, and its effects on
 * holds, whatever command it answers.
 */
export type TurnReading =
  | {
      outcome: TurnOutcome;
      /**
       * The rest it starts, from the message's time: the bot's, after a turn; after another
       * command, that command's own hold (its wait, a "too soon").
       */
      restMs?: number;
      /** The commands it unlocks (`CommandMechanics.unlock`), by first word. */
      unlocks?: readonly string[];
      /** Its effects on commands' holds, as a success's (`CommandMechanics.effects`). */
      effects?: readonly CommandEffect[];
    }
  | { unread: true }
  | undefined;

export interface TurnParserSpec {
  /** The plugin's id, and its namespace. */
  id: string;
  /** Its bot's username, without `@`. */
  bot: string;
  description: string;
  /**
   * Its bot's turn commands, by first word (`/play`), each counted bare or addressed to its bot:
   * which commands are turns is a fact of the game, so the grammar says it, not a node's config
   * (bot-os.md D70). They share one readiness: the bot's rest.
   */
  turnCommands: readonly string[];
  /**
   * Its bot's other commands that a player may play, by first word, with their mechanics
   * (bot-os.md D132): a once-a-day command, one the bot unlocks by an announcement, one that resets
   * the turn's wait. None: turns only, as before.
   */
  commands?: Readonly<Record<string, CommandMechanics>>;
  read(m: BotMessage): TurnReading;
}

/** A turn command, as a spec names it: its first word. */
const TURN_COMMAND = /^\/\w+$/u;

/** Until when the bot rests, and why. */
export interface Rest {
  until: number;
  why: string;
}

/** A turn of the owner's, as its parser knows it: when, and the network's id of the message. */
export interface LastTurn {
  t: number;
  id?: string;
}

/**
 * A command's readiness (bot-os.md D132): ready, since when (none: since ever, as far as its
 * parser knows); or held, until when (none: until the bot unlocks it) and why. With its last send,
 * by hand (the owner's, from any device) or its player's, and the last answer read to it, with its
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

/** A send of a command, as its player tells its parser. */
export interface SentCommand {
  chat: string;
  id?: string;
  t: number;
  /** The command sent, by first word; a turn (its first turn command) when not given. */
  command?: string;
}

/** The interface a player uses of its parser (a contract, docs/bot-os-api.md §2.1). */
export interface TurnParserInterface {
  state: {
    rest(): Rest | undefined;
    lastTurn(): LastTurn | undefined;
    ready(): Record<string, Readiness>;
  };
  actions: { sent(sent: SentCommand): void };
}

/** The members of the contract, as an input names them. */
export const TURN_PARSER_MEMBERS = ['state.rest', 'state.lastTurn', 'state.ready', 'actions.sent'];

/** How long after a turn the first message of the bot in private still answers it. */
export const ANSWER_WINDOW_MS = 2 * 60_000;
/** How many of the owner's turns are kept, to match replies to. */
const KEPT_TURNS = 100;
/**
 * The store's document of what it parsed: the owner's recent sends, its bot's rest, and its
 * commands' state.
 */
export const PARSED_DOC = 'parsed';

/** A command's state, as it keeps it. */
interface CommandState {
  /** Its last send, and whether by hand. */
  sent?: { t: number; byHand: boolean };
  /** The last answer read to it. */
  answer?: { t: number; length: number };
  /** Not one of the turns: held until then, and why (none: not held). */
  readyAt?: number;
  why?: string;
  /** Unlocked (an unlockable command), since then, and until then if it lapses. */
  unlocked?: { at: number; until?: number };
}

/** What it keeps of what it parsed, to resume from at its next start. */
interface Parsed {
  /**
   * The owner's sends: `private`, in the private chat with its bot; `command`, the command (a
   * turn's when unset); `byHand`, sent by the owner rather than told by its player.
   */
  turns: {
    chat: string;
    id?: string;
    t: number;
    answered: boolean;
    private?: boolean;
    command?: string;
    byHand?: boolean;
  }[];
  rest?: Rest;
  /** Each command's state, by its name in the spec. */
  commands?: Record<string, CommandState>;
}

const outcomeSchema = z.looseObject({ kind: z.string(), bot: z.string() });

/** The command `text` is, of `commands`, bare or addressed to `bot`, as `commands` names it. */
export function commandOf(
  text: string,
  commands: readonly string[],
  bot: string
): string | undefined {
  const m = /^(\/\w+)(?:@(\w+))?$/u.exec(text.trim());
  if (m === null) return undefined;
  if (m[2] !== undefined && m[2].toLowerCase() !== bot.toLowerCase()) return undefined;
  return commands.find((c) => c.toLowerCase() === (m[1] as string).toLowerCase());
}

/** Whether `text` is one of `commands`, bare or addressed to `bot`. */
export function isTurnCommand(text: string, commands: readonly string[], bot: string): boolean {
  return commandOf(text, commands, bot) !== undefined;
}

/** What is wrong with a spec's other commands, or undefined (bot-os.md D132). */
function commandsProblem(spec: TurnParserSpec): string | undefined {
  const turns = spec.turnCommands.map((c) => c.toLowerCase());
  const extra = Object.keys(spec.commands ?? {});
  const all = [...turns, ...extra.map((c) => c.toLowerCase())];
  for (const [command, m] of Object.entries(spec.commands ?? {})) {
    if (!TURN_COMMAND.test(command)) return `${command} is not a command, as /daily`;
    if (turns.includes(command.toLowerCase()))
      return `${command} is a turn command: its readiness is the rest's`;
    if (m.cooldownMin !== undefined && !(m.cooldownMin > 0))
      return `${command}: cooldownMin must be over 0`;
    if (m.unlock?.forMin !== undefined && !(m.unlock.forMin > 0))
      return `${command}: unlock.forMin must be over 0`;
    if (m.unlock?.pattern !== undefined)
      try {
        new RegExp(m.unlock.pattern, 'u');
      } catch (e) {
        return `${command}: unlock.pattern: ${e instanceof Error ? e.message : String(e)}`;
      }
    for (const effect of m.effects ?? []) {
      if (!all.includes(effect.command.toLowerCase()))
        return `${command}: its effect names ${effect.command}, not one of its commands`;
      if (effect.clear !== true && !((effect.shortenMin ?? 0) > 0))
        return `${command}: an effect clears its command's hold or shortens it (shortenMin over 0)`;
    }
  }
  return undefined;
}

/**
 * A parser plugin of one game bot, from its grammar (`spec`, code a game gives). Its default edge
 * reads the private chat with its bot; an edge of the graph that also reads the game's group (its
 * id) has it read the turns the owner plays there by hand.
 */
export function turnParserPlugin(spec: TurnParserSpec): Plugin {
  const privateChat = `@${spec.bot}`;
  const turnCommands = [...spec.turnCommands];
  const bad = turnCommands.filter((c) => !TURN_COMMAND.test(c));
  if (turnCommands.length === 0 || bad.length > 0)
    throw new Error(
      `turn parser ${spec.id}: expected its turn commands, as /play, not ${JSON.stringify(turnCommands)}`
    );
  const problem = commandsProblem(spec);
  if (problem !== undefined) throw new Error(`turn parser ${spec.id}: ${problem}`);
  const mechanics: Readonly<Record<string, CommandMechanics>> = spec.commands ?? {};
  const others = Object.keys(mechanics);
  const all = [...turnCommands, ...others];
  /** A command as the spec names it, of any spelling; undefined if it declares none such. */
  const named = (c: string): string | undefined =>
    all.find((x) => x.toLowerCase() === c.toLowerCase());
  const isTurn = (c: string | undefined): boolean =>
    c === undefined || turnCommands.some((x) => x.toLowerCase() === c.toLowerCase());
  const patterns = others.flatMap((c) => {
    const pattern = mechanics[c]?.unlock?.pattern;
    return pattern === undefined ? [] : [{ command: c, re: new RegExp(pattern, 'u') }];
  });
  const answer = (
    event: string,
    commands: string[],
    extra: Partial<AnswerDeclarationInput>
  ): AnswerDeclarationInput[] => [
    {
      event,
      commands,
      when: { ...extra.when, 'outcome.kind': 'nothing', 'outcome.reason': 'cooldown' },
      status: 'refused',
      reason: 'cooldown',
      retryAtFrom: 'retryAt',
      holdsAtFrom: 'holds',
      withinS: ANSWER_WINDOW_MS / 1000,
    },
    {
      event,
      commands,
      ...(extra.when === undefined ? {} : { when: extra.when }),
      unless: { 'outcome.kind': 'unknown' },
      status: 'ok',
      reason: 'rest',
      retryAtFrom: 'retryAt',
      holdsAtFrom: 'holds',
      withinS: ANSWER_WINDOW_MS / 1000,
    },
  ];
  const holdsSchema = z
    .record(z.string(), z.number())
    .optional()
    .describe('The holds an effect set, by command (ms): ended or shortened (D132)');
  const playbackSchema = z
    .literal(true)
    .optional()
    .describe('Read from history (a message missed while down), not news: act on none');
  const readinessSchema = z.object({
    ready: z.boolean(),
    since: z.number().optional(),
    until: z.number().optional(),
    why: z.string().optional(),
    sent: z.object({ t: z.number(), byHand: z.boolean() }).optional(),
    answer: z.object({ t: z.number(), length: z.number() }).optional(),
  });
  return definePlugin({
    manifest: {
      id: spec.id,
      version: '0.1.0',
      kinds: ['parser'],
      description: spec.description,
      // The answers it read since the last summary, by outcome, for the owner (bot-os.md D92).
      summary: true,
      games: { registers: [spec.id] },
      events: {
        [`${spec.id}.turn`]: z
          .object({
            chat: z.string(),
            outcome: outcomeSchema,
            playback: playbackSchema,
            retryAt: z
              .number()
              .optional()
              .describe('When the bot rests until, as this answer says (ms): its next turn then'),
            holds: holdsSchema,
          })
          .describe(`What @${spec.bot} answered to a turn of the owner's, as its grammar reads it`),
        ...(others.length === 0
          ? {}
          : {
              [`${spec.id}.answer`]: z
                .object({
                  chat: z.string(),
                  command: z.string().describe('The command it answers, by first word'),
                  outcome: outcomeSchema,
                  playback: playbackSchema,
                  retryAt: z
                    .number()
                    .optional()
                    .describe('When the command may go again, as this answer says (ms)'),
                  holds: holdsSchema,
                })
                .describe(
                  `What @${spec.bot} answered to another command of the owner's, as its grammar reads it`
                ),
            }),
      },
      // Its turn event answers a turn (D98): a "too soon" refuses it, any other reading takes it;
      // its answer event each of its other commands the same way, each holding back its own (D132).
      answers: [
        ...answer(`${spec.id}.turn`, turnCommands, {}),
        ...others.flatMap((c) => answer(`${spec.id}.answer`, [c], { when: { command: c } })),
      ],
      inputs: {
        chat: {
          type: 'chat-in',
          network: 'telegram',
          help: `the owner's own account: the private chat with @${spec.bot}, and the game's group if the edge reads it`,
          bind: { node: TELEGRAM_USER, reads: [privateChat], senders: [privateChat, ME] },
        },
      },
      interface: {
        state: {
          rest: {
            help: `Until when @${spec.bot} rests, as its last answer said`,
            output: z.object({ until: z.number(), why: z.string() }).optional(),
          },
          lastTurn: {
            help: `The owner's last turn with @${spec.bot}, in private or in the group: by hand, from any device, or its player's`,
            output: z.object({ t: z.number(), id: z.string().optional() }).optional(),
          },
          ready: {
            help: `Each command of @${spec.bot}'s that it knows: ready since when, or held until when and why; its last send, by hand or not, and its last answer`,
            output: z.record(z.string(), readinessSchema),
          },
        },
        actions: {
          sent: {
            help: 'A command sent by its player, whose answer it matches: a turn when it names none',
            input: z.object({
              chat: z.string(),
              id: z.string().optional(),
              t: z.number(),
              command: z.string().optional(),
            }),
          },
        },
      },
    },
    create: (ctx) => {
      const handle = ctx.connector('chat');
      /** The answers read live (not history), by their outcome's kind; `unknown`, unread. */
      const read = new Tally(ctx.clock);
      ctx.summary?.contribute((w) => {
        const kinds = read.counts(w);
        const total = kinds.reduce((sum, [, n]) => sum + n, 0);
        if (total === 0) return [];
        const each = kinds.map(([kind, n]) => `${n} ${kind}`).join(', ');
        return [`${counted(total, 'answer')} to turns read: ${each}`];
      });
      /** the owner's sends, newest last: chat, id, time, command, and whether something answered it. */
      const kept = ctx.store.read<Parsed>(PARSED_DOC);
      const turns: Parsed['turns'] = kept?.turns ?? [];
      let rest: Rest | undefined = kept?.rest;
      const state: Record<string, CommandState> = kept?.commands ?? {};
      const of = (c: string): CommandState => (state[c] ??= {});
      const keep = (): void =>
        ctx.store.write(PARSED_DOC, {
          turns,
          ...(rest === undefined ? {} : { rest }),
          ...(Object.keys(state).length === 0 ? {} : { commands: state }),
        });
      const remember = (
        sent: { chat: string; id?: string; t: number; command: string; byHand: boolean },
        inPrivate: boolean
      ): void => {
        if (sent.id !== undefined && turns.some((x) => x.chat === sent.chat && x.id === sent.id))
          return;
        turns.push({ ...sent, answered: false, private: inPrivate });
        if (turns.length > KEPT_TURNS) turns.shift();
        const s = of(sent.command);
        if (s.sent === undefined || sent.t >= s.sent.t) s.sent = { t: sent.t, byHand: sent.byHand };
        keep();
      };
      /** The send `m` answers, marked answered; undefined if none. */
      const answered = (m: Inbound): Parsed['turns'][number] | undefined => {
        let turn: Parsed['turns'][number] | undefined;
        if (m.replyTo !== undefined)
          turn = turns.find((x) => x.chat === m.chat && x.id === m.replyTo);
        else if (isPrivate(m)) {
          const last = turns.findLast((x) => x.chat === m.chat);
          if (last !== undefined && !last.answered && m.time - last.t <= ANSWER_WINDOW_MS)
            turn = last;
        }
        if (turn === undefined) return undefined;
        turn.answered = true;
        const s = of(turn.command ?? (turnCommands[0] as string));
        s.answer = { t: m.time, length: m.text.trim().length };
        keep();
        return turn;
      };
      /** A command unlocked at `t`, by an announcement (D132). */
      const unlock = (command: string, t: number): void => {
        const c = named(command);
        const forMin = c === undefined ? undefined : mechanics[c]?.unlock?.forMin;
        if (c === undefined || mechanics[c]?.unlock === undefined) return;
        of(c).unlocked = { at: t, ...(forMin === undefined ? {} : { until: t + forMin * 60_000 }) };
      };
      /**
       * Applies effects on holds at `t` (D132): each command's hold ended or shortened. The holds
       * set, by command, for the outbox (every turn command, for the rest they share).
       */
      const apply = (
        effects: readonly CommandEffect[],
        t: number,
        by: string
      ): Record<string, number> => {
        const holds: Record<string, number> = {};
        for (const effect of effects) {
          const c = named(effect.command);
          if (c === undefined) continue;
          const cut = (until: number): number =>
            effect.clear === true ? t : Math.max(t, until - (effect.shortenMin ?? 0) * 60_000);
          if (isTurn(c)) {
            if (rest === undefined || rest.until <= t) continue;
            rest = { until: cut(rest.until), why: `${rest.why}, cut by ${by}` };
            for (const x of turnCommands) holds[x] = rest.until;
          } else {
            const s = of(c);
            if (s.readyAt === undefined || s.readyAt <= t) continue;
            s.readyAt = cut(s.readyAt);
            s.why = `${s.why ?? 'held'}, cut by ${by}`;
            holds[c] = s.readyAt;
          }
        }
        return holds;
      };
      handle.onMessage((m) => {
        if (m.own === true) {
          const command = commandOf(m.text, all, spec.bot);
          if (command !== undefined)
            remember(
              {
                chat: m.chat,
                ...(m.id === undefined ? {} : { id: m.id }),
                t: m.time,
                command,
                byHand: true,
              },
              isPrivate(m)
            );
          return;
        }
        if (m.sender.toLowerCase() !== spec.bot.toLowerCase()) return;
        const turn = answered(m);
        const command = turn === undefined ? undefined : (turn.command ?? turnCommands[0]);
        // An announcement unlocks a command (D132), whatever the grammar makes of its message.
        if (isPrivate(m) || turn !== undefined) {
          let changed = false;
          for (const p of patterns)
            if (p.re.test(m.text)) {
              unlock(p.command, m.time);
              changed = true;
            }
          if (changed) keep();
        }
        const reading = spec.read({
          text: m.text,
          private: isPrivate(m),
          answers: turn !== undefined,
          ...(command === undefined ? {} : { command }),
          replies: m.replyTo !== undefined,
          self: handle.self(),
          ...(m.document === undefined ? {} : { document: m.document }),
        });
        if (reading === undefined) return;
        // History, not news (bot-os.md D83): a message missed while down, or played back.
        const old = m.playback ? { playback: true } : {};
        const asTurn = isTurn(command);
        const event = asTurn ? `${spec.id}.turn` : `${spec.id}.answer`;
        const which = asTurn ? {} : { command: command as string };
        if (!m.playback && asTurn) read.add('unread' in reading ? 'unknown' : reading.outcome.kind);
        if ('unread' in reading) {
          ctx.drift.unread({ text: m.text, t: m.time });
          ctx.bus.publish(
            event,
            {
              chat: m.chat,
              ...which,
              outcome: { kind: 'unknown', bot: spec.bot, text: m.text.trim() },
              ...old,
            },
            m.time
          );
          return;
        }
        ctx.drift.read(m.time);
        const t = m.time;
        let retryAt = reading.restMs === undefined ? undefined : t + reading.restMs;
        const tooSoon = reading.outcome.kind === 'nothing' && reading.outcome.reason === 'cooldown';
        const effects: CommandEffect[] = [...(reading.effects ?? [])];
        if (asTurn) {
          if (retryAt !== undefined && (rest === undefined || retryAt > rest.until))
            rest = { until: retryAt, why: whyOf(reading.outcome) };
        } else {
          const c = command as string;
          const mech = mechanics[c] ?? {};
          const s = of(c);
          if (!tooSoon) {
            // A success: its cooldown, its unlock used up, its effects (D132).
            const cooldown =
              mech.cooldownMin === undefined ? undefined : t + mech.cooldownMin * 60_000;
            if (cooldown !== undefined && (retryAt === undefined || cooldown > retryAt))
              retryAt = cooldown;
            if (mech.unlock !== undefined) delete s.unlocked;
            effects.unshift(...(mech.effects ?? []));
          }
          if (retryAt !== undefined) {
            s.readyAt = retryAt;
            s.why = tooSoon
              ? 'it said too soon'
              : reading.restMs === undefined
                ? 'its cooldown'
                : whyOf(reading.outcome);
          }
        }
        for (const u of reading.unlocks ?? []) unlock(u, t);
        const holds = apply(effects, t, command ?? 'an answer');
        keep();
        ctx.bus.publish(
          event,
          {
            chat: m.chat,
            ...which,
            outcome: reading.outcome,
            ...(retryAt === undefined ? {} : { retryAt }),
            ...(Object.keys(holds).length === 0 ? {} : { holds }),
            ...old,
          },
          m.time
        );
      });
      /** A command's readiness now (D132). */
      const readiness = (c: string, now: number): Readiness => {
        const s = state[c] ?? {};
        const seen = {
          ...(s.sent === undefined ? {} : { sent: s.sent }),
          ...(s.answer === undefined ? {} : { answer: s.answer }),
        };
        if (isTurn(c)) {
          if (rest !== undefined && rest.until > now)
            return { ready: false, until: rest.until, why: rest.why, ...seen };
          return { ready: true, ...(rest === undefined ? {} : { since: rest.until }), ...seen };
        }
        const mech = mechanics[c] ?? {};
        if (mech.unlock !== undefined) {
          const u = s.unlocked;
          if (u === undefined) return { ready: false, why: 'waits for an unlock', ...seen };
          if (u.until !== undefined && u.until <= now)
            return { ready: false, why: 'its unlock lapsed', ...seen };
        }
        if (s.readyAt !== undefined && s.readyAt > now)
          return { ready: false, until: s.readyAt, why: s.why ?? 'held', ...seen };
        const since = Math.max(s.readyAt ?? -Infinity, s.unlocked?.at ?? -Infinity);
        return { ready: true, ...(Number.isFinite(since) ? { since } : {}), ...seen };
      };
      const iface: TurnParserInterface = {
        state: {
          rest: () => (rest !== undefined && rest.until > ctx.clock.now() ? rest : undefined),
          lastTurn: () => {
            // A turn is a turn, in private or in the group (D129).
            const last = turns
              .filter((x) => isTurn(x.command))
              .reduce<Parsed['turns'][number] | undefined>(
                (a, x) => (a === undefined || x.t >= a.t ? x : a),
                undefined
              );
            return last === undefined
              ? undefined
              : { t: last.t, ...(last.id === undefined ? {} : { id: last.id }) };
          },
          ready: () => {
            const now = ctx.clock.now();
            return Object.fromEntries(all.map((c) => [c, readiness(c, now)]));
          },
        },
        // Its player sends to its bot's private chat alone (D97).
        actions: {
          sent: (sent) => {
            const command = named(sent.command ?? (turnCommands[0] as string));
            if (command === undefined) return;
            remember(
              {
                chat: sent.chat,
                ...(sent.id === undefined ? {} : { id: sent.id }),
                t: sent.t,
                command,
                byHand: false,
              },
              true
            );
          },
        },
      };
      return { interface: iface };
    },
  });
}

/**
 * Whether `m` is in a private chat: as its connector says (`Inbound.private`), since a private
 * chat configured by id (as the chat picker keeps it) is delivered under its id (bot-os.md D90);
 * else, from a connector that does not say, by its name, a private chat's being a `@username`.
 */
export function isPrivate(m: Pick<Inbound, 'chat' | 'private'>): boolean {
  return m.private ?? m.chat.startsWith('@');
}

/** Why the bot rests, in the owner's words. */
function whyOf(o: TurnOutcome): string {
  if (o.kind === 'nothing' && o.reason !== undefined)
    return o.reason === 'cooldown' ? 'it said too soon' : o.reason;
  return 'its rest after a turn';
}
