import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  Core,
  FakeConnector,
  fakeConnectorPlugin,
  GraphError,
  type GraphInput,
  moveChats,
  parseManifest,
  resolveGraph,
  VirtualClock,
  withInstances,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SCHEDULE } from '#src/schedule.ts';
import { QUEST, QUESTBOT, questPlugin } from '#test/quest.ts';
import {
  CONNECT_WAIT_MS,
  PLAN_GRACE_MS,
  RETRY_MS,
  TURN_ACTOR,
  turnActorConfig,
  turnActorPlugin,
  type TurnStatus,
  type TurnStep,
  turnSummary,
} from './turn-actor.ts';

const T0 = Date.parse('2026-11-06T12:00:00Z'); // 13:00 in Rome
const MIN = 60_000;
const CHAT = `@${QUESTBOT}`;

/** alice's account, faked: each send answered with an id, as Telegram does. */
class Account extends FakeConnector {
  private n = 500;
  fail: string | undefined;
  deliver(chat: string, text: string): Promise<{ id?: string }> {
    if (this.fail !== undefined) return Promise.reject(new Error(this.fail));
    this.send(chat, text);
    return Promise.resolve({ id: String(this.n++) });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** @QuestBot's parser and one turn-actor instance, `quest-turns`, on alice's faked account. */
async function run(
  o: {
    /** Its chat-out edge: a dry run (the editor's default for a new edge, D64), or live. */
    edge?: 'dry-run' | 'live';
    dataDir?: string;
    clock?: VirtualClock;
    config?: Record<string, unknown>;
  } = {}
) {
  const account = new Account({ account: 'telegram:alice' });
  const steps: TurnStep[] = [];
  const clock = o.clock ?? new VirtualClock(T0);
  const core = new Core({
    clock,
    ...(o.dataDir === undefined ? {} : { dataDir: o.dataDir }),
    record: (r) => {
      if (r.type === `${TURN_ACTOR}.step`) steps.push(r as unknown as TurnStep);
    },
    // A function of the default graph, as the instance's wiring's is.
    graph: (defaults) =>
      withInstances(defaults, TURN_ACTOR, [
        {
          id: 'quest-turns',
          // One interval, 17 minutes: a plan "at once" is at once.
          config: { seed: 7, schedule: { maxGapMin: 17 }, ...o.config },
          edges: [
            { from: TELEGRAM_USER, to: 'quest-turns.chat', reads: [CHAT] },
            {
              from: 'quest-turns.chat',
              to: `${TELEGRAM_USER}.chat`,
              sends: [CHAT],
              commands: ['/play'],
              ...(o.edge === 'live' ? {} : { dryRun: true }),
            },
            { from: QUEST, to: 'quest-turns.parser' },
          ],
        },
      ]),
  });
  core.register(fakeConnectorPlugin(TELEGRAM_USER, account), questPlugin(), turnActorPlugin());
  await core.start();
  const status = (): TurnStatus => {
    const r = core.controls.read('quest-turns', 'status');
    return ('value' in r ? r.value : r) as TurnStatus;
  };
  const events = (): string[] => steps.map((s) => s.event);
  /** Runs the clock to `t` a minute at a time, each send's answer awaited. */
  const until = async (t: number): Promise<void> => {
    while (clock.now() < t) {
      clock.advanceTo(Math.min(t, clock.now() + MIN));
      await flush();
    }
    clock.advanceTo(t);
    await flush();
  };
  /** Its lines in the owner's summary (D92), since the start. */
  const summary = (): string[] | undefined =>
    core.summary({ since: 0, until: clock.now() + 1 }).find((s) => s.node === 'quest-turns')?.lines;
  return { core, clock, account, steps, events, status, until, summary };
}

describe('its bot’s chat, its edges’ alone (D97)', () => {
  const manifests = new Map(
    [
      fakeConnectorPlugin(TELEGRAM_USER, new FakeConnector({ account: 'telegram:alice' })),
      questPlugin(),
      turnActorPlugin(),
    ].map((p) => {
      const m = parseManifest(p.manifest);
      return [m.id, m];
    })
  );
  const graph = (sends: string[], reads: string[] | '*', config = {}): GraphInput => ({
    version: 2,
    nodes: [
      { id: TELEGRAM_USER, plugin: TELEGRAM_USER },
      { id: QUEST, plugin: QUEST },
      { id: 'quest-turns', plugin: TURN_ACTOR, config },
    ],
    edges: [
      { from: `${TELEGRAM_USER}.chat`, to: `${QUEST}.chat`, type: 'chat-in', reads: [CHAT] },
      { from: `${TELEGRAM_USER}.chat`, to: 'quest-turns.chat', type: 'chat-in', reads },
      { from: 'quest-turns.chat', to: `${TELEGRAM_USER}.chat`, type: 'chat-out', sends },
      { from: `${QUEST}.interface`, to: 'quest-turns.parser', type: 'interface' },
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

  it('takes the one chat its chat-out edge names, which its chat-in edge reads', () => {
    expect(problems(graph([CHAT], [CHAT]))).toEqual([]);
    // Without case, as the networks compare names.
    expect(problems(graph([CHAT], [CHAT.toLowerCase()]))).toEqual([]);
  });

  it('refuses an edge of no chat, of two, or of a chat not a bot’s @username', () => {
    expect(problems(graph([], [CHAT]))).toEqual([
      `node quest-turns: output port chat sends to one chat, its bot's @username: its edge names none (edge quest-turns.chat → ${TELEGRAM_USER}.chat)`,
    ]);
    expect(problems(graph([CHAT, '@OtherBot'], [CHAT]))[0]).toContain(
      `its edge names ${CHAT}, @OtherBot`
    );
    expect(problems(graph(['5000001'], ['5000001']))).toEqual([
      `node quest-turns: output port chat sends to its bot's @username, not 5000001 (edge quest-turns.chat → ${TELEGRAM_USER}.chat)`,
    ]);
  });

  it('refuses a chat-in edge that reads another chat, more, or every chat', () => {
    const said = (reads: string[] | '*') => problems(graph([CHAT], reads));
    expect(said(['@OtherBot'])).toEqual([
      `node quest-turns: input port chat reads ${CHAT}, the chat its output chat sends to, and no other: its edge reads @OtherBot (edge ${TELEGRAM_USER}.chat → quest-turns.chat)`,
    ]);
    expect(said([CHAT, '@OtherBot'])[0]).toContain(`its edge reads ${CHAT}, @OtherBot`);
    expect(said('*')[0]).toContain('its edge reads every chat');
    expect(said([])[0]).toContain('its edge reads none');
  });

  it('moves the chat of a graph saved by 0.1.19 from its config onto its edges', () => {
    const saved = graph([], [], { chat: CHAT, seed: 3 });
    expect(problems(saved)).toEqual([]);
    const moved = moveChats(saved, manifests) as GraphInput;
    expect(moved.nodes.find((n) => n.id === 'quest-turns')?.config).toEqual({ seed: 3 });
    expect(
      moved.edges?.filter((e) => e.from === 'quest-turns.chat' || e.to === 'quest-turns.chat')
    ).toMatchObject([{ reads: [CHAT] }, { sends: [CHAT] }]);
    // A chat there already, by any case, is not added again; nothing else moved, nothing changed.
    const again = moveChats(
      graph([CHAT], [CHAT.toLowerCase()], { chat: CHAT }),
      manifests
    ) as GraphInput;
    expect(again.edges?.[1]?.reads).toEqual([CHAT.toLowerCase()]);
    expect(again.edges?.[2]?.sends).toEqual([CHAT]);
    expect(again.nodes[2]).toEqual({ id: 'quest-turns', plugin: TURN_ACTOR });
    const plain = graph([CHAT], [CHAT]);
    expect(moveChats(plain, manifests)).toBe(plain);
  });
});

describe('turnActorConfig', () => {
  it('takes its command and pace, no chat (its edge’s, D97), and refuses a pace under the bots’ rest', () => {
    const c = turnActorConfig.parse({ chat: CHAT, schedule: { maxGapMin: 25 } });
    expect(c).toMatchObject({ command: '/play', nightSalt: '' });
    expect(c).not.toHaveProperty('chat');
    expect(c.schedule).toMatchObject({ minGapMin: 17, maxGapMin: 25 });
    expect(() => turnActorConfig.parse({ schedule: { minGapMin: 10 } })).toThrow(
      'minGapMin must be at least 15'
    );
  });

  it('carries every default in its schema, the schedule’s included, and applies them as before', () => {
    expect(turnActorConfig.parse({}).schedule).toEqual(DEFAULT_SCHEDULE);
    expect(turnActorConfig.parse({ schedule: {} }).schedule).toEqual(DEFAULT_SCHEDULE);
    const json = z.toJSONSchema(turnActorConfig, { io: 'input' }) as {
      properties: Record<string, { default?: unknown; description?: string; properties?: object }>;
    };
    const schedule = json.properties['schedule'];
    expect(schedule?.default).toEqual(DEFAULT_SCHEDULE);
    expect(schedule?.description).toBeDefined();
    const fields = (schedule?.properties ?? {}) as Record<string, { default?: unknown }>;
    expect(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.default]))).toEqual(
      DEFAULT_SCHEDULE
    );
    expect(json.properties['command']?.default).toBe('/play');
    expect(json.properties['chat']).toBeUndefined();
    // The default is a copy each time: a parse cannot change the next one's.
    const a = turnActorConfig.parse({});
    a.schedule.minGapMin = 99;
    expect(turnActorConfig.parse({}).schedule.minGapMin).toBe(17);
  });
});

describe('turnSummary', () => {
  it("gives an instance's chat, state, last and next turn", () => {
    expect(
      turnSummary('quest-turns', 'live', {
        chat: CHAT,
        command: '/play',
        last: T0,
        next: T0 + 18 * MIN,
      })
    ).toBe('@QuestBot: live, last 12:00, next 12:18 UTC');
    expect(turnSummary('quest-turns', 'stopped', undefined)).toBe('quest-turns: stopped');
  });
});

describe('the turn-actor', () => {
  it('plays nothing once its node is stopped, nor after a restart, until the stop is cleared', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-actor-'));
    try {
      const a = await run({ dataDir, clock: new VirtualClock(T0 - MIN) });
      expect(a.status().next).toBeDefined();
      expect(a.core.stopNode('quest-turns', 'drift on quest', 'drift')).toBe(true);
      expect(a.status().next).toBeUndefined();
      expect(a.steps.at(-1)?.detail).toBe('plan dropped: stopped: drift on quest');
      await a.core.stop();
      const b = await run({ dataDir, clock: a.clock });
      await b.until(T0 + 120 * MIN);
      expect(b.core.state('quest-turns')).toMatchObject({ state: 'stopped' });
      expect(b.events()).toEqual([]);
      expect(b.account.sent).toEqual([]);
      expect(b.core.clearStop('quest-turns')).toBe(true);
      await b.core.stop();
      const c = await run({ dataDir, clock: a.clock });
      expect(c.events()).toEqual(['planned']);
      await c.core.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('through a dry-run edge sends nothing, at once with no last turn, then at the planner’s pace', async () => {
    const r = await run();
    expect(r.events()).toEqual(['planned']);
    await r.until(T0);
    expect(r.steps[1]).toMatchObject({
      actor: 'quest-turns',
      chat: CHAT,
      event: 'sent',
      detail: '/play (dry run)',
    });
    const { next } = r.status();
    expect(r.status().last).toBe(T0);
    expect((next as number) - T0).toBeGreaterThanOrEqual(17 * MIN);
    expect((next as number) - T0).toBeLessThanOrEqual(60 * MIN);
    await r.until(T0 + 6 * 60 * MIN);
    expect(r.events().filter((e) => e === 'sent').length).toBeGreaterThanOrEqual(10);
    expect(r.account.sent).toEqual([]);
    expect(r.summary()?.[0]).toMatch(/^\d+ turns in a dry run$/u);
  });

  it('in live sends its command to its chat, tells its parser, and waits out the rest it reads', async () => {
    const r = await run({ edge: 'live', config: { schedule: { maxGapMin: 17, skipChance: 0 } } });
    r.account.open();
    await r.until(T0);
    expect(r.account.sent).toEqual([{ chat: CHAT, text: '/play' }]);
    // Lost a fight: the parser matches the reply to the turn sent, and says 30 minutes' rest.
    r.account.hear({
      chat: CHAT,
      sender: QUESTBOT,
      time: T0 + 1000,
      id: '900',
      replyTo: '500',
      text: 'Defeated.',
    });
    await r.until(T0 + 25 * MIN);
    expect(r.steps.find((s) => s.event === 'rest')?.detail).toMatch(
      /^12:3[0-3] UTC \(@QuestBot rests: defeated\)$/u
    );
    await r.until(T0 + 34 * MIN);
    expect(r.account.sent).toHaveLength(2);
    expect(r.summary()).toEqual(['2 turns sent']);
  });

  it('with no recent turn, sends within the spread of its interval, not at once', async () => {
    const r = await run({ config: { schedule: {} } });
    const first = r.status().next as number;
    expect(first - T0).toBeGreaterThanOrEqual(0);
    expect(first - T0).toBeLessThanOrEqual(3 * MIN);
  });

  it('counts from a turn alice sends by hand in its chat, and from none elsewhere', async () => {
    const r = await run({ clock: new VirtualClock(T0 - 5 * MIN) });
    await r.until(T0 - 5 * MIN);
    const own = { sender: 'alice', own: true, id: '1' };
    r.account.hear({ ...own, chat: CHAT, time: T0, text: '/play' });
    expect(r.steps.at(-2)).toMatchObject({ event: 'seen', detail: 'sent by hand at 12:00' });
    expect(r.steps.at(-1)?.event).toBe('planned');
    expect(r.status().last).toBe(T0);
    // An older one, another command, another's: nothing.
    r.account.hear({ ...own, chat: CHAT, time: T0 - MIN, text: '/play' });
    r.account.hear({ ...own, chat: CHAT, time: T0 + MIN, text: '/inventario' });
    r.account.hear({ chat: CHAT, sender: QUESTBOT, time: T0 + MIN, text: '/play' });
    expect(r.events().filter((e) => e === 'seen')).toHaveLength(1);
    // Its chat delivered by id, its @username an alias (D90): the same chat.
    r.account.hear({ ...own, chat: '5000001', aliases: [CHAT], time: T0 + 2 * MIN, text: '/play' });
    expect(r.events().filter((e) => e === 'seen')).toHaveLength(2);
    expect(r.summary()).toEqual(['1 turn in a dry run, 2 by hand']);
  });

  it('waits for the account through a live edge, and retries a failed send two minutes later', async () => {
    const r = await run({ edge: 'live' });
    await r.until(T0);
    expect(r.events()).toEqual(['planned', 'waiting']);
    await r.until(T0 + CONNECT_WAIT_MS);
    expect(r.events()).toEqual(['planned', 'waiting']);
    r.account.open();
    r.account.fail = 'PEER_ID_INVALID';
    await r.until(T0 + 2 * CONNECT_WAIT_MS);
    expect(r.steps.at(-2)).toMatchObject({ event: 'failed' });
    expect(r.steps.at(-1)).toMatchObject({ event: 'planned' });
    expect(r.status().next).toBe(T0 + 2 * CONNECT_WAIT_MS + RETRY_MS);
    r.account.fail = undefined;
    await r.until(T0 + 2 * CONNECT_WAIT_MS + RETRY_MS);
    expect(r.account.sent).toHaveLength(1);
    expect(r.summary()).toEqual(['1 turn sent, 1 failed']);
  });

  it('drops its plan off and plans again on; its safety stop stops its node', async () => {
    const r = await run({ clock: new VirtualClock(T0 - MIN) });
    expect(r.status().next).toBeDefined();
    r.core.controls.turnOff();
    expect(r.status().next).toBeUndefined();
    expect(r.steps.at(-1)?.detail).toBe('plan dropped: the bot is off');
    r.core.controls.turnOn();
    expect(r.status().next).toBeDefined();
    const killed = r.core.controls.kill();
    expect(JSON.stringify(killed)).toContain('@QuestBot: stopped');
    expect(r.core.state('quest-turns')).toMatchObject({
      state: 'stopped',
      stop: { reason: 'safety stop', source: 'safety' },
    });
    expect(r.status().next).toBeUndefined();
    expect(r.steps.at(-1)?.detail).toBe('plan dropped: stopped: safety stop');
    // Back on, still stopped: only the owner, in the editor, starts it again.
    r.core.controls.turnOff();
    r.core.controls.turnOn();
    expect(r.status().next).toBeUndefined();
  });

  it('keeps its last turn and its plan across a restart, and drops a plan long overdue', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-actor-'));
    try {
      const a = await run({ dataDir });
      await a.until(T0);
      const kept = a.status();
      expect(kept.last).toBe(T0);
      await a.core.stop();
      const b = await run({ dataDir, clock: a.clock });
      expect(b.status()).toEqual(kept);
      expect(b.events()).toEqual([]);
      await b.core.stop();
      a.clock.advanceTo((kept.next as number) + PLAN_GRACE_MS + 1);
      const c = await run({ dataDir, clock: a.clock });
      // Planned afresh from the last turn, long past: at once.
      expect(c.status()).toEqual({
        chat: CHAT,
        command: '/play',
        last: T0,
        next: a.clock.now(),
      });
      expect(c.events()).toEqual(['planned']);
      await c.core.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('several turn-actor nodes', () => {
  it('run one per bot from a saved graph, each on its own instance, store, state and records', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-actors-'));
    const account = new Account({ account: 'telegram:alice' });
    const records: { type: string; instance?: unknown; event?: unknown }[] = [];
    const clock = new VirtualClock(T0);
    // Each actor reads its bot's chat (chat-in) and sends its command there (chat-out).
    const read = (to: string, bot: string) => ({
      from: `${TELEGRAM_USER}.chat`,
      to: `${to}.chat`,
      type: 'chat-in' as const,
      reads: [bot],
    });
    const chat = (to: string, bot: string, commands = ['/play']) => [
      read(to, bot),
      {
        from: `${to}.chat`,
        to: `${TELEGRAM_USER}.chat`,
        type: 'chat-out' as const,
        sends: [bot],
        commands,
        dryRun: true,
      },
    ];
    const core = new Core({
      clock,
      dataDir,
      record: (r) => records.push(r as (typeof records)[number]),
      // As the editor saves it: plain data, each node its instance, config and state.
      graph: {
        version: 2,
        nodes: [
          { id: TELEGRAM_USER, plugin: TELEGRAM_USER, account: 'telegram:alice' },
          { id: QUEST, plugin: QUEST },
          {
            id: 'quest-a',
            plugin: TURN_ACTOR,
            instance: 'turns-a',
            config: { seed: 1, schedule: { maxGapMin: 17 } },
          },
          {
            id: 'quest-b',
            plugin: TURN_ACTOR,
            disabled: true,
            config: { seed: 2, command: '/quest' },
          },
        ],
        edges: [
          read(QUEST, CHAT),
          ...chat('quest-a', CHAT),
          ...chat('quest-b', CHAT, ['/quest']),
          { from: `${QUEST}.interface`, to: 'quest-a.parser', type: 'interface' },
          { from: `${QUEST}.interface`, to: 'quest-b.parser', type: 'interface' },
        ],
      },
    });
    core.register(fakeConnectorPlugin(TELEGRAM_USER, account), questPlugin(), turnActorPlugin());
    await core.start();
    expect(core.status().map((s) => [s.id, s.state])).toEqual([
      [TELEGRAM_USER, 'running'],
      [QUEST, 'running'],
      ['quest-a', 'running'],
      ['quest-b', 'disabled'],
    ]);
    clock.advanceTo(T0 + 20 * MIN);
    await flush();
    // Each records as its own instance: only the enabled one played; the disabled one never ran.
    const steps = records.filter((r) => r.type === `${TURN_ACTOR}.step`);
    expect(steps.some((s) => s.event === 'sent')).toBe(true);
    expect(new Set(steps.map((s) => s.instance))).toEqual(new Set(['turns-a']));
    const statusOf = (id: string) => {
      const r = core.controls.read(id, 'status');
      return ('value' in r ? r.value : r) as TurnStatus;
    };
    expect(statusOf('quest-a').last).toBeGreaterThanOrEqual(T0);
    expect(statusOf('quest-b').last).toBeUndefined();
    await core.stop();
    expect(fs.readdirSync(path.join(dataDir, 'instances')).sort()).toEqual(
      expect.arrayContaining(['quest-b', 'turns-a'])
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
