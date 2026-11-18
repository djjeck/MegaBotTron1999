import { describe, expect, it } from 'vitest';
import {
  ChatGroups,
  type GroupMember,
  pickForm,
  type PlayerSend,
  type Reacher,
  reachOf,
  widestReach,
} from './chat-group.ts';
import { commandOf } from './turn-parser.ts';

/** A player of `bot`, whose commands are `commands`, playing those `plays` names now. */
function reacher(
  bot: string,
  commands: { command: string; aliases?: string[] }[],
  plays: string[],
  forms?: string[]
): Reacher {
  return {
    id: bot,
    takes: (form) => commandOf(form, commands, bot),
    wouldPlay: (command, form) =>
      plays.includes(command) && (forms === undefined || forms.includes(form)),
  };
}

const turn = (...names: string[]) => [{ command: names[0] as string, aliases: names.slice(1) }];

describe('reachOf and pickForm (bot-os.md D140)', () => {
  const quest = (plays: string[]) => reacher('QuestBot', turn('/play'), plays);
  const duel = (plays: string[]) => reacher('DuelBot', turn('/play'), plays);
  const lore = (plays: string[], forms?: string[]) =>
    reacher('LoreBot', turn('/play', '/quest'), plays, forms);
  // Every name bare, then every name addressed.
  const LORE = ['/play', '/quest', '/play@LoreBot', '/quest@LoreBot'];

  it('reaches every bot declaring a bare name, an addressed form its bot alone', () => {
    const all = [quest([]), duel([]), lore([])];
    expect(reachOf('/play', all)).toEqual([
      { id: 'QuestBot', command: '/play' },
      { id: 'DuelBot', command: '/play' },
      { id: 'LoreBot', command: '/play' },
    ]);
    expect(reachOf('/quest', all)).toEqual([{ id: 'LoreBot', command: '/play' }]);
    expect(reachOf('/play@LoreBot', all)).toEqual([{ id: 'LoreBot', command: '/play' }]);
    expect(reachOf('/boost', all)).toEqual([]);
    expect(widestReach(LORE, all)).toHaveLength(3);
  });

  it('picks the widest form every bot it reaches would play', () => {
    const all = [quest(['/play']), duel(['/play']), lore(['/play'])];
    expect(pickForm(LORE, all)).toEqual({ form: '/play', reach: reachOf('/play', all) });
  });

  it('picks a narrower form when a bot the bare one reaches would not play', () => {
    // On a tie, the first in order: its own bare alias before any addressed form.
    const alone = [quest([]), duel([]), lore(['/play'])];
    expect(pickForm(LORE, alone)?.form).toBe('/quest');
    // A form the player may not send is not allowed.
    const pinned = [quest([]), duel([]), lore(['/play'], ['/play@LoreBot'])];
    expect(pickForm(LORE, pinned)?.form).toBe('/play@LoreBot');
    // Its only bare form reaches a bot that would not play: addressed, or nothing.
    const two = [quest(['/play']), duel(['/play']), lore([])];
    expect(pickForm(['/play', '/play@QuestBot'], two)?.form).toBe('/play@QuestBot');
    expect(pickForm(['/play'], two)).toBeUndefined();
  });
});

describe('ChatGroups (bot-os.md D140)', () => {
  const member = (id: string, heard: PlayerSend[]): GroupMember => ({
    id,
    takes: () => undefined,
    wouldPlay: () => false,
    dueWithin: () => undefined,
    unanswered: () => undefined,
    heard: (s) => heard.push(s),
  });

  it('groups players by account and chat, and hands a send to every other of the account', () => {
    const g = new ChatGroups();
    const heard: Record<string, PlayerSend[]> = { a: [], b: [], c: [], d: [] };
    g.join('a', 'telegram:alice', '-100', member('a', heard['a'] as PlayerSend[]));
    g.join('b', 'telegram:alice', '-100', member('b', heard['b'] as PlayerSend[]));
    const leave = g.join('c', 'telegram:alice', '@LoreBot', member('c', heard['c'] as []));
    g.join('d', 'telegram:bob', '-100', member('d', heard['d'] as PlayerSend[]));
    expect(g.group('a').map((m) => m.id)).toEqual(['a', 'b']);
    expect(g.group('x')).toEqual([]);
    const s = { chat: '-100', text: '/play', t: 1 };
    g.sent('a', s);
    // Its account's players, its chat's or another's; not another account's.
    expect(heard).toEqual({ a: [], b: [s], c: [s], d: [] });
    leave();
    g.sent('b', s);
    expect(heard['c']).toHaveLength(1);
    g.sent('x', s);
  });

  it('covers the players a claim reaches, until it is released or times out', () => {
    const g = new ChatGroups();
    g.claim('a', [{ id: 'b', command: '/Play' }], 100);
    expect(g.covered('b', '/play', 50)).toBe(true);
    expect(g.covered('b', '/play', 100)).toBe(false);
    expect(g.covered('b', '/quest', 50)).toBe(false);
    g.claim('c', [{ id: 'b', command: '/quest' }], 100);
    g.release('a');
    expect(g.covered('b', '/play', 50)).toBe(false);
    expect(g.covered('b', '/quest', 50)).toBe(true);
    g.sent('c', { chat: '-100', text: '/quest', t: 1 });
    expect(g.covered('b', '/quest', 50)).toBe(false);
  });
});
