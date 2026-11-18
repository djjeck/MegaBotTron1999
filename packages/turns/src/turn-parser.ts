/**
 * The base of the game bots' parser plugins (docs/bot-os-api.md §5): one plugin per bot, each
 * made by `turnParserPlugin` from its bot's grammar, which knows the game (the shell does not: a
 * reading's outcome is the grammar's, of any shape with a `kind` and a `bot`). A parser turns its
 * bot's messages into events, and nothing else (bot-os.md D141): what the events mean for when a
 * command may be played is a state's (`src/readiness.ts`). Each reads, through the owner's account
 * (`telegram-user`), the private chat with its bot and, optionally, a group, and:
 *
 * - knows its bot's **vocabulary**: its turn (`spec.turnCommands`, a fact of the game, not of a
 *   node's config: bot-os.md D70; its name, then its aliases, D140) and its other commands
 *   (`spec.commands`, each with its aliases, D132, D140). Any alias, bare or addressed to its bot,
 *   is its command, named by its name in every event;
 * - knows the owner's sends of them: by hand (from any device, which the account sees), and those a
 *   player sends (told through `actions.sent`, since the account never sees its own sends come
 *   back), each published as `<id>.sent`;
 * - tells which of its bot's messages answer one: a reply to it, or, in the private chat, where
 *   every message is the owner's, the first message within two minutes of it;
 * - publishes what it reads as `<id>.turn`, the outcome of a turn, or `<id>.answer`, that of
 *   another command, each with the wait the bot stated (`retryAt`), the commands the message
 *   announces unlocked (`unlocks`) and its effects on other commands' holds (`effects`), and, when
 *   it answers a send, the answer's length (`answer`); a message it claims and cannot read is
 *   reported to drift (P5) and published with the outcome `unknown`; one the grammar leaves that
 *   answers a send or announces an unlock, as `<id>.reply` (marked `playback` when the message was
 *   history: missed while down, bot-os.md D83);
 * - declares its `<id>.turn` an answer to its turn (bot-os.md D98): `refused` with `cooldown` for a
 *   "too soon", `ok` for any other outcome read (not an unread one), each with its `retryAt`, so
 *   that a turn queued by any node settles with what the bot answered, and the outbox holds the
 *   next one back until the bot's rest is over; its `<id>.answer` the same way to each of its other
 *   commands, and both with the holds the effects the bot announced set (`holds`), so that a reset
 *   the bot announces ends the outbox's cooldown too.
 *
 * It keeps nothing in its factory's closure: everything hangs off its instance (§2.1). It resumes
 * from its own records (bot-os.md D62): the owner's recent sends and the waits it told the outbox,
 * kept in its store as they change, and never re-reads the chat; what was said while the instance
 * was down comes from the connector's catch-up, once, as missed messages (`playback`, `missed`),
 * which it reads as any other.
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
  /** It answers one of the owner's sends (a reply to it, or the first after it in private). */
  answers: boolean;
  /**
   * The command it answers, by its name in the spec (the first turn command, or a key of
   * `spec.commands`), whichever of its aliases was sent (bot-os.md D132, D140), when it answers
   * one.
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
 * What a message does to a command's hold (bot-os.md D132), as the bot announces it or, on the
 * state's side, as a command's success does: ends it (`clear`, a reset: the command is ready at
 * once) or takes `shortenMin` minutes off it.
 */
export interface CommandEffect {
  /** The command whose hold it changes: its name, or one of its aliases (D140). */
  command: string;
  clear?: true;
  shortenMin?: number;
}

/**
 * The words of one of the bot's other commands (bot-os.md D141): what the parser needs to know it
 * when it is sent and when the bot announces it. Its mechanics are its state's (`src/readiness.ts`).
 */
export interface CommandWords {
  /**
   * The other names the bot takes it by (bot-os.md D140), in order: one command, whichever is
   * sent (`/boost`, `/b`); never addressed, a player adds `@<bot>` itself.
   */
  aliases?: readonly string[];
  /**
   * A message of the bot (in private, or answering the owner) that matches it announces the
   * command unlocked (a regular expression on its text, as written: case counts), whatever the
   * grammar makes of the message: published in `unlocks`.
   */
  announcedBy?: string;
}

/**
 * A bot's vocabulary (bot-os.md D141): its username, its turn and its other commands, each with
 * its aliases. Its parser's, and given to its readiness state too, which keys each command's
 * readiness by its name.
 */
export interface BotVocabulary {
  /** Its bot's username, without `@`. */
  bot: string;
  /**
   * Its bot's turn, by first word (`/play`): its name first, then its aliases (bot-os.md D140:
   * `['/play', '/quest']`, one turn), each counted bare or addressed to its bot. Which commands are
   * the turn is a fact of the game, so the grammar says it, not a node's config (bot-os.md D70).
   */
  turnCommands: readonly string[];
  /**
   * Its bot's other commands that a player may play, by first word (bot-os.md D132): a
   * once-a-day command, one the bot unlocks by an announcement, one that resets the turn's wait;
   * each with its `aliases` (D140). None: turns only.
   */
  commands?: Readonly<Record<string, CommandWords>>;
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
       * The wait it states, from the message's time: the bot's rest, after a turn; after another
       * command, that command's own (its wait, a "too soon").
       */
      restMs?: number;
      /** The commands it unlocks, by name or alias. */
      unlocks?: readonly string[];
      /** Its effects on commands' holds. */
      effects?: readonly CommandEffect[];
    }
  | { unread: true }
  | undefined;

export interface TurnParserSpec extends BotVocabulary {
  /** The plugin's id, and its namespace. */
  id: string;
  description: string;
  read(m: BotMessage): TurnReading;
}

/** A command, as a spec names it: its first word. */
const COMMAND = /^\/\w+$/u;

/**
 * A send of a command, as a player tells its parser (through its state, D141): its own, or one of
 * another player of the same account (bot-os.md D139, D140), which counts only if it reaches this
 * parser's bot.
 */
export interface SentCommand {
  chat: string;
  id?: string;
  t: number;
  /**
   * The command sent, as sent: bare (`/play`) or addressed (`/play@QuestBot`); a turn (its first
   * turn command) when not given. Addressed to another bot, it is not this bot's.
   */
  command?: string;
}

/** The interface of a parser (a contract, docs/bot-os-api.md §2.1): the sends it is told of. */
export interface TurnParserInterface {
  actions: { sent(sent: SentCommand): void };
}

/** The members of the contract, as an input names them. */
export const TURN_PARSER_MEMBERS = ['actions.sent'];

/** How long after a send the first message of the bot in private still answers it. */
export const ANSWER_WINDOW_MS = 2 * 60_000;
/** How many of the owner's sends are kept, to match replies to. */
const KEPT_SENDS = 100;
/** The store's document of what it parsed: the owner's recent sends, and the waits it told. */
export const PARSED_DOC = 'parsed';

/** What it keeps of what it parsed, to resume from at its next start. */
interface Parsed {
  /**
   * The owner's sends: `command`, the command by its name; `byHand`, sent by the owner rather than
   * told by a player.
   */
  sends: {
    chat: string;
    id?: string;
    t: number;
    answered: boolean;
    command: string;
    byHand: boolean;
  }[];
  /**
   * The last wait it told the outbox of each command, by its name (its answers' `retryAt`): what
   * an effect the bot announces shortens.
   */
  told?: Record<string, number>;
}

const outcomeSchema = z.looseObject({ kind: z.string(), bot: z.string() });

/** A command as a list names it: its name alone, or with its aliases (D140). */
export type CommandNames = string | { command: string; aliases?: readonly string[] | undefined };

/** A command's names (D140): its own, then its aliases, in order. */
export function namesOf(c: CommandNames): string[] {
  return typeof c === 'string' ? [c] : [c.command, ...(c.aliases ?? [])];
}

/**
 * The command `text` is, of `commands`, by its name or an alias, bare or addressed to `bot`: its
 * name (D140), as `commands` gives it.
 */
export function commandOf(
  text: string,
  commands: readonly CommandNames[],
  bot: string
): string | undefined {
  const m = /^(\/\w+)(?:@(\w+))?$/u.exec(text.trim());
  if (m === null) return undefined;
  if (m[2] !== undefined && m[2].toLowerCase() !== bot.toLowerCase()) return undefined;
  const word = (m[1] as string).toLowerCase();
  const c = commands.find((x) => namesOf(x).some((n) => n.toLowerCase() === word));
  return c === undefined ? undefined : namesOf(c)[0];
}

/** Whether `text` is one of `commands`, bare or addressed to `bot`. */
export function isTurnCommand(
  text: string,
  commands: readonly CommandNames[],
  bot: string
): boolean {
  return commandOf(text, commands, bot) !== undefined;
}

/** A vocabulary's commands, the turn first, each by its name with its aliases (D140). */
export function vocabularyCommands(v: BotVocabulary): { command: string; aliases: string[] }[] {
  const [turn = '', ...aliases] = v.turnCommands;
  return [
    { command: turn, aliases },
    ...Object.entries(v.commands ?? {}).map(([command, w]) => ({
      command,
      aliases: [...(w.aliases ?? [])],
    })),
  ];
}

/**
 * What is wrong with a vocabulary, or undefined (bot-os.md D132, D140): a turn, every name a
 * command's first word, no name or alias twice (any case), each announcement a regular expression.
 */
export function vocabularyProblem(v: BotVocabulary): string | undefined {
  const turns = [...v.turnCommands];
  if (turns.length === 0 || turns.some((c) => !COMMAND.test(c)))
    return `expected its turn commands, as /play, not ${JSON.stringify(turns)}`;
  const all = vocabularyCommands(v).flatMap((c) => namesOf(c).map((n) => n.toLowerCase()));
  const twice = all.find((n, i) => all.indexOf(n) !== i);
  for (const [command, w] of Object.entries(v.commands ?? {})) {
    if (!COMMAND.test(command)) return `${command} is not a command, as /daily`;
    for (const alias of w.aliases ?? [])
      if (!COMMAND.test(alias)) return `${command}: its alias ${alias} is not a command, as /d`;
    if (w.announcedBy !== undefined)
      try {
        new RegExp(w.announcedBy, 'u');
      } catch (e) {
        return `${command}: announcedBy: ${e instanceof Error ? e.message : String(e)}`;
      }
  }
  if (twice !== undefined) return `${twice} names two commands, or one twice`;
  return undefined;
}

/**
 * A parser plugin of one game bot, from its grammar (`spec`, code a game gives). Its default edge
 * reads the private chat with its bot; an edge of the graph that also reads the game's group (its
 * id) has it read the sends the owner makes there by hand.
 */
export function turnParserPlugin(spec: TurnParserSpec): Plugin {
  const privateChat = `@${spec.bot}`;
  const problem = vocabularyProblem(spec);
  if (problem !== undefined) throw new Error(`turn parser ${spec.id}: ${problem}`);
  /** Each command by its name with its aliases (D140): the turn first. */
  const commands = vocabularyCommands(spec);
  const others = commands.slice(1).map((c) => c.command);
  /** The turn's name: its first turn command (D140). */
  const turn = spec.turnCommands[0] as string;
  /** A command by its name, of any spelling, or an alias's (D140); undefined if none such. */
  const named = (c: string): string | undefined => commandOf(c, commands, spec.bot);
  /** A command's every form (D140): each of its names, bare and addressed to its bot. */
  const formsOf = (c: string): string[] => {
    const names = namesOf(commands.find((x) => x.command === c) ?? c);
    return [...names, ...names.map((n) => `${n}@${spec.bot}`)];
  };
  const patterns = Object.entries(spec.commands ?? {}).flatMap(([command, w]) =>
    w.announcedBy === undefined ? [] : [{ command, re: new RegExp(w.announcedBy, 'u') }]
  );
  // Each command answered by any of its names, bare or addressed to its bot (D139, D140), as a
  // player may send it.
  const answer = (
    event: string,
    command: string,
    when: Record<string, unknown> | undefined
  ): AnswerDeclarationInput[] => {
    const forms = formsOf(command);
    const common = {
      event,
      commands: forms,
      retryAtFrom: 'retryAt',
      holdsAtFrom: 'holds',
      withinS: ANSWER_WINDOW_MS / 1000,
    };
    return [
      {
        ...common,
        when: { ...when, 'outcome.kind': 'nothing', 'outcome.reason': 'cooldown' },
        status: 'refused',
        reason: 'cooldown',
      },
      {
        ...common,
        ...(when === undefined ? {} : { when }),
        unless: { 'outcome.kind': 'unknown' },
        status: 'ok',
        reason: 'rest',
      },
    ];
  };
  const playbackSchema = z
    .literal(true)
    .optional()
    .describe('Read from history (a message missed while down), not news: act on none');
  const announced = {
    unlocks: z
      .array(z.string())
      .optional()
      .describe('The commands the message announces unlocked, by name'),
    effects: z
      .array(
        z.object({
          command: z.string(),
          clear: z.literal(true).optional(),
          shortenMin: z.number().optional(),
        })
      )
      .optional()
      .describe("The message's effects on commands' holds, as the bot announces them, by name"),
    answer: z
      .object({ length: z.number().describe('Its length, in characters') })
      .optional()
      .describe('It answers a send of the command'),
    playback: playbackSchema,
  };
  const read = {
    outcome: outcomeSchema,
    retryAt: z
      .number()
      .optional()
      .describe(
        'When the command may go again, as this answer says (ms): the bot rests until then'
      ),
    holds: z
      .record(z.string(), z.number())
      .optional()
      .describe("The outbox's holds the effects set, by form (ms): ended or shortened (D98, D132)"),
  };
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
        [`${spec.id}.sent`]: z
          .object({
            chat: z.string(),
            command: z.string().describe('The command sent, by its name'),
            byHand: z.boolean().describe("The owner's, by hand, rather than a player's"),
            id: z.string().optional().describe("The network's id of the message"),
            playback: playbackSchema,
          })
          .describe(`A command of @${spec.bot}'s sent from the owner's account`),
        [`${spec.id}.turn`]: z
          .object({ chat: z.string(), ...read, ...announced })
          .describe(`What @${spec.bot} answered to a turn of the owner's, as its grammar reads it`),
        ...(others.length === 0
          ? {}
          : {
              [`${spec.id}.answer`]: z
                .object({
                  chat: z.string(),
                  command: z.string().describe('The command it answers, by its name'),
                  ...read,
                  ...announced,
                })
                .describe(
                  `What @${spec.bot} answered to another command of the owner's, as its grammar reads it`
                ),
            }),
        [`${spec.id}.reply`]: z
          .object({
            chat: z.string(),
            command: z.string().optional().describe('The command it answers, by its name'),
            ...announced,
          })
          .describe(
            `A message of @${spec.bot}'s that its grammar does not read, which answers a send or announces an unlock`
          ),
      },
      // Its turn event answers a turn (D98): a "too soon" refuses it, any other reading takes it;
      // its answer event each of its other commands the same way, each holding back its own.
      answers: [
        ...answer(`${spec.id}.turn`, turn, undefined),
        ...others.flatMap((c) => answer(`${spec.id}.answer`, c, { command: c })),
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
        actions: {
          sent: {
            help: "A command sent by a player (its own, or another's of its account), whose answer it matches: a turn when it names none; counted only if it reaches its bot",
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
      /**
       * A chat its edge reads (D139); reading every chat, any but another's private chat (a
       * `@username`), which its bot never sees.
       */
      const reachable = (chat: string): boolean => {
        const reads = handle.reads?.() ?? '*';
        if (reads === '*') return !chat.startsWith('@');
        return reads.some((r) => r.toLowerCase() === chat.toLowerCase());
      };
      /** The answers to turns read live (not history), by their outcome's kind; `unknown`, unread. */
      const tally = new Tally(ctx.clock);
      ctx.summary?.contribute((w) => {
        const kinds = tally.counts(w);
        const total = kinds.reduce((sum, [, n]) => sum + n, 0);
        if (total === 0) return [];
        const each = kinds.map(([kind, n]) => `${n} ${kind}`).join(', ');
        return [`${counted(total, 'answer')} to turns read: ${each}`];
      });
      const kept = ctx.store.read<Parsed>(PARSED_DOC);
      /** The owner's sends, newest last, and whether something answered each. */
      const sends: Parsed['sends'] = kept?.sends ?? [];
      const told: Record<string, number> = kept?.told ?? {};
      const keep = (): void => ctx.store.write(PARSED_DOC, { sends, told } satisfies Parsed);
      /** A send counted: kept to pair its answer with, and published (D141). */
      const remember = (
        sent: Omit<Parsed['sends'][number], 'answered'>,
        playback: boolean
      ): void => {
        if (sent.id !== undefined && sends.some((x) => x.chat === sent.chat && x.id === sent.id))
          return;
        sends.push({ ...sent, answered: false });
        if (sends.length > KEPT_SENDS) sends.shift();
        keep();
        ctx.bus.publish(
          `${spec.id}.sent`,
          {
            chat: sent.chat,
            command: sent.command,
            byHand: sent.byHand,
            ...(sent.id === undefined ? {} : { id: sent.id }),
            ...(playback ? { playback: true } : {}),
          },
          sent.t
        );
      };
      /** The send `m` answers, marked answered; undefined if none. */
      const answered = (m: Inbound): Parsed['sends'][number] | undefined => {
        let sent: Parsed['sends'][number] | undefined;
        if (m.replyTo !== undefined)
          sent = sends.find((x) => x.chat === m.chat && x.id === m.replyTo);
        else if (isPrivate(m)) {
          const last = sends.findLast((x) => x.chat === m.chat);
          if (last !== undefined && !last.answered && m.time - last.t <= ANSWER_WINDOW_MS)
            sent = last;
        }
        if (sent === undefined) return undefined;
        sent.answered = true;
        keep();
        return sent;
      };
      /**
       * The outbox's holds the effects the bot announced set at `t` (D98, D132), by form: a clear
       * ends the command's, a shortening takes its minutes off the last wait told of it.
       */
      const holdsOf = (effects: readonly CommandEffect[], t: number): Record<string, number> => {
        const holds: Record<string, number> = {};
        for (const effect of effects) {
          const at =
            effect.clear === true
              ? t
              : told[effect.command] === undefined || (told[effect.command] as number) <= t
                ? undefined
                : Math.max(t, (told[effect.command] as number) - (effect.shortenMin ?? 0) * 60_000);
          if (at === undefined) continue;
          told[effect.command] = at;
          for (const x of formsOf(effect.command)) holds[x] = at;
        }
        return holds;
      };
      /** Effects by their commands' names (D140); one naming no command of its bot's, dropped. */
      const resolved = (effects: readonly CommandEffect[] | undefined): CommandEffect[] =>
        (effects ?? []).flatMap((e) => {
          const c = named(e.command);
          return c === undefined ? [] : [{ ...e, command: c }];
        });
      handle.onMessage((m) => {
        const old = m.playback ? { playback: true } : {};
        if (m.own === true) {
          const command = named(m.text);
          if (command !== undefined)
            remember(
              {
                chat: m.chat,
                ...(m.id === undefined ? {} : { id: m.id }),
                t: m.time,
                command,
                byHand: true,
              },
              m.playback
            );
          return;
        }
        if (m.sender.toLowerCase() !== spec.bot.toLowerCase()) return;
        const sent = answered(m);
        const command = sent?.command;
        const answer = sent === undefined ? {} : { answer: { length: m.text.trim().length } };
        // An announcement unlocks a command (D132), whatever the grammar makes of its message.
        const heard =
          isPrivate(m) || sent !== undefined
            ? patterns.filter((p) => p.re.test(m.text)).map((p) => p.command)
            : [];
        const reading = spec.read({
          text: m.text,
          private: isPrivate(m),
          answers: sent !== undefined,
          ...(command === undefined ? {} : { command }),
          replies: m.replyTo !== undefined,
          self: handle.self(),
          ...(m.document === undefined ? {} : { document: m.document }),
        });
        const unlocksOf = (more: readonly string[]) => {
          const all = [
            ...new Set(
              [...heard, ...more.flatMap((u) => named(u) ?? [])].filter((c) => c !== turn)
            ),
          ];
          return all.length === 0 ? {} : { unlocks: all };
        };
        if (reading === undefined) {
          if (sent === undefined && heard.length === 0) return;
          ctx.bus.publish(
            `${spec.id}.reply`,
            {
              chat: m.chat,
              ...(command === undefined ? {} : { command }),
              ...answer,
              ...unlocksOf([]),
              ...old,
            },
            m.time
          );
          return;
        }
        const asTurn = command === undefined || command === turn;
        const event = asTurn ? `${spec.id}.turn` : `${spec.id}.answer`;
        const which = asTurn ? {} : { command };
        if (!m.playback && asTurn)
          tally.add('unread' in reading ? 'unknown' : reading.outcome.kind);
        if ('unread' in reading) {
          ctx.drift.unread({ text: m.text, t: m.time });
          ctx.bus.publish(
            event,
            {
              chat: m.chat,
              ...which,
              outcome: { kind: 'unknown', bot: spec.bot, text: m.text.trim() },
              ...answer,
              ...unlocksOf([]),
              ...old,
            },
            m.time
          );
          return;
        }
        ctx.drift.read(m.time);
        const t = m.time;
        const retryAt = reading.restMs === undefined ? undefined : t + reading.restMs;
        const c = command ?? turn;
        if (retryAt !== undefined)
          told[c] = asTurn ? Math.max(told[c] ?? retryAt, retryAt) : retryAt;
        const effects = resolved(reading.effects);
        const holds = holdsOf(effects, t);
        keep();
        ctx.bus.publish(
          event,
          {
            chat: m.chat,
            ...which,
            outcome: reading.outcome,
            ...(retryAt === undefined ? {} : { retryAt }),
            ...(Object.keys(holds).length === 0 ? {} : { holds }),
            ...unlocksOf(reading.unlocks ?? []),
            ...(effects.length === 0 ? {} : { effects }),
            ...answer,
            ...old,
          },
          t
        );
      });
      const iface: TurnParserInterface = {
        actions: {
          // A send reaches its bot (D139) in its private chat, or in a group its edge reads, bare
          // or addressed to it: so a bare turn another player sent in the group is its turn too.
          sent: (s) => {
            const command = s.command === undefined ? turn : named(s.command);
            const inPrivate = s.chat.toLowerCase() === privateChat.toLowerCase();
            if (command === undefined || !(inPrivate || reachable(s.chat))) return;
            remember(
              {
                chat: s.chat,
                ...(s.id === undefined ? {} : { id: s.id }),
                t: s.t,
                command,
                byHand: false,
              },
              false
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
