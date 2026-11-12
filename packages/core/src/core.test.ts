import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusEvent } from './bus.ts';
import { VirtualClock } from './clock.ts';
import { Core, type CoreRecord, StartError } from './core.ts';
import { FakeConnector } from './devkit.ts';
import { definePlugin, type Instance, type Plugin } from './plugin.ts';
import { type MigrationStore } from './store.ts';

/** A test plugin that writes its hooks to `seen`. */
function plugin(
  id: string,
  seen: string[],
  more: { requires?: string[]; instance?: Partial<Instance>; create?: () => never } = {}
): Plugin {
  return definePlugin({
    manifest: {
      id,
      version: '0.1.0',
      kinds: ['stats'],
      description: `test plugin ${id}`,
      requires: more.requires ?? [],
    },
    create: (ctx) => {
      if (more.create !== undefined) more.create();
      seen.push(
        `create ${id}${ctx.restored === undefined ? '' : ` ${JSON.stringify(ctx.restored)}`}`
      );
      return {
        start: () => {
          seen.push(`start ${id}`);
        },
        stop: () => {
          seen.push(`stop ${id}`);
        },
        ...more.instance,
      };
    },
  });
}

function core(extra: Partial<ConstructorParameters<typeof Core>[0]> = {}) {
  const records: (CoreRecord | BusEvent)[] = [];
  const lines: string[] = [];
  const told: string[] = [];
  const c = new Core({
    clock: new VirtualClock(1000),
    record: (r) => records.push(r),
    print: (l) => lines.push(l),
    notify: (t) => told.push(t),
    ...extra,
  });
  return { core: c, records, lines, told };
}

describe('Core', () => {
  it('starts the plugins in the order of their requirements, and stops them in reverse', async () => {
    const seen: string[] = [];
    const { core: c } = core();
    c.register(
      plugin('c', seen, { requires: ['b'] }),
      plugin('a', seen),
      plugin('b', seen, { requires: ['a'] })
    );
    await c.start();
    expect(seen).toEqual(['create a', 'start a', 'create b', 'start b', 'create c', 'start c']);
    expect(c.status().map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(c.status().every((s) => s.state === 'running')).toBe(true);
    seen.length = 0;
    await c.stop();
    expect(seen).toEqual(['stop c', 'stop b', 'stop a']);
    expect(c.state('a')).toEqual({ id: 'a', state: 'stopped' });
    expect(c.state('nobody')).toBeUndefined();
    expect(c.nodes().map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('fails the start for an error of the deployment, naming each, before any plugin runs', async () => {
    const seen: string[] = [];
    const { core: c } = core();
    c.register(plugin('a', seen, { requires: ['missing'] }), plugin('a', seen), {
      manifest: { id: 'Bad' } as never,
      create: () => ({}),
    });
    await expect(c.start()).rejects.toThrow(StartError);
    await expect(c.start()).rejects.toThrow('started once');
    expect(seen).toEqual([]);

    const other = core().core;
    other.register(plugin('a', seen), plugin('a', seen, { requires: ['missing'] }));
    await expect(other.start()).rejects.toThrow('plugin a: registered twice');

    const third = core().core;
    third.register(plugin('a', seen, { requires: ['nope'] }), {
      manifest: { id: 'Bad' } as never,
      create: () => ({}),
    });
    await expect(third.start()).rejects.toThrow(
      /plugin Bad: bad manifest: id: .*\nnode a: input port nope \(interface of nope\) is not bound: nope is not in the graph/su
    );
  });

  it('names a cycle by its path', async () => {
    const seen: string[] = [];
    const { core: c } = core();
    c.register(
      plugin('a', seen, { requires: ['b'] }),
      plugin('b', seen, { requires: ['c'] }),
      plugin('c', seen, { requires: ['a'] })
    );
    await expect(c.start()).rejects.toThrow('a cycle of required edges: a → b → c → a');
  });

  it('fails a plugin that fails to start, and those that require it, and starts the rest', async () => {
    const seen: string[] = [];
    const { core: c, told, records, lines } = core();
    c.register(
      plugin('a', seen, {
        create: () => {
          throw new Error('no connection');
        },
      }),
      plugin('b', seen, { requires: ['a'] }),
      plugin('c', seen, {
        instance: {
          start: () => Promise.reject(new Error('bad start')),
        },
      }),
      plugin('d', seen)
    );
    await c.start();
    expect(c.status()).toEqual([
      { id: 'a', state: 'failed', reason: 'no connection' },
      { id: 'b', state: 'failed', reason: 'requires a, which failed' },
      { id: 'c', state: 'failed', reason: 'bad start' },
      { id: 'd', state: 'running' },
    ]);
    expect(told).toEqual([
      'Plugin a failed: no connection',
      'Plugin b failed: requires a, which failed',
      'Plugin c failed: bad start',
    ]);
    expect(lines).toContain('a: error: failed: no connection');
    expect(records).toContainEqual({
      type: 'core.plugin',
      t: 1000,
      plugin: 'a',
      state: 'failed',
      reason: 'no connection',
    });
    seen.length = 0;
    await c.stop();
    expect(seen).toEqual(['stop d']);
  });

  it('keeps what a plugin serialises at stop in its store, and hands it back once', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
    const seen: string[] = [];
    let n = 0;
    const make = (): Plugin => plugin('a', seen, { instance: { serialise: () => ({ n: ++n }) } });
    for (let run = 0; run < 2; run++) {
      const c = core({ dataDir }).core;
      c.register(make());
      await c.start();
      if (run === 0) await c.stop();
    }
    expect(seen.filter((s) => s.startsWith('create'))).toEqual(['create a', 'create a {"n":1}']);
    // Not stopped the second time: a third start has nothing to restore.
    const third = core({ dataDir }).core;
    third.register(make());
    await third.start();
    expect(seen.at(-2)).toBe('create a');
    fs.rmSync(dataDir, { recursive: true });
  });

  it('migrates a store before create, and fails only the plugin whose migration fails', async () => {
    const seen: string[] = [];
    const { core: c } = core();
    const migrated = definePlugin({
      manifest: {
        id: 'migrated',
        version: '0.2.0',
        kinds: ['stats'],
        description: 'migrated',
        state: { migrations: [(s: MigrationStore) => s.write('doc', { v: 1 })] },
      },
      create: (ctx) => {
        seen.push(`doc ${JSON.stringify(ctx.store.read('doc'))}`);
        return {};
      },
    });
    const broken = definePlugin({
      manifest: {
        id: 'broken',
        version: '0.2.0',
        kinds: ['stats'],
        description: 'broken',
        state: {
          migrations: [
            () => {
              throw new Error('bad data');
            },
          ],
        },
      },
      create: () => ({}),
    });
    c.register(migrated, broken, plugin('after', seen, { requires: ['broken'] }));
    await c.start();
    expect(seen).toEqual(['doc {"v":1}']);
    expect(c.state('broken')).toEqual({
      id: 'broken',
      state: 'failed',
      reason: 'migration 0 → 1 failed: bad data',
    });
    expect(c.state('after')?.state).toBe('failed');
  });

  it('logs a stop that fails or takes too long, and stops the rest', async () => {
    const clock = new VirtualClock();
    const seen: string[] = [];
    const { core: c, lines } = core({ clock, stopTimeoutMs: 100 });
    c.register(
      plugin('a', seen),
      plugin('b', seen, {
        instance: {
          stop: () => {
            throw new Error('stuck');
          },
        },
      }),
      plugin('c', seen, {
        instance: {
          stop: () => {
            const done = new Promise<void>(() => {});
            clock.advance(100);
            return done;
          },
        },
      })
    );
    await c.start();
    await c.stop();
    expect(lines).toEqual([
      'c: error: stop failed: c took over 100 ms',
      'b: error: stop failed: stuck',
    ]);
    expect(seen).toContain('stop a');
    expect(c.status().every((s) => s.state === 'stopped')).toBe(true);
  });

  it('stops a running plugin, telling its hooks, kept until the stop is cleared', async () => {
    const seen: string[] = [];
    const { core: c } = core();
    c.register(
      plugin('a', seen, {
        instance: {
          pause: (why) => seen.push(`pause ${why}`),
          resume: () => seen.push('resume'),
        },
      }),
      plugin('b', seen)
    );
    await c.start();
    expect(c.stopNode('a', 'drift', 'drift')).toBe(true);
    expect(c.state('a')).toEqual({
      id: 'a',
      state: 'stopped',
      reason: 'drift',
      stop: { reason: 'drift', time: expect.any(String), source: 'drift' },
    });
    // Stopped again: the latest stop is kept, its hooks not told twice.
    expect(c.stopNode('a', 'again', 'owner')).toBe(true);
    expect(c.state('a')?.stop).toMatchObject({ reason: 'again', source: 'owner' });
    expect(c.stopNode('b', 'owner', 'owner')).toBe(true);
    expect(c.stopNode('nobody', 'x', 'owner')).toBe(false);
    expect(seen.filter((x) => x.startsWith('pause'))).toEqual(['pause drift']);
    expect(seen).not.toContain('resume');
    expect(c.clearStop('a')).toBe(true);
    expect(c.clearStop('a')).toBe(false);
    await c.stop();
    expect(c.state('a')?.state).toBe('stopped');
    expect(seen).toContain('stop a');
  });

  it('takes no plugin once started, and needs no options beyond the clock', async () => {
    const c = new Core({ clock: new VirtualClock() });
    c.register(
      definePlugin({
        manifest: { id: 'quiet', version: '1.0.0', kinds: ['actor'], description: 'quiet' },
        create: (ctx) => {
          ctx.log.info('hello');
          ctx.log.warn('careful');
          ctx.notify('nobody hears');
          return {};
        },
      })
    );
    await c.start();
    expect(() => c.register(plugin('late', []))).toThrow('before the core starts');
    await c.stop();
    expect(c.state('quiet')?.state).toBe('stopped');
  });

  it('hands a plugin the members it uses of another’s interface, and only those', async () => {
    const offered = definePlugin({
      manifest: {
        id: 'game',
        version: '0.1.0',
        kinds: ['parser'],
        description: 'offers',
        interface: {
          state: {
            score: { help: 'the score', output: z.number() },
            secret: { help: 'not used', output: z.number() },
          },
          actions: { add: { help: 'adds', input: z.number() } },
        },
      },
      create: () => {
        let score = 1;
        return {
          interface: {
            state: { score: () => score, secret: () => 42 },
            actions: { add: (n: number) => (score += n) },
          },
        };
      },
    });
    let got:
      | { state: { score: () => number; secret?: unknown }; actions: { add(n: number): void } }
      | undefined;
    const errors: string[] = [];
    const user = definePlugin({
      manifest: {
        id: 'player',
        version: '0.1.0',
        kinds: ['actor'],
        description: 'uses',
        requires: ['game', 'other'],
        uses: { game: ['state.score', 'actions.add'] },
      },
      create: (ctx) => {
        got = ctx.use('game');
        for (const id of ['other', 'nobody'])
          try {
            ctx.use(id);
          } catch (e) {
            errors.push((e as Error).message);
          }
        return {};
      },
    });
    const { core: c } = core();
    c.register(offered, plugin('other', []), user);
    await c.start();
    got?.actions.add(2);
    expect(got?.state.score()).toBe(3);
    expect(got?.state.secret).toBeUndefined();
    // A plugin only required is used with none of its members; one not bound, not at all.
    expect(errors).toEqual(['player does not use nobody: add an interface input of it']);
  });

  it('lists the running plugins’ chat commands for the surface, answered while they run', async () => {
    const answered: string[] = [];
    const commander = (id: string, offers: NonNullable<Instance['commands']>) =>
      definePlugin({
        manifest: {
          id,
          version: '0.1.0',
          kinds: ['stats'],
          description: 'answers',
          interface: {
            commands: {
              [`${id}Map`]: { help: 'the map', menu: 'la mappa', aliases: [`${id}_mappa`] },
              [`${id}Stats`]: { help: 'the stats', args: '[hours]' },
            },
          },
        },
        create: () => ({ commands: offers }),
      });
    const handler = (what: string) => ({
      run: (_answer: unknown, request: { args: string }) => {
        answered.push(`${what} ${request.args}`);
        return Promise.resolve();
      },
    });
    const { core: c } = core();
    c.register(
      commander('a', {
        aMap: handler('map'),
        aStats: { ...handler('stats'), allow: (asker) => asker.owner === true },
      }),
      commander('b', {})
    );
    await c.start();
    expect(c.state('b')).toEqual({
      id: 'b',
      state: 'failed',
      reason: 'it declares the command bMap, and offers no handler for it',
    });
    const commands = c.commands().filter((x) => x.plugin !== 'core');
    const plain = { owner: false, hidden: false };
    expect(commands.map(({ run: _r, allow: _a, ...rest }) => rest)).toEqual([
      {
        plugin: 'a',
        name: 'aMap',
        help: 'the map',
        aliases: ['a_mappa'],
        menu: 'la mappa',
        ...plain,
      },
      { plugin: 'a', name: 'aStats', help: 'the stats', args: '[hours]', aliases: [], ...plain },
    ]);
    const answer = { text: () => Promise.resolve(), photo: () => Promise.resolve(undefined) };
    await commands[0]?.run(answer, { args: 'x' });
    expect(commands[0]?.allow).toBeUndefined();
    expect(commands[1]?.allow?.({ id: '1', owner: true })).toBe(true);
    expect(commands[1]?.allow?.({ id: '2' })).toBe(false);
    await c.stop();
    await commands[0]?.run(answer, { args: 'y' });
    expect(commands[1]?.allow?.({ id: '1', owner: true })).toBe(false);
    expect(answered).toEqual(['map x']);
    // The core's own stay, the owner's.
    expect(c.commands().map((x) => x.plugin)).toEqual(Array(6).fill('core'));
  });

  it('fails the load for a command name taken twice', async () => {
    const commander = (id: string, name: string, aliases: string[] = []) =>
      definePlugin({
        manifest: {
          id,
          version: '0.1.0',
          kinds: ['stats'],
          description: 'answers',
          interface: { commands: { [name]: { help: 'h', aliases } } },
        },
        create: () => ({ commands: { [name]: { run: () => Promise.resolve() } } }),
      });
    const { core: c } = core();
    c.register(commander('a', 'map', ['stats']), commander('b', 'stats'));
    await expect(c.start()).rejects.toThrow(
      "plugin b: the command stats of its stats is a's map already"
    );
    const { core: d } = core();
    d.register(commander('a', 'kill'));
    await expect(d.start()).rejects.toThrow(
      "plugin a: the command kill of its kill is the core's kill already"
    );
  });

  it('fails the load for a use not declared, and a plugin for a member not offered', async () => {
    const provider = (offers: object) =>
      definePlugin({
        manifest: {
          id: 'game',
          version: '0.1.0',
          kinds: ['parser'],
          description: 'offers',
          interface: { state: { score: { help: 'the score', output: z.number() } } },
        },
        create: () => offers,
      });
    const consumer = (requires: string[], uses: Record<string, string[]>) =>
      definePlugin({
        manifest: {
          id: 'player',
          version: '0.1.0',
          kinds: ['actor'],
          description: 'uses',
          requires,
          uses,
        },
        create: (ctx) => {
          ctx.use('game');
          return {};
        },
      });
    const bad = core();
    bad.core.register(
      provider({}),
      consumer([], { game: ['state.score', 'state.nothing', 'score'], nobody: ['state.x'] })
    );
    await expect(bad.core.start()).rejects.toThrow(
      [
        'node player: input port game: game does not declare state.nothing, score (edge game.interface → player.game)',
        'node player: input port nobody (interface of nobody) is not bound: nobody is not in the graph',
      ].join('\n')
    );
    const missing = core();
    missing.core.register(provider({}), consumer(['game'], { game: ['state.score'] }));
    await missing.core.start();
    expect(missing.core.state('player')).toEqual({
      id: 'player',
      state: 'failed',
      reason: 'game does not offer state.score',
    });
    const down = core();
    down.core.register(
      definePlugin({
        manifest: {
          id: 'game',
          version: '0.1.0',
          kinds: ['parser'],
          description: 'offers',
          interface: { state: { score: { help: 'the score', output: z.number() } } },
        },
        create: () => ({ interface: { state: { score: () => 1 } } }),
      }),
      consumer(['game'], { game: ['state.score'] })
    );
    await down.core.start();
    expect(down.core.state('player')?.state).toBe('running');
    down.core.stopNode('game', 'owner', 'owner');
    await down.core.stop();
  });

  it('keeps and puts in force the settings of a plugin that serves its own', async () => {
    const values: Record<string, number | boolean | string | string[]> = { level: 1 };
    let handle: import('./plugin.ts').PluginSettingsHandle | undefined;
    const p = definePlugin({
      manifest: {
        id: 'tuned',
        version: '0.1.0',
        kinds: ['actor'],
        description: 'tuned',
        settings: z.object({ level: z.coerce.number().int().min(0).describe('the level') }),
      },
      create: (ctx) => {
        handle = ctx.settings;
        return {
          settings: {
            apply: (key, value) => (values[key] = value),
            read: (key) => values[key],
          },
        };
      },
    });
    const { core: c } = core();
    c.register(p);
    await c.start();
    expect(handle?.kept()).toEqual({});
    expect(handle?.set('level', '3')).toBeUndefined();
    expect(handle?.set('level', '-1')).toBeDefined();
    expect(values['level']).toBe(3);
    expect(handle?.kept()).toEqual({ level: 3 });
    expect(c.settings.current()).toEqual({ level: 3 });
    values['level'] = 1;
    c.settings.putInForce();
    expect(values['level']).toBe(3);
    expect(c.settings.set('level', 4)).toBeUndefined();
    expect(values['level']).toBe(4);
  });

  it('tells each plugin, in load order, once every plugin has started', async () => {
    const seen: string[] = [];
    const { core: c, told } = core();
    c.register(
      plugin('b', seen, { requires: ['a'], instance: { ready: () => void seen.push('ready b') } }),
      plugin('a', seen, { instance: { ready: () => void seen.push('ready a') } }),
      plugin('c', seen)
    );
    await c.start();
    expect(seen).toEqual([
      'create a',
      'start a',
      'create b',
      'start b',
      'create c',
      'start c',
      'ready a',
      'ready b',
    ]);
    expect(told).toEqual([]);
  });

  it('fails a plugin whose ready throws, stopping it and those that require it', async () => {
    const seen: string[] = [];
    const { core: c, told } = core();
    c.register(
      plugin('a', seen, {
        instance: {
          ready: () => {
            throw new Error('no history');
          },
        },
      }),
      plugin('b', seen, { requires: ['a'], instance: { ready: () => void seen.push('ready b') } }),
      plugin('c', seen, { requires: ['b'] }),
      plugin('d', seen)
    );
    await c.start();
    expect(c.status()).toEqual([
      { id: 'a', state: 'failed', reason: 'no history' },
      { id: 'b', state: 'failed', reason: 'requires a, which failed' },
      { id: 'c', state: 'failed', reason: 'requires b, which failed' },
      { id: 'd', state: 'running' },
    ]);
    expect(seen.filter((x) => x.startsWith('stop') || x.startsWith('ready'))).toEqual([
      'stop a',
      'stop b',
      'stop c',
    ]);
    expect(told).toEqual([
      'Plugin a failed: no history',
      'Plugin b failed: requires a, which failed',
      'Plugin c failed: requires b, which failed',
    ]);
  });
});

describe('archived plugins (bot-os.md D32)', () => {
  const archive = (id: string, seen: string[]): Plugin =>
    definePlugin({
      manifest: {
        id,
        version: '0.1.0',
        kinds: ['actor'],
        description: `an archived plugin ${id}`,
        archived: true,
      },
      create: () => {
        seen.push(`create ${id}`);
        return {};
      },
    });

  it('refuses one in the default graph: no plugin starts, and the error names it', async () => {
    const seen: string[] = [];
    const { core: c } = core();
    c.register(plugin('a', seen), archive('old', seen));
    await expect(c.start()).rejects.toThrow(
      'plugin old: old is archived (bot-os.md D32): it runs in no instance'
    );
    expect(seen).toEqual([]);
  });

  it('refuses one in an explicit graph, under any node id, and with allowArchived false', () => {
    const seen: string[] = [];
    const { core: c } = core({
      allowArchived: false,
      graph: { version: 2, nodes: [{ id: 'renamed', plugin: 'old' }], edges: [] },
    });
    c.register(archive('old', seen));
    expect(() => c.load()).toThrow('plugin renamed: old is archived');
  });

  it('runs one only in a run that allows archives, as a test or a tool does', async () => {
    const seen: string[] = [];
    const { core: c } = core({ allowArchived: true });
    c.register(plugin('a', seen), archive('old', seen));
    await c.start();
    expect(seen).toContain('create old');
    expect(c.status().find((s) => s.id === 'old')?.state).toBe('running');
  });

  it('is false unless the manifest says so', () => {
    const { core: c } = core();
    c.register(plugin('a', []));
    expect(() => c.load()).not.toThrow();
  });
});

describe('the owner’s notices (bot-os-api.md §4.8)', () => {
  /** A connector whose instance offers a chat surface, as a `telegram-bot` with its `owner` does. */
  const surfaced = (id: string, told: string[]) =>
    definePlugin({
      manifest: {
        id,
        version: '0.1.0',
        kinds: ['connector'],
        description: 'a surface',
        account: `x:${id}`,
      },
      create: () => ({
        connector: new FakeConnector({ account: `x:${id}` }),
        surface: { serve: () => {}, tell: (t: string) => told.push(`${id}: ${t}`) },
      }),
    });
  /** A plugin that tells the owner as it is made. */
  const teller = definePlugin({
    manifest: { id: 'teller', version: '0.1.0', kinds: ['stats'], description: 'tells' },
    create: (ctx) => {
      ctx.notify('made');
      return {};
    },
  });

  it('go to the first node of the graph that offers a chat surface, waiting for it', async () => {
    const told: string[] = [];
    const lines: string[] = [];
    const core = new Core({
      clock: new VirtualClock(0),
      print: (l) => lines.push(l),
      graph: {
        version: 2,
        nodes: [
          { id: 'teller', plugin: 'teller' },
          { id: 'a', plugin: 'a' },
          { id: 'b', plugin: 'b' },
        ],
        edges: [],
      },
    });
    core.register(teller, surfaced('a', told), surfaced('b', told));
    await core.start();
    core.notify('later');
    expect(told).toEqual(['a: made', 'a: later']);
    expect(lines.filter((l) => l.includes('not told'))).toEqual([]);
    await core.stop();
  });

  it('are printed when no node offers one and the wiring gives no other way', async () => {
    const lines: string[] = [];
    const core = new Core({ clock: new VirtualClock(0), print: (l) => lines.push(l) });
    core.register(teller);
    await core.start();
    core.notify('after');
    expect(lines.filter((l) => l.includes('not told'))).toEqual([
      "core: not told (no node offers the owner's chat): made",
      "core: not told (no node offers the owner's chat): after",
    ]);
    await core.stop();
  });
});
