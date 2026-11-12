/**
 * The base of the game bots' parser plugins (docs/bot-os-api.md §5): one plugin per bot, each
 * made by `turnParserPlugin` from its bot's grammar, which knows the game (the shell does not: a
 * reading's outcome is the grammar's, of any shape with a `kind` and a `bot`). Each reads,
 * through the owner's account (`telegram-user`), the private chat with its bot and, optionally, a
 * group, and:
 *
 * - knows the owner's turns: its game's turn commands (`spec.turnCommands`, a fact of the game, not
 *   of a node's config: bot-os.md D70) that the owner sends by hand (from any device, which the
 *   account sees), and those its turn-actor sends (told through `actions.sent`, since the account
 *   never sees its own sends come back);
 * - tells which of its bot's messages answer one: a reply to it, or, in the private chat, where
 *   every message is the owner's, the first message within two minutes of it;
 * - publishes what it reads as `<id>.turn`, the outcome, and reports to drift (P5) a message it
 *   claims and cannot read, which pauses the turn-actor that requires it past the threshold;
 * - offers `state.rest`: until when its bot rests, as its last answer said (the bot's rest after a
 *   turn, or the wait of a "too soon"), for the actor to wait out.
 *
 * It keeps nothing in its factory's closure: everything hangs off its instance (§2.1). It resumes
 * from its own records (bot-os.md D62): the owner's recent turns and its bot's rest, kept in its
 * store as they change, and never re-reads the chat; what was said while the instance was down
 * comes from the connector's catch-up, once, as missed messages (`playback`, `missed`), which it
 * reads as any other.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import { definePlugin, type Inbound, ME, type Plugin } from '@megabottron1999/core';
import { z } from 'zod';

/** A message of the bot, as its grammar reads it. */
export interface BotMessage {
  /** Its text, as the bot wrote it. */
  text: string;
  /** In the private chat with the bot, where everything is the owner's. */
  private: boolean;
  /** It answers one of the owner's turns (a reply to it, or the first after it in private). */
  answers: boolean;
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

/** What a grammar makes of a message: read, claimed and unread, or not its business. */
export type TurnReading =
  | { outcome: TurnOutcome; /** The rest it starts, from the message's time. */ restMs?: number }
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
   * (bot-os.md D70).
   */
  turnCommands: readonly string[];
  read(m: BotMessage): TurnReading;
}

/** A turn command, as a spec names it: its first word. */
const TURN_COMMAND = /^\/\w+$/u;

/** Until when the bot rests, and why. */
export interface Rest {
  until: number;
  why: string;
}

/** The interface a turn-actor uses of its parser (a contract, docs/bot-os-api.md §2.1). */
export interface TurnParserInterface {
  state: { rest(): Rest | undefined };
  actions: { sent(turn: { chat: string; id?: string; t: number }): void };
}

/** The members of the contract, as an actor's input names them. */
export const TURN_PARSER_MEMBERS = ['state.rest', 'actions.sent'];

/** How long after a turn the first message of the bot in private still answers it. */
export const ANSWER_WINDOW_MS = 2 * 60_000;
/** How many of the owner's turns are kept, to match replies to. */
const KEPT_TURNS = 100;
/** The store's document of what it parsed: the owner's recent turns, and its bot's rest. */
export const PARSED_DOC = 'parsed';

/** What it keeps of what it parsed, to resume from at its next start. */
interface Parsed {
  turns: { chat: string; id?: string; t: number; answered: boolean }[];
  rest?: Rest;
}

const outcomeSchema = z.looseObject({ kind: z.string(), bot: z.string() });

/** Whether `text` is one of `commands`, bare or addressed to `bot`. */
export function isTurnCommand(text: string, commands: readonly string[], bot: string): boolean {
  const m = /^(\/\w+)(?:@(\w+))?$/u.exec(text.trim());
  if (m === null) return false;
  if (m[2] !== undefined && m[2].toLowerCase() !== bot.toLowerCase()) return false;
  return commands.some((c) => c.toLowerCase() === (m[1] as string).toLowerCase());
}

/**
 * A parser plugin of one game bot, from its grammar (`spec`, code a game gives). Its default edge
 * reads the private chat with its bot; an edge of the graph that also reads the game's group (its
 * id) has it read the turns the owner plays there by hand.
 */
export function turnParserPlugin(spec: TurnParserSpec): Plugin {
  const privateChat = `@${spec.bot}`;
  const commands = [...spec.turnCommands];
  const bad = commands.filter((c) => !TURN_COMMAND.test(c));
  if (commands.length === 0 || bad.length > 0)
    throw new Error(
      `turn parser ${spec.id}: expected its turn commands, as /play, not ${JSON.stringify(commands)}`
    );
  return definePlugin({
    manifest: {
      id: spec.id,
      version: '0.1.0',
      kinds: ['parser'],
      description: spec.description,
      games: { registers: [spec.id] },
      events: {
        [`${spec.id}.turn`]: z
          .object({ chat: z.string(), outcome: outcomeSchema })
          .describe(`What @${spec.bot} answered to a turn of the owner's, as its grammar reads it`),
      },
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
        },
        actions: {
          sent: {
            help: 'A turn sent by its actor, whose answer it matches',
            input: z.object({ chat: z.string(), id: z.string().optional(), t: z.number() }),
          },
        },
      },
    },
    create: (ctx) => {
      const handle = ctx.connector('chat');
      /** the owner's turns, newest last: chat, id, time, and whether something answered it. */
      const kept = ctx.store.read<Parsed>(PARSED_DOC);
      const turns: Parsed['turns'] = kept?.turns ?? [];
      let rest: Rest | undefined = kept?.rest;
      const keep = (): void =>
        ctx.store.write(PARSED_DOC, { turns, ...(rest === undefined ? {} : { rest }) });
      const remember = (turn: { chat: string; id?: string; t: number }): void => {
        if (turn.id !== undefined && turns.some((x) => x.chat === turn.chat && x.id === turn.id))
          return;
        turns.push({ ...turn, answered: false });
        if (turns.length > KEPT_TURNS) turns.shift();
        keep();
      };
      const answered = (m: Inbound): boolean => {
        if (m.replyTo !== undefined) {
          const turn = turns.find((x) => x.chat === m.chat && x.id === m.replyTo);
          if (turn === undefined) return false;
          turn.answered = true;
          keep();
          return true;
        }
        if (!m.chat.startsWith('@')) return false;
        const turn = turns.findLast((x) => x.chat === m.chat);
        if (turn === undefined || turn.answered || m.time - turn.t > ANSWER_WINDOW_MS) return false;
        turn.answered = true;
        keep();
        return true;
      };
      handle.onMessage((m) => {
        if (m.own === true) {
          if (isTurnCommand(m.text, commands, spec.bot))
            remember({ chat: m.chat, ...(m.id === undefined ? {} : { id: m.id }), t: m.time });
          return;
        }
        if (m.sender.toLowerCase() !== spec.bot.toLowerCase()) return;
        const reading = spec.read({
          text: m.text,
          private: m.chat.startsWith('@'),
          answers: answered(m),
          replies: m.replyTo !== undefined,
          self: handle.self(),
        });
        if (reading === undefined) return;
        if ('unread' in reading) {
          ctx.drift.unread({ text: m.text, t: m.time });
          ctx.bus.publish(
            `${spec.id}.turn`,
            { chat: m.chat, outcome: { kind: 'unknown', bot: spec.bot, text: m.text.trim() } },
            m.time
          );
          return;
        }
        ctx.drift.read(m.time);
        if (reading.restMs !== undefined) {
          const until = m.time + reading.restMs;
          if (rest === undefined || until > rest.until) {
            rest = { until, why: whyOf(reading.outcome) };
            keep();
          }
        }
        ctx.bus.publish(`${spec.id}.turn`, { chat: m.chat, outcome: reading.outcome }, m.time);
      });
      const iface: TurnParserInterface = {
        state: {
          rest: () => (rest !== undefined && rest.until > ctx.clock.now() ? rest : undefined),
        },
        actions: { sent: (turn) => remember(turn) },
      };
      return { interface: iface };
    },
  });
}

/** Why the bot rests, in the owner's words. */
function whyOf(o: TurnOutcome): string {
  if (o.kind === 'nothing' && o.reason !== undefined)
    return o.reason === 'cooldown' ? 'it said too soon' : o.reason;
  return 'its rest after a turn';
}
