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
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  codeProblem,
  SCRIPT_TEMPLATE,
  scriptConfig,
  scriptManifest,
  scriptPlugin,
} from '#src/script-plugin.ts';
import { ScriptRuntime } from '#src/script-runtime.ts';
import { statePlugin } from '#src/state-plugin.ts';

/** The made-up game's parser: what the test says, published. */
function questParser(): Plugin & { publish?: (type: string, payload: object) => void } {
  const p: Plugin & { publish?: (type: string, payload: object) => void } = definePlugin({
    manifest: {
      id: 'quest',
      version: '0.1.0',
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
    { id: 'tg', plugin: 'tg' },
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
          'examine: {"a":1}',
        ])
      );
      expect(kit.core.state('examine')?.state).toBe('running');
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
      expect(kit.core.state('examine')?.reason).toBe(
        'its script hung: a handler of quest.tick took over 50 ms'
      );
      expect(kit.core.state('quest-state')?.state).toBe('running');
      expect(lines.some((l) => l.startsWith('examine: error: failed: its script hung'))).toBe(true);
      await kit.stop();
    });

    it('fails its node at start when its script throws, or hears what no input brings', async () => {
      for (const [code, why] of [
        ['throw new Error("broken");', 'its script failed: broken'],
        ['for (;;) {}', 'its script hung: its first run took over 50 ms'],
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
  const bridge = (lines: string[]) => ({
    use: () => Promise.resolve(undefined),
    enqueue: () => {},
    cancel: () => Promise.resolve(false),
    publish: () => {},
    write: () => {},
    remove: (n: string) => void lines.push(`remove ${n}`),
    log: (level: string, line: string) => void lines.push(`${level} ${line}`),
    now: () => 42,
  });

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
