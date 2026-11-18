/**
 * A made-up game bot, @QuestBot, for the tests of the turn plugins: its grammar reads "Found an
 * apple." (an item, 15 minutes' rest), "Defeated." (nothing, 30 minutes' rest) and "Too soon: 20
 * minutes." (nothing, the wait it states), and claims as unread whatever else answers a turn.
 */
import { type Plugin } from '@megabottron1999/core';
import { readinessPlugin } from '#src/state-plugin.ts';
import { type TurnOutcome, turnParserPlugin, type TurnReading } from '#src/turn-parser.ts';

export const QUEST = 'quest';
export const QUESTBOT = 'QuestBot';
const MIN = 60_000;

/** What @QuestBot's message says, or undefined. */
export function readQuest(text: string): { outcome: TurnOutcome; restMs: number } | undefined {
  const bot = QUESTBOT;
  const found = /^Found (.+)\.$/u.exec(text.trim());
  if (found !== null)
    return { outcome: { kind: 'gain', bot, item: found[1] } as TurnOutcome, restMs: 15 * MIN };
  if (text.trim() === 'Defeated.')
    return { outcome: { kind: 'nothing', bot, reason: 'defeated' }, restMs: 30 * MIN };
  const soon = /^Too soon: (\d+) minutes\.$/u.exec(text.trim());
  if (soon !== null)
    return { outcome: { kind: 'nothing', bot, reason: 'cooldown' }, restMs: Number(soon[1]) * MIN };
  return undefined;
}

/**
 * @QuestBot's parser: what answers alice's turns (`/play`, or the commands given), and in private a
 * reply that reads as one.
 */
export function questPlugin(turnCommands: readonly string[] = ['/play']): Plugin {
  return turnParserPlugin({
    id: QUEST,
    bot: QUESTBOT,
    description: "@QuestBot's answers to the owner's turns",
    turnCommands,
    read: (m): TurnReading => {
      if (!m.answers && !(m.private && m.replies)) return undefined;
      const read = readQuest(m.text);
      if (read === undefined) return m.answers ? { unread: true } : undefined;
      return read;
    },
  });
}

/**
 * @QuestBot's vocabulary with its other commands (bot-os.md D132, D141): `/daily`, `/chest`,
 * announced by "A chest appears!", and `/coffee`.
 */
export const QUEST_VOCABULARY = {
  bot: QUESTBOT,
  turnCommands: ['/play'],
  commands: { '/daily': {}, '/chest': { announcedBy: 'A chest appears!' }, '/coffee': {} },
};

/**
 * Their mechanics, its state's (bot-os.md D132, D141): `/daily`, once a day; `/chest`, usable once
 * announced, for 30 minutes; `/coffee`, once an hour, which ends the turn's rest.
 */
export const QUEST_MECHANICS = {
  '/daily': { cooldownMin: 24 * 60 },
  '/chest': { unlock: { forMin: 30 } },
  '/coffee': { cooldownMin: 60, effects: [{ command: '/play', clear: true as const }] },
};

/** The id of @QuestBot's readiness state. */
export const QUEST_READY = 'quest-ready';

/** @QuestBot's turn's readiness state (D141), for `questPlugin`: its rest, for a player. */
export function questTurnReadyPlugin(turnCommands: readonly string[] = ['/play']): Plugin {
  return readinessPlugin({ id: QUEST_READY, parser: { id: QUEST, bot: QUESTBOT, turnCommands } });
}

/** @QuestBot's readiness state (D141): its commands' readiness, for a player. */
export function questReadyPlugin(): Plugin {
  return readinessPlugin({
    id: QUEST_READY,
    parser: { id: QUEST, ...QUEST_VOCABULARY },
    mechanics: QUEST_MECHANICS,
  });
}

/** What @QuestBot answers to its other commands, or undefined. */
export function readQuestCommand(command: string, text: string): TurnReading {
  const bot = QUESTBOT;
  const t = text.trim();
  const daily = /^Daily reward: (.+)\.$/u.exec(t);
  if (command === '/daily' && daily !== null)
    return { outcome: { kind: 'gain', bot, item: daily[1] } as TurnOutcome };
  const later = /^Come back in (\d+) minutes\.$/u.exec(t);
  if (later !== null)
    return {
      outcome: { kind: 'nothing', bot, reason: 'cooldown' },
      restMs: Number(later[1]) * MIN,
    };
  const chest = /^The chest holds (.+)\.$/u.exec(t);
  if (command === '/chest' && chest !== null)
    return { outcome: { kind: 'gain', bot, item: chest[1] } as TurnOutcome };
  // It says the turn's rest is over: the outbox's cooldown on it ends too (D98, D141).
  if (command === '/coffee' && t === 'You drink a coffee: rested.')
    return { outcome: { kind: 'rested', bot }, effects: [{ command: '/play', clear: true }] };
  return undefined;
}

/**
 * @QuestBot's parser with its other commands (`QUEST_VOCABULARY`): a turn's answer read by its
 * first line (the rest may announce a chest), another command's by `readQuestCommand`.
 */
export function questGamePlugin(): Plugin {
  return turnParserPlugin({
    id: QUEST,
    description: "@QuestBot's answers to the owner's commands",
    ...QUEST_VOCABULARY,
    read: (m): TurnReading => {
      if (!m.answers && !(m.private && m.replies)) return undefined;
      const read =
        m.command === undefined || m.command === '/play'
          ? readQuest(m.text.split('\n')[0] ?? '')
          : readQuestCommand(m.command, m.text);
      if (read === undefined) return m.answers ? { unread: true } : undefined;
      return read;
    },
  });
}
