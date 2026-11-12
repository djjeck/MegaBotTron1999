import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  Core,
  FakeConnector,
  fakeConnectorPlugin,
  type Mode,
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
    mode?: Mode;
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
          config: { chat: CHAT, seed: 7, schedule: { maxGapMin: 17 }, ...o.config },
          edges: [
            { from: TELEGRAM_USER, to: 'quest-turns.chat', reads: [CHAT] },
            {
              from: 'quest-turns.chat',
              to: `${TELEGRAM_USER}.chat`,
              sends: [CHAT],
              commands: ['/play'],
            },
            { from: QUEST, to: 'quest-turns.parser' },
          ],
        },
      ]),
  });
  core.register(fakeConnectorPlugin(TELEGRAM_USER, account), questPlugin(), turnActorPlugin());
  core.load();
  if (o.mode !== undefined) core.modes.set('quest-turns', o.mode);
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
  return { core, clock, account, steps, events, status, until };
}

describe('turnActorConfig', () => {
  it('takes its chat, command and pace, and refuses a pace under the bots’ rest', () => {
    const c = turnActorConfig.parse({ chat: CHAT, schedule: { maxGapMin: 25 } });
    expect(c).toMatchObject({ chat: CHAT, command: '/play', nightSalt: '' });
    expect(c.schedule).toMatchObject({ minGapMin: 17, maxGapMin: 25 });
    expect(() => turnActorConfig.parse({ chat: QUESTBOT })).toThrow('@username');
    expect(() => turnActorConfig.parse({ chat: CHAT, schedule: { minGapMin: 10 } })).toThrow(
      'minGapMin must be at least 15'
    );
  });

  it('carries every default in its schema, the schedule’s included, and applies them as before', () => {
    expect(turnActorConfig.parse({ chat: CHAT }).schedule).toEqual(DEFAULT_SCHEDULE);
    expect(turnActorConfig.parse({ chat: CHAT, schedule: {} }).schedule).toEqual(DEFAULT_SCHEDULE);
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
    expect(json.properties['chat']?.description).toContain('@username');
    // The default is a copy each time: a parse cannot change the next one's.
    const a = turnActorConfig.parse({ chat: CHAT });
    a.schedule.minGapMin = 99;
    expect(turnActorConfig.parse({ chat: CHAT }).schedule.minGapMin).toBe(17);
  });
});

describe('turnSummary', () => {
  it("gives an instance's chat, mode, last and next turn", () => {
    expect(
      turnSummary('quest-turns', 'live', {
        chat: CHAT,
        command: '/play',
        last: T0,
        next: T0 + 18 * MIN,
      })
    ).toBe('@QuestBot: live, last 12:00, next 12:18 UTC');
    expect(turnSummary('quest-turns', 'read-only', undefined)).toBe('quest-turns: read-only');
  });
});

describe('the turn-actor', () => {
  it('plays nothing read-only, the mode it starts in', async () => {
    const r = await run();
    await r.until(T0 + 120 * MIN);
    expect(r.events()).toEqual([]);
    expect(r.status()).toEqual({ chat: CHAT, command: '/play' });
    expect(r.account.sent).toEqual([]);
  });

  it('in dry-run sends nothing, at once with no last turn, then at the planner’s pace', async () => {
    const r = await run({ mode: 'dry-run' });
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
  });

  it('in live sends its command to its chat, tells its parser, and waits out the rest it reads', async () => {
    const r = await run({ mode: 'live', config: { schedule: { maxGapMin: 17, skipChance: 0 } } });
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
  });

  it('with no recent turn, sends within the spread of its interval, not at once', async () => {
    const r = await run({ mode: 'dry-run', config: { schedule: {} } });
    const first = r.status().next as number;
    expect(first - T0).toBeGreaterThanOrEqual(0);
    expect(first - T0).toBeLessThanOrEqual(3 * MIN);
  });

  it('counts from a turn alice sends by hand in its chat, and from none elsewhere', async () => {
    const r = await run({ mode: 'dry-run', clock: new VirtualClock(T0 - 5 * MIN) });
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
  });

  it('waits for the account in live, and retries a failed send two minutes later', async () => {
    const r = await run({ mode: 'live' });
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
  });

  it('drops its plan read-only, paused, off or killed, and plans again when it may', async () => {
    const r = await run({ mode: 'dry-run', clock: new VirtualClock(T0 - MIN) });
    expect(r.status().next).toBeDefined();
    r.core.modes.set('quest-turns', 'read-only');
    expect(r.status().next).toBeUndefined();
    expect(r.steps.at(-1)?.detail).toBe('plan dropped: read-only');
    r.core.modes.set('quest-turns', 'dry-run');
    expect(r.status().next).toBeDefined();
    expect(r.core.pause('quest-turns', 'drift')).toBe(true);
    expect(r.status().next).toBeUndefined();
    expect(r.core.resume('quest-turns')).toBe(true);
    expect(r.status().next).toBeDefined();
    r.core.controls.turnOff();
    expect(r.status().next).toBeUndefined();
    r.core.controls.turnOn();
    expect(r.status().next).toBeDefined();
    const killed = r.core.controls.kill();
    expect(JSON.stringify(killed)).toContain('@QuestBot: read-only');
    expect(r.core.modes.get('quest-turns')).toBe('read-only');
    expect(r.status().next).toBeUndefined();
  });

  it('keeps its last turn and its plan across a restart, and drops a plan long overdue', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-actor-'));
    try {
      const a = await run({ mode: 'dry-run', dataDir });
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
  it('run one per bot from a saved graph, each on its own instance, store, mode and records', async () => {
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
      },
    ];
    const core = new Core({
      clock,
      dataDir,
      record: (r) => records.push(r as (typeof records)[number]),
      // As the editor saves it: plain data, each node its instance, config and mode.
      graph: {
        version: 2,
        nodes: [
          { id: TELEGRAM_USER, plugin: TELEGRAM_USER, account: 'telegram:alice' },
          { id: QUEST, plugin: QUEST },
          {
            id: 'quest-a',
            plugin: TURN_ACTOR,
            instance: 'turns-a',
            mode: 'dry-run',
            config: { chat: CHAT, seed: 1, schedule: { maxGapMin: 17 } },
          },
          {
            id: 'quest-b',
            plugin: TURN_ACTOR,
            mode: 'read-only',
            config: { chat: CHAT, seed: 2, command: '/quest' },
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
      ['quest-b', 'running'],
    ]);
    expect([core.modes.get('quest-a'), core.modes.get('quest-b')]).toEqual([
      'dry-run',
      'read-only',
    ]);
    clock.advanceTo(T0 + 20 * MIN);
    await flush();
    // Each records as its own instance: only the dry-run one played; the read-only one waits.
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
