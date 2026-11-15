/**
 * Chat commands served through the graph (bot-os.md D109): a plugin's derived commands input, a
 * connector's commands output, the check of the edge between them, what the core serves each chat
 * surface (where, to whom, and its answers held as sends are), and the first start's migration of a
 * graph saved before commands needed an edge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { type Answer, type Asker, type ChatCommand } from './commands.ts';
import { COMMANDS_DOC, Core, STATES_DOC } from './core.ts';
import { FakeConnector } from './devkit.ts';
import { commandEdges, type GraphInput, resolveGraph } from './graph.ts';
import { GraphFile } from './graph-file.ts';
import { type Manifest, parseManifest } from './manifest.ts';
import { definePlugin, type Plugin } from './plugin.ts';

/** A record of the event log, as a test reads it. */
type CoreRecord = { type: string } & Record<string, unknown>;

const OWNER = '4242';
const GROUP = '-100123';

/** A chat surface's connector, as a `telegram-bot` with its owner is: what it is served, kept. */
function bot(id = 'bot', served: ChatCommand[][] = []): Plugin {
  return definePlugin({
    manifest: {
      id,
      version: '0.1.0',
      kinds: ['connector'],
      description: 'a bot',
      account: `chat:${id}`,
      config: z.object({ owner: z.number().optional(), group: z.number().optional() }),
      outputs: {
        commands: {
          type: 'commands',
          servedBefore: { when: 'owner', chats: ['owner', 'group'], privateChats: true },
        },
      },
    },
    create: () => ({
      connector: new FakeConnector({ account: `chat:${id}`, owner: OWNER }),
      surface: { serve: (c) => void served.push([...c]) },
    }),
  });
}

/** A plugin of two commands: `/map` for anyone, `/ban` for alice alone. */
const mapper = definePlugin({
  manifest: {
    id: 'mapper',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'draws the map',
    interface: {
      commands: { map: { help: 'the map', menu: 'la mappa' }, ban: { help: 'ban someone' } },
    },
  },
  create: () => ({
    commands: {
      map: {
        run: async (a) => {
          await a.text('here');
          await a.photo({ data: new Uint8Array([1]), filename: 'map.png' });
        },
      },
      ban: { run: (a) => a.text('banned'), allow: (who) => who.username === 'alice' },
    },
  }),
});

const manifests = (...plugins: Plugin[]): Map<string, Manifest> =>
  new Map(plugins.map((p) => [p.manifest.id as string, parseManifest(p.manifest)]));

const nodes = [
  { id: 'bot', plugin: 'bot', config: { owner: Number(OWNER), group: Number(GROUP) } },
  { id: 'mapper', plugin: 'mapper' },
];

describe('the commands ports (D109)', () => {
  it('derives a plugin’s commands input, and a connector’s output of its network', () => {
    const m = parseManifest(mapper.manifest);
    expect(m.inputs['commands']).toEqual({
      type: 'commands',
      commands: ['map', 'ban'],
      optional: true,
      help: 'Its chat commands: the connectors that answer them, where, and to whom',
    });
    expect(parseManifest(bot().manifest).outputs['commands']).toMatchObject({
      type: 'commands',
      network: 'chat',
    });
    // None without commands; the name is the derived port's.
    expect(parseManifest({ ...mapper.manifest, interface: {} }).inputs).toEqual({});
    expect(() =>
      parseManifest({
        ...mapper.manifest,
        inputs: { commands: { type: 'interface', plugin: 'x' } },
      })
    ).toThrow('the input commands is derived from its commands (D109)');
    expect(() =>
      parseManifest({ ...mapper.manifest, outputs: { commands: { type: 'commands' } } })
    ).toThrow('only a connector serves commands (D109)');
  });

  it('checks the edge: its ends, the commands it serves, and what only it carries', () => {
    const check = (edges: GraphInput['edges']) => {
      try {
        return resolveGraph({ version: 2, nodes, edges }, manifests(bot(), mapper));
      } catch (e) {
        return (e as { problems: string[] }).problems;
      }
    };
    const ok = check([{ from: 'bot', to: 'mapper.commands', chats: [GROUP], senders: ['owner'] }]);
    expect(Array.isArray(ok) ? ok : ok.graph.edges).toEqual([
      {
        from: 'bot.commands',
        to: 'mapper.commands',
        type: 'commands',
        chats: [GROUP],
        senders: ['owner'],
      },
    ]);
    expect(check([{ from: 'bot.chat', to: 'mapper.commands' }])).toEqual([
      'node mapper: input port commands: chat-in of chat cannot bind commands (edge bot.chat → mapper.commands)',
    ]);
    expect(
      check([
        { from: 'bot.commands', to: 'mapper.commands', serves: ['map', 'nuke'], chats: [GROUP] },
      ])
    ).toEqual([
      'node mapper: input port commands has no command nuke (edge bot.commands → mapper.commands)',
    ]);
    expect(
      check([
        { from: 'bot.commands', to: 'mapper.commands', chats: [GROUP] },
        { from: 'bot.commands', to: 'mapper.commands', chats: [OWNER] },
      ])
    ).toEqual(['edge bot.commands → mapper.commands: twice in the graph']);
    expect(check([{ from: 'bot.commands', to: 'mapper.commands', sends: [GROUP] }])).toEqual([
      'edge bot.commands → mapper.commands: only a chat-out edge carries sends, commands and minIntervalS',
    ]);
    expect(check([{ from: 'bot.commands', to: 'mapper.commands', reads: '*' }])).toEqual([
      'edge bot.commands → mapper.commands: only a chat-in edge carries reads',
    ]);
    // An edge that names no chat answers nowhere: warned of.
    const none = check([{ from: 'bot.commands', to: 'mapper.commands' }]);
    expect(Array.isArray(none) ? none : none.warnings).toEqual([
      'node mapper: input port commands is served in no chat: its edge names none (edge bot.commands → mapper.commands)',
    ]);
  });

  it('refuses the commands edge’s fields on another edge', () => {
    const chat = definePlugin({
      manifest: {
        id: 'reader',
        version: '0.1.0',
        kinds: ['parser'],
        description: 'reads',
        inputs: { chat: { type: 'chat-in' } },
      },
      create: () => ({}),
    });
    expect(() =>
      resolveGraph(
        {
          version: 2,
          nodes: [...nodes, { id: 'reader', plugin: 'reader' }],
          edges: [{ from: 'bot.chat', to: 'reader.chat', reads: '*', privateChats: true }],
        },
        manifests(bot(), mapper, chat)
      )
    ).toThrow('only a commands edge carries serves, chats and privateChats');
  });
});

describe('what the core serves a chat surface (D109)', () => {
  const answered: string[] = [];
  const answer: Answer = {
    text: (t) => (answered.push(t), Promise.resolve()),
    photo: () => (answered.push('photo'), Promise.resolve('file-1')),
  };
  const asker = (more: Partial<Asker> = {}): Asker => ({ id: '7', username: 'bob', ...more });

  async function start(edges: GraphInput['edges'], more: GraphInput['nodes'] = []) {
    answered.length = 0;
    const records: CoreRecord[] = [];
    const served: ChatCommand[][] = [];
    const core = new Core({
      clock: new VirtualClock(Date.UTC(2026, 10, 15)),
      record: (r) => void records.push(r as CoreRecord),
      graph: { version: 2, nodes: [...nodes, ...more], edges },
    });
    core.register(bot('bot', served), mapper, bot('other'));
    await core.start();
    return { core, records, served: served[0] ?? [] };
  }

  it('serves no plugin command without an edge; the owner’s controls always', async () => {
    const { served, core } = await start([]);
    expect(served.map((c) => `${c.plugin} ${c.name}`)).toEqual([
      'core plugins',
      'core kill',
      'core settings',
      'core set',
      'core off',
      'core on',
    ]);
    expect(served.every((c) => c.where === undefined)).toBe(true);
    // The admin side still lists every plugin's.
    expect(core.commands().filter((c) => c.plugin === 'mapper')).toHaveLength(2);
    await core.stop();
  });

  it('serves those of its edges, where and to whom they say, the plugin’s check on top', async () => {
    const { served, core, records } = await start(
      [
        {
          from: 'bot.commands',
          to: 'mapper.commands',
          serves: ['map', 'ban'],
          chats: [GROUP],
          senders: ['owner', '@Bob', '8'],
        },
        // Another bot's edge: not this surface's.
        { from: 'other.commands', to: 'mapper.commands', chats: ['#x'], privateChats: true },
      ],
      [{ id: 'other', plugin: 'other' }]
    );
    const map = served.find((c) => c.name === 'map') as ChatCommand;
    const ban = served.find((c) => c.name === 'ban') as ChatCommand;
    expect(map.where).toEqual({ chats: [GROUP], privateChats: false });
    expect(map.allow?.(asker())).toBe(true);
    expect(map.allow?.(asker({ username: 'carol', id: '8' }))).toBe(true);
    expect(map.allow?.(asker({ username: 'carol', owner: true }))).toBe(true);
    expect(map.allow?.(asker({ username: 'carol' }))).toBe(false);
    // Bob may ask, but the plugin answers /ban to alice alone.
    expect(ban.allow?.(asker())).toBe(false);
    await map.run(answer, { args: '', chat: GROUP });
    expect(answered).toEqual(['here', 'photo']);
    expect(
      records
        .filter((r) => r.type === 'core.send')
        .map((r) => `${String(r['origin'])} ${String(r['chat'])} ${String(r['outcome'])}`)
    ).toEqual([`command /map ${GROUP} sent`, `command /map ${GROUP} sent`]);
    await core.stop();
  });

  it('logs a dry run’s answers and sends none, and records a failed one', async () => {
    const { served, core, records } = await start([
      {
        from: 'bot.commands',
        to: 'mapper.commands',
        serves: ['map'],
        privateChats: true,
        dryRun: true,
      },
    ]);
    const map = served.find((c) => c.name === 'map') as ChatCommand;
    expect(map.allow).toBeUndefined();
    expect(served.some((c) => c.name === 'ban')).toBe(false);
    await map.run(answer, { args: '' });
    expect(answered).toEqual([]);
    expect(
      records
        .filter((r) => r.type === 'core.send')
        .map((r) => `${String(r['text'])} ${String(r['mode'])} ${String(r['outcome'])}`)
    ).toEqual(['here dry-run dry-run', '[photo map.png] dry-run dry-run']);
    await core.stop();
    const live = await start([{ from: 'bot.commands', to: 'mapper.commands', chats: [OWNER] }]);
    const broken: Answer = {
      text: () => Promise.reject(new Error('blocked')),
      photo: answer.photo,
    };
    await expect(
      (live.served.find((c) => c.name === 'map') as ChatCommand).run(broken, { args: '' })
    ).rejects.toThrow('blocked');
    expect(live.records.filter((r) => r.type === 'core.send').at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'blocked',
      chat: '',
    });
    await live.core.stop();
  });

  it('serves nothing of a node down', async () => {
    const { served, core } = await start(
      [{ from: 'bot.commands', to: 'mapper.commands', chats: [GROUP] }],
      []
    );
    expect(served.some((c) => c.plugin === 'mapper')).toBe(true);
    await core.stop();
    const records: CoreRecord[] = [];
    const surfaced: ChatCommand[][] = [];
    const down = new Core({
      clock: new VirtualClock(),
      record: (r) => void records.push(r as CoreRecord),
      graph: {
        version: 2,
        nodes: [
          nodes[0] as GraphInput['nodes'][number],
          { id: 'mapper', plugin: 'mapper', disabled: true },
        ],
        edges: [{ from: 'bot.commands', to: 'mapper.commands', chats: [GROUP] }],
      },
    });
    down.register(bot('bot', surfaced), mapper);
    await down.start();
    expect(surfaced[0]?.some((c) => c.plugin === 'mapper')).toBe(false);
    await down.stop();
  });
});

describe('the first start since commands need an edge (D109)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-edges-'));
    fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'core', `${STATES_DOC}.json`), '{"migrated":"before"}\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = {
    version: 2,
    nodes: [...nodes, { id: 'quiet', plugin: 'other' }, { id: 'plain', plugin: 'plain' }],
    edges: [],
  };
  const plain = definePlugin({
    manifest: { id: 'plain', version: '0.1.0', kinds: ['stats'], description: 'no commands' },
    create: () => ({}),
  });

  it('adds an edge from each surface to each plugin with commands, where it answered before', () => {
    const { graph, added } = commandEdges(saved, manifests(bot(), bot('other'), mapper, plain));
    // The bot without an owner was no surface: nothing from it.
    expect(added).toEqual(['bot.commands → mapper.commands']);
    expect((graph as { edges: unknown[] }).edges).toEqual([
      {
        from: 'bot.commands',
        to: 'mapper.commands',
        type: 'commands',
        chats: [OWNER, GROUP],
        privateChats: true,
      },
    ]);
    // Joined already, by its node alone too: nothing added.
    const joined = { ...saved, edges: [{ from: 'bot', to: 'mapper.commands', chats: [] }] };
    expect(commandEdges(joined, manifests(bot(), mapper)).added).toEqual([]);
    expect(commandEdges('not a graph', manifests(bot())).added).toEqual([]);
  });

  it('writes it once, as a version of the history, recorded and told; never again', async () => {
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(saved));
    const run = async () => {
      const records: CoreRecord[] = [];
      const file = new GraphFile(dir, () => Date.now());
      const core = new Core({
        clock: new VirtualClock(Date.UTC(2026, 10, 15)),
        dataDir: dir,
        graphFile: file,
        record: (r) => void records.push(r as CoreRecord),
      });
      core.register(bot(), bot('other'), mapper, plain);
      await core.start();
      await core.stop();
      return { core, records, file };
    };
    const first = await run();
    expect(first.core.graph()?.edges).toEqual([
      {
        from: 'bot.commands',
        to: 'mapper.commands',
        type: 'commands',
        chats: [OWNER, GROUP],
        privateChats: true,
      },
    ]);
    expect(first.file.current()?.source).toBe('migrated');
    expect(first.records.find((r) => r.type === 'core.graph')).toMatchObject({
      event: 'migrated',
      commandEdges: ['bot.commands → mapper.commands'],
    });
    expect(first.core.notices().find((n) => n.kind === 'graph-migrated')?.detail).toEqual({
      edges: ['bot.commands → mapper.commands'],
    });
    expect(fs.existsSync(path.join(dir, 'core', `${COMMANDS_DOC}.json`))).toBe(true);
    // The owner removes the edge: it stays removed.
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(saved));
    const second = await run();
    expect(second.core.graph()?.edges).toEqual([]);
    expect(second.core.notices().some((n) => n.kind === 'graph-migrated')).toBe(false);
  });

  it('has nothing to add on a fresh instance, and marks it done', async () => {
    const file = new GraphFile(dir, () => 0);
    const core = new Core({ clock: new VirtualClock(), dataDir: dir, graphFile: file });
    core.register(bot(), mapper);
    await core.start();
    await core.stop();
    expect(fs.existsSync(path.join(dir, 'core', `${COMMANDS_DOC}.json`))).toBe(true);
    expect(file.read().exists).toBe(false);
  });
});
