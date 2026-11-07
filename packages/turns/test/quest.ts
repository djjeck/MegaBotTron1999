/**
 * A made-up game bot, @QuestBot, for the tests of the turn plugins: its grammar reads "Found an
 * apple." (an item, 15 minutes' rest), "Defeated." (nothing, 30 minutes' rest) and "Too soon: 20
 * minutes." (nothing, the wait it states), and claims as unread whatever else answers a turn.
 */
import { type Plugin } from '@megabottron1999/core';
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

/** @QuestBot's parser: what answers alice's turns, and in private a reply that reads as one. */
export function questPlugin(o: { group?: string } = {}): Plugin {
  return turnParserPlugin(
    {
      id: QUEST,
      bot: QUESTBOT,
      description: "@QuestBot's answers to the owner's turns",
      read: (m): TurnReading => {
        if (!m.answers && !(m.private && m.replies)) return undefined;
        const read = readQuest(m.text);
        if (read === undefined) return m.answers ? { unread: true } : undefined;
        return read;
      },
    },
    o
  );
}
