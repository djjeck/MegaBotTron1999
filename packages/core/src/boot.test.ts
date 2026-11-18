import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { entrySource, manifestOf, tempDir, writeModule } from '#test/modules.ts';
import { blame, bootstrap, guard, loadPackages, type PackageSpec } from './boot.ts';
import { wallClock } from './clock.ts';
import { controlHandler } from './control-server.ts';
import { Core, type CoreRecord } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { GraphFile } from './graph-file.ts';
import { GRAPH_FILE } from './graph-view.ts';
import { healthServer } from './health.ts';
import { loadModules } from './module-loader.ts';
import { definePlugin, type Plugin } from './plugin.ts';

/** A game's parser that offers its score. */
const scorer = (id = 'scorer'): Plugin =>
  definePlugin({
    manifest: {
      id,
      version: '0.1.0',
      kinds: ['parser'],
      description: 'keeps a score',
      interface: { state: { score: { help: 'the score', output: z.number() } } },
    },
    create: () => ({ interface: { state: { score: () => 7 } } }),
  });

/** An actor on a chat, reading a score. */
const actor = definePlugin({
  manifest: {
    id: 'actor',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'acts on the score',
    inputs: {
      chat: { type: 'chat-in', network: 'chat' },
      score: { type: 'interface', plugin: 'scorer', members: ['state.score'] },
    },
    outputs: { chat: { type: 'chat-out', network: 'chat' } },
  },
  create: () => ({}),
});

const graph = {
  version: 2,
  nodes: [
    { id: 'chat', plugin: 'chat', account: 'chat:me' },
    { id: 'scorer', plugin: 'scorer' },
    { id: 'actor', plugin: 'actor' },
  ],
  edges: [
    { from: 'chat', to: 'actor.chat', reads: ['#lobby'] },
    { from: 'actor.chat', to: 'chat.chat', sends: ['#lobby'] },
    { from: 'scorer', to: 'actor.score' },
  ],
};

const pkg = (name: string, ...plugins: Plugin[]): PackageSpec => ({
  name,
  load: () => Promise.resolve(plugins),
});

let dir: string;
let servers: http.Server[];
beforeEach(() => {
  dir = tempDir('boot-');
  servers = [];
});
afterEach(() => {
  for (const s of servers) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An instance on a data volume with `saved` as its graph, its records and lines kept. */
function instance(saved: unknown = graph, more: { startTimeoutMs?: number } = {}) {
  fs.writeFileSync(path.join(dir, GRAPH_FILE), JSON.stringify(saved));
  const records: CoreRecord[] = [];
  const lines: string[] = [];
  const graphFile = new GraphFile(dir);
  const core = new Core({
    clock: wallClock(),
    dataDir: dir,
    graphFile,
    print: (l) => lines.push(l),
    record: (r) => void records.push(r as CoreRecord),
    ...more,
  });
  return { core, records, lines, graphFile };
}

/** A server of `handler` on a free port of the loopback: its base URL. */
async function serve(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const getJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
};

/** A node's state as `GET /status` says it. */
const stateIn = (body: unknown, id: string) =>
  (body as { plugins: { id: string; state: string; reason?: string }[] }).plugins.find(
    (p) => p.id === id
  );

describe('loading the packages, each on its own (D143)', () => {
  it('names a package whose import throws, never settles or whose factory throws; the others load', async () => {
    const bad = path.join(dir, 'bad.ts');
    fs.writeFileSync(bad, 'export const plugins = [;\n');
    const r = await loadPackages(
      [
        pkg('good', scorer()),
        { name: 'syntax', load: async () => [(await import(pathToFileURL(bad).href)) as Plugin] },
        { name: 'hangs', load: () => new Promise<never>(() => {}) },
        {
          name: 'factory',
          load: () => {
            throw new Error('boom');
          },
        },
      ],
      100
    );
    expect(r.loaded.map((p) => p.name)).toEqual(['good']);
    expect(r.failures).toEqual([
      { source: 'package syntax', error: expect.any(String) as unknown },
      { source: 'package hangs', error: 'it did not load within 0.1 s' },
      { source: 'package factory', error: 'boom' },
    ]);
  });
});

describe('starting in the background (D143)', () => {
  it('serves first: health answers and the nodes are loading; a package that fails holds only its nodes', async () => {
    const { core, records, graphFile } = instance();
    const chat = new FakeConnector({ account: 'chat:me' });
    const health = await serve(healthServer(core.controls, () => 1));
    const control = await serve(
      (await import('node:http')).createServer(
        controlHandler({ controls: core.controls, settings: core.settings })
      )
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const booting = bootstrap({
      core,
      packages: [
        { name: 'chat', load: async () => (await gate, [fakeConnectorPlugin('chat', chat)]) },
        {
          name: 'scorer',
          load: () => Promise.reject(new SyntaxError("Unexpected token ';'")),
        },
        pkg('actor', actor),
      ],
      loaded: () => graphFile.started(core),
    });
    // Before any plugin is in: the server answers, the saved graph's nodes are loading.
    const early = await getJson(`${health}/health`);
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ ok: true, phase: 'loading', connectors: [] });
    const loading = await getJson(`${control}/status`);
    expect(loading.body).toMatchObject({ boot: { phase: 'loading', failures: [] } });
    expect(stateIn(loading.body, 'scorer')).toMatchObject({ state: 'loading' });
    expect(core.check(graph)).toEqual({
      ok: false,
      problems: [{ text: 'the instance is still loading its plugins: check again in a moment' }],
    });
    release();
    const done = await booting;
    expect(done.failures).toEqual([{ source: 'package scorer', error: "Unexpected token ';'" }]);
    // The scorer did not load: its node failed to load, its actor inactive, the chat runs.
    const status = await getJson(`${control}/status`);
    expect(status.body).toMatchObject({
      boot: { phase: 'started', failures: done.failures },
    });
    expect(stateIn(status.body, 'chat')).toMatchObject({ state: 'running' });
    expect(stateIn(status.body, 'scorer')).toMatchObject({
      state: 'unloaded',
      reason: "its plugin scorer did not load: package scorer failed: Unexpected token ';'",
      failures: [{ source: 'package scorer', error: "Unexpected token ';'" }],
    });
    expect(stateIn(status.body, 'actor')).toMatchObject({
      state: 'inactive',
      reason: 'needs scorer (unloaded)',
    });
    expect((await getJson(`${health}/health`)).body).toMatchObject({ ok: true, phase: 'started' });
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'core.load', event: 'failed', source: 'package scorer' })
    );
    expect(core.notices()).toContainEqual(
      expect.objectContaining({
        kind: 'load-failed',
        text: "package scorer failed to load: Unexpected token ';'",
      })
    );
    await core.stop();
  });

  it('answers the health while a connector connects, saying so (D143)', async () => {
    const { core } = instance({
      version: 2,
      nodes: [{ id: 'chat', plugin: 'chat', account: 'chat:me' }],
      edges: [],
    });
    const chat = new FakeConnector({ account: 'chat:me' });
    chat.connecting('dialing');
    const health = await serve(healthServer(core.controls, () => 1));
    const control = await serve(
      (await import('node:http')).createServer(
        controlHandler({ controls: core.controls, settings: core.settings })
      )
    );
    await bootstrap({ core, packages: [pkg('chat', fakeConnectorPlugin('chat', chat))] });
    const h = await getJson(`${health}/health`);
    expect(h).toEqual({
      status: 200,
      body: {
        ok: true,
        uptimeS: 1,
        on: true,
        phase: 'started',
        connected: false,
        connectors: [{ id: 'chat', plugin: 'chat', status: 'connecting', counted: true }],
      },
    });
    const accounts = await getJson(`${control}/accounts`);
    expect(accounts.body).toMatchObject([
      { id: 'chat', state: 'running', connection: { state: 'connecting', phase: 'dialing' } },
    ]);
    await core.stop();
  });

  it('holds the nodes of a module failing at its top level, names it, and runs the others', async () => {
    const modules = path.join(dir, 'modules');
    writeModule(modules, 'boom', manifestOf('boom', { plugins: ['src/p.ts'] }), {
      'src/p.ts': `throw new Error('top-level boom');\n${entrySource('scorer')}`,
    });
    writeModule(modules, 'fine', manifestOf('fine', { plugins: ['src/p.ts'] }), {
      'src/p.ts': entrySource('stats'),
    });
    const { core } = instance({
      version: 2,
      nodes: [
        { id: 'scorer', plugin: 'scorer' },
        { id: 'stats', plugin: 'stats' },
      ],
      edges: [],
    });
    const done = await bootstrap({
      core,
      packages: [],
      modules: (reserved) =>
        loadModules({ dir: modules, host: import.meta.url, reserved, register: () => {} }),
    });
    expect(done.modules?.modules.map((m) => m.id)).toEqual(['fine']);
    expect(done.failures).toEqual([
      {
        source: 'module boom',
        module: 'boom',
        error: 'src/p.ts failed to load: top-level boom',
      },
    ]);
    expect(core.state('stats')?.state).toBe('running');
    expect(core.held()).toEqual([
      {
        id: 'scorer',
        plugin: 'scorer',
        state: 'unloaded',
        reason:
          'its plugin scorer did not load: module boom failed: src/p.ts failed to load: top-level boom',
        failures: done.failures,
      },
    ]);
    await core.stop();
  });

  it('names the failure that took a plugin, as the start before kept where it came from', async () => {
    const first = instance({ version: 2, nodes: [{ id: 'scorer', plugin: 'scorer' }], edges: [] });
    await bootstrap({ core: first.core, packages: [pkg('scores', scorer())] });
    await first.core.stop();
    const second = instance({ version: 2, nodes: [{ id: 'scorer', plugin: 'scorer' }], edges: [] });
    await bootstrap({
      core: second.core,
      packages: [
        { name: 'other', load: () => Promise.reject(new Error('other broke')) },
        { name: 'scores', load: () => Promise.reject(new Error('scores broke')) },
      ],
    });
    expect(second.core.held()).toMatchObject([
      {
        id: 'scorer',
        state: 'unloaded',
        reason: 'its plugin scorer did not load: package scores failed: scores broke',
      },
    ]);
    await second.core.stop();
  });

  it('serves on when the modules cannot be read, or a graph given by the wiring is refused', async () => {
    const lines: string[] = [];
    const core = new Core({
      clock: wallClock(),
      graph: { version: 2, nodes: [{ id: 'x', plugin: 'nowhere' }], edges: [] },
      print: (l) => lines.push(l),
    });
    const done = await bootstrap({
      core,
      packages: [],
      modules: () => Promise.reject(new Error('no volume')),
      print: (l) => lines.push(l),
    });
    expect(done.failures).toEqual([{ source: 'the modules', error: 'no volume' }]);
    // Something failed to load: the node of a plugin not offered is held, not the graph refused.
    expect(core.held()).toMatchObject([{ id: 'x', state: 'unloaded' }]);
    expect(core.boot().phase).toBe('started');
    // Nothing failed: a plugin not offered refuses the wiring's graph, as before; the process
    // serves on.
    const refused = new Core({
      clock: wallClock(),
      graph: { version: 2, nodes: [{ id: 'x', plugin: 'nowhere' }], edges: [] },
    });
    await bootstrap({ core: refused, packages: [], print: (l) => lines.push(l) });
    expect(lines.at(-1)).toMatch(
      /^megabottron1999: node x: its plugin nowhere is not in the image/u
    );
    expect(refused.nodes()).toEqual([]);
  });

  it('tells a failing graph history, and a start that throws, and goes on', async () => {
    const lines: string[] = [];
    const { core } = instance({ version: 2, nodes: [], edges: [] });
    const start = core.start.bind(core);
    core.start = () => start().then(() => Promise.reject(new Error('start broke')));
    await bootstrap({
      core,
      packages: [],
      loaded: () => {
        throw new Error('no history');
      },
      print: (l) => lines.push(l),
    });
    expect(lines).toEqual([
      'megabottron1999: no history',
      'megabottron1999: the start failed: start broke',
    ]);
    await core.stop();
  });
});

describe('a node that does not start in time (D143)', () => {
  it('fails alone, and the start goes on; what it makes late is stopped', async () => {
    let stopped = 0;
    let finish: () => void = () => {};
    const slow = definePlugin({
      manifest: { id: 'slow', version: '0.1.0', kinds: ['stats'], description: 'slow' },
      create: () =>
        new Promise((r) => {
          finish = () => r({ stop: () => void (stopped += 1) });
        }),
    });
    const hangs = definePlugin({
      manifest: { id: 'hangs', version: '0.1.0', kinds: ['stats'], description: 'hangs' },
      create: () => ({
        start: () => new Promise<void>(() => {}),
        stop: () => void (stopped += 10),
      }),
    });
    const late = definePlugin({
      manifest: { id: 'late', version: '0.1.0', kinds: ['stats'], description: 'late' },
      create: () => ({
        ready: () => new Promise<void>(() => {}),
        stop: () => void (stopped += 100),
      }),
    });
    const { core } = instance(
      {
        version: 2,
        nodes: [
          { id: 'slow', plugin: 'slow' },
          { id: 'hangs', plugin: 'hangs' },
          { id: 'late', plugin: 'late' },
          { id: 'stats', plugin: 'stats' },
        ],
        edges: [],
      },
      { startTimeoutMs: 50 }
    );
    await bootstrap({ core, packages: [pkg('all', slow, hangs, late, scorer('stats'))] });
    expect(core.state('slow')).toEqual({
      id: 'slow',
      state: 'failed',
      reason: 'its start did not finish within 0.05 s',
    });
    expect(core.state('hangs')?.state).toBe('failed');
    expect(core.state('late')).toEqual({
      id: 'late',
      state: 'failed',
      reason: 'its ready did not finish within 0.05 s',
    });
    expect(core.state('stats')?.state).toBe('running');
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(111);
    await core.stop();
  });

  it('starts no more nodes once the instance stops', async () => {
    let release: () => void = () => {};
    const first = definePlugin({
      manifest: { id: 'first', version: '0.1.0', kinds: ['stats'], description: 'first' },
      create: () => new Promise((r) => (release = () => r({}))),
    });
    const { core } = instance({
      version: 2,
      nodes: [
        { id: 'first', plugin: 'first' },
        { id: 'stats', plugin: 'stats' },
      ],
      edges: [],
    });
    const booting = bootstrap({ core, packages: [pkg('all', first, scorer('stats'))] });
    await new Promise((r) => setTimeout(r, 20));
    const stopping = core.stop('SIGTERM');
    release();
    await booting;
    await stopping;
    expect(core.state('stats')?.state).toBe('registered');
    expect(core.boot().phase).toBe('starting');
  });
});

describe('an error nothing caught (D143)', () => {
  it('is told, naming the module or package its stack names, and the process goes on', () => {
    const { core, records, lines } = instance({ version: 2, nodes: [], edges: [] });
    const emitter = new EventEmitter();
    guard(core, emitter, () => [{ id: 'dice', dir: '/data/modules/dice' }]);
    const fromModule = new Error('dice broke');
    fromModule.stack = 'Error: dice broke\n    at roll (file:///data/modules/dice/src/p.ts:3:9)';
    emitter.emit('unhandledRejection', fromModule);
    const fromPackage = new Error('turns broke');
    fromPackage.stack =
      'Error: turns broke\n    at x (file:///app/packages/core/src/bus.ts:1:1)\n    at y (file:///app/packages/turns/src/player.ts:1:1)';
    emitter.emit('uncaughtException', fromPackage);
    emitter.emit('unhandledRejection', 'a bare reason');
    expect(core.notices().map((n) => [n.kind, n.text])).toEqual([
      ['uncaught', 'an error nothing caught (module dice): dice broke'],
      ['uncaught', 'an error nothing caught (package @megabottron1999/turns): turns broke'],
      ['uncaught', 'an error nothing caught: a bare reason'],
    ]);
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'core.uncaught', error: 'dice broke', from: 'module dice' })
    );
    expect(lines[0]).toMatch(/^core: uncaught error \(module dice\): Error: dice broke/u);
    expect(blame(new Error('x'))).toBeUndefined();
  });

  it('is told of a failed load only before the load', () => {
    const { core } = instance({ version: 2, nodes: [], edges: [] });
    core.load();
    expect(() => core.failedToLoad({ source: 'package x', error: 'late' })).toThrow(
      'a failed load is told before the core loads'
    );
    expect(core.held()).toEqual([]);
  });
});
