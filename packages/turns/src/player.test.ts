import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  FakeConnector,
  fakeConnectorPlugin,
  GraphError,
  type GraphInput,
  parseManifest,
  resolveGraph,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { attentionPlugin } from '#src/attention.ts';
import { QUEST, questGamePlugin } from '#test/quest.ts';
import { CHAT, PLAYS, runSittings, T0 } from '#test/sittings-run.ts';
import {
  ANSWER_WAIT_MS,
  CONNECT_WAIT_MS,
  PLAYER,
  playerConfig,
  playerPlugin,
  playerSummary,
} from './player.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('its ports: its bot’s chat, its parser, its person (D97, D133)', () => {
  const manifests = new Map(
    [
      fakeConnectorPlugin(TELEGRAM_USER, new FakeConnector({ account: 'telegram:alice' })),
      questGamePlugin(),
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
      { id: 'alice', plugin: 'attention' },
      { id: 'quest-player', plugin: PLAYER },
    ],
    edges: [
      { from: `${TELEGRAM_USER}.chat`, to: `${QUEST}.chat`, type: 'chat-in', reads: [CHAT] },
      { from: 'quest-player.chat', to: `${TELEGRAM_USER}.chat`, type: 'chat-out', sends },
      { from: `${QUEST}.interface`, to: 'quest-player.parser', type: 'interface' },
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

  it('takes the one chat its edge names, its parser and its person', () => {
    expect(problems(graph([CHAT], [person]))).toEqual([]);
  });

  it('needs a person, and refuses an edge of no chat, of two, or not a bot’s', () => {
    expect(problems(graph([CHAT]))).toEqual([
      'node quest-player: input port attention (attention) is not bound',
    ]);
    expect(problems(graph([], [person]))).toEqual([
      `node quest-player: output port chat sends to one chat, its bot's @username: its edge names none (edge quest-player.chat → ${TELEGRAM_USER}.chat)`,
    ]);
    expect(problems(graph([CHAT, '@OtherBot'], [person]))[0]).toContain(
      `its edge names ${CHAT}, @OtherBot`
    );
    expect(problems(graph(['5000001'], [person]))[0]).toContain('not 5000001');
  });

  it('has no chat-in: an edge to one is refused (D99)', () => {
    expect(playerPlugin().manifest.inputs).not.toHaveProperty('chat');
    expect(
      problems(graph([CHAT], [person, { from: `${TELEGRAM_USER}.chat`, to: 'quest-player.chat' }]))
    ).toEqual([expect.stringContaining('quest-player')]);
  });
});

describe('playerConfig', () => {
  it('plays the turn by default, and takes each command with its policy, in order', () => {
    expect(playerConfig.parse({})).toEqual({ commands: [{ command: '/play' }] });
    expect(playerConfig.parse({ commands: PLAYS }).commands[3]).toEqual({
      command: '/coffee',
      whileHeld: '/play',
    });
    expect(() => playerConfig.parse({ commands: [] })).toThrow();
    expect(() => playerConfig.parse({ commands: [{ command: 'play' }] })).toThrow(
      'expected a command, as /play'
    );
    // The default is a copy each time.
    playerConfig.parse({}).commands.push({ command: '/x' });
    expect(playerConfig.parse({}).commands).toHaveLength(1);
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

  it('is stopped by drift on its parser, and plays no more', async () => {
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

  it('plays nothing its parser knows not, and says so once', async () => {
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
      'failed: its parser knows no /dance: never played',
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
