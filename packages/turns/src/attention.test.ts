import { type Clock, DevKit, type Plugin } from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ATTENTION,
  attentionConfig,
  type AttentionHandle,
  attentionPlugin,
  type AttentionStatus,
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
  o: { hand?: () => number | undefined; react?: number; clock?: () => Clock } = {}
): Plugin {
  return {
    manifest: {
      id,
      version: '1.0.0',
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
              log.push(`${id} #${s.id} at ${s.start - T0}`);
              if (o.react !== undefined)
                for (let i = 0; i < o.react; i++)
                  log.push(`${id} reacts at ${a.react({ length: 100 }) - s.start}`);
            },
            lastByHand: () => o.hand?.(),
          });
        },
        stop: () => leave?.(),
      };
    },
  };
}

async function run(
  players: Plugin[],
  o: { config?: Record<string, unknown>; documents?: Record<string, Record<string, unknown>> } = {}
) {
  const steps: string[] = [];
  const kit = new DevKit({
    start: T0,
    plugins: [attentionPlugin(), ...players],
    graph: (d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === ATTENTION ? { ...n, config: { seed: 5, skipChance: 0, ...o.config } } : n
      ),
      edges: players.map((p) => ({
        from: `${ATTENTION}.attention`,
        to: `${p.manifest.id}.attention`,
        type: 'attention' as const,
      })),
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
  return { kit, steps, status };
}

describe('attentionConfig', () => {
  it('carries every default, the reaction’s too, and refuses a pace it cannot keep', () => {
    const c = attentionConfig.parse({});
    expect(c).toMatchObject({ ...DEFAULT_SCHEDULE });
    expect(c.reaction).toEqual({ minS: 2, maxS: 8, perCharMs: 40, longChance: 0.1, longMaxS: 60 });
    expect(() => attentionConfig.parse({ minGapMin: 0 })).toThrow('minGapMin must be at least 1');
    expect(() => attentionConfig.parse({ reaction: { minS: 9 } })).toThrow(
      'maxS must not be under minS'
    );
    const json = z.toJSONSchema(attentionConfig, { io: 'input' }) as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(json.properties['minGapMin']?.default).toBe(17);
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
