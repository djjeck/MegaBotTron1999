import { describe, expect, it } from 'vitest';
import type { BotCommand, Graph, GraphNode, PluginView } from '#src/ui/api.ts';
import {
  boundCommands,
  derivedPolicy,
  duration,
  entriesOf,
  followedBy,
  followPlays,
  formsOf,
  listedForms,
  playedCommands,
  playPlace,
  playRows,
  playSentence,
  rowsValue,
  unknownEntries,
} from './plays.ts';

/** @QuestBot's commands, one of each mechanic (made up). */
const PLAY: BotCommand = { command: '/play', turn: true };
const COFFEE: BotCommand = { command: '/coffee', effects: [{ command: '/play', clear: true }] };
const CHEST: BotCommand = {
  command: '/chest',
  unlock: { pattern: 'A chest appears!', forMin: 30 },
};
const DAILY: BotCommand = { command: '/daily', cooldownMin: 1440 };
const SHOP: BotCommand = { command: '/shop', interactive: true };
const DECLARED = [PLAY, COFFEE, CHEST, DAILY, SHOP];

/** A command's sentence, played with its policy (its mechanics' if not given). */
const sentence = (command: BotCommand, ...rest: [policy?: string, played?: boolean]): string =>
  playSentence({
    command,
    played: rest[1] ?? true,
    policy: rest.length === 0 ? derivedPolicy(command) : rest[0],
  });

describe('a sentence per command (D137)', () => {
  it('says what the player will do with each mechanic, by default', () => {
    expect(sentence(PLAY)).toBe("a turn: played whenever the bot's rest is over");
    expect(sentence(COFFEE)).toBe('played if /play is cooling down; ends its cool-down');
    expect(sentence(CHEST)).toBe(
      'activated by “A chest appears!”, for 30 minutes: played while active'
    );
    expect(sentence(DAILY)).toBe('played whenever ready, then cooling down for 24 hours');
    expect(
      sentence({ command: '/market', resetsAt: { times: ['00:00', '12:00'], timeZone: 'UTC' } })
    ).toBe('played whenever ready, then held until 00:00 or 12:00 (UTC)');
    expect(playSentence({ command: SHOP, played: false, policy: undefined }, true)).toBe(
      'needs you to answer: not played by default'
    );
  });

  it('says it is not played, unchecked, with what the command is', () => {
    expect(sentence(DAILY, undefined, false)).toBe('not played');
    expect(sentence(PLAY, undefined, false)).toBe('a turn: not played');
    expect(sentence(CHEST, undefined, false)).toBe(
      'activated by “A chest appears!”, for 30 minutes: not played'
    );
    expect(sentence(SHOP, undefined, false)).toBe('needs you to answer: not played');
  });

  it('follows an override of the policy', () => {
    expect(sentence(COFFEE, undefined)).toBe("played whenever ready; ends /play's cool-down");
    expect(sentence(DAILY, '/play')).toBe(
      'played if /play is cooling down, then cooling down for 24 hours'
    );
    expect(sentence(PLAY, '/daily')).toBe('a turn: played if /daily is cooling down');
    expect(sentence(CHEST, '/play')).toBe(
      'activated by “A chest appears!”, for 30 minutes: played while active, if /play is cooling down'
    );
    expect(sentence(SHOP)).toBe('needs you to answer: played whenever ready');
  });

  it('composes the rarer mechanics', () => {
    expect(sentence({ command: '/x', unlock: {} })).toBe(
      'activated by the bot: played while active'
    );
    expect(sentence({ command: '/x', unlock: { pattern: 'Go!' } })).toBe(
      'activated by “Go!”: played while active'
    );
    expect(
      sentence({
        command: '/nap',
        cooldownMin: 60,
        effects: [
          { command: '/play', clear: true },
          { command: '/daily', shortenMin: 5 },
          { command: '/odd' },
        ],
      })
    ).toBe(
      "played if /play is cooling down, then cooling down for 1 hour; ends its cool-down and shortens /daily's cool-down by 5 minutes"
    );
    expect(
      sentence({ command: '/x', interactive: true, unlock: { forMin: 1 } }, undefined, false)
    ).toBe('needs you to answer, activated by the bot, for 1 minute: not played');
  });

  it('writes a duration in words', () => {
    expect(duration(1)).toBe('1 minute');
    expect(duration(30)).toBe('30 minutes');
    expect(duration(60)).toBe('1 hour');
    expect(duration(90)).toBe('90 minutes');
    expect(duration(1440)).toBe('24 hours');
  });
});

describe('the checklist’s rows and the config they make (D137)', () => {
  it('derives each policy from the mechanics: a reset only while what it clears is held', () => {
    expect(derivedPolicy(PLAY)).toBeUndefined();
    expect(derivedPolicy(COFFEE)).toBe('/play');
    expect(derivedPolicy(DAILY)).toBeUndefined();
    expect(derivedPolicy({ command: '/x', effects: [{ command: '/X', clear: true }] })).toBe(
      undefined
    );
  });

  it('checks every command but an interactive one by default, and writes nothing for them', () => {
    const rows = playRows(undefined, DECLARED);
    expect(rows.map((r) => [r.command.command, r.played, r.policy])).toEqual([
      ['/play', true, undefined],
      ['/coffee', true, '/play'],
      ['/chest', true, undefined],
      ['/daily', true, undefined],
      ['/shop', false, undefined],
    ]);
    expect(rowsValue(rows)).toBeUndefined();
    expect(playedCommands(undefined, DECLARED)).toEqual(['/play', '/coffee', '/chest', '/daily']);
  });

  it('writes the list in the parser’s order once it differs, overrides only where they differ', () => {
    const rows = playRows(undefined, DECLARED).map((r) =>
      r.command === DAILY
        ? { ...r, played: false }
        : r.command === COFFEE
          ? { ...r, policy: undefined }
          : r.command === CHEST
            ? { ...r, policy: '/play' }
            : r.command === SHOP
              ? { ...r, played: true }
              : r
    );
    const value = rowsValue(rows);
    expect(value).toEqual([
      { command: '/play' },
      { command: '/coffee', whenReady: true },
      { command: '/chest', whileHeld: '/play' },
      { command: '/shop' },
    ]);
    // Read back, the same rows.
    expect(playRows(value, DECLARED).map((r) => [r.played, r.policy, r.overridden])).toEqual([
      [true, undefined, false],
      [true, undefined, true],
      [true, '/play', true],
      [false, undefined, false],
      [true, undefined, false],
    ]);
    expect(playedCommands(value, DECLARED)).toEqual(['/play', '/coffee', '/chest', '/shop']);
  });

  it('reads an explicit list of before, keeps what its parser does not know', () => {
    const before = [{ command: '/COFFEE', whileHeld: '/play' }, { command: '/dance' }, 'junk'];
    expect(entriesOf(before)).toEqual([
      { command: '/COFFEE', whileHeld: '/play' },
      { command: '/dance' },
    ]);
    expect(entriesOf({})).toBeUndefined();
    const rows = playRows(before, DECLARED);
    expect(rows.filter((r) => r.played).map((r) => r.command.command)).toEqual(['/coffee']);
    const extra = unknownEntries(before, DECLARED);
    expect(extra).toEqual([{ command: '/dance' }]);
    expect(rowsValue(rows, extra)).toEqual([{ command: '/coffee' }, { command: '/dance' }]);
    // Every default checked again, an extra still kept: a list.
    expect(rowsValue(playRows(undefined, DECLARED), extra)).toHaveLength(5);
  });
});

describe('the player’s chat edge, following its checklist (D137)', () => {
  const parserView = { botCommands: DECLARED } as unknown as PluginView;
  const playerView = {
    configPlays: { key: 'commands', input: 'parser', output: 'chat' },
  } as unknown as PluginView;
  const viewOf = (n: GraphNode): PluginView | undefined =>
    n.plugin === 'quest' ? parserView : n.plugin === 'player' ? playerView : undefined;
  const graph = (config?: Record<string, unknown>, parser = true): Graph => ({
    version: 2,
    nodes: [
      { id: 'quest', plugin: 'quest' },
      { id: 'tg', plugin: 'telegram-user' },
      { id: 'p', plugin: 'player', ...(config === undefined ? {} : { config }) },
    ],
    edges: [
      ...(parser ? [{ from: 'quest.interface', to: 'p.parser', type: 'interface' as const }] : []),
      {
        from: 'p.chat',
        to: 'tg.chat',
        type: 'chat-out',
        sends: ['@QuestBot'],
        commands: ['/play', '/daily'],
        minIntervalS: { '/daily': 5, '/old': 3 },
      },
    ],
  });

  it('knows the commands its parser edge binds, and which edge follows them', () => {
    expect(boundCommands(graph(), 'p', 'parser', viewOf)).toBe(DECLARED);
    expect(boundCommands(graph(undefined, false), 'p', 'parser', viewOf)).toBeUndefined();
    expect(followedBy(graph(), 'p.chat', viewOf)).toBe('p');
    expect(followedBy(graph(undefined, false), 'p.chat', viewOf)).toBeUndefined();
    expect(followedBy(graph(), 'p.other', viewOf)).toBeUndefined();
    expect(followedBy(graph(), 'quest.interface', viewOf)).toBeUndefined();
    const empty = (n: GraphNode) =>
      n.plugin === 'quest' ? ({ botCommands: [] } as unknown as PluginView) : viewOf(n);
    expect(boundCommands(graph(), 'p', 'parser', empty)).toBeUndefined();
  });

  it('allows what it plays, its spacing kept for those alone, and leaves the rest alone', () => {
    const g = followPlays(graph(), viewOf);
    expect(g.edges[1]).toMatchObject({
      commands: ['/play', '/coffee', '/chest', '/daily'],
      minIntervalS: { '/daily': 5 },
      sends: ['@QuestBot'],
    });
    // Nothing to change: the same graph.
    expect(followPlays(g, viewOf)).toBe(g);
    const none = followPlays(graph({ commands: [] }), viewOf);
    expect(none.edges[1]?.commands).toEqual([]);
    expect(none.edges[1]).not.toHaveProperty('minIntervalS');
    // No parser bound: as it was.
    const loose = graph(undefined, false);
    expect(followPlays(loose, viewOf)).toBe(loose);
  });

  it('knows where it sends, and allows in a group every form of what it plays (D139, D140)', () => {
    const named = (n: GraphNode) =>
      n.plugin === 'quest'
        ? ({ botCommands: DECLARED, botUsername: 'QuestBot' } as unknown as PluginView)
        : viewOf(n);
    const config = {
      commands: [{ command: '/play', forms: ['/play@QuestBot'] }, { command: '/daily' }],
    };
    expect(followPlays(graph(config), named).edges[1]?.commands).toEqual([
      '/play@QuestBot',
      '/daily',
    ]);
    const plays = { input: 'parser', output: 'chat' };
    expect(playPlace(graph(), 'p', plays, named)).toEqual({ bot: 'QuestBot', group: false });
    expect(playPlace(graph(), 'p', plays, viewOf)).toBeUndefined();
    expect(playPlace(graph(undefined, false), 'p', plays, named)).toBeUndefined();
    const inGroup = graph();
    const g: Graph = {
      ...inGroup,
      edges: inGroup.edges.map((e) => (e.from === 'p.chat' ? { ...e, sends: ['-1001'] } : e)),
    };
    expect(playPlace(g, 'p', plays, named)).toEqual({ bot: 'QuestBot', group: true });
    // In a group, every form of what it plays (D140), its names bare, then addressed.
    expect(followPlays(g, named).edges[1]?.commands).toEqual(
      ['/play', '/coffee', '/chest', '/daily'].flatMap((c) => [c, `${c}@QuestBot`])
    );
  });
});

describe('a command’s forms, its aliases bare and addressed (D140)', () => {
  const TURN: BotCommand = { command: '/quest', aliases: ['/play'], turn: true };
  const BOOST: BotCommand = {
    command: '/boost',
    aliases: ['/b'],
    effects: [{ command: '/quest', clear: true }],
  };
  const group = { bot: 'LoreBot', group: true };
  const LORE = ['/quest', '/play', '/quest@LoreBot', '/play@LoreBot'];

  it('lists every name bare, then every name addressed in a group alone', () => {
    expect(formsOf(TURN, group)).toEqual(LORE);
    expect(formsOf(TURN, { ...group, group: false })).toEqual(['/quest', '/play']);
    expect(formsOf(TURN)).toEqual(['/quest', '/play']);
    // An addressed form its entry allows in private is listed too, to untick.
    expect(
      listedForms({ command: TURN, forms: ['/quest@LoreBot'] }, { ...group, group: false })
    ).toEqual(['/quest', '/play', '/quest@LoreBot']);
  });

  it('gives one row per command, an entry by an alias its, with its forms', () => {
    const value = [{ command: '/play', forms: ['/quest', '/play@LoreBot'] }, { command: '/b' }];
    const rows = playRows(value, [TURN, BOOST]);
    expect(rows.map((r) => [r.command.command, r.played, r.forms])).toEqual([
      ['/quest', true, ['/quest', '/play@LoreBot']],
      ['/boost', true, undefined],
    ]);
    expect(rowsValue(rows)).toEqual([
      { command: '/quest', forms: ['/quest', '/play@LoreBot'] },
      { command: '/boost' },
    ]);
    expect(unknownEntries(value, [TURN, BOOST])).toEqual([]);
    // Every form ticked: the defaults again.
    expect(rowsValue(rows.map(({ forms: _, ...r }) => r))).toBeUndefined();
    // The edge allows the forms it may send, in order.
    expect(playedCommands(value, [TURN, BOOST], group)).toEqual([
      '/quest',
      '/play@LoreBot',
      '/boost',
      '/b',
      '/boost@LoreBot',
      '/b@LoreBot',
    ]);
    expect(playedCommands(undefined, [TURN, BOOST], { ...group, group: false })).toEqual([
      '/quest',
      '/play',
      '/boost',
      '/b',
    ]);
  });

  it('says in the sentence how the form is chosen', () => {
    const row = { command: TURN, played: true, policy: undefined };
    expect(playSentence(row, false, group)).toBe(
      "a turn: played whenever the bot's rest is over; sent as the form that plays the most ready turns at once"
    );
    expect(playSentence({ ...row, command: BOOST, policy: '/quest' }, false, group)).toBe(
      'played if /quest is cooling down; ends its cool-down; sent as the form that plays it for the most ready bots at once'
    );
    expect(playSentence({ ...row, forms: ['/play@LoreBot'] }, false, group)).toBe(
      "a turn: played whenever the bot's rest is over; sent as /play@LoreBot, which only @LoreBot takes"
    );
    expect(playSentence({ ...row, forms: ['/play'] }, false, group)).toBe(
      "a turn: played whenever the bot's rest is over; sent as /play, which every bot in the group that declares it takes"
    );
    // In its bot's private chat: its first name, or nothing for its own alone.
    const solo = { ...group, group: false };
    expect(playSentence(row, false, solo)).toBe(
      "a turn: played whenever the bot's rest is over; sent as /quest"
    );
    expect(playSentence({ ...row, forms: ['/play'] }, false, solo)).toBe(
      "a turn: played whenever the bot's rest is over; sent as /play"
    );
    expect(playSentence({ ...row, command: PLAY }, false, solo)).toBe(
      "a turn: played whenever the bot's rest is over"
    );
    expect(playSentence({ ...row, forms: [] }, false, solo)).toBe(
      "a turn: played whenever the bot's rest is over"
    );
  });
});
