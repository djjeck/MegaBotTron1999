/**
 * The script node (docs/bot-os.md D76): its config and manifest, its runtime in the main thread
 * (the dev kit's) and in a worker (an instance's), the bridge between them, and its limits. The
 * game is made up: @QuestBot, its `quest.gain` events, and a state of its inventory.
 */
import {
  Core,
  definePlugin,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type GraphInput,
  parseManifest,
  type Plugin,
  type PluginContext,
} from '@megabottron1999/core';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  codeProblem,
  SCRIPT_TEMPLATE,
  scriptConfig,
  scriptManifest,
  scriptPlugin,
} from '#src/script-plugin.ts';
import { MAX_TIMERS, ScriptRuntime } from '#src/script-runtime.ts';
import { statePlugin } from '#src/state-plugin.ts';

/** The made-up game's parser: what the test says, published. */
function questParser(): Plugin & { publish?: (type: string, payload: object) => void } {
  const p: Plugin & { publish?: (type: string, payload: object) => void } = definePlugin({
    manifest: {
      id: 'quest',
      kinds: ['parser'],
      description: 'A made-up game',
      games: { registers: ['quest'] },
      events: { 'quest.gain': z.object({ name: z.string() }), 'quest.tick': z.object({}) },
    },
    create: (ctx: PluginContext) => {
      p.publish = (type, payload) => ctx.bus.publish(type, payload as Record<string, unknown>);
      return {};
    },
  });
  return p;
}

type Inventory = { inventory: { items: { name: string; count: number }[] } };
const questState = statePlugin<Inventory>({
  id: 'quest-state',
  description: 'The inventory at @QuestBot',
  schema: z.object({
    inventory: z
      .object({ items: z.array(z.object({ name: z.string(), count: z.number() })) })
      .describe('Inventory'),
  }),
  initial: { inventory: { items: [] } },
  consumes: ['quest.gain'],
  reduce: (state, e) => {
    const name = String(e['name']);
    const items = state.inventory.items.some((i) => i.name === name)
      ? state.inventory.items.map((i) => (i.name === name ? { ...i, count: i.count + 1 } : i))
      : [...state.inventory.items, { name, count: 1 }];
    return { inventory: { items } };
  },
  queries: {
    count: {
      help: 'How many of an item',
      input: z.object({ name: z.string() }),
      output: z.number(),
      run: (s, { name }: { name: string }) =>
        s.inventory.items.find((i) => i.name === name)?.count ?? 0,
    },
  },
});

/** The examine node: on a change of the state, a new item (its count now 1) is looked at. */
const EXAMINE = `
interface Changed { sections: string[]; event?: { type: string; t: number } }
let last: string | undefined;
on('quest.gain', (e: { name: string }) => { last = e.name; });
on('quest-state.changed', async (e: Changed) => {
  if (last === undefined) return;
  const item: string = last;
  const n = (await use('state').state.count({ name: item })) as number;
  if (n !== 1) return;
  const seen = (store.read('seen') as string[] | undefined) ?? [];
  store.write('seen', [...seen, item]);
  log.info('examining', item, 'at', clock.now(), new Date().getTime());
  const sent = enqueue('chat', '@QuestBot', '/look ' + item, {
    cancel: { on: 'quest.gain', when: { name: 'nothing' }, withinMs: 60_000 },
  });
  const r = await sent;
  publish('examine.looked', { item, outcome: r.outcome });
});
`;

const examineConfig = (code = EXAMINE) => ({
  inputs: {
    'state-events': { type: 'events', namespace: 'quest-state' },
    'quest-events': { type: 'events', namespace: 'quest' },
    state: { type: 'interface', plugin: 'quest-state', members: ['state.count'] },
  },
  outputs: { chat: { type: 'chat-out', commands: ['/look'], minIntervalS: { '/look': 5 } } },
  events: { looked: { help: 'An item looked at', fields: { item: 'string', outcome: 'string' } } },
  code,
});

const graph = (config: object = examineConfig(), more: GraphInput['nodes'] = []): GraphInput => ({
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg', account: 'telegram:alice' },
    { id: 'quest', plugin: 'quest' },
    { id: 'quest-state', plugin: 'quest-state' },
    { id: 'examine', plugin: 'script', config: config as Record<string, unknown> },
    ...more,
  ],
  edges: [
    { from: 'quest.events', to: 'quest-state.events' },
    { from: 'quest-state.events', to: 'examine.state-events' },
    { from: 'quest.events', to: 'examine.quest-events' },
    { from: 'quest-state.interface', to: 'examine.state' },
    {
      from: 'examine.chat',
      to: 'tg.chat',
      sends: ['@QuestBot'],
      commands: ['/look'],
    },
  ],
});

async function run(isolation: 'worker' | 'in-process', config: object = examineConfig()) {
  const connector = new FakeConnector({ account: 'telegram:alice' });
  const parser = questParser();
  const lines: string[] = [];
  const kit = new DevKit({
    start: Date.parse('2026-11-12T10:00:00Z'),
    plugins: [
      fakeConnectorPlugin('tg', connector),
      parser,
      questState,
      scriptPlugin({ isolation }),
    ],
    graph: graph(config),
    print: (l) => lines.push(l),
  });
  await kit.start();
  connector.open();
  return { kit, connector, parser, lines };
}

/** Waits, in real time, for what a worker answers. */
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A bridge that answers little, and says what it is asked. */
const bridge = (lines: string[]) => ({
  use: () => Promise.resolve(undefined),
  enqueue: () => {},
  cancel: () => Promise.resolve(false),
  held: () =>
    Promise.resolve({ until: 7, reason: 'backed off: refused 3 times in a row (missing)' }),
  publish: () => {},
  write: () => {},
  remove: (n: string) => void lines.push(`remove ${n}`),
  log: (level: string, line: string) => void lines.push(`${level} ${line}`),
  now: () => 42,
  schedule: (id: number, at: number, every: number | undefined) =>
    void lines.push(`schedule ${id} ${at} ${every}`),
  unschedule: (id: number) => void lines.push(`unschedule ${id}`),
});

describe('a script node’s config', () => {
  it('starts with code that loads and does nothing', () => {
    expect(codeProblem(SCRIPT_TEMPLATE)).toBeUndefined();
    expect(scriptConfig.parse({}).code).toBe(SCRIPT_TEMPLATE);
  });

  it('refuses code that does not parse, as TypeScript or as JavaScript', () => {
    expect(codeProblem('const a: = 1;')).toMatch(/^does not parse: /u);
    expect(codeProblem('enum E { A }')).toBe(
      'does not parse: TypeScript enum is not supported in strip-only mode'
    );
    expect(codeProblem('let a = 1;\nlet a = 2;')).toBe(
      "does not parse: Identifier 'a' has already been declared (line 2)"
    );
    expect(codeProblem('const x: number = await Promise.resolve(1);')).toBeUndefined();
    const r = scriptConfig.safeParse({ code: 'let = ;' });
    expect(r.success).toBe(false);
  });

  it('makes its node’s manifest from its ports: an actor when it sends', () => {
    const m = parseManifest(scriptManifest(scriptConfig.parse(examineConfig()), 'examine'));
    expect(m.kinds).toEqual(['actor']);
    expect(Object.keys(m.inputs)).toEqual(['state-events', 'quest-events', 'state']);
    expect(m.outputs['chat']).toMatchObject({ type: 'chat-out', commands: ['/look'] });
    expect(m.games.registers).toEqual(['examine']);
    expect(Object.keys(m.events)).toEqual(['examine.looked']);
    expect(m.audit).toEqual(['code']);
    const odd = parseManifest(
      scriptManifest({ events: { seen: { help: '', fields: { when: 'date' } } } }, 'odd')
    );
    expect(odd.events['odd.seen']?.description).toBeUndefined();
    expect(odd.events['odd.seen']?.safeParse({ when: new Date() }).success).toBe(true);
    const quiet = parseManifest(scriptManifest({ events: 'nonsense' }, 'quiet'));
    expect(quiet.kinds).toEqual(['stats']);
    expect(quiet.games.registers).toEqual([]);
  });

  it('is refused by the check where it is wrong: the code, a port', async () => {
    const kit = new DevKit({ plugins: [scriptPlugin()], graph: { version: 2, nodes: [] } });
    await kit.start();
    const c = kit.core.check({
      version: 2,
      nodes: [{ id: 's', plugin: 'script', config: { code: 'let = ;' } }],
    });
    expect(c.ok ? [] : c.problems.map((p) => [p.node, p.config])).toEqual([['s', 'code']]);
    await kit.stop();
  });
});

for (const isolation of ['in-process', 'worker'] as const)
  describe(`a script node, ${isolation}`, () => {
    it('reacts to a state’s change, asks its interface, and queues a command', async () => {
      const { kit, connector, parser, lines } = await run(isolation);
      parser.publish?.('quest.gain', { name: 'lantern' });
      await until(() => connector.sent.length > 0);
      expect(connector.sent).toEqual([{ chat: '@QuestBot', text: '/look lantern' }]);
      // A second lantern: its count is 2, so nothing is sent.
      parser.publish?.('quest.gain', { name: 'lantern' });
      parser.publish?.('quest.gain', { name: 'rope' });
      kit.runUntil(Date.parse('2026-11-12T10:00:10Z'));
      await until(() => connector.sent.length > 1);
      expect(connector.sent.map((s) => s.text)).toEqual(['/look lantern', '/look rope']);
      await until(() => kit.log.records.filter((r) => r.type === 'examine.looked').length === 2);
      expect(
        kit.log.records.filter((r) => r.type === 'examine.looked').map((r) => r['item'])
      ).toEqual(['lantern', 'rope']);
      expect(lines).toContain(
        `examine: examining lantern at ${Date.parse('2026-11-12T10:00:00Z')} ${Date.parse('2026-11-12T10:00:00Z')}`
      );
      expect(
        lines.some((l) =>
          l.startsWith(
            `examine: loaded, ${isolation === 'worker' ? 'in a worker' : 'in process'}: on quest.gain, quest-state.changed`
          )
        )
      ).toBe(true);
      // What it cost (D77): its handlers' calls, and a worker's CPU and heap.
      await until(() => (kit.core.cost('examine')?.own?.calls ?? 0) >= 5);
      if (isolation === 'worker')
        await until(() => (kit.core.cost('examine')?.own?.heapBytes ?? 0) > 0);
      const own = kit.core.cost('examine')?.own;
      expect(own).toMatchObject({ runs: isolation, errors: 0 });
      expect(own?.ms).toBeGreaterThan(0);
      if (isolation === 'worker') expect(own?.cpuMs).toBeGreaterThan(0);
      else expect(own?.cpuMs).toBeUndefined();
      await kit.stop();
      expect(kit.core.state('examine')?.state).toBe('stopped');
    });

    it('keeps its store, and refuses what its ports do not reach', async () => {
      const code = `
        on('quest.tick', async () => {
          store.write('n', ((store.read('n') as number | undefined) ?? 0) + 1);
          log.warn(store.names());
          try { await use('state').state.get({}); } catch (e) { log.error(String(e)); }
          try { await use('nowhere').state.count({ name: 'x' }); } catch (e) { log.error(String(e)); }
          const r = await outbox('nowhere').enqueue('@QuestBot', '/look x');
          log.error(r.outcome, r.reason);
          try { publish('quest.gain', { name: 'x' }); } catch (e) { log.error(String(e)); }
          await enqueue('chat', '@QuestBot', '/look now');
          const q = enqueue('chat', '@QuestBot', '/look later');
          log.info(q.status(), await q.cancel(), (await q).outcome);
          log.info('held', await outbox('chat').held('@QuestBot', '/look'));
          console.log({ a: 1 });
          throw new Error('done');
        });
      `;
      const { kit, parser, lines } = await run(isolation, examineConfig(code));
      parser.publish?.('quest.tick', {});
      await until(() => lines.some((l) => l.includes('a handler threw: done')));
      expect(lines).toEqual(
        expect.arrayContaining([
          'examine: warning: ["n"]',
          'examine: error: Error: state offers it state.count, not state.get',
          'examine: error: Error: use("nowhere"): it has no interface input nowhere',
          expect.stringMatching(/^examine: error: refused examine has no reach/u),
          expect.stringMatching(
            /^examine: error: Error: publish\("quest.gain"\): it publishes examine.looked/u
          ),
          'examine: waiting true cancelled',
          'examine: held undefined',
          'examine: {"a":1}',
        ])
      );
      expect(kit.core.state('examine')?.state).toBe('running');
      await kit.stop();
    });

    it('has several ports of a kind, each told apart by its name (D84)', async () => {
      const code = `
        on('quest.gain', async (e: { name: string }) => {
          const n = await use('counts').state.count({ name: e.name });
          const all = await use('reads').state.get({});
          log.info('heard', e.name, typeof n, typeof all);
          await enqueue('look', '@QuestBot', '/look ' + e.name);
          await outbox('use').enqueue('@QuestBot', '/use ' + e.name);
        });
      `;
      const connector = new FakeConnector({ account: 'telegram:alice' });
      const parser = questParser();
      const lines: string[] = [];
      const kit = new DevKit({
        start: Date.parse('2026-11-12T10:00:00Z'),
        plugins: [
          fakeConnectorPlugin('tg', connector),
          parser,
          questState,
          scriptPlugin({ isolation }),
        ],
        graph: {
          version: 2,
          nodes: [
            { id: 'tg', plugin: 'tg', account: 'telegram:alice' },
            { id: 'quest', plugin: 'quest' },
            { id: 'quest-state', plugin: 'quest-state' },
            {
              id: 'examine',
              plugin: 'script',
              config: {
                // Two events inputs of one namespace, two interface inputs of one plugin, two
                // chat-out outputs: each port its own name.
                inputs: {
                  'quest-a': { type: 'events', namespace: 'quest' },
                  'quest-b': { type: 'events', namespace: 'quest' },
                  counts: { type: 'interface', plugin: 'quest-state', members: ['state.count'] },
                  reads: { type: 'interface', plugin: 'quest-state', members: ['state.get'] },
                },
                outputs: {
                  look: { type: 'chat-out', commands: ['/look'] },
                  use: { type: 'chat-out', commands: ['/use'] },
                },
                code,
              },
            },
          ],
          edges: [
            { from: 'quest.events', to: 'quest-state.events' },
            { from: 'quest.events', to: 'examine.quest-a' },
            { from: 'quest.events', to: 'examine.quest-b' },
            { from: 'quest-state.interface', to: 'examine.counts' },
            { from: 'quest-state.interface', to: 'examine.reads' },
            { from: 'examine.look', to: 'tg.chat', sends: ['@QuestBot'], commands: ['/look'] },
            { from: 'examine.use', to: 'tg.chat', sends: ['@QuestBot'], commands: ['/use'] },
          ],
        },
        print: (l) => lines.push(l),
      });
      await kit.start();
      connector.open();
      parser.publish?.('quest.gain', { name: 'lantern' });
      await until(() => connector.sent.length > 1);
      // Heard once, though two inputs bring its namespace; each send through its own output.
      expect(lines.filter((l) => l.startsWith('examine: heard'))).toEqual([
        'examine: heard lantern number object',
      ]);
      expect(connector.sent).toEqual([
        { chat: '@QuestBot', text: '/look lantern' },
        { chat: '@QuestBot', text: '/use lantern' },
      ]);
      await kit.stop();
    });

    it('fails its node alone when a handler holds its thread past its limit', async () => {
      const code = `on('quest.tick', () => { for (;;) {} });`;
      const { kit, parser, lines } = await run(isolation, {
        ...examineConfig(code),
        limits: { callMs: 50, memoryMb: 64 },
      });
      parser.publish?.('quest.tick', {});
      await until(() => kit.core.state('examine')?.state === 'failed');
      // In a worker, its limit is the CPU it spends (D85); in process, vm's, in real time.
      expect(kit.core.state('examine')?.reason).toBe(
        isolation === 'worker'
          ? 'its script hung: a handler of quest.tick spent over 50 ms of CPU'
          : 'its script hung: a handler of quest.tick took over 50 ms'
      );
      expect(kit.core.state('quest-state')?.state).toBe('running');
      expect(lines.some((l) => l.startsWith('examine: error: failed: its script hung'))).toBe(true);
      await kit.stop();
    });

    it('fails its node at start when its script throws, or hears what no input brings', async () => {
      for (const [code, why] of [
        ['throw new Error("broken");', 'its script failed: broken'],
        [
          'for (;;) {}',
          isolation === 'worker'
            ? 'its script hung: its first run spent over 50 ms of CPU'
            : 'its script hung: its first run took over 50 ms',
        ],
        [
          `on('cards.deal', () => {});`,
          'examine does not consume cards: add an events input of it',
        ],
        [`await Promise.resolve(); on('quest.tick', () => {}); `, ''],
      ] as const) {
        const connector = new FakeConnector({ account: 'telegram:alice' });
        const core = new Core({
          clock: new DevKit({}).clock,
          graph: graph({ ...examineConfig(code), limits: { callMs: 50, memoryMb: 64 } }),
        });
        core.register(
          fakeConnectorPlugin('tg', connector),
          questParser(),
          questState,
          scriptPlugin({ isolation })
        );
        await core.start();
        expect(core.state('examine')).toEqual(
          why === ''
            ? { id: 'examine', state: 'running' }
            : { id: 'examine', state: 'failed', reason: why }
        );
        await core.stop();
      }
    });
  });

describe('a script node in a worker', () => {
  it('is killed when it holds its thread after an await, past its limit', async () => {
    const code = `on('quest.tick', async () => { await use('state').state.count({ name: 'x' }); for (;;) {} });`;
    const { kit, parser } = await run('worker', {
      ...examineConfig(code),
      limits: { callMs: 50, memoryMb: 64 },
    });
    parser.publish?.('quest.tick', {});
    let t = kit.clock.now();
    await until(() => {
      t += 50;
      kit.runUntil(t);
      return kit.core.state('examine')?.state === 'failed';
    });
    expect(kit.core.state('examine')?.reason).toBe(
      'its script hung: it held its thread past its limit of 50 ms'
    );
    await kit.stop();
  });

  it('costs nothing while idle: no ping, no poll, and its CPU is its own runs’ (D87)', async () => {
    // Every message its host posts to a worker, the watchdog's pings among them.
    const posts: { worker: Worker; op: string }[] = [];
    const real = Worker.prototype.postMessage;
    const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...a: Parameters<Worker['postMessage']>
    ) {
      posts.push({ worker: this, op: (a[0] as { op: string }).op });
      real.apply(this, a);
    });
    try {
      // A handler that spends a few ms of CPU, and a limit that pinged every 100 ms before D87.
      const code = `on('quest.tick', () => { let x = 0; for (let i = 0; i < 3e6; i++) x += i; log.info('ticked ' + (x > 0)); });`;
      const { kit, parser, lines } = await run('worker', {
        ...examineConfig(code),
        limits: { callMs: 50, memoryMb: 64 },
      });
      const own = () => kit.core.cost('examine')?.own;
      await until(() => own()?.cpuMs !== undefined);
      const loaded = own() as { cpuMs: number; heapBytes: number };
      // Its first run is short: a thread clock that counts in ticks (a CI runner's) may say 0.
      expect(loaded.cpuMs).toBeGreaterThanOrEqual(0);
      const worker = posts[0]?.worker;
      // Idle for eight of the old rounds: nothing posted to it, its cost unchanged.
      await new Promise((r) => setTimeout(r, 100));
      const before = posts.length;
      const thread0 = worker === undefined ? 0 : (await worker.cpuUsage()).user;
      await new Promise((r) => setTimeout(r, 800));
      expect(posts.slice(before).map((p) => p.op)).toEqual([]);
      expect(own()).toMatchObject(loaded);
      // Its thread, left alone, spends next to nothing (cpuUsage itself runs on it, once).
      if (worker !== undefined) expect((await worker.cpuUsage()).user - thread0).toBeLessThan(5000);
      // An event: watched while it runs, then idle again, its run's CPU added.
      parser.publish?.('quest.tick', {});
      await until(() => lines.some((l) => l.includes('ticked true')));
      await until(() => (own()?.cpuMs ?? 0) > loaded.cpuMs);
      expect(posts.slice(before).map((p) => p.op)[0]).toBe('event');
      await new Promise((r) => setTimeout(r, 100));
      const after = posts.length;
      await new Promise((r) => setTimeout(r, 400));
      expect(posts.length).toBe(after);
      expect(kit.core.state('examine')?.state).toBe('running');
      await kit.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('is not killed while its thread is stalled, not running, past its limit', async () => {
    // A host short of memory stalls the whole process, its threads waiting on the disk: a ping
    // then waits behind an idle script. A wait that burns no CPU stands in for that stall here.
    const code = `on('quest.tick', async () => { await null; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); log.info('woke'); });`;
    const { kit, parser, lines } = await run('worker', {
      ...examineConfig(code),
      limits: { callMs: 50, memoryMb: 64 },
    });
    parser.publish?.('quest.tick', {});
    await until(() => lines.some((l) => l.includes('woke')));
    // A few more of its watchdog's rounds, answered.
    await new Promise((r) => setTimeout(r, 300));
    expect(kit.core.state('examine')?.state).toBe('running');
    await kit.stop();
  });

  it('lets a handler’s run outlast its limit in real time while it spends no CPU (D85)', async () => {
    // A host stalled in the middle of a run: the run is slow by the clock, light on the CPU. A wait
    // that burns no CPU stands in for that stall here, in the handler's synchronous run itself.
    const code = `on('quest.tick', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); log.info('woke'); });`;
    const { kit, parser, lines } = await run('worker', {
      ...examineConfig(code),
      limits: { callMs: 50, memoryMb: 64 },
    });
    parser.publish?.('quest.tick', {});
    await until(() => lines.some((l) => l.includes('woke')));
    await new Promise((r) => setTimeout(r, 300));
    expect(kit.core.state('examine')?.state).toBe('running');
    await kit.stop();
  });

  it('is killed past its memory limit, its node failed with why', async () => {
    const code = `on('quest.tick', () => { const a = []; for (;;) a.push(new Array(100_000).fill(Math.random())); });`;
    const { kit, parser } = await run('worker', {
      ...examineConfig(code),
      limits: { callMs: 60_000, memoryMb: 16 },
    });
    parser.publish?.('quest.tick', {});
    await until(() => kit.core.state('examine')?.state === 'failed', 20_000);
    expect(kit.core.state('examine')?.reason).toBe(
      'its script ran out of memory (its limit is 16 MB)'
    );
    expect(kit.core.state('quest-state')?.state).toBe('running');
    await kit.stop();
  }, 30_000);
});

describe('the script runtime', () => {
  it('holds the API alone, and refuses misuse with why', async () => {
    const lines: string[] = [];
    const r = new ScriptRuntime({
      bridge: bridge(lines),
      limits: { callMs: 100 },
      documents: { a: 1 },
      publishes: [],
      id: 't',
    });
    await r.load(
      `
      const circular = {}; circular['self'] = circular;
      log('plain', 1, circular);
      store.remove('a');
      log.info(store.names().length, typeof process, typeof require, typeof setTimeout);
      try { eval('1'); } catch (e) { log.warn('no eval'); }
      try { publish('t.x', {}); } catch (e) { log.error(e.message); }
      try { on(1, 2); } catch (e) { log.error(e.message); }
      log.info(typeof use('p').state.then, Date.now(), clock.now());
      on('a.b', () => { throw 'plain'; });
      on('a.b', () => { on('c.d', () => {}); });
      `,
      't.ts'
    );
    expect(r.patterns()).toEqual(['a.b']);
    const ends: unknown[] = [];
    r.dispatch(
      'a.b',
      {},
      (e) => ends.push(e.error),
      () => 0
    );
    r.dispatch(
      'other',
      {},
      (e) => ends.push(e),
      () => 0
    );
    expect(ends).toEqual(['plain', 'on() registers handlers while the script loads only']);
    expect(lines).toEqual([
      'info plain 1 [object Object]',
      'remove a',
      'info 0 undefined undefined undefined',
      'warn no eval',
      'error publish("t.x"): it publishes no event type (declare its events)',
      'error on(type, fn): an event type or a namespace, and a function',
      'info undefined 42 42',
    ]);
    await expect(
      new ScriptRuntime({
        bridge: bridge([]),
        limits: { callMs: 100 },
        documents: {},
        publishes: [],
        id: 'u',
      }).load('let a; let a;', 'u.ts')
    ).rejects.toThrow("Identifier 'a' has already been declared");
  });
});

describe('a script’s timers (D106)', () => {
  const T0 = Date.parse('2026-11-12T10:00:00Z');
  /** Its timers' lines, those of a test's own words. */
  const timerLines = (lines: string[]) =>
    lines.filter((l) =>
      /^examine: (past|later|from a handler|minute|seven|warning: a timer)/u.test(l)
    );

  for (const isolation of ['in-process', 'worker'] as const)
    describe(isolation, () => {
      it('fires at() and every() on its node’s clock, as the dev kit’s leaps', async () => {
        const code = `
          const t0 = clock.now();
          every(60_000, () => log.info('minute', new Date().toISOString()));
          every(7_000, () => log.info('seven', clock.now() % 7_000));
          at(t0 - 1_000, () => log.info('past', clock.now() - t0));
          const later = at(new Date(t0 + 30_000), () => log.info('later'));
          at(t0 + 90_000, () => { throw new Error('boom'); });
          on('quest.tick', () => {
            at(clock.now() + 5_000, () => log.info('from a handler', clock.now() - t0));
            log.info('cancelled', later.cancel(), later.cancel());
          });
        `;
        const { kit, parser, lines } = await run(isolation, examineConfig(code));
        parser.publish?.('quest.tick', {});
        await until(() => lines.includes('examine: cancelled true false'));
        const end = T0 + 3 * 60_000 + 10_000;
        kit.runUntil(end);
        let sevens = 0;
        for (let t = Math.floor(T0 / 7_000 + 1) * 7_000; t <= end; t += 7_000) sevens++;
        await until(() => timerLines(lines).length === 6 + sevens);
        const own = timerLines(lines).filter((l) => !l.includes('seven'));
        expect(own).toEqual([
          'examine: past 0',
          'examine: from a handler 5000',
          'examine: minute 2026-11-12T10:01:00.000Z',
          'examine: warning: a timer threw: boom',
          'examine: minute 2026-11-12T10:02:00.000Z',
          'examine: minute 2026-11-12T10:03:00.000Z',
        ]);
        // Each beat of every(7 s) on a whole multiple of 7 s since the epoch.
        expect(new Set(timerLines(lines).filter((l) => l.includes('seven')))).toEqual(
          new Set(['examine: seven 0'])
        );
        await until(() => (kit.core.cost('examine')?.own?.errors ?? 0) === 1);
        expect(kit.core.state('examine')?.state).toBe('running');
        await kit.stop();
      });

      it('drops its timers when its node is stopped, by the owner or for good', async () => {
        const code = `every(60_000, () => log.info('minute', new Date().toISOString()));`;
        const { kit, lines } = await run(isolation, examineConfig(code));
        const pending = kit.clock.pending;
        kit.runUntil(T0 + 60_000);
        await until(() => timerLines(lines).length === 1);
        expect(kit.clock.pending).toBe(pending);
        expect(kit.core.stopNode('examine', 'held', 'owner')).toBe(true);
        expect(kit.clock.pending).toBe(pending - 1);
        kit.runUntil(T0 + 10 * 60_000);
        await new Promise((r) => setTimeout(r, 50));
        expect(timerLines(lines)).toEqual(['examine: minute 2026-11-12T10:01:00.000Z']);
        await kit.stop();
        // Started and stopped for good: its timers dropped with it.
        const again = await run(isolation, examineConfig(code));
        const armed = again.kit.clock.pending;
        await again.kit.stop();
        expect(again.kit.clock.pending).toBeLessThan(armed);
        again.kit.runUntil(T0 + 10 * 60_000);
        await new Promise((r) => setTimeout(r, 50));
        expect(timerLines(again.lines)).toEqual([]);
      });

      it('fails its node when a timer holds its thread past its limit', async () => {
        const code = `every(1_000, () => { for (;;) {} });`;
        const { kit } = await run(isolation, {
          ...examineConfig(code),
          limits: { callMs: 50, memoryMb: 64 },
        });
        kit.runUntil(T0 + 1_000);
        await until(() => kit.core.state('examine')?.state === 'failed');
        expect(kit.core.state('examine')?.reason).toBe(
          isolation === 'worker'
            ? 'its script hung: a timer of every(1000) spent over 50 ms of CPU'
            : 'its script hung: a timer of every(1000) took over 50 ms'
        );
        await kit.stop();
      });
    });

  it('runs a daily action once a day, caught up at start from its store', async () => {
    // The example of docs/bot-os-api.md §5, its send a log line here.
    const code = `
      const HOUR = 6; // 06:00 UTC
      const today = (): string => new Date().toISOString().slice(0, 10);
      function next(): Date {
        const d = new Date();
        d.setUTCHours(HOUR, 0, 0, 0);
        if (d.getTime() <= clock.now()) d.setUTCDate(d.getUTCDate() + 1);
        return d;
      }
      function daily(): void {
        if (new Date().getUTCHours() >= HOUR && store.read('daily') !== today()) {
          store.write('daily', today());
          log.info('later: daily', new Date().toISOString());
        }
        at(next(), daily);
      }
      daily();
    `;
    const { kit, lines } = await run('in-process', examineConfig(code));
    kit.runUntil(Date.parse('2026-11-14T12:00:00Z'));
    expect(timerLines(lines)).toEqual([
      'examine: later: daily 2026-11-12T10:00:00.000Z',
      'examine: later: daily 2026-11-13T06:00:00.000Z',
      'examine: later: daily 2026-11-14T06:00:00.000Z',
    ]);
    await kit.stop();
  });

  it('fires a time further off than a timer holds, once it is due', async () => {
    const code = `at(clock.now() + 40 * 86_400_000, () => log.info('later', new Date().toISOString()));`;
    const { kit, lines } = await run('in-process', examineConfig(code));
    kit.runUntil(T0 + 39 * 86_400_000);
    expect(timerLines(lines)).toEqual([]);
    kit.runUntil(T0 + 41 * 86_400_000);
    expect(timerLines(lines)).toEqual(['examine: later 2026-12-22T10:00:00.000Z']);
    await kit.stop();
  });

  it('refuses a bad time, a short interval and one timer too many, with why', async () => {
    const lines: string[] = [];
    const ends: unknown[] = [];
    const r = new ScriptRuntime({
      bridge: { ...bridge(lines), now: () => 61_500 },
      limits: { callMs: 100 },
      documents: {},
      publishes: [],
      id: 't',
    });
    await r.load(
      `
      for (const bad of [() => at('soon', () => {}), () => at(new Date(NaN), () => {}),
          () => at(1, 'fn'), () => every(999, () => {}), () => every('1s', () => {})])
        try { bad(); } catch (e) { log.error(e.message); }
      const a = at(new Date(70_000), () => log.info('a'));
      every(60_000, () => log.info('beat'));
      const all = [];
      try { for (;;) all.push(at(0, () => {})); } catch (e) { log.error(all.length, e.message); }
      log.info(all[0].cancel(), all[0].cancel());
      at(0, () => {});
      on('x.y', () => a.cancel());
      `,
      't.ts'
    );
    const fire = (id: number) =>
      r.fire(
        id,
        (e) => ends.push(e),
        () => 0
      );
    expect(lines.filter((l) => !l.startsWith('schedule') && !l.startsWith('unschedule'))).toEqual([
      'error at(time, fn): a time (ms since the epoch, or a Date), and a function',
      'error at(time, fn): a time (ms since the epoch, or a Date), and a function',
      'error at(time, fn): a time (ms since the epoch, or a Date), and a function',
      'error every(999, fn): its interval is 1000 ms at least',
      'error every(ms, fn): an interval in ms, and a function',
      `error ${MAX_TIMERS - 2} at(): it has ${MAX_TIMERS} timers pending, the most a script may (cancel one first)`,
      'info true false',
    ]);
    // at() as asked; every() at the next whole minute.
    expect(lines.filter((l) => l.startsWith('schedule')).slice(0, 2)).toEqual([
      'schedule 1 70000 undefined',
      'schedule 2 120000 60000',
    ]);
    expect(lines).toContain('unschedule 3');
    expect(r.pendingTimers()).toBe(MAX_TIMERS);
    lines.length = 0;
    fire(2);
    fire(2);
    fire(1);
    fire(1);
    fire(9_999);
    await Promise.resolve();
    expect(lines).toEqual(['info beat', 'info beat', 'info a']);
    expect(r.pendingTimers()).toBe(MAX_TIMERS - 1);
    // Cancelled once fired: nothing left to cancel.
    r.dispatch(
      'x.y',
      {},
      () => {},
      () => 0
    );
    expect(lines).not.toContain('unschedule 1');
    expect(ends).toEqual([
      { ms: 0, timer: true },
      { ms: 0, timer: true },
      { ms: 0, timer: true },
    ]);
  });
});

describe('a script node’s host', () => {
  it('says what an unbound optional input, an empty answer and a bad payload come to', async () => {
    for (const isolation of ['in-process', 'worker'] as const) {
      const code = `
        on('quest.tick', async () => {
          try { await use('maybe').state.count({ name: 'x' }); } catch (e) { log.error(String(e)); }
          log.info('got', await use('state').state.get({ path: 'nowhere' }));
          publish('examine.looked', { item: 1 } as never);
          store.remove('nothing');
          log.info('done');
        });`;
      const config = examineConfig(code);
      const { kit, parser, lines } = await run(isolation, {
        ...config,
        inputs: {
          ...config.inputs,
          state: { type: 'interface', plugin: 'quest-state', members: ['state.get'] },
          maybe: {
            type: 'interface',
            plugin: 'quest-state',
            members: ['state.count'],
            optional: true,
          },
        },
      });
      parser.publish?.('quest.tick', {});
      await until(() => lines.some((l) => l.endsWith('done') || l.includes('threw')));
      expect(lines).toEqual(
        expect.arrayContaining([
          'examine: error: Error: maybe is not bound, or not running',
          'examine: got undefined',
        ])
      );
      expect(lines.some((l) => /examine\.looked: item/u.test(l))).toBe(true);
      await kit.stop();
    }
  });
});
