/**
 * A node's states (bot-os.md D64): disabled in the graph, stopped by exception and kept in its
 * instance, inactive by the chain of required ports; dry runs on chat-out edges; and module API 1's
 * `ctx.mode`, derived, as a plugin that sets its own mode from its owner commands and its safety
 * stops uses it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { Core, STOP_DOC } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { downText, foldModes, type GraphInput, nodeStates, resolveGraph } from './graph.ts';
import { graphText } from './graph-view.ts';
import { parseManifest } from './manifest.ts';
import { type Mode, Modes, type OutboxHandle } from './outbox.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A parser of `#lobby`, offering its count. */
const parser = definePlugin({
  manifest: {
    id: 'parser',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'reads #lobby',
    config: z.object({ chat: z.string().default('#lobby') }),
    inputs: { chat: { type: 'chat-in' } },
    interface: { state: { count: { help: 'how many', output: z.number() } } },
  },
  create: () => ({ interface: { state: { count: () => 1 } } }),
});

/** An actor that needs the parser, and may use a helper; it sends through two outputs. */
function actor(seen: PluginContext[]) {
  return definePlugin({
    manifest: {
      id: 'actor',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'acts',
      inputs: {
        parser: { type: 'interface', plugin: 'parser', members: ['state.count'] },
        helper: { type: 'interface', plugin: 'parser', members: [], optional: true },
      },
      outputs: {
        quiet: { type: 'chat-out' },
        loud: { type: 'chat-out', optional: true },
      },
    },
    create: (ctx) => {
      seen.push(ctx);
      return {};
    },
  });
}

/** A node that reads the actor's interface: inactive when the actor is down. */
const watcher = definePlugin({
  manifest: {
    id: 'watcher',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'watches',
    inputs: { actor: { type: 'interface', plugin: 'actor', members: [] } },
  },
  create: () => ({}),
});

const graph = (over: Partial<Record<string, object>> = {}, edges: object[] = []): GraphInput =>
  ({
    version: 2,
    nodes: [
      { id: 'tg', plugin: 'tg', ...over['tg'] },
      { id: 'parser', plugin: 'parser', ...over['parser'] },
      { id: 'helper', plugin: 'parser', ...over['helper'] },
      { id: 'actor', plugin: 'actor', ...over['actor'] },
      { id: 'watcher', plugin: 'watcher', ...over['watcher'] },
    ],
    edges: [
      { from: 'tg.chat', to: 'parser.chat', type: 'chat-in', reads: ['#lobby'] },
      { from: 'tg.chat', to: 'helper.chat', type: 'chat-in', reads: ['#lobby'] },
      { from: 'parser.interface', to: 'actor.parser' },
      { from: 'helper.interface', to: 'actor.helper' },
      { from: 'actor.interface', to: 'watcher.actor' },
      { from: 'actor.quiet', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'], dryRun: true },
      { from: 'actor.loud', to: 'tg.chat', type: 'chat-out', sends: ['#lobby', '#news'] },
      ...edges,
    ],
  }) as GraphInput;

function instance(g: GraphInput, o: { dataDir?: string } = {}) {
  const tg = new FakeConnector({ account: 'tg:me' });
  const seen: PluginContext[] = [];
  const lines: string[] = [];
  const core = new Core({
    clock: new VirtualClock(Date.UTC(2026, 10, 12)),
    graph: g,
    print: (l) => lines.push(l),
    ...o,
  });
  core.register(fakeConnectorPlugin('tg', tg), parser, actor(seen), watcher);
  const states = () =>
    core.status().map((s) => `${s.id} ${s.state}${s.reason ? `: ${s.reason}` : ''}`);
  return { core, tg, seen, lines, states };
}

describe('a disabled node (D64)', () => {
  it('is never started, and makes inactive what requires it, transitively', async () => {
    const { core, states, seen } = instance(graph({ parser: { disabled: true } }));
    await core.start();
    expect(states()).toEqual([
      'tg running',
      'parser disabled',
      'helper running',
      'actor inactive: needs parser (disabled)',
      'watcher inactive: needs actor (inactive)',
    ]);
    expect(seen).toEqual([]);
    expect(core.controls.status().plugins[3]).toMatchObject({
      state: 'inactive',
      reason: 'needs parser (disabled)',
    });
    expect(core.graph()?.nodes[1]).toEqual({ id: 'parser', plugin: 'parser', disabled: true });
    await core.stop();
  });

  it('is unbound for an optional input bound to it: the node using it runs', async () => {
    const { core, states, seen } = instance(graph({ helper: { disabled: true } }));
    await core.start();
    expect(states()).toEqual([
      'tg running',
      'parser running',
      'helper disabled',
      'actor running',
      'watcher running',
    ]);
    expect(seen[0]?.useOptional('helper')).toBeUndefined();
    await core.stop();
  });

  it('as a connector, makes inactive every node reading from it or sending to it', async () => {
    const { core, states } = instance(graph({ tg: { disabled: true } }));
    await core.start();
    expect(states()).toEqual([
      'tg disabled',
      'parser inactive: needs tg (disabled)',
      'helper inactive: needs tg (disabled)',
      'actor inactive: needs parser (inactive)',
      'watcher inactive: needs actor (inactive)',
    ]);
    // A sender alone, its chat-out output required: inactive for the connector it sends to.
    const sender = resolveGraph(
      {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'tg', disabled: true },
          { id: 'actor', plugin: 'actor' },
          { id: 'parser', plugin: 'parser', config: {} },
        ],
        edges: [
          { from: 'tg.chat', to: 'parser.chat', type: 'chat-in' },
          { from: 'parser.interface', to: 'actor.parser' },
          { from: 'actor.quiet', to: 'tg.chat', type: 'chat-out' },
        ],
      },
      new Map(
        [fakeConnectorPlugin('tg', new FakeConnector({ account: 'tg:me' })), parser, actor([])].map(
          (p) => {
            const m = parseManifest(p.manifest);
            return [m.id, m];
          }
        )
      )
    );
    const byId = new Map(sender.nodes.map((n) => [n.id, n]));
    const down = nodeStates(
      ['tg', 'parser', 'actor'].map((id) => byId.get(id) as (typeof sender.nodes)[number]),
      () => false
    );
    expect([...down].map(([id, d]) => `${id} ${downText(d)}`)).toEqual([
      'tg disabled',
      'parser inactive: needs tg (disabled)',
      'actor inactive: needs parser (inactive)',
    ]);
  });

  it('is checked as any other: its config and its edges', () => {
    const config = instance(graph({ parser: { disabled: true, config: { chat: 3 } } }));
    expect(() => config.core.load()).toThrow(/^plugin parser: config chat: /u);
    const edge = instance(
      graph({ actor: { disabled: true } }, [{ from: 'actor.interface', to: 'parser.nothing' }])
    );
    expect(() => edge.core.load()).toThrow('node parser: no input port nothing');
  });

  it('prints `disabled`, and a dry-run edge `dry-run`, for the history’s diffs', () => {
    const text = graphText(
      resolveGraphOf(graph({ actor: { disabled: true } })) as Parameters<typeof graphText>[0]
    );
    expect(text).toContain('  actor (actor), disabled');
    expect(text).toContain('  actor.quiet → tg.chat (chat-out): sends #lobby; dry-run');
    expect(text).toContain('  actor.loud → tg.chat (chat-out): sends #lobby #news\n');
  });
});

/** The graph as the core holds it. */
function resolveGraphOf(g: GraphInput): unknown {
  const { core } = instance(g);
  core.load();
  return core.graph();
}

describe('a dry-run edge (D64)', () => {
  it('logs what it sends as sent and sends nothing; a live edge sends', async () => {
    const { core, tg, seen } = instance(graph());
    await core.start();
    tg.open();
    const ctx = seen[0] as PluginContext;
    // Through `quiet`, its own edge: a dry run, and only #lobby.
    expect(ctx.outbox('quiet').send('#lobby', 'hi')).toEqual({ text: 'hi', outcome: 'dry-run' });
    expect(ctx.outbox('quiet').send('#news', 'hi').reason).toBe('actor does not send to #news');
    expect(ctx.outbox('quiet').mode()).toBe('dry-run');
    // Through `loud`, live.
    expect(ctx.outbox('loud').send('#news', 'hi')).toEqual({ text: 'hi', outcome: 'sent' });
    expect(ctx.outbox('loud').mode()).toBe('live');
    // By the connector's id, every edge to it: a chat a live one sends to goes for real.
    expect(ctx.outbox('tg').send('#lobby', 'hey')).toEqual({ text: 'hey', outcome: 'sent' });
    expect(ctx.mode.get()).toBe('live');
    await core.stop();
    expect(tg.sent).toEqual([
      { chat: '#news', text: 'hi' },
      { chat: '#lobby', text: 'hey' },
    ]);
    // Every edge a dry run: logged as sent, counted, never sent.
    const all = instance({
      ...graph(),
      edges: (graph().edges ?? []).map((e) => (e.type === 'chat-out' ? { ...e, dryRun: true } : e)),
    });
    await all.core.start();
    all.tg.open();
    const c = all.seen[0] as PluginContext;
    expect(c.outbox('loud').send('#news', 'hi')).toEqual({ text: 'hi', outcome: 'dry-run' });
    expect(c.outbox('loud').mode()).toBe('dry-run');
    expect(c.mode.get()).toBe('dry-run');
    expect(all.tg.sent).toEqual([]);
    await all.core.stop();
  });

  it('is carried only by a chat-out edge', () => {
    const { core } = instance({
      ...graph(),
      edges: (graph().edges ?? []).map((e) => (e.type === 'chat-in' ? { ...e, dryRun: true } : e)),
    });
    expect(() => core.load()).toThrow(
      'only a chat-out edge carries sends, commands, minIntervalS and dryRun'
    );
  });
});

describe('a stop (D64)', () => {
  it('is kept in the instance across restarts, the nodes requiring it inactive, until cleared', async () => {
    const first = instance(graph(), { dataDir: dir });
    await first.core.start();
    const ctx = first.seen[0] as PluginContext;
    ctx.stop('out of 🧊');
    expect(first.states()[3]).toBe('actor stopped: out of 🧊');
    expect(ctx.outbox('loud').send('#news', 'x').reason).toBe('stopped: out of 🧊');
    expect(first.lines).toContain('actor: warning: stopped (safety): out of 🧊');
    await first.core.stop();
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'instances', 'actor', `${STOP_DOC}.json`), 'utf8'))
    ).toEqual({ reason: 'out of 🧊', time: '2026-11-12T00:00:00.000Z', source: 'safety' });
    const second = instance(graph(), { dataDir: dir });
    await second.core.start();
    expect(second.states().slice(3)).toEqual([
      'actor stopped: out of 🧊',
      'watcher inactive: needs actor (stopped)',
    ]);
    expect(second.seen).toEqual([]);
    expect(second.core.clearStop('actor')).toBe(true);
    await second.core.stop();
    const third = instance(graph(), { dataDir: dir });
    await third.core.start();
    expect(third.states().slice(3)).toEqual(['actor running', 'watcher running']);
    await third.core.stop();
  });

  it('a disabled node stopped too shows disabled', async () => {
    fs.mkdirSync(path.join(dir, 'instances', 'actor'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'instances', 'actor', `${STOP_DOC}.json`),
      JSON.stringify({ reason: 42, source: 'nobody' })
    );
    const off = instance(graph({ actor: { disabled: true } }), { dataDir: dir });
    await off.core.start();
    expect(off.states()[3]).toBe('actor disabled');
    await off.core.stop();
    // A stop written by hand, its fields not as kept, still holds.
    const on = instance(graph(), { dataDir: dir });
    await on.core.start();
    expect(on.core.state('actor')).toMatchObject({
      state: 'stopped',
      reason: 'stopped',
      stop: { reason: 'stopped', source: 'owner', time: '1970-01-01T00:00:00.000Z' },
    });
    await on.core.stop();
  });

  it('a plugin that stops itself as it starts stays stopped', async () => {
    const early = definePlugin({
      manifest: { id: 'early', version: '0.1.0', kinds: ['actor'], description: 'stops' },
      create: (ctx) => ({ start: () => ctx.stop('nothing to do') }),
    });
    const core = new Core({ clock: new VirtualClock() });
    core.register(early);
    await core.start();
    expect(core.state('early')).toMatchObject({ state: 'stopped', reason: 'nothing to do' });
  });
});

describe('a runtime stop’s cascade (#29)', () => {
  /** A reader of `#lobby` that needs the actor, and logs what it hears, its stop and its keep. */
  function reader(id: string, needs: string, heard: string[]) {
    return definePlugin({
      manifest: {
        id,
        version: '0.1.0',
        kinds: ['stats'],
        description: 'reads and watches',
        inputs: {
          chat: { type: 'chat-in' },
          needs: { type: 'interface', plugin: needs, members: [] },
        },
      },
      create: (ctx) => {
        ctx.connector('chat').onMessage((m) => heard.push(`${id} heard ${m.text}`));
        ctx.scheduler.at('tick', 60_000);
        return {
          serialise: () => ({ kept: id }),
          stop: () => {
            heard.push(`${id} stop`);
          },
          onTimer: () => heard.push(`${id} tick`),
        };
      },
    });
  }

  function cascading(o: { dataDir?: string } = {}) {
    const heard: string[] = [];
    const tg = new FakeConnector({ account: 'tg:me' });
    const seen: PluginContext[] = [];
    const clock = new VirtualClock(Date.UTC(2026, 10, 12));
    const g = {
      version: 2,
      nodes: [
        { id: 'tg', plugin: 'tg' },
        { id: 'parser', plugin: 'parser' },
        { id: 'actor', plugin: 'actor' },
        { id: 'near', plugin: 'near' },
        { id: 'far', plugin: 'far' },
        { id: 'apart', plugin: 'apart' },
      ],
      edges: [
        { from: 'tg.chat', to: 'parser.chat', type: 'chat-in', reads: ['#lobby'] },
        { from: 'parser.interface', to: 'actor.parser' },
        { from: 'actor.quiet', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
        { from: 'tg.chat', to: 'near.chat', type: 'chat-in', reads: ['#lobby'] },
        { from: 'actor.interface', to: 'near.needs' },
        { from: 'tg.chat', to: 'far.chat', type: 'chat-in', reads: ['#lobby'] },
        { from: 'near.interface', to: 'far.needs' },
        { from: 'tg.chat', to: 'apart.chat', type: 'chat-in', reads: ['#lobby'] },
        { from: 'parser.interface', to: 'apart.needs' },
      ],
    } as GraphInput;
    const core = new Core({ clock, graph: g, ...o });
    core.register(
      fakeConnectorPlugin('tg', tg),
      parser,
      actor(seen),
      reader('near', 'actor', heard),
      reader('far', 'near', heard),
      reader('apart', 'parser', heard)
    );
    const states = () =>
      core.status().map((s) => `${s.id} ${s.state}${s.reason ? `: ${s.reason}` : ''}`);
    return { core, tg, seen, heard, clock, states };
  }

  it('shuts down at once, dependents first, every node the stop makes inactive', async () => {
    const { core, tg, seen, heard, clock, states } = cascading({ dataDir: dir });
    await core.start();
    tg.hear({ chat: '#lobby', sender: 'alice', text: 'one', time: 1 });
    expect(heard).toEqual(['near heard one', 'far heard one', 'apart heard one']);
    heard.length = 0;
    (seen[0] as PluginContext).stop('out of 🧊');
    expect(states()).toEqual([
      'tg running',
      'parser running',
      'actor stopped: out of 🧊',
      'near inactive: needs actor (stopped)',
      'far inactive: needs near (inactive)',
      'apart running',
    ]);
    // Its messages, its timers and its interface end at once; its stop runs, its keep is kept.
    tg.hear({ chat: '#lobby', sender: 'alice', text: 'two', time: 2 });
    clock.advance(60_000);
    await core.stop();
    // Their own stops run as the instance's do, a moment later, dependents first.
    expect(heard).toEqual(['apart heard two', 'apart tick', 'far stop', 'near stop', 'apart stop']);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'instances', 'near', '_restore.json'), 'utf8'))
    ).toEqual({ kept: 'near' });
  });

  it('is derived again at the next start, and undone once the stop is cleared', async () => {
    const first = cascading({ dataDir: dir });
    await first.core.start();
    expect(first.core.stopNode('actor', 'enough', 'owner')).toBe(true);
    // A stop made again cascades nothing more.
    expect(first.core.stopNode('actor', 'enough again', 'owner')).toBe(true);
    await first.core.stop();
    const second = cascading({ dataDir: dir });
    await second.core.start();
    expect(second.states().slice(2, 5)).toEqual([
      'actor stopped: enough again',
      'near inactive: needs actor (stopped)',
      'far inactive: needs near (inactive)',
    ]);
    expect(second.core.clearStop('actor')).toBe(true);
    await second.core.stop();
    const third = cascading({ dataDir: dir });
    await third.core.start();
    expect(third.states().slice(2, 5)).toEqual(['actor running', 'near running', 'far running']);
    await third.core.stop();
  });

  it('of a connector, takes down every node reading from it or sending through it', async () => {
    const { core, tg, heard, states } = cascading();
    await core.start();
    expect(core.stopNode('tg', 'by the owner', 'owner')).toBe(true);
    expect(states()).toEqual([
      'tg stopped: by the owner',
      'parser inactive: needs tg (stopped)',
      'actor inactive: needs parser (inactive)',
      'near inactive: needs tg (stopped)',
      'far inactive: needs tg (stopped)',
      'apart inactive: needs tg (stopped)',
    ]);
    tg.hear({ chat: '#lobby', sender: 'alice', text: 'late', time: 1 });
    await core.stop();
    expect(heard).toEqual(['apart stop', 'far stop', 'near stop']);
  });

  it('made as a node starts, keeps those after it from starting', async () => {
    const early = definePlugin({
      manifest: { id: 'early', version: '0.1.0', kinds: ['actor'], description: 'stops' },
      create: (ctx) => ({ start: () => ctx.stop('nothing to do'), interface: {} }),
    });
    const later = definePlugin({
      manifest: {
        id: 'later',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'needs early',
        requires: ['early'],
      },
      create: () => {
        throw new Error('never made');
      },
    });
    const core = new Core({ clock: new VirtualClock() });
    core.register(early, later);
    await core.start();
    expect(core.state('later')).toMatchObject({
      state: 'inactive',
      reason: 'needs early (stopped)',
    });
    await core.stop();
  });

  it('logs a shutdown that fails, and goes on', async () => {
    const lines: string[] = [];
    const fragile = definePlugin({
      manifest: {
        id: 'fragile',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'fails to stop',
        requires: ['base'],
      },
      create: () => ({
        stop: () => {
          throw new Error('stuck');
        },
      }),
    });
    const base = definePlugin({
      manifest: { id: 'base', version: '0.1.0', kinds: ['actor'], description: 'base' },
      create: () => ({}),
    });
    const core = new Core({ clock: new VirtualClock(), print: (l) => lines.push(l) });
    core.register(base, fragile);
    await core.start();
    core.stopNode('base', 'halt', 'safety');
    await core.stop();
    expect(lines).toEqual([
      'base: warning: stopped (safety): halt',
      'fragile: warning: inactive: needs base (stopped)',
      'fragile: error: stop failed: stuck',
    ]);
  });
});

/**
 * A plugin of module API 1 that keeps its commands' mode through `ctx.mode`, as a module's tactics
 * do: its owner commands set it (`owner`), its safety stops lower it (`safety`), through a `Modes`
 * look-alike over the context, and it reads its mode from its outbox handle.
 */
function tactics(heard: string[], grab: (t: Tactics) => void) {
  return definePlugin({
    manifest: {
      id: 'tactics',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'plays',
      inputs: {
        channel: { type: 'chat', bind: { node: 'tg', reads: ['#lobby'], sends: ['#lobby'] } },
      },
    },
    create: (ctx) => {
      const out: Tactics = {
        handle: ctx.outbox('channel'),
        modes: {
          set: (_plugin: string, mode: Mode, by?: 'owner' | 'safety') => ctx.mode.set(mode, by),
        },
        ctx,
      };
      grab(out);
      ctx.mode.onChange((m) => heard.push(`mode ${m}`));
      return {
        pause: (why) => heard.push(`pause ${why}`),
        resume: () => heard.push('resume'),
      };
    },
  });
}

interface Tactics {
  handle: OutboxHandle;
  modes: Pick<Modes, 'set'>;
  ctx: PluginContext;
}

describe('module API 1: ctx.mode, derived (D64)', () => {
  async function run(dryRun: boolean | undefined, dataDir?: string) {
    const heard: string[] = [];
    let t: Tactics | undefined;
    const tg = new FakeConnector({ account: 'tg:me' });
    const lines: string[] = [];
    const core = new Core({
      clock: new VirtualClock(Date.UTC(2026, 10, 12)),
      print: (l) => lines.push(l),
      ...(dataDir === undefined ? {} : { dataDir }),
      graph: (g) => ({
        ...g,
        edges: g.edges.map((e) =>
          e.type === 'chat-out' && dryRun !== undefined ? { ...e, dryRun } : e
        ),
      }),
    });
    core.register(
      fakeConnectorPlugin('tg', tg),
      tactics(heard, (x) => (t = x))
    );
    await core.start();
    tg.open();
    return { core, tg, heard, lines, t: t as Tactics };
  }

  it('gets live through a live edge, dry-run through dry-run ones', async () => {
    const live = await run(undefined);
    expect(live.t.ctx.mode.get()).toBe('live');
    expect(live.t.handle.mode()).toBe('live');
    expect(live.t.handle.send('#lobby', 'go').outcome).toBe('sent');
    const dry = await run(true);
    expect(dry.t.ctx.mode.get()).toBe('dry-run');
    expect(dry.t.handle.mode()).toBe('dry-run');
    expect(dry.t.handle.send('#lobby', 'go').outcome).toBe('dry-run');
    expect(dry.tg.sent).toEqual([]);
  });

  it('refuses and logs a raise, the owner’s or not: states are raised in the editor', async () => {
    const { t, core, lines, heard } = await run(true);
    const why = "live refused: a node's state and its edges' dry runs change only in the editor";
    expect(t.modes.set('tactics', 'live', 'owner')).toBe(why);
    expect(t.modes.set('tactics', 'dry-run')).toBe(
      "dry-run refused: a node's state and its edges' dry runs change only in the editor"
    );
    expect(t.ctx.mode.set('loud' as Mode)).toBe('not a mode: loud');
    expect(lines).toContain(`tactics: warning: ctx.mode.set: ${why}`);
    expect(core.state('tactics')?.state).toBe('running');
    expect(t.ctx.mode.get()).toBe('dry-run');
    expect(heard).toEqual([]);
  });

  it('stops the node on a safety stop, kept, its listeners told read-only', async () => {
    const { t, core, heard, lines } = await run(undefined, dir);
    expect(t.modes.set('tactics', 'read-only', 'safety')).toBeUndefined();
    expect(core.state('tactics')).toMatchObject({
      state: 'stopped',
      reason: 'safety stop (read-only)',
      stop: { source: 'safety' },
    });
    expect(heard).toEqual(['pause safety stop (read-only)', 'mode read-only']);
    expect(t.handle.send('#lobby', 'go').reason).toBe('stopped: safety stop (read-only)');
    // Its mode never reads `read-only`: a stopped node does not run.
    expect(t.ctx.mode.get()).toBe('live');
    // Its own way back is refused, and logged; so is a raise.
    expect(t.ctx.resume()).toBe(false);
    expect(lines).toContain(
      'tactics: warning: ctx.resume refused: a stop is cleared only in the editor'
    );
    expect(t.modes.set('tactics', 'live', 'owner')).toMatch(/^live refused/u);
    expect(heard).not.toContain('resume');
    await core.stop();
    // Not started again.
    const again = await run(undefined, dir);
    expect(again.core.state('tactics')?.state).toBe('stopped');
  });

  it('stops the node on the owner’s read-only too, with that reason', async () => {
    const { t, core } = await run(undefined);
    expect(t.modes.set('tactics', 'read-only')).toBeUndefined();
    expect(core.state('tactics')).toMatchObject({
      state: 'stopped',
      reason: 'read-only, by the owner',
      stop: { source: 'owner' },
    });
  });

  it('an outbox made outside the core keeps its own modes, as before', () => {
    const modes = new Modes();
    const tg = new FakeConnector({ account: 'tg:me' });
    tg.open();
    const core = new Core({ clock: new VirtualClock() });
    const outbox = new (core.outbox('tg:me').constructor as typeof import('./outbox.ts').Outbox)({
      account: 'tg:me',
      connector: () => tg,
      clock: new VirtualClock(),
      modes,
    });
    const p = outbox.as('mine');
    expect(p.send('#lobby', 'x').reason).toBe('read-only');
    modes.set('mine', 'dry-run');
    expect([p.mode(), p.send('#lobby', 'x').outcome]).toEqual(['dry-run', 'dry-run']);
    modes.set('mine', 'live');
    expect(p.send('#lobby', 'x').outcome).toBe('sent');
  });
});

describe('a graph’s node modes, folded into its chat-out edges', () => {
  it('makes a dry-run or read-only node’s edges dry runs, a live one’s live, and drops the mode', () => {
    expect(
      foldModes({
        version: 2,
        nodes: [
          { id: 'a', plugin: 'p', mode: 'dry-run' },
          { id: 'b', plugin: 'p', mode: 'live' },
          { id: 'c', plugin: 'p', mode: 'read-only' },
          { id: 'd', plugin: 'p' },
          'x',
        ],
        edges: [
          { from: 'a.out', to: 'tg.chat', type: 'chat-out' },
          { from: 'b.out', to: 'tg.chat', type: 'chat-out' },
          { from: 'c.out', to: 'tg.chat', type: 'chat-out' },
          { from: 'd.out', to: 'tg.chat', type: 'chat-out' },
          { from: 'tg.chat', to: 'a.in', type: 'chat-in' },
          'y',
        ],
      })
    ).toEqual({
      version: 2,
      nodes: [
        { id: 'a', plugin: 'p' },
        { id: 'b', plugin: 'p' },
        { id: 'c', plugin: 'p' },
        { id: 'd', plugin: 'p' },
        'x',
      ],
      edges: [
        { from: 'a.out', to: 'tg.chat', type: 'chat-out', dryRun: true },
        { from: 'b.out', to: 'tg.chat', type: 'chat-out' },
        { from: 'c.out', to: 'tg.chat', type: 'chat-out', dryRun: true },
        { from: 'd.out', to: 'tg.chat', type: 'chat-out' },
        { from: 'tg.chat', to: 'a.in', type: 'chat-in' },
        'y',
      ],
    });
    const plain = { version: 2, nodes: [{ id: 'a', plugin: 'p' }], edges: [] };
    expect(foldModes(plain)).toBe(plain);
    expect(foldModes({ version: 2, nodes: [{ id: 'a', mode: 'live' }] })).toEqual({
      version: 2,
      nodes: [{ id: 'a' }],
    });
    expect(foldModes(null)).toBeNull();
  });
});
