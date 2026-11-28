/**
 * What changed, for the views open (bot-os.md D173): touches coalesced over half a second,
 * propagated along interface edges, from the store's writes, the events published, a node's state,
 * its settings and `ctx.changed()`; and the control API's `GET /changes` stream and `POST /reads`.
 */
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CHANGE_COALESCE_MS, Changes } from './changes.ts';
import { VirtualClock } from './clock.ts';
import { controlServer, MAX_READS } from './control-server.ts';
import { Core } from './core.ts';
import { type GraphInput } from './graph.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

describe('Changes', () => {
  it('coalesces touches, propagates them along readers, and tells only while heard', () => {
    const clock = new VirtualClock();
    const readers: Record<string, string[]> = { game: ['donations'], donations: ['view', 'game'] };
    const c = new Changes(clock, (n) => readers[n] ?? []);
    c.touch('game');
    const heard: string[][] = [];
    const stop = c.subscribe((nodes) => heard.push([...nodes].sort()));
    const broken = c.subscribe(() => {
      throw new Error('closed');
    });
    c.touch('game');
    c.touch('other');
    clock.advance(CHANGE_COALESCE_MS - 1);
    expect(heard).toEqual([]);
    clock.advance(1);
    expect(heard).toEqual([['donations', 'game', 'other', 'view']]);
    broken();
    stop();
    c.touch('game');
    clock.advance(CHANGE_COALESCE_MS);
    expect(heard).toHaveLength(1);
    // A touch pending when the last listener leaves is dropped.
    const again = c.subscribe((nodes) => heard.push([...nodes]));
    c.touch('view');
    again();
    clock.advance(CHANGE_COALESCE_MS);
    expect(heard).toHaveLength(1);
  });
});

let server: http.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A game whose state a donations node reads, a third node apart, and their ways to change. */
async function setup() {
  const clock = new VirtualClock();
  let game: PluginContext | undefined;
  let apart: PluginContext | undefined;
  const gamePlugin = definePlugin({
    manifest: {
      id: 'game',
      kinds: ['stats'],
      description: 'a made-up game',
      settings: z.object({ rate: z.number().default(1).describe('Rate') }),
      games: { registers: ['game'] },
      events: { 'game.turn': z.object({ n: z.number() }) },
      interface: {
        state: {
          gold: {
            help: 'Its gold',
            input: z.object({ who: z.string() }),
            output: z.number(),
          },
        },
      },
    },
    create: (ctx) => {
      game = ctx;
      return {
        interface: {
          state: { gold: (i: { who: string }) => ctx.store.read<number>(i.who) ?? 0 },
        },
      };
    },
  });
  const donations = definePlugin({
    manifest: {
      id: 'donations',
      kinds: ['stats'],
      description: 'donations',
      inputs: { game: { type: 'interface', plugin: 'game', members: ['state.gold'] } },
      interface: { state: { total: { help: 'Their total', output: z.number() } } },
    },
    create: () => ({ interface: { state: { total: () => 3 } } }),
  });
  const other = definePlugin({
    manifest: { id: 'apart', kinds: ['stats'], description: 'apart' },
    create: (ctx) => {
      apart = ctx;
      return {};
    },
  });
  const graph: GraphInput = {
    version: 2,
    nodes: [
      { id: 'game', plugin: 'game' },
      { id: 'donations', plugin: 'donations' },
      { id: 'apart', plugin: 'apart' },
    ],
    edges: [{ from: 'game', to: 'donations.game' }],
  };
  const core = new Core({ clock, graph });
  core.register(gamePlugin, donations, other);
  await core.start();
  const heard: string[][] = [];
  core.controls.changes((nodes) => heard.push([...nodes].sort()));
  const flush = (): string[][] => {
    clock.advance(CHANGE_COALESCE_MS);
    return heard.splice(0);
  };
  return {
    core,
    clock,
    flush,
    game: game as PluginContext,
    apart: apart as PluginContext,
  };
}

describe('what touches a node (D173)', () => {
  it('a store write, a file, an event, a setting, a state and ctx.changed(), with its readers', async () => {
    const { core, flush, game, apart } = await setup();
    expect(flush()).toEqual([]);
    game.store.write('alice', 5);
    expect(flush()).toEqual([['donations', 'game']]);
    game.store.remove('alice');
    expect(flush()).toEqual([['donations', 'game']]);
    game.store.files.write('map.png', new Uint8Array([1]));
    game.store.files.delete('map.png');
    expect(flush()).toEqual([['donations', 'game']]);
    game.bus.publish('game.turn', { n: 1 });
    expect(flush()).toEqual([['donations', 'game']]);
    apart.changed();
    expect(flush()).toEqual([['apart']]);
    core.settings.set('game.rate', 2);
    expect(flush()).toEqual([['donations', 'game']]);
    core.controls.killNode('apart');
    expect(flush()[0]).toContain('apart');
  });
});

describe('the live routes (D173)', () => {
  async function serve() {
    const s = await setup();
    server = controlServer({ controls: s.core.controls, settings: s.core.settings });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return { ...s, base: `http://127.0.0.1:${port}` };
  }

  it('answers several reads at once, in order, each counted in its node’s cost', async () => {
    const { core, base, game } = await serve();
    game.store.write('alice', 7);
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/reads`, { method: 'POST', body: JSON.stringify(body) });
      return [res.status, await res.json()] as const;
    };
    expect(
      await post({
        reads: [
          { node: 'game', read: 'gold', input: { who: 'alice' } },
          { node: 'donations', read: 'total' },
          { node: 'game', read: 'nope' },
        ],
      })
    ).toEqual([
      200,
      { answers: [{ value: 7 }, { value: 3 }, { error: 'game declares no read nope' }] },
    ]);
    expect(core.cost('game')?.reads?.calls).toBe(2);
    expect(core.cost('donations')?.reads?.calls).toBe(1);
    expect((await post({}))[0]).toBe(400);
    expect(await post({ reads: [{ node: 1 }] })).toEqual([
      400,
      { error: 'reads.0: a node and a read, each a text' },
    ]);
    expect(await post({ reads: [{ node: 'a', read: 'b', input: { n: 1 } }] })).toEqual([
      400,
      { error: 'reads.0.input: fields, each a text' },
    ]);
    expect(
      (
        await post({
          reads: Array.from({ length: MAX_READS + 1 }, () => ({ node: 'a', read: 'b' })),
        })
      )[1]
    ).toEqual({ error: `reads: at most ${MAX_READS}` });
    const empty = await fetch(`${base}/reads`, { method: 'POST' });
    expect(empty.status).toBe(400);
  });

  it('streams the changes of the nodes asked for, and stops hearing once closed', async () => {
    const { base, clock, game, apart } = await serve();
    const abort = new AbortController();
    const res = await fetch(`${base}/changes?nodes=donations,apart`, { signal: abort.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const next = async (): Promise<string> => decoder.decode((await reader.read()).value);
    expect(await next()).toBe(': open\n\n');
    game.store.write('alice', 1);
    clock.advance(CHANGE_COALESCE_MS);
    // The game itself is not asked for: its reader is.
    expect(await next()).toBe('event: changed\ndata: {"nodes":["donations"]}\n\n');
    apart.changed();
    clock.advance(CHANGE_COALESCE_MS);
    expect(await next()).toBe('event: changed\ndata: {"nodes":["apart"]}\n\n');
    abort.abort();
    await reader.cancel().catch(() => undefined);
    // Every node when none is named.
    const all = await fetch(`${base}/changes`);
    const r2 = (all.body as ReadableStream<Uint8Array>).getReader();
    expect(decoder.decode((await r2.read()).value)).toBe(': open\n\n');
    game.store.write('bob', 1);
    clock.advance(CHANGE_COALESCE_MS);
    expect(decoder.decode((await r2.read()).value)).toBe(
      'event: changed\ndata: {"nodes":["game","donations"]}\n\n'
    );
    await r2.cancel();
  });
});
