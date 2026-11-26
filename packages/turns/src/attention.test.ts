import {
  type Clock,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type GraphInput,
  parseManifest,
  type Plugin,
  resolveGraph,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ATTENTION,
  attentionConfig,
  type AttentionHandle,
  attentionPlugin,
  type AttentionStatus,
  FOLLOWS,
  NEVER,
  type Sitting,
  SITTING_TIMER,
} from './attention.ts';
import { DEFAULT_SCHEDULE } from './sittings.ts';

const T0 = Date.parse('2026-11-06T12:00:00Z'); // 13:00 in Rome
const MIN = 60_000;

/**
 * A made-up player of `alice`'s sittings: it notes each sitting, reacts once per sitting if told
 * to, and says the owner's play by hand it is given.
 */
function fakePlayer(
  id: string,
  log: string[],
  o: {
    hand?: () => number | undefined;
    react?: number;
    clock?: () => Clock;
    /** Whether it is in a sitting still: none by default, each sitting over at once. */
    busy?: () => boolean;
  } = {}
): Plugin {
  return {
    manifest: {
      id,
      kinds: ['actor'],
      description: 'a made-up player',
      inputs: { attention: { type: 'attention' } },
    },
    create: (ctx) => {
      let leave: (() => void) | undefined;
      return {
        start: () => {
          const a = ctx.attention<AttentionHandle>();
          leave = a.join({
            sitting: (s: Sitting) => {
              log.push(`${id} #${s.id} at ${s.start - T0}${s.follow === true ? ' following' : ''}`);
              if (o.react !== undefined)
                for (let i = 0; i < o.react; i++)
                  log.push(`${id} reacts at ${a.react({ length: 100 }) - s.start}`);
            },
            lastByHand: () => o.hand?.(),
            inSitting: () => o.busy?.() ?? false,
            again: () => log.push(`${id} again`),
          });
        },
        stop: () => leave?.(),
      };
    },
  };
}

/** alice's own account, whose messages a person that follows her play listens to (D138). */
const ACCOUNT = 'telegram-user';
const QUEST_CHAT = '@QuestBot';

async function run(
  players: Plugin[],
  o: {
    config?: Record<string, unknown>;
    documents?: Record<string, Record<string, unknown>>;
    /** Its listen edge's reads, from alice's account; none, no edge. */
    reads?: string[] | '*';
  } = {}
) {
  const steps: string[] = [];
  const account = new FakeConnector({ account: 'telegram:alice' });
  const kit = new DevKit({
    start: T0,
    plugins: [
      attentionPlugin(),
      ...players,
      ...(o.reads === undefined ? [] : [fakeConnectorPlugin(ACCOUNT, account)]),
    ],
    graph: (d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === ATTENTION ? { ...n, config: { seed: 5, skipChance: 0, ...o.config } } : n
      ),
      edges: [
        ...players.map((p) => ({
          from: `${ATTENTION}.attention`,
          to: `${p.manifest.id}.attention`,
          type: 'attention' as const,
        })),
        ...(o.reads === undefined
          ? []
          : [
              {
                from: `${ACCOUNT}.chat`,
                to: `${ATTENTION}.listen`,
                type: 'chat-in' as const,
                reads: o.reads,
              },
            ]),
      ],
    }),
    ...(o.documents === undefined ? {} : { documents: o.documents }),
    record: (r) => {
      if (r.type === `${ATTENTION}.step`)
        steps.push(`${String(r['event'])}: ${String(r['detail'])}`);
    },
  });
  await kit.start();
  const status = (): AttentionStatus => {
    const r = kit.core.controls.read(ATTENTION, 'status');
    return ('value' in r ? r.value : r) as AttentionStatus;
  };
  /** alice writes `text` in `chat`, or someone else does. */
  const say = (chat: string, text: string, own = true): void =>
    account.hear({ chat, sender: own ? 'alice' : 'bob', own, time: kit.clock.now(), text });
  return { kit, steps, status, say };
}

describe('attentionConfig', () => {
  it('carries every default, the reaction’s too, and refuses a pace it cannot keep', () => {
    const c = attentionConfig.parse({});
    expect(c).toMatchObject({ ...DEFAULT_SCHEDULE });
    expect(c.reaction).toEqual({
      minS: 2,
      maxS: 8,
      perCharMs: 40,
      readMaxS: 4,
      longChance: 0.1,
      longMaxS: 60,
    });
    expect(() => attentionConfig.parse({ minGapMin: 0 })).toThrow('minGapMin must be at least 1');
    expect(() => attentionConfig.parse({ reaction: { minS: 9 } })).toThrow(
      'maxS must not be under minS'
    );
    const json = z.toJSONSchema(attentionConfig, { io: 'input' }) as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(json.properties['minGapMin']?.default).toBe(17);
  });

  it('is scheduled by default and follows nothing; its schedule checked only while scheduled', () => {
    expect(attentionConfig.parse({})).toMatchObject({
      scheduled: true,
      followsMyPlay: false,
      followDelayS: 3,
    });
    expect(attentionConfig.parse({}).listen).toBeUndefined();
    expect(() => attentionConfig.parse({ minGapMin: 0 })).toThrow();
    expect(attentionConfig.parse({ scheduled: false, minGapMin: 0 }).scheduled).toBe(false);
    expect(() => attentionConfig.parse({ followsMyPlay: true })).toThrow(
      'followsMyPlay needs the chats it listens to (listen)'
    );
    expect(() => attentionConfig.parse({ listen: [QUEST_CHAT] })).toThrow(
      'listen applies only with followsMyPlay'
    );
    expect(
      attentionConfig.parse({ scheduled: false, followsMyPlay: true, listen: [QUEST_CHAT] })
    ).toMatchObject({ scheduled: false, followsMyPlay: true, listen: [QUEST_CHAT] });
  });

  it('hides its schedule in the editor while not scheduled, and its listening while not following', () => {
    const json = z.toJSONSchema(attentionConfig, { io: 'input' }) as {
      properties: Record<string, { shownWhen?: unknown }>;
    };
    const p = json.properties;
    for (const key of [
      'minGapMin',
      'maxGapMin',
      'skipChance',
      'wake',
      'bedtime',
      'jitterMin',
      'wakeDelayMaxMin',
      'timeZone',
    ])
      expect(p[key]?.shownWhen, key).toEqual({ scheduled: true });
    expect(p['listen']?.shownWhen).toEqual({ followsMyPlay: true });
    expect(p['followDelayS']?.shownWhen).toEqual({ followsMyPlay: true });
    for (const key of ['scheduled', 'followsMyPlay', 'reaction', 'seed'])
      expect(p[key]?.shownWhen, key).toBeUndefined();
    // Its two behaviours first.
    expect(Object.keys(p).slice(0, 2)).toEqual(['scheduled', 'followsMyPlay']);
  });
});

describe('its listen port and its warning (D138)', () => {
  const manifests = new Map(
    [
      fakeConnectorPlugin(ACCOUNT, new FakeConnector({ account: 'telegram:alice' })),
      attentionPlugin(),
    ].map((p) => {
      const m = parseManifest(p.manifest);
      return [m.id, m];
    })
  );
  const check = (config: Record<string, unknown>, listen = false) => {
    const g: GraphInput = {
      version: 2,
      nodes: [
        { id: ACCOUNT, plugin: ACCOUNT },
        { id: 'alice', plugin: ATTENTION, config },
      ],
      edges: listen
        ? [{ from: `${ACCOUNT}.chat`, to: 'alice.listen', type: 'chat-in', reads: [QUEST_CHAT] }]
        : [],
    };
    try {
      return { problems: [], warnings: resolveGraph(g, manifests).warnings };
    } catch (e) {
      return e as { problems: string[]; warnings: string[] };
    }
  };

  it('listens only while it follows, and then needs its edge', () => {
    expect(check({})).toEqual({ problems: [], warnings: [] });
    const follows = { followsMyPlay: true, listen: [QUEST_CHAT] };
    expect(check(follows).problems).toEqual([
      'node alice: input port listen (chat-in of telegram) is not bound',
    ]);
    expect(check(follows, true)).toEqual({ problems: [], warnings: [] });
  });

  it("listens through the owner's own account, never a bot's", () => {
    const bot = 'telegram-bot';
    const both = new Map(manifests);
    const m = parseManifest(
      fakeConnectorPlugin(bot, new FakeConnector({ account: 'telegram-bot:ExampleBot' })).manifest
    );
    both.set(m.id, m);
    const g = (from: string): GraphInput => ({
      version: 2,
      nodes: [
        { id: ACCOUNT, plugin: ACCOUNT },
        { id: bot, plugin: bot },
        { id: 'alice', plugin: ATTENTION, config: { followsMyPlay: true, listen: [QUEST_CHAT] } },
      ],
      edges: [{ from: `${from}.chat`, to: 'alice.listen', type: 'chat-in', reads: [QUEST_CHAT] }],
    });
    let refused: string[] = [];
    try {
      resolveGraph(g(bot), both);
    } catch (e) {
      refused = (e as { problems: string[] }).problems;
    }
    expect(refused).toEqual([
      'node alice: input port listen: chat-in of telegram-bot cannot bind chat-in of telegram (edge telegram-bot.chat → alice.listen)',
    ]);
    expect(resolveGraph(g(ACCOUNT), both).warnings).toEqual([]);
  });

  it('warns that it never plays, neither scheduled nor following', () => {
    expect(check({ scheduled: false }).warnings).toEqual([
      'node alice: it never plays: neither scheduled nor following your play',
    ]);
    expect(
      check({ scheduled: false, followsMyPlay: true, listen: [QUEST_CHAT] }, true).warnings
    ).toEqual([]);
  });
});

describe('attention', () => {
  it('starts each sitting for all its players at once, the first within a few minutes', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log), fakePlayer('b', log)]);
    expect(r.status()).toMatchObject({ players: 2 });
    const first = r.status().next as number;
    expect(first - T0).toBeLessThanOrEqual(3 * MIN);
    r.kit.runUntil(T0 + 30 * MIN);
    expect(log).toHaveLength(4);
    expect(log[0]).toBe(`a #1 at ${first - T0}`);
    expect(log[1]).toBe(`b #1 at ${first - T0}`);
    expect(log[2]?.startsWith('a #2')).toBe(true);
    expect(r.steps.filter((s) => s.startsWith('sitting'))).toEqual([
      'sitting: #1, 2 players',
      'sitting: #2, 2 players',
    ]);
    expect(
      r.kit.core.summary({ since: 0, until: T0 + 31 * MIN }).find((s) => s.node === ATTENTION)
        ?.lines
    ).toEqual(['2 sittings']);
    await r.kit.stop();
  });

  it('has its players act one after the other, each reaction after the last, an answer read', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log, { react: 2 }), fakePlayer('b', log, { react: 1 })], {
      config: { reaction: { minS: 1, maxS: 1, perCharMs: 10, longChance: 0 } },
    });
    r.kit.runUntil(T0 + 5 * MIN);
    // Each reaction 1 s and 100 characters at 10 ms: 2 s, one after the other.
    expect(log.filter((l) => l.includes('reacts'))).toEqual([
      'a reacts at 2000',
      'a reacts at 4000',
      'b reacts at 6000',
    ]);
    await r.kit.stop();
  });

  it('caps the reading of a long answer (D146)', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log, { react: 2 })], {
      config: { reaction: { minS: 1, maxS: 1, perCharMs: 100, readMaxS: 3, longChance: 0 } },
    });
    r.kit.runUntil(T0 + 5 * MIN);
    // 100 characters at 100 ms would be 10 s: 3 s at most, and 1 s more each.
    expect(log.filter((l) => l.includes('reacts'))).toEqual([
      'a reacts at 4000',
      'a reacts at 8000',
    ]);
    await r.kit.stop();
  });

  it('puts a sitting off while the person is still busy with the last', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log, { react: 1 })], {
      config: { minGapMin: 1, maxGapMin: 1, reaction: { minS: 300, maxS: 300, longChance: 0 } },
    });
    r.kit.runUntil(T0 + 10 * MIN);
    expect(r.steps.some((x) => /^busy: \d\d:\d\d UTC \(still busy\)$/u.test(x))).toBe(true);
    await r.kit.stop();
  });

  it('counts the owner’s play by hand as a sitting, at a due one and once all have started', async () => {
    const log: string[] = [];
    let hand: number | undefined = T0 - 5 * MIN;
    const r = await run([fakePlayer('a', log, { hand: () => hand })]);
    // At its start, the owner had played 5 minutes before: a gap after it.
    expect(r.steps[1]).toBe('seen: played by hand at 11:55');
    expect(r.status()).toMatchObject({ last: T0 - 5 * MIN, byHand: true });
    expect(r.status().next).toBeGreaterThanOrEqual(T0 + 12 * MIN);
    const due = r.status().next as number;
    hand = due - MIN;
    r.kit.runUntil(due);
    expect(log).toEqual([]);
    expect(r.steps.at(-1)).toMatch(/^planned: /u);
    hand = undefined;
    r.kit.runUntil(T0 + 60 * MIN);
    expect(log.length).toBeGreaterThan(0);
    expect(
      r.kit.core.summary({ since: 0, until: T0 + 61 * MIN }).find((s) => s.node === ATTENTION)
        ?.lines?.[0]
    ).toMatch(/^\d+ sittings?, 2 by hand$/u);
    await r.kit.stop();
  });

  it('keeps its last sitting across a restart, and plans from it', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log)], {
      documents: {
        [ATTENTION]: { state: { last: { t: T0 - 2 * MIN, byHand: false }, sittings: 7 } },
      },
    });
    expect(r.status().next).toBeGreaterThanOrEqual(T0 + 15 * MIN);
    r.kit.runUntil(T0 + 30 * MIN);
    expect(log[0]?.startsWith('a #8')).toBe(true);
    await r.kit.stop();
  });

  it('drops its plan when off, plans again on, and stops on its safety stop', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log)]);
    r.kit.core.controls.turnOff();
    expect(r.status().next).toBeUndefined();
    expect(r.steps.at(-1)).toBe('stopped: plan dropped: the bot is off');
    r.kit.runUntil(T0 + 30 * MIN);
    expect(log).toEqual([]);
    expect(r.kit.core.controls.turnOn()).toMatch(/^attention: next sitting \d\d:\d\d UTC$/u);
    expect(r.kit.core.controls.killNode(ATTENTION)).toEqual({
      result: 'attention killed: attention: stopped',
    });
    expect(r.kit.core.state(ATTENTION)).toMatchObject({ state: 'stopped' });
    await r.kit.stop();
  });

  it('shows its next sitting on its card and its sittings on its page (D112)', async () => {
    const r = await run([fakePlayer('a', [])]);
    const node = r.kit.core.controls.status().plugins.find((p) => p.id === ATTENTION);
    expect(node?.widget).toEqual(r.status());
    expect(attentionPlugin().manifest.page?.title).toBe('Sittings');
    expect(SITTING_TIMER).toBe('sitting');
    await r.kit.stop();
  });
});

describe('its two behaviours: scheduled, and following your play (D138)', () => {
  const follows = { followsMyPlay: true, listen: [QUEST_CHAT] };

  it('plans nothing when not scheduled, and says it never plays', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log)], {
      // The schedule left as written, invalid, does not matter.
      config: { scheduled: false, minGapMin: 0 },
    });
    expect(r.status()).toEqual({ mode: 'never plays', players: 1, next: NEVER });
    r.kit.runUntil(T0 + 24 * 60 * MIN);
    expect(log).toEqual([]);
    r.kit.core.controls.turnOff();
    expect(r.status().next).toBeUndefined();
    expect(r.kit.core.controls.turnOn()).toBe(`attention: ${NEVER}`);
    await r.kit.stop();
  });

  it('plans nothing while it only follows your play', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log)], {
      config: { scheduled: false, ...follows },
      reads: [QUEST_CHAT],
      documents: { [ATTENTION]: { state: { last: { t: T0 - 20 * MIN, byHand: false } } } },
    });
    expect(r.status()).toMatchObject({ mode: FOLLOWS, next: FOLLOWS });
    r.kit.runUntil(T0 + 3 * 60 * MIN);
    expect(log).toEqual([]);
    await r.kit.stop();
  });

  it('starts a sitting a few seconds after your message in a chat it listens to', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log)], {
      config: { scheduled: false, ...follows },
      reads: '*',
    });
    r.kit.runUntil(T0 + MIN);
    // Not a command: any message of yours.
    r.say(QUEST_CHAT, 'hello');
    r.kit.runUntil(T0 + MIN + 2999);
    expect(log).toEqual([]);
    r.kit.runUntil(T0 + MIN + 3000);
    expect(log).toEqual([`a #1 at ${MIN + 3000} following`]);
    expect(r.steps).toContain('sitting: #1, 1 player, following you');
    expect(r.status()).toMatchObject({ last: T0 + MIN + 3000, byHand: true, next: FOLLOWS });
    // Someone else's, or one in a chat it does not listen to: nothing.
    r.say(QUEST_CHAT, '/play', false);
    r.say('@OtherBot', '/play');
    r.kit.runUntil(T0 + 10 * MIN);
    expect(log).toHaveLength(1);
    expect(
      r.kit.core.summary({ since: 0, until: T0 + 11 * MIN }).find((s) => s.node === ATTENTION)
        ?.lines
    ).toEqual(['1 sitting (1 following you)']);
    await r.kit.stop();
  });

  it('starts no second sitting during one: its players look again', async () => {
    const log: string[] = [];
    let busy = false;
    const r = await run([fakePlayer('a', log, { busy: () => busy })], {
      config: { scheduled: false, ...follows, followDelayS: 5 },
      reads: [QUEST_CHAT],
    });
    r.say(QUEST_CHAT, '/play');
    // Messages while one is about to start start no other.
    r.kit.runUntil(T0 + 2000);
    r.say(QUEST_CHAT, '/daily');
    r.kit.runUntil(T0 + 5000);
    busy = true;
    r.say(QUEST_CHAT, '/coffee');
    r.kit.runUntil(T0 + MIN);
    expect(log).toEqual(['a #1 at 5000 following', 'a again']);
    busy = false;
    r.say(QUEST_CHAT, '/play');
    r.kit.runUntil(T0 + 2 * MIN);
    expect(log.at(-1)).toBe(`a #2 at ${MIN + 5000} following`);
    await r.kit.stop();
  });

  it('follows your play and keeps its schedule, a full gap after your play', async () => {
    const log: string[] = [];
    const r = await run([fakePlayer('a', log)], {
      config: follows,
      reads: [QUEST_CHAT],
    });
    expect(r.status().mode).toBe(`scheduled, ${FOLLOWS}`);
    const first = r.status().next as number;
    r.kit.runUntil(first);
    expect(log).toHaveLength(1);
    const played = first + 5 * MIN;
    r.kit.runUntil(played);
    r.say(QUEST_CHAT, 'hi');
    r.kit.runUntil(played + 3000);
    expect(log.at(-1)).toBe(`a #2 at ${played + 3000 - T0} following`);
    // Planned again from your play, not from its own sitting.
    expect((r.status().next as number) - (played + 3000)).toBeGreaterThanOrEqual(17 * MIN);
    await r.kit.stop();
  });
});
