import { describe, expect, it } from 'vitest';
import { runParser as run, T0 } from '#test/parser-run.ts';
import { QUESTBOT, questPlugin } from '#test/quest.ts';
import { isTurnCommand } from './turn-parser.ts';

const GROUP = '-1001000000001';
const MIN = 60_000;
const PRIVATE = `@${QUESTBOT}`;
const bot = { sender: QUESTBOT };
const own = { sender: 'alice', own: true };

describe('isTurnCommand', () => {
  it('knows a turn command bare or addressed to its bot, in any case', () => {
    expect(isTurnCommand('/quest', ['/quest'], 'QuestBot')).toBe(true);
    expect(isTurnCommand(' /Quest@questbot ', ['/quest'], 'QuestBot')).toBe(true);
    expect(isTurnCommand('/quest@OtherBot', ['/quest'], 'QuestBot')).toBe(false);
    expect(isTurnCommand('/lore', ['/quest'], 'QuestBot')).toBe(false);
    expect(isTurnCommand('/quest now', ['/quest'], 'QuestBot')).toBe(false);
  });
});

describe('a turn parser', () => {
  it("reads the replies to the owner's turns in the group, by hand, and no one else's", async () => {
    const p = await run(questPlugin(), { commands: ['/quest'] }, GROUP);
    const hand = p.hear({ ...own, chat: GROUP, text: `/quest@${QUESTBOT}` });
    p.hear({ ...bot, chat: GROUP, replyTo: hand, text: 'Found an apple.' });
    p.hear({ ...bot, chat: GROUP, replyTo: '1', text: 'Found a pear.' });
    // Another command, and another sender's message, are none of its business.
    const other = p.hear({ ...own, chat: GROUP, text: '/inventory' });
    p.hear({ ...bot, chat: GROUP, replyTo: other, text: 'Found a plum.' });
    p.hear({ sender: 'someone', chat: GROUP, replyTo: hand, text: 'Found a fig.' });
    expect(p.events).toEqual([
      {
        type: 'quest.turn',
        t: T0,
        instance: 'quest',
        chat: GROUP,
        outcome: { kind: 'gain', bot: QUESTBOT, item: 'an apple' },
      },
    ]);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 15 * MIN, why: 'its rest after a turn' });
    expect(p.drift()).toMatchObject({ read: 1, unread: 0 });
  });

  it('reads nothing of the group without one', async () => {
    const p = await run(questPlugin());
    const hand = p.hear({ ...own, chat: GROUP, text: '/play' });
    p.hear({ ...bot, chat: GROUP, replyTo: hand, text: 'Found an apple.' });
    expect(p.events).toEqual([]);
  });

  it('matches the first message in private within two minutes, once', async () => {
    const p = await run(questPlugin());
    p.hear({ ...own, chat: PRIVATE, text: '/play' });
    p.hear({ ...bot, chat: PRIVATE, text: 'Defeated.' });
    // Only the first answers the turn.
    p.hear({ ...bot, chat: PRIVATE, text: 'Something else' });
    // A turn sent by its actor, twice told; its answer comes too late.
    await p.iface.sent({ chat: PRIVATE, id: '77', t: p.kit.clock.now() });
    await p.iface.sent({ chat: PRIVATE, id: '77', t: p.kit.clock.now() });
    p.kit.runUntil(T0 + 3 * MIN);
    p.hear({ ...bot, chat: PRIVATE, text: 'Later' });
    expect(p.outcomes()).toEqual(['nothing']);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 30 * MIN, why: 'defeated' });
  });

  it('claims an answer it cannot read, reports it to drift and publishes it unknown', async () => {
    const p = await run(questPlugin());
    await p.iface.sent({ chat: PRIVATE, id: '5', t: p.kit.clock.now() });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '5', text: ' Level 5! ' });
    expect(p.events[0]).toMatchObject({
      chat: PRIVATE,
      outcome: { kind: 'unknown', bot: QUESTBOT, text: 'Level 5!' },
    });
    expect(p.drift()).toMatchObject({ read: 0, unread: 1 });
  });

  it('in private, reads a reply to a turn it does not know, and keeps the longest rest', async () => {
    const p = await run(questPlugin());
    p.hear({ ...bot, chat: PRIVATE, replyTo: '9', text: 'Too soon: 40 minutes.' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '10', text: 'Found an apple.' });
    p.hear({ ...bot, chat: PRIVATE, replyTo: '11', text: 'Unreadable' });
    expect(p.outcomes()).toEqual(['nothing', 'gain']);
    expect(p.iface.rest()).toMatchObject({ until: T0 + 40 * MIN, why: 'it said too soon' });
    p.kit.runUntil(T0 + 41 * MIN);
    expect(p.iface.rest()).toBeUndefined();
  });
});
