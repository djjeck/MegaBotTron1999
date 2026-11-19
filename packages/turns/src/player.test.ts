import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  type BotCommand,
  FakeConnector,
  fakeConnectorPlugin,
  GraphError,
  type GraphInput,
  parseManifest,
  resolveGraph,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { attentionPlugin } from '#src/attention.ts';
import { QUEST, QUEST_READY, questGamePlugin, questReadyPlugin } from '#test/quest.ts';
import { CHAT, PLAYS, runSittings, T0 } from '#test/sittings-run.ts';
import {
  ANSWER_WAIT_MS,
  CONNECT_WAIT_MS,
  derivedWhileHeld,
  PLAYER,
  playerConfig,
  playerPlugin,
  playerSummary,
  playForms,
  playsOf,
} from './player.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('its ports: its bot’s chat, its readiness state, its person (D97, D133, D141)', () => {
  const manifests = new Map(
    [
      fakeConnectorPlugin(TELEGRAM_USER, new FakeConnector({ account: 'telegram:alice' })),
      questGamePlugin(),
      questReadyPlugin(),
      attentionPlugin(),
      playerPlugin(),
    ].map((p) => {
      const m = parseManifest(p.manifest);
      return [m.id, m];
    })
  );
  const graph = (sends: string[], edges: GraphInput['edges'] = []): GraphInput => ({
    version: 2,
    nodes: [
      { id: TELEGRAM_USER, plugin: TELEGRAM_USER },
      { id: QUEST, plugin: QUEST },
      { id: QUEST_READY, plugin: QUEST_READY },
      { id: 'alice', plugin: 'attention' },
      { id: 'quest-player', plugin: PLAYER },
    ],
    edges: [
      { from: `${TELEGRAM_USER}.chat`, to: `${QUEST}.chat`, type: 'chat-in', reads: [CHAT] },
      { from: 'quest-player.chat', to: `${TELEGRAM_USER}.chat`, type: 'chat-out', sends },
      { from: `${QUEST}.events`, to: `${QUEST_READY}.events`, type: 'events' },
      { from: `${QUEST}.interface`, to: `${QUEST_READY}.parser`, type: 'interface' },
      { from: `${QUEST_READY}.interface`, to: 'quest-player.state', type: 'interface' },
      ...(edges ?? []),
    ],
  });
  const problems = (g: GraphInput): string[] => {
    try {
      resolveGraph(g, manifests);
      return [];
    } catch (e) {
      return e instanceof GraphError ? e.problems : [String(e)];
    }
  };
  const person = {
    from: 'alice.attention',
    to: 'quest-player.attention',
    type: 'attention' as const,
  };

  it('takes the one chat its edge names, its readiness state and its person', () => {
    expect(problems(graph([CHAT], [person]))).toEqual([]);
  });

  it('binds to a readiness state, not to a parser, which offers no readiness (D141)', () => {
    const g = graph([CHAT], [person]);
    const toParser = {
      ...g,
      edges: g.edges?.map((e) =>
        e.to === 'quest-player.state' ? { ...e, from: `${QUEST}.interface` } : e
      ),
    };
    expect(problems(toParser)[0]).toContain('state.ready');
  });

  it('needs a person, and refuses an edge of no chat, of two, or not a bot’s', () => {
    expect(problems(graph([CHAT]))).toEqual([
      'node quest-player: input port attention (attention) is not bound',
    ]);
    expect(problems(graph([], [person]))).toEqual([
      `node quest-player: output port chat sends to one chat, its bot's @username, or a group's id: its edge names none (edge quest-player.chat → ${TELEGRAM_USER}.chat)`,
    ]);
    expect(problems(graph([CHAT, '@OtherBot'], [person]))[0]).toContain(
      `its edge names ${CHAT}, @OtherBot`
    );
    expect(problems(graph(['5000001'], [person]))[0]).toContain('not 5000001');
  });

  it('takes a group instead of its bot’s private chat, as the owner prefers (D139)', () => {
    expect(problems(graph(['-1001000000001'], [person]))).toEqual([]);
  });

  it('has no chat-in: an edge to one is refused (D99)', () => {
    expect(playerPlugin().manifest.inputs).not.toHaveProperty('chat');
    expect(
      problems(graph([CHAT], [person, { from: `${TELEGRAM_USER}.chat`, to: 'quest-player.chat' }]))
    ).toEqual([expect.stringContaining('quest-player')]);
  });
});

describe('playerConfig', () => {
  it('takes the forms a command may go as (D140)', () => {
    const forms = ['/quest', '/play@LoreBot'];
    expect(playerConfig.parse({ commands: [{ command: '/play', forms }] })).toEqual({
      commands: [{ command: '/play', forms }],
      settleS: 10,
      marginS: 5,
    });
    expect(() => playerConfig.parse({ commands: [{ command: '/play', forms: [] }] })).toThrow();
    expect(() =>
      playerConfig.parse({ commands: [{ command: '/play', forms: ['play@LoreBot'] }] })
    ).toThrow('expected a form, as /play or /play@QuestBot');
    const aliased: BotCommand[] = [{ command: '/quest', aliases: ['/play'], turn: true }];
    expect(playsOf([{ command: '/play', forms: ['/quest'] }], aliased)).toEqual([
      { command: '/quest', forms: ['/quest'] },
    ]);
  });

  it('takes no commands (the defaults), or each command with its override, in order', () => {
    expect(playerConfig.parse({})).toEqual({ settleS: 10, marginS: 5 });
    expect(playerConfig.parse({ commands: PLAYS }).commands?.[3]).toEqual({
      command: '/coffee',
      whileHeld: '/play',
    });
    // An empty list plays nothing; an override is one policy or the other.
    expect(playerConfig.parse({ commands: [] })).toEqual({ commands: [], settleS: 10, marginS: 5 });
    expect(playerConfig.parse({ commands: [{ command: '/a', whenReady: true }] })).toEqual({
      commands: [{ command: '/a', whenReady: true }],
      settleS: 10,
      marginS: 5,
    });
    expect(() =>
      playerConfig.parse({ commands: [{ command: '/a', whileHeld: '/b', whenReady: true }] })
    ).toThrow('whileHeld or whenReady, not both');
    expect(() => playerConfig.parse({ commands: [{ command: 'play' }] })).toThrow(
      'expected a command, as /play'
    );
  });
});

describe('playsOf: what it plays, and when (D137)', () => {
  const declared: BotCommand[] = [
    { command: '/play', turn: true },
    { command: '/shop', interactive: true },
    { command: '/daily', cooldownMin: 1440 },
    { command: '/coffee', effects: [{ command: '/play', clear: true }] },
    { command: '/nap', effects: [{ command: '/daily', shortenMin: 5 }] },
    { command: '/loop', effects: [{ command: '/loop', clear: true }] },
  ];

  it('plays by default every command but an interactive one, a reset only while held', () => {
    expect(playsOf(undefined, declared)).toEqual([
      { command: '/play' },
      { command: '/daily' },
      { command: '/coffee', whileHeld: '/play' },
      { command: '/nap' },
      { command: '/loop' },
    ]);
    expect(playsOf(undefined, [])).toEqual([]);
  });

  it('plays an explicit list in its order, each override winning over the mechanics', () => {
    expect(
      playsOf(
        [
          { command: '/SHOP' },
          { command: '/coffee', whenReady: true },
          { command: '/daily', whileHeld: '/play' },
          { command: '/COFFEE' },
          { command: '/dance' },
        ],
        declared
      )
    ).toEqual([
      // By its parser's name, in its spelling (D140).
      { command: '/shop' },
      { command: '/coffee' },
      { command: '/daily', whileHeld: '/play' },
      { command: '/coffee', whileHeld: '/play' },
      { command: '/dance' },
    ]);
  });

  it('names a command or a policy given by an alias by its command’s name (D140)', () => {
    const aliased: BotCommand[] = [
      { command: '/play', aliases: ['/quest'], turn: true },
      { command: '/boost', aliases: ['/b'], effects: [{ command: '/play', clear: true }] },
    ];
    expect(playsOf([{ command: '/b' }, { command: '/QUEST' }], aliased)).toEqual([
      { command: '/boost', whileHeld: '/play' },
      { command: '/play' },
    ]);
    expect(playsOf([{ command: '/b', whileHeld: '/quest' }], aliased)).toEqual([
      { command: '/boost', whileHeld: '/play' },
    ]);
  });

  it('sends a command as every name bare, then every name addressed in a group, or as its forms say', () => {
    const aliased: BotCommand[] = [{ command: '/quest', aliases: ['/play'], turn: true }];
    const quest = { command: '/quest' };
    expect(playForms(quest, aliased, 'LoreBot', true)).toEqual([
      '/quest',
      '/play',
      '/quest@LoreBot',
      '/play@LoreBot',
    ]);
    // In its bot's private chat, bare only (D139).
    expect(playForms(quest, aliased, 'LoreBot', false)).toEqual(['/quest', '/play']);
    // Its forms, in their order, those that are this command of its bot's.
    expect(
      playForms(
        { ...quest, forms: ['/play@LoreBot', '/quest', '/play@QuestBot', '/boost'] },
        aliased,
        'LoreBot',
        true
      )
    ).toEqual(['/play@LoreBot', '/quest']);
    expect(playForms({ command: '/dance' }, aliased, 'LoreBot', false)).toEqual(['/dance']);
  });

  it('derives a policy from the mechanics alone', () => {
    expect(derivedWhileHeld(undefined)).toBeUndefined();
    expect(derivedWhileHeld({ command: '/go', turn: true })).toBeUndefined();
    expect(derivedWhileHeld(declared[3])).toBe('/play');
  });
});

describe('playerSummary', () => {
  it("gives a node's chat, state, last and next play", () => {
    expect(
      playerSummary('quest-player', 'live', {
        chat: CHAT,
        commands: '/play',
        last: T0,
        next: T0 + 18 * MIN,
      })
    ).toBe('@QuestBot: live, last 12:00, next 12:18 UTC');
    expect(playerSummary('quest-player', 'stopped', undefined)).toBe('quest-player: stopped');
  });
});

/** The commands of each sitting, in order, by the sitting's index. */
const bySitting = (sends: { sitting: number; command: string }[]): string[][] => {
  const out: string[][] = [];
  for (const s of sends) (out[s.sitting] ??= []).push(s.command);
  return out;
};

/** The hour on Rome's clock of `t`. */
const romeHour = (t: number): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(t)
      .replace(':', '.')
  );

describe('a person’s sittings, played on the dev kit (bot-os.md D134)', () => {
  it('plays in bursts: every command in a sitting, a gap between sittings', async () => {
    const r = await runSittings();
    await r.until(T0 + 6 * HOUR);
    const starts = r.sittings();
    expect(starts.length).toBeGreaterThanOrEqual(17);
    for (let i = 1; i < starts.length; i++) {
      const gap = (starts[i] as number) - (starts[i - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(17 * MIN);
      expect(gap).toBeLessThanOrEqual(21 * MIN);
    }
    // Each send within a few minutes of its sitting's start; each sitting a turn at least.
    for (const s of r.sends()) {
      expect(s.sitting).toBeGreaterThanOrEqual(0);
      expect(s.t - (starts[s.sitting] as number)).toBeLessThan(3 * MIN);
    }
    expect(bySitting(r.sends()).every((c) => c[0] === '/play')).toBe(true);
    expect(r.summary('alice')).toEqual([`${starts.length} sittings`]);
    expect(r.summary('quest-player')?.[0]).toMatch(/^\d+ commands sent \(\/play \d+, /u);
    expect(r.account.replies.some((x) => x.text.startsWith('Too soon'))).toBe(false);
    await r.kit.stop();
  });

  it('takes an unlock announced in an answer, and a reset’s extra turn, in the same sitting', async () => {
    const r = await runSittings();
    await r.until(T0 + 2 * HOUR);
    const sittings = bySitting(r.sends());
    // The first: a turn; the daily; the reset, while the turn rests; the extra turn, which
    // announces a chest; the chest.
    expect(sittings[0]).toEqual(['/play', '/daily', '/coffee', '/play', '/chest']);
    // Every chest announced is opened in the sitting that announced it.
    const sends = r.sends();
    sends.forEach((s, i) => {
      if (s.text.includes('A chest appears!'))
        expect(sends[i + 1]).toMatchObject({ command: '/chest', sitting: s.sitting });
    });
    // The reset again an hour after: its own cooldown kept it back meanwhile.
    const coffees = sends.filter((s) => s.command === '/coffee');
    expect(coffees.length).toBe(2);
    expect((coffees[1] as { t: number }).t - (coffees[0] as { t: number }).t).toBeGreaterThan(HOUR);
    const steps = r.steps('player.step');
    expect(steps[0]).toBe('sitting: #1');
    expect(steps).toContain('read: /play: 32 characters');
    expect(steps).toContain('done: sitting #1 done: nothing left to play');
    await r.kit.stop();
  });

  it('plays the daily command in the first sitting after its day, and sleeps at night', async () => {
    const r = await runSittings();
    await r.until(T0 + 50 * HOUR);
    const sends = r.sends();
    const dailies = sends.filter((s) => s.command === '/daily');
    expect(dailies.map((d) => d.text)).toEqual([
      'Daily reward: 5 coins.',
      'Daily reward: 5 coins.',
      'Daily reward: 5 coins.',
    ]);
    const starts = r.sittings();
    for (let i = 1; i < dailies.length; i++) {
      const ready = (dailies[i - 1] as { t: number }).t + 24 * HOUR;
      const d = dailies[i] as { t: number; sitting: number };
      expect(d.t).toBeGreaterThan(ready);
      // No sitting started between its day's end and the sitting it went in.
      expect(starts.filter((s) => s > ready && s < (starts[d.sitting] as number))).toEqual([]);
    }
    // Asleep from about 01:30 to 08:30 in Rome, give or take 45 minutes: nothing in between.
    expect(sends.filter((s) => romeHour(s.t) >= 2.15 && romeHour(s.t) < 7.45)).toEqual([]);
    expect(r.steps('attention.step').some((s) => s.includes('(after the night)'))).toBe(true);
    await r.kit.stop();
  });

  it('sends a command no sooner than its margin after it is ready, a reaction after (D146)', async () => {
    // A sitting each minute, and a glance of no time: only the margin keeps it back.
    const r = await runSittings({
      attention: { minGapMin: 1, maxGapMin: 1, reaction: { minS: 0, maxS: 0, longChance: 0 } },
      player: { commands: [{ command: '/play' }] },
    });
    await r.until(T0 + 3 * HOUR);
    const plays = r.sends().filter((s) => s.command === '/play');
    expect(plays.length).toBeGreaterThan(5);
    for (let i = 1; i < plays.length; i++) {
      const was = plays[i - 1] as { t: number; text: string };
      const ready = was.t + (was.text.startsWith('Defeated') ? 30 : 15) * MIN;
      // Ready within a sitting: it waits for it, then the margin; never before.
      expect((plays[i] as { t: number }).t - ready).toBeGreaterThanOrEqual(5_000);
    }
    expect(r.account.replies.some((x) => x.text.startsWith('Too soon'))).toBe(false);
    await r.kit.stop();
  });

  it('forgets a sitting now and then', async () => {
    const r = await runSittings({ attention: { skipChance: 0.5 } });
    await r.until(T0 + 6 * HOUR);
    const starts = r.sittings();
    const gaps = starts.slice(1).map((s, i) => s - (starts[i] as number));
    expect(gaps.some((g) => g > 34 * MIN)).toBe(true);
    expect(r.steps('attention.step').some((s) => / forgotten\)/u.test(s))).toBe(true);
    await r.kit.stop();
  });

  it('counts the owner’s play by hand as a sitting, and puts the next one back', async () => {
    const r = await runSittings({ player: { commands: [{ command: '/play' }] } });
    await r.until(T0 + 5 * MIN);
    const planned = r.person().next as number;
    const hand = planned - 4 * MIN;
    await r.until(hand);
    r.account.byHand(CHAT, '/daily');
    await r.until(planned + MIN);
    // Nothing played when it was due: the owner was there.
    expect(r.sends().filter((s) => s.t > hand + 2000)).toEqual([]);
    expect(r.steps('attention.step')).toContain(
      `seen: played by hand at ${new Date(hand).toISOString().slice(11, 16)}`
    );
    expect(r.person()).toMatchObject({ last: hand, byHand: true });
    const next = r.person().next as number;
    expect(next - hand).toBeGreaterThanOrEqual(17 * MIN);
    await r.until(next + 2 * MIN);
    expect(r.sends().at(-1)).toMatchObject({ command: '/play', t: expect.any(Number) });
    expect((r.sends().at(-1) as { t: number }).t).toBeGreaterThanOrEqual(next);
    expect(r.summary('alice')).toEqual(['2 sittings, 1 by hand']);
    await r.kit.stop();
  });

  it('through a dry-run edge sends nothing, and plays each command once a sitting', async () => {
    const r = await runSittings({ dryRun: true });
    await r.until(T0 + HOUR);
    expect(r.account.sent).toEqual([]);
    const steps = r.steps('player.step');
    // Nothing answers: the turn and the daily stay ready, played once each sitting; the chest is
    // never announced, nor the turn held for the reset.
    expect(steps.slice(0, 4)).toEqual([
      'sitting: #1',
      'sent: /play (dry run)',
      'sent: /daily (dry run)',
      'done: sitting #1 done: nothing left to play',
    ]);
    expect(steps.filter((s) => s === 'sent: /play (dry run)')).toHaveLength(r.sittings().length);
    expect(r.summary('quest-player')).toEqual([
      `${2 * r.sittings().length} commands in a dry run (/play ${r.sittings().length}, /daily ${r.sittings().length})`,
    ]);
    await r.kit.stop();
  });

  it('is stopped by drift on its bot’s parser, through its state, and plays no more', async () => {
    const r = await runSittings();
    await r.until(T0 + 5 * MIN);
    r.account.garble = true;
    for (let i = 0; i < 6; i++) {
      r.account.byHand(CHAT, '/play');
      await r.until(r.kit.clock.now() + 30_000);
    }
    expect(r.kit.core.state('quest-player')).toMatchObject({ state: 'stopped' });
    expect(r.kit.core.state('quest-player')?.reason).toMatch(
      /^drift: quest could not read 6 messages/u
    );
    const sent = r.account.sent.length;
    await r.until(T0 + 2 * HOUR);
    expect(r.account.sent).toHaveLength(sent);
    await r.kit.stop();
  });

  it('waits for the account, telling it once, then plays', async () => {
    const r = await runSittings({ closed: true, player: { commands: [{ command: '/play' }] } });
    const first = r.person().next as number;
    // A glance (a minute and more, at worst), then a minute's wait, then another: told once.
    await r.until(first + 3 * CONNECT_WAIT_MS);
    expect(r.steps('player.step')).toEqual([
      'sitting: #1',
      "waiting: the owner's account is not connected",
    ]);
    r.account.open();
    // The bot says nothing to it.
    r.account.garble = true;
    await r.until(first + 4 * CONNECT_WAIT_MS + ANSWER_WAIT_MS + MIN);
    expect(r.account.sent).toEqual([{ chat: CHAT, text: '/play' }]);
    expect(r.steps('player.step').at(-1)).toBe('done: sitting #1 done: nothing left to play');
    await r.kit.stop();
  });

  it('gives up waiting for an answer that never comes', async () => {
    const r = await runSittings({ player: { commands: [{ command: '/play' }] } });
    // The clone's answers lost: no reply ever comes.
    (r.account as unknown as { answer: () => void }).answer = () => undefined;
    const first = r.person().next as number;
    await r.until(first + ANSWER_WAIT_MS + MIN);
    expect(r.steps('player.step')).toEqual([
      'sitting: #1',
      'sent: /play #500',
      'done: sitting #1 done: nothing left to play',
    ]);
    await r.kit.stop();
  });

  it('follows your play: waits for your command’s answer, then plays the rest, the turn too (D138)', async () => {
    const r = await runSittings({
      attention: { scheduled: false, followsMyPlay: true, listen: [CHAT] },
      graph: (g) => ({
        ...g,
        edges: [
          ...(g.edges ?? []),
          { from: `${TELEGRAM_USER}.chat`, to: 'alice.listen', type: 'chat-in', reads: [CHAT] },
        ],
      }),
    });
    expect(r.status().next).toBe('follows your play');
    await r.until(T0 + 30 * MIN);
    expect(r.account.sent).toEqual([]);
    // A slow bot: its answer to your turn comes well after the sitting starts.
    r.account.answerMs = 90_000;
    const hand = T0 + 30 * MIN;
    r.account.byHand(CHAT, '/play');
    await r.until(hand + 85_000);
    expect(r.sittings()).toEqual([hand + 3000]);
    // Waiting for the answer: your turn not played again over it.
    expect(r.account.sent).toEqual([]);
    r.account.answerMs = 1000;
    await r.until(hand + 5 * MIN);
    const played = r.sends().map((s) => s.command);
    expect(played.slice(0, 2)).toEqual(['/play', '/daily']);
    expect(played).toContain('/coffee');
    // The turn its reset freed, in the same sitting.
    expect(played.filter((c) => c === '/play')).toHaveLength(2);
    expect(r.account.replies.some((x) => x.text.startsWith('Too soon'))).toBe(false);
    expect(r.sittings()).toHaveLength(1);
    expect(r.steps('player.step')).toContain('done: sitting #1 done: nothing left to play');
    expect(r.summary('alice')).toEqual(['1 sitting (1 following you)']);
    await r.kit.stop();
  });

  it('looks again when you write during its sitting (D138)', async () => {
    const r = await runSittings({
      attention: { followsMyPlay: true, listen: [CHAT] },
      graph: (g) => ({
        ...g,
        edges: [
          ...(g.edges ?? []),
          { from: `${TELEGRAM_USER}.chat`, to: 'alice.listen', type: 'chat-in', reads: [CHAT] },
        ],
      }),
    });
    const first = r.person().next as number;
    await r.until(first + 1000);
    r.account.byHand(CHAT, '/daily');
    await r.until(first + 5 * MIN);
    expect(r.steps('attention.step')).toContain(
      'heard: a message of yours: its players look again'
    );
    expect(r.sittings()).toHaveLength(1);
    // Your /daily answered: not sent again over it.
    expect(r.account.sent.filter((s) => s.text === '/daily')).toEqual([]);
    expect(r.steps('player.step').at(-1)).toBe('done: sitting #1 done: nothing left to play');
    await r.kit.stop();
  });

  it('shows its next play on its card and its plays on its page (D112)', async () => {
    const r = await runSittings();
    const m = parseManifest(playerPlugin().manifest);
    expect(m.widget).toEqual({ show: 'until', read: 'status', path: 'next' });
    expect(m.page?.sections.map((s) => s.show)).toEqual(['keyValue', 'until', 'until']);
    const node = r.kit.core.controls.status().plugins.find((p) => p.id === 'quest-player');
    expect(node?.widget).toEqual(r.status());
    expect(r.status()).toEqual({
      chat: CHAT,
      commands: '/play, /chest, /daily, /coffee',
      next: r.person().next,
    });
    await r.until((r.person().next as number) + 1000);
    // In a sitting, its next step.
    expect(r.status().next).toBeLessThan(r.person().next as number);
    await r.kit.stop();
  });

  it('drops its sitting when the bot is off, and its safety stop stops its node', async () => {
    const r = await runSittings();
    await r.until((r.person().next as number) + 1000);
    r.kit.core.controls.turnOff();
    expect(r.steps('player.step').at(-1)).toBe('stopped: sitting #1 dropped: the bot is off');
    expect(r.status().next).toBeUndefined();
    r.kit.core.controls.turnOn();
    expect(r.status().next).toBe(r.person().next);
    expect(r.kit.core.controls.killNode('quest-player')).toEqual({
      result: 'quest-player killed: @QuestBot: stopped',
    });
    expect(r.kit.core.state('quest-player')).toMatchObject({ state: 'stopped' });
    await r.kit.stop();
  });

  it('ends a sitting kept across a restart whose next step was lost', async () => {
    const r = await runSittings({
      documents: {
        'quest-player': { state: { last: T0 - HOUR, sitting: { id: 4, sent: {}, count: 0 } } },
      },
    });
    expect(r.steps('player.step')).toEqual([
      'done: sitting #4 done: the sitting ended while it was down',
    ]);
    expect(r.status().last).toBe(T0 - HOUR);
    await r.kit.stop();
  });

  it('plays its state’s commands by default, in its order, from its read (D137)', async () => {
    const r = await runSittings({ player: { commands: undefined } });
    expect(r.status().commands).toBe('/play, /daily, /chest, /coffee');
    await r.until(T0 + 2 * HOUR);
    const sent = new Set(r.account.sent.map((s) => s.text));
    expect(sent.has('/play')).toBe(true);
    expect(sent.has('/daily')).toBe(true);
    await r.kit.stop();
  });

  it('plays nothing its state knows not, and says so once', async () => {
    const r = await runSittings({
      player: { commands: [{ command: '/dance' }, { command: '/play' }] },
      graph: (g) => ({
        ...g,
        edges: (g.edges ?? []).map((e) =>
          e.type === 'chat-out' ? { ...e, commands: ['/play', '/dance'] } : e
        ),
      }),
    });
    await r.until(T0 + HOUR);
    const steps = r.steps('player.step');
    expect(steps.filter((s) => s.startsWith('failed'))).toEqual([
      'failed: its state knows no /dance: never played',
    ]);
    expect(r.account.sent.every((s) => s.text === '/play')).toBe(true);
    await r.kit.stop();
  });

  it('counts a send its outbox refuses as failed, and tries it no more that sitting', async () => {
    const r = await runSittings({
      player: { commands: [{ command: '/play' }] },
      // Its edge does not allow /play.
      graph: (g) => ({
        ...g,
        edges: (g.edges ?? []).map((e) =>
          e.type === 'chat-out' ? { ...e, commands: ['/daily'] } : e
        ),
      }),
    });
    await r.until((r.person().next as number) + MIN);
    expect(r.steps('player.step')).toEqual([
      'sitting: #1',
      expect.stringMatching(/^failed: \/play: /u),
      'done: sitting #1 done: nothing left to play',
    ]);
    expect(r.summary('quest-player')).toEqual(['1 failed']);
    await r.kit.stop();
  });
});
