import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { controlServer } from './control-server.ts';
import { Core, STATES_DOC } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { type GraphInput } from './graph.ts';
import { graphDiff, GraphFile, graphFileControls, locateProblem } from './graph-file.ts';
import { definePlugin } from './plugin.ts';
import { shutdown } from './shutdown.ts';

/** A game's parser that offers its score. */
const scorer = definePlugin({
  manifest: {
    id: 'scorer',
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
    config: z.object({ every: z.number().int().min(1) }),
    inputs: {
      chat: { type: 'chat', network: 'chat' },
      score: { type: 'interface', plugin: 'scorer', members: ['state.score'] },
    },
  },
  create: () => ({}),
});

const good: GraphInput = {
  version: 2,
  nodes: [
    { id: 'chat', plugin: 'chat' },
    { id: 'scorer', plugin: 'scorer' },
    { id: 'actor', plugin: 'actor', instance: 'actor-1', config: { every: 2 } },
  ],
  edges: [
    { from: 'chat', to: 'actor.chat', reads: ['#lobby'] },
    { from: 'actor.chat', to: 'chat.chat', sends: ['#lobby'] },
    { from: 'scorer', to: 'actor.score' },
  ],
};

/** The good graph as version 1 wrote it: one chat edge for the reads and the sends. */
const legacy = {
  ...good,
  version: 1,
  edges: [
    { from: 'chat.chat', to: 'actor.chat', type: 'chat', reads: ['#lobby'], sends: ['#lobby'] },
    { from: 'scorer.interface', to: 'actor.score', type: 'interface' },
  ],
};

/** The good graph with an edge between ports of two types, and a bad config. */
const bad = {
  ...good,
  nodes: [
    { id: 'chat', plugin: 'chat' },
    { id: 'scorer', plugin: 'scorer' },
    { id: 'actor', plugin: 'actor', config: { every: 0 } },
  ],
  edges: [
    { from: 'chat.chat', to: 'actor.score' },
    { from: 'scorer', to: 'actor.chat' },
  ],
};

let dir: string;
let clock: VirtualClock;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-file-'));
  clock = new VirtualClock(Date.UTC(2026, 10, 1));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function instance(): { core: Core; lines: string[]; told: string[]; file: GraphFile } {
  const lines: string[] = [];
  const told: string[] = [];
  const file = new GraphFile(dir, () => clock.now());
  // The modes of before bot-os.md D64 migrated already: a first start's is `states.test.ts`'s.
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', `${STATES_DOC}.json`), '{"migrated":"before"}\n');
  const core = new Core({
    clock,
    dataDir: dir,
    graphFile: file,
    print: (l) => lines.push(l),
    notify: (t) => told.push(t),
  });
  core.register(
    fakeConnectorPlugin('chat', new FakeConnector({ account: 'chat:me' })),
    scorer,
    actor
  );
  return { core, lines, told, file };
}

const write = (name: string, content: unknown): void =>
  fs.writeFileSync(
    path.join(dir, name),
    typeof content === 'string' ? content : JSON.stringify(content)
  );

describe('the graph file', () => {
  it('reads nothing, a graph, or why not; names its instances; saves, each a version', () => {
    const file = new GraphFile(path.join(dir, 'sub'), () => clock.now());
    expect(file.read()).toEqual({ exists: false });
    expect(file.references()).toEqual(new Set());
    expect(file.current()).toBeUndefined();
    expect(file.save({ version: 2, nodes: [{ id: 'a', plugin: 'p' }], edges: [] })).toBe(true);
    expect(file.references()).toEqual(new Set(['a']));
    clock.advance(1000);
    expect(
      file.save({ version: 2, nodes: [{ id: 'b', plugin: 'p', instance: 'i' }], edges: [] })
    ).toBe(true);
    expect(
      file.save({ version: 2, nodes: [{ id: 'b', plugin: 'p', instance: 'i' }], edges: [] })
    ).toBe(false);
    expect(file.references()).toEqual(new Set(['i']));
    expect(file.history.list()).toEqual([
      {
        id: '2026-11-01T00-00-01.000Z',
        time: '2026-11-01T00:00:01.000Z',
        source: 'save',
        summary: '+ node b; − node a',
      },
      {
        id: '2026-11-01T00-00-00.000Z',
        time: '2026-11-01T00:00:00.000Z',
        source: 'save',
        summary: '+ node a',
      },
    ]);
    expect(file.current()?.id).toBe('2026-11-01T00-00-01.000Z');
    // A file written by hand is kept as a version of its own before the next save replaces it.
    fs.writeFileSync(file.file, JSON.stringify({ version: 2, nodes: [], edges: [] }));
    expect(file.current()).toBeUndefined();
    expect(file.save({ version: 2, nodes: [{ id: 'c', plugin: 'p' }], edges: [] })).toBe(true);
    expect(file.history.list().map((v) => [v.source, v.summary])).toEqual([
      ['save', '+ node c'],
      ['found', '− node b'],
      ['save', '+ node b; − node a'],
      ['save', '+ node a'],
    ]);
    fs.writeFileSync(file.file, '{half');
    expect(file.read()).toMatchObject({ exists: true, error: expect.stringMatching(/not JSON/) });
    expect(file.references()).toBeUndefined();
    fs.rmSync(file.file);
    fs.mkdirSync(file.file);
    expect(file.read()).toMatchObject({ error: expect.stringMatching(/does not read/) });
  });

  it('locates each problem: its node, edge, port, config or setting', () => {
    const raw = { nodes: [{ id: 'a' }, 'x'], edges: [{ from: 'a', to: 'b.c' }, 1] };
    expect(locateProblem('graph: nodes.0.config.x: bad', raw)).toEqual({
      text: 'graph: nodes.0.config.x: bad',
      node: 'a',
      config: 'x',
    });
    expect(locateProblem('graph: nodes.0.settings.s: bad', raw)).toMatchObject({ setting: 's' });
    expect(locateProblem('graph: nodes.1.id: bad', raw)).toEqual({
      text: 'graph: nodes.1.id: bad',
    });
    expect(locateProblem('graph: edges.0.to: bad', raw)).toMatchObject({
      edge: { from: 'a', to: 'b.c' },
    });
    expect(locateProblem('graph: edges.1: bad', raw)).toEqual({ text: 'graph: edges.1: bad' });
    expect(locateProblem('node a: no output port p', raw)).toMatchObject({ node: 'a', port: 'p' });
    expect(
      locateProblem('node a: input port p: x cannot bind y (edge b.q → a.p)', raw)
    ).toMatchObject({ node: 'a', port: 'p', edge: { from: 'b.q', to: 'a.p' } });
    expect(locateProblem('edge a → b.c: a node cannot feed itself', raw)).toMatchObject({
      edge: { from: 'a', to: 'b.c' },
    });
    expect(locateProblem('plugin a: config every: too small', raw)).toMatchObject({
      node: 'a',
      config: 'every',
    });
    expect(locateProblem('plugin a: config (all): bad', raw)).toEqual({
      text: 'plugin a: config (all): bad',
      node: 'a',
    });
    expect(locateProblem('plugin a: settings s: no such setting', raw)).toMatchObject({
      setting: 's',
    });
    expect(locateProblem('a cycle of required edges: a → b → a', raw)).toMatchObject({
      node: 'a',
    });
    expect(locateProblem('graph: (graph): bad', 'not a graph')).toEqual({
      text: 'graph: (graph): bad',
    });
  });

  it('diffs two graphs by node and by edge', () => {
    expect(graphDiff(good, bad)).toEqual({
      nodes: { added: [], removed: [], changed: [{ id: 'actor', fields: ['config', 'instance'] }] },
      edges: {
        added: [
          { from: 'chat.chat', to: 'actor.score' },
          { from: 'scorer', to: 'actor.chat' },
        ],
        removed: [
          { from: 'chat', to: 'actor.chat' },
          { from: 'actor.chat', to: 'chat.chat' },
          { from: 'scorer', to: 'actor.score' },
        ],
        changed: [],
      },
    });
    const moved = { ...good, edges: [{ from: 'chat', to: 'actor.chat', reads: ['#other'] }] };
    expect(graphDiff(good, moved).edges.changed).toEqual([
      { from: 'chat', to: 'actor.chat', fields: ['reads'] },
    ]);
    expect(graphDiff(undefined, { nodes: [{ id: 'n' }, {}], edges: [{}] })).toEqual({
      nodes: { added: ['n'], removed: [], changed: [] },
      edges: { added: [], removed: [], changed: [] },
    });
  });
});

describe('the core on the graph file', () => {
  it('starts empty with no file, and runs the saved graph', async () => {
    const empty = instance();
    await empty.core.start();
    expect(empty.core.nodes()).toEqual([]);
    expect(empty.core.graphProblems()).toEqual([]);
    await empty.core.stop();
    write('graph.json', good);
    const { core } = instance();
    await core.start();
    expect(core.status().map((s) => [s.id, s.state])).toEqual([
      ['chat', 'running'],
      ['scorer', 'running'],
      ['actor', 'running'],
    ]);
    expect(fs.existsSync(path.join(dir, 'instances', 'actor-1', '_instance.json'))).toBe(true);
    await core.stop();
  });

  it('starts with no node on a file it refuses, keeps the file, and says why', async () => {
    write('graph.json', bad);
    const { core, lines, told } = instance();
    await core.start();
    expect(core.nodes()).toEqual([]);
    expect(core.graphProblems()).toEqual([
      {
        text: 'node actor: input port score: chat-in of chat cannot bind interface of scorer (edge chat.chat → actor.score)',
        node: 'actor',
        port: 'score',
        edge: { from: 'chat.chat', to: 'actor.score' },
      },
      {
        text: 'edge scorer → actor.chat: no output of scorer fits chat-in of chat; name it',
        edge: { from: 'scorer', to: 'actor.chat' },
      },
      {
        text: 'node actor: input port chat (chat-in of chat) is not bound',
        node: 'actor',
        port: 'chat',
      },
      {
        text: 'node actor: output port chat (chat-out of chat) is not bound',
        node: 'actor',
        port: 'chat',
      },
    ]);
    expect(lines[0]).toMatch(/^core: the saved graph is refused, no node runs:/u);
    expect(told[0]).toMatch(/^The saved graph is refused, and no node runs: node actor/u);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'))).toEqual(bad);
    await core.stop();
    write('graph.json', '{half');
    const again = instance();
    await again.core.start();
    expect(again.core.graphProblems()[0]?.text).toMatch(/^graph.json is not JSON/u);
    await again.core.stop();
  });
});

describe('the graph API', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serve(core: Core, file: GraphFile, restart?: () => void) {
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      graphFile: graphFileControls(file, core),
      instances: () => core.instances(),
      ...(restart === undefined ? {} : { restart }),
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return async (p: string, method = 'GET', payload?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return [res.status, await res.json()] as const;
    };
  }

  it('reads, checks, saves and rolls back the saved graph', async () => {
    const { core, file } = instance();
    await core.start();
    const call = await serve(core, file);
    expect(await call('/graph/file')).toEqual([200, { exists: false, differs: false }]);
    expect(await call('/graph/rollback', 'POST')).toEqual([
      409,
      { error: 'there is no version before the current one to roll back to' },
    ]);
    expect(await call('/graph/history')).toEqual([
      200,
      { versions: [], keep: { days: 7, latest: 5 } },
    ]);
    expect(await call('/graph/history/nope')).toEqual([404, { error: 'there is no version nope' }]);
    expect(await call('/graph/history/nope/rollback', 'POST')).toEqual([
      404,
      { error: 'there is no version nope' },
    ]);
    expect(await call('/graph/history/nope/rollback')).toEqual([404, { error: 'not found' }]);
    expect(await call('/graph/history/nope', 'POST')).toEqual([404, { error: 'not found' }]);
    expect(await call('/graph/history', 'POST')).toEqual([404, { error: 'not found' }]);
    expect(await call('/graph/rollback')).toEqual([404, { error: 'not found' }]);
    // A check refuses an edge between ports of two types, with why, where.
    const [, checked] = await call('/graph/check', 'POST', bad);
    expect(checked).toMatchObject({
      ok: false,
      problems: [
        { node: 'actor', port: 'score', edge: { from: 'chat.chat', to: 'actor.score' } },
        { edge: { from: 'scorer', to: 'actor.chat' } },
        { node: 'actor', port: 'chat' },
        { node: 'actor', port: 'chat' },
      ],
      diff: { nodes: { added: ['chat', 'scorer', 'actor'] } },
    });
    const [status, refused] = await call('/graph/file', 'PUT', bad);
    expect(status).toBe(400);
    expect(refused).toMatchObject({
      error: 'the graph is refused',
      problems: [{ node: 'actor' }, {}, {}, {}],
    });
    expect(fs.existsSync(file.file)).toBe(false);
    // A good one is saved, and differs from the empty graph running.
    expect(await call('/graph/check', 'POST', good)).toMatchObject([
      200,
      {
        ok: true,
        problems: [],
        text: expect.stringMatching(
          /^nodes:\n {2}actor \(actor\), instance actor-1\n {4}config.every: 2\n/u
        ),
      },
    ]);
    expect(await call('/graph/file', 'PUT', good)).toEqual([200, { saved: true, restart: true }]);
    const [, saved] = await call('/graph/file');
    expect(saved).toMatchObject({
      exists: true,
      differs: true,
      graph: { nodes: [{ id: 'chat' }, {}, {}] },
      text: expect.stringContaining('  chat.chat → actor.chat (chat-in): reads #lobby'),
    });
    // The saved graph names the instance it will run on: it is in use, though nothing runs on it.
    clock.advance(1000);
    const next = { ...good, nodes: good.nodes.slice(0, 2), edges: [] };
    expect(await call('/graph/file', 'PUT', next)).toEqual([200, { saved: true, restart: true }]);
    const first = '2026-11-01T00-00-00.000Z';
    const second = '2026-11-01T00-00-01.000Z';
    const [, history] = await call('/graph/history');
    expect(history).toEqual({
      versions: [
        {
          id: second,
          time: '2026-11-01T00:00:01.000Z',
          source: 'save',
          summary:
            '− node actor; − edge chat.chat → actor.chat; − edge actor.chat → chat.chat; − edge scorer.interface → actor.score',
        },
        {
          id: first,
          time: '2026-11-01T00:00:00.000Z',
          source: 'save',
          summary: expect.stringMatching(/^\+ node chat; \+ node scorer; \+ node actor; \+ edge/u),
        },
      ],
      current: second,
      keep: { days: 7, latest: 5 },
    });
    // A version: what rolling back to it would change, structured and line by line.
    const [, one] = await call(`/graph/history/${first}`);
    expect(one).toMatchObject({
      id: first,
      source: 'save',
      current: false,
      graph: { nodes: [{}, {}, {}] },
      diff: {
        nodes: { added: ['actor'], removed: [], changed: [] },
        edges: { added: [{}, {}, {}], removed: [], changed: [] },
      },
      text: expect.stringContaining('actor (actor), instance actor-1'),
      currentText: 'nodes:\n  chat (chat)\n  scorer (scorer)\nedges:',
    });
    expect(one).not.toHaveProperty('problems');
    expect((one as { lines: { op: string }[] }).lines.map((l) => l.op).join('')).toBe(' ++   +++');
    expect((await call(`/graph/history/${second}`))[1]).toMatchObject({ current: true });
    expect(await call(`/graph/history/${second}/rollback`, 'POST')).toEqual([
      409,
      { error: `version ${second} is the current graph already` },
    ]);
    // A rollback writes the version back, kept as a new one that names it.
    clock.advance(1000);
    expect(await call(`/graph/history/${encodeURIComponent(first)}/rollback`, 'POST')).toEqual([
      200,
      { rolledBack: true, version: '2026-11-01T00-00-02.000Z', restores: first, restart: true },
    ]);
    expect((await call('/graph/file'))[1]).toMatchObject({ graph: { nodes: [{}, {}, {}] } });
    expect((await call('/graph/history'))[1]).toMatchObject({
      versions: [
        { source: 'rollback', restores: first, summary: expect.stringMatching(/^\+ node actor/u) },
        {},
        {},
      ],
      current: '2026-11-01T00-00-02.000Z',
    });
    // The old route: the version before the current one, so a second goes forward again.
    clock.advance(1000);
    expect((await call('/graph/rollback', 'POST'))[1]).toMatchObject({ restores: second });
    expect((await call('/graph/file'))[1]).toMatchObject({ graph: { nodes: [{}, {}] } });
    // A saved file that the check refuses says so; written by hand, it is kept before a rollback.
    write('graph.json', bad);
    expect((await call('/graph/file'))[1]).toMatchObject({
      differs: true,
      problems: [{}, {}, {}, {}],
      text: expect.stringContaining('chat.chat → actor.score (?)'),
    });
    expect((await call('/graph/check', 'POST', bad))[1]).toMatchObject({
      text: expect.stringContaining('scorer → actor.chat (?)'),
    });
    clock.advance(1000);
    expect((await call('/graph/rollback', 'POST'))[1]).toMatchObject({
      restores: '2026-11-01T00-00-03.000Z',
    });
    expect((await call('/graph/history'))[1]).toMatchObject({
      versions: [{ source: 'rollback' }, { source: 'found' }, {}, {}, {}, {}],
    });
    // A version that the check refuses now says so, and rolls back all the same.
    const found = ((await call('/graph/history'))[1] as { versions: { id: string }[] }).versions[1]
      ?.id as string;
    expect((await call(`/graph/history/${found}`))[1]).toMatchObject({
      problems: [{}, {}, {}, {}],
    });
    clock.advance(1000);
    expect((await call(`/graph/history/${found}/rollback`, 'POST'))[1]).toMatchObject({
      rolledBack: true,
      problems: [{}, {}, {}, {}],
    });
    write('graph.json', '{half');
    expect((await call('/graph/file'))[1]).toMatchObject({ error: expect.any(String) });
    expect((await call('/status'))[1]).not.toHaveProperty('graph');
    await core.stop();
  });

  it('runs the saved graph after a restart, its file the same, and says why one is refused', async () => {
    write('graph.json', good);
    const { core, file } = instance();
    await core.start();
    let restarts = 0;
    const call = await serve(core, file, () => restarts++);
    expect((await call('/graph/file'))[1]).toMatchObject({ differs: false });
    // Saved as the core holds it (each edge's ends and type written out), then unchanged.
    expect(await call('/graph/file', 'PUT', good)).toEqual([200, { saved: true, restart: false }]);
    expect(await call('/graph/file', 'PUT', good)).toEqual([200, { saved: false, restart: false }]);
    expect(await call('/restart', 'POST')).toEqual([200, { restarting: true }]);
    expect(restarts).toBe(1);
    expect((await call('/instances'))[1]).toMatchObject([
      { id: 'actor-1', node: 'actor' },
      { id: 'chat' },
      { id: 'scorer' },
    ]);
    await core.stop();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    write('graph.json', bad);
    const refused = instance();
    await refused.core.start();
    const again = await serve(refused.core, refused.file);
    expect((await again('/status'))[1]).toMatchObject({
      graph: {
        refused: [
          { node: 'actor', port: 'score' },
          { edge: {} },
          { port: 'chat' },
          { port: 'chat' },
        ],
      },
    });
    expect(await again('/restart', 'POST')).toEqual([404, { error: 'not found' }]);
    await refused.core.stop();
  });
});

describe('a graph file of version 1', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('runs converted, is shown and saved as version 2, and rolls back as version 2', async () => {
    write('graph.json', legacy);
    write('graph.previous.json', legacy);
    // Written a day before, each version is kept at its file's time.
    const before = new Date(clock.now() - 86_400_000);
    fs.utimesSync(path.join(dir, 'graph.previous.json'), before, before);
    fs.utimesSync(path.join(dir, 'graph.json'), before, before);
    const { core, file } = instance();
    await core.start();
    // The first start takes both files into the history: one version, as they are the same.
    file.started(core);
    expect(fs.existsSync(file.previous)).toBe(false);
    expect(file.history.list()).toMatchObject([
      { source: 'migrated', time: '2026-10-31T00:00:00.000Z', start: { result: 'ran' } },
    ]);
    expect(core.status().map((s) => s.state)).toEqual(['running', 'running', 'running']);
    const converted = [
      { from: 'chat.chat', to: 'actor.chat', type: 'chat-in', reads: ['#lobby'] },
      { from: 'actor.chat', to: 'chat.chat', type: 'chat-out', sends: ['#lobby'] },
      { from: 'scorer.interface', to: 'actor.score', type: 'interface' },
    ];
    expect(core.graph()).toMatchObject({ version: 2, edges: converted });
    expect(core.sends('actor')).toBe(true);
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      graphFile: graphFileControls(file, core),
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const call = async (p: string, method = 'GET', payload?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    // Shown as version 2, the file left as it is until a save; what runs already.
    expect(await call('/graph/file')).toMatchObject({
      differs: false,
      graph: { version: 2, edges: converted },
    });
    expect(JSON.parse(fs.readFileSync(file.file, 'utf8'))).toMatchObject({ version: 1 });
    // Checked against the saved file, both converted: nothing changes.
    expect(await call('/graph/check', 'POST', legacy)).toMatchObject({
      ok: true,
      diff: { edges: { added: [], removed: [], changed: [] } },
    });
    // Saved, as version 2: the same graph, so it is no new version.
    expect(await call('/graph/file', 'PUT', legacy)).toEqual({ saved: true, restart: false });
    expect(JSON.parse(fs.readFileSync(file.file, 'utf8'))).toMatchObject({
      version: 2,
      edges: converted,
    });
    expect(file.history.list()).toHaveLength(1);
    // A version 1 version is shown, diffed and rolled back as version 2.
    clock.advance(1000);
    const changed = {
      ...good,
      nodes: [...good.nodes.slice(0, 2), { ...good.nodes[2], config: { every: 3 } }],
    };
    expect(await call('/graph/file', 'PUT', changed)).toMatchObject({ saved: true });
    const v1 = file.history.list()[1]?.id as string;
    expect(await call(`/graph/history/${v1}`)).toMatchObject({
      graph: { version: 2, edges: converted },
      diff: {
        nodes: { changed: [{ id: 'actor', fields: ['config'] }] },
        edges: { added: [], removed: [], changed: [] },
      },
      lines: expect.arrayContaining([
        { op: '-', text: '    config.every: 3' },
        { op: '+', text: '    config.every: 2' },
      ]),
    });
    clock.advance(1000);
    expect(await call('/graph/rollback', 'POST')).toMatchObject({
      rolledBack: true,
      restart: false,
    });
    expect(JSON.parse(fs.readFileSync(file.file, 'utf8'))).toMatchObject({
      version: 2,
      edges: converted,
    });
    expect(await call('/graph/file')).toMatchObject({ differs: false });
    await core.stop();
  });
});

describe('shutdown', () => {
  it('stops the core, closes, and exits 0, once', async () => {
    const steps: string[] = [];
    const end = shutdown({
      stop: () => {
        steps.push('stop');
        return Promise.resolve();
      },
      close: () => steps.push('close'),
      exit: (code) => steps.push(`exit ${code}`),
      clock,
      print: (l) => steps.push(l),
    });
    await Promise.all([end('restart'), end('SIGTERM')]);
    expect(steps).toEqual(['megabottron1999: stopping (restart)', 'stop', 'close', 'exit 0']);
  });

  it('exits anyway when the stop hangs past its cap, or fails', async () => {
    const steps: string[] = [];
    const end = shutdown({
      stop: () => new Promise(() => {}),
      exit: (code) => steps.push(`exit ${code}`),
      clock,
      capMs: 1000,
      print: (l) => steps.push(l),
    });
    const ending = end('SIGTERM');
    await Promise.resolve();
    clock.advance(1000);
    await ending;
    expect(steps).toEqual([
      'megabottron1999: stopping (SIGTERM)',
      'megabottron1999: the stop took over 1000 ms',
      'exit 0',
    ]);
    const failed: string[] = [];
    await shutdown({
      stop: () => Promise.reject(new Error('stuck')),
      exit: (code) => failed.push(`exit ${code}`),
      clock,
      print: (l) => failed.push(l),
    })('SIGINT');
    expect(failed.slice(1)).toEqual(['megabottron1999: the stop failed: stuck', 'exit 0']);
  });
});
