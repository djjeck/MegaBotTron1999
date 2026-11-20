import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Graph } from './graph.ts';
import {
  describeNodes,
  describePlugin,
  GRAPH_FILE,
  graphMermaid,
  graphText,
  lineDiff,
  readGraphFile,
  writeGraphFile,
} from './graph-view.ts';
import { parseManifest } from './manifest.ts';

const graph: Graph = {
  version: 2,
  nodes: [
    { id: 'irc', plugin: 'irc', config: { host: 'znc', nick: 'me' } },
    { id: 'game', plugin: 'game', group: 'Quest Bot' },
    {
      id: 'actor-b',
      plugin: 'actor',
      account: 'x:y',
      instance: 'actor-1',
      disabled: true,
      group: 'Quest Bot',
      config: { z: { b: 1, a: [2] }, a: 'x' },
      settings: { verbose: true },
    },
  ],
  edges: [
    { from: 'irc.chat', to: 'game.channel', type: 'chat-in', reads: ['#a'] },
    { from: 'game.interface', to: 'actor-b.game', type: 'interface' },
    { from: 'irc.chat', to: 'actor-b.channel', type: 'chat-in', reads: [] },
    {
      from: 'actor-b.channel',
      to: 'irc.chat',
      type: 'chat-out',
      sends: ['#a'],
      commands: ['!go', '"q"'],
      dryRun: true,
    },
    { from: 'game.events', to: 'actor-b.notices' },
  ],
};

describe('the graph printed', () => {
  it('as text: each node and each value a line, then the edges, in a stable order', () => {
    expect(graphText(graph)).toBe(
      [
        'nodes:',
        '  actor-b (actor), instance actor-1, disabled, account x:y, group Quest Bot',
        '    config.a: "x"',
        '    config.z: {"a":[2],"b":1}',
        '    settings.verbose: true',
        '  game (game), group Quest Bot',
        '  irc (irc)',
        '    config.host: "znc"',
        '    config.nick: "me"',
        'edges:',
        '  actor-b.channel → irc.chat (chat-out): sends #a; commands !go "q"; dry-run',
        '  game.events → actor-b.notices (?)',
        '  game.interface → actor-b.game (interface)',
        '  irc.chat → actor-b.channel (chat-in)',
        '  irc.chat → game.channel (chat-in): reads #a',
      ].join('\n')
    );
    // Reordered, the same graph prints the same.
    const reordered = {
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    expect(graphText(reordered)).toBe(graphText(graph));
    // A commands edge (D109): what it serves, where, to whom.
    expect(
      graphText({
        version: 2,
        nodes: [],
        edges: [
          {
            from: 'irc.commands',
            to: 'game.commands',
            type: 'commands',
            serves: ['map'],
            chats: ['#a'],
            privateChats: true,
            senders: ['owner'],
            dryRun: true,
          },
        ],
      }).split('\n')[2]
    ).toBe(
      '  irc.commands → game.commands (commands): from owner; serves map; in #a; in private chats; dry-run'
    );
    expect(
      graphText({ version: 2, nodes: [{ id: 'a', plugin: 'a', instance: 'a' }], edges: [] })
    ).toBe('nodes:\n  a (a)\nedges:');
  });

  it('two printouts line by line: what is kept, removed and added', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nc\nx\nd\ne')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'x' },
      { op: ' ', text: 'd' },
      { op: '+', text: 'e' },
    ]);
    expect(lineDiff('a\nb', 'b\na')).toEqual([
      { op: '-', text: 'a' },
      { op: ' ', text: 'b' },
      { op: '+', text: 'a' },
    ]);
    expect(lineDiff('', 'a')).toEqual([{ op: '+', text: 'a' }]);
    expect(lineDiff('a', '')).toEqual([{ op: '-', text: 'a' }]);
    // Too long for the shortest diff: all removed, then all added.
    const long = Array.from({ length: 2001 }, (_, i) => `${i}`).join('\n');
    const diff = lineDiff(long, long);
    expect(diff).toHaveLength(4002);
    expect(diff[0]).toEqual({ op: '-', text: '0' });
    expect(diff[2001]).toEqual({ op: '+', text: '0' });
  });

  it('as a Mermaid flowchart, each edge coloured by its port type', () => {
    expect(graphMermaid(graph)).toBe(
      [
        'flowchart LR',
        '  irc["irc"]',
        '  game["game"]',
        '  actor_b["actor-b<br/><i>actor</i>"]',
        '  irc_out["irc · out"]',
        '  irc -- "chat → channel<br/>reads #a" --> game',
        '  game -- "interface → game" --> actor_b',
        '  irc -- "chat → channel" --> actor_b',
        '  actor_b -- "channel → chat<br/>sends #a; commands !go #quot;q#quot;; dry-run" --> irc_out',
        '  game -- "events → notices" --> actor_b',
        '  linkStyle 0 stroke:#2f7ed8',
        '  linkStyle 1 stroke:#3a9a5b',
        '  linkStyle 2 stroke:#2f7ed8',
        '  linkStyle 3 stroke:#8a4fd1',
      ].join('\n')
    );
  });

  it('is written to the data volume, saying whether it changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-'));
    expect(writeGraphFile(dir, graph)).toBe(true);
    expect(readGraphFile(path.join(dir, GRAPH_FILE))).toEqual(graph);
    expect(writeGraphFile(dir, graph)).toBe(false);
    const next = { ...graph, edges: [] };
    expect(writeGraphFile(dir, next)).toBe(true);
    expect(readGraphFile(path.join(dir, GRAPH_FILE))).toEqual(next);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('the nodes as the graph view shows them', () => {
  const irc = parseManifest({
    id: 'irc',
    version: '1.0.0',
    kinds: ['connector'],
    description: 'a network',
    account: 'irc:me',
    secrets: ['irc_password'],
    configSecrets: ['token'],
    config: z.object({
      host: z.string().describe('where'),
      port: z.number().default(6667),
      token: z.string().optional(),
    }),
  });
  const actor = parseManifest({
    id: 'actor',
    version: '0.2.0',
    kinds: ['actor'],
    description: 'acts',
    requires: ['game'],
    uses: { game: ['state.board'] },
    games: { consumes: ['game'] },
    inputs: {
      irc: { type: 'chat-in', bind: { node: 'irc', reads: [] } },
      helper: { type: 'interface', members: ['actions.help'], optional: true, help: 'any helper' },
      lobby: { type: 'chat-in', network: 'irc', optional: true },
    },
    outputs: {
      irc: { type: 'chat-out', bind: { node: 'irc', sends: ['#a'] } },
      lobby: { type: 'chat-out', network: 'irc', optional: true },
    },
    settings: z.object({ loud: z.boolean().default(false) }),
    interface: {
      state: { status: { help: 'how it is', output: z.object({ n: z.number() }) } },
      actions: {
        go: { help: 'goes', input: z.object({ to: z.string() }), output: z.boolean() },
        stay: { help: 'stays', input: z.object({}) },
      },
      commands: { poke: { help: 'pokes', args: '<who>', owner: true } },
    },
  });
  const game = parseManifest({
    id: 'game',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'reads the game',
    games: { registers: ['game'] },
    events: { 'game.win': z.object({}).describe('Someone won'), 'game.move': z.object({}) },
    interface: { state: { board: { help: 'the board', output: z.array(z.string()) } } },
  });

  it('gives each its ports, interface and the JSON Schemas of its config and settings', () => {
    const views = describeNodes(
      [
        { id: 'irc', manifest: irc },
        { id: 'game', manifest: game },
        { id: 'actor-b', manifest: actor },
      ],
      graph
    );
    expect(views[0]).toMatchObject({
      id: 'irc',
      plugin: 'irc',
      version: '1.0.0',
      // Its node names no account: `<network>:<its id>` (D119).
      account: 'irc:irc',
      network: 'irc',
      config: { host: 'znc', nick: 'me' },
      configSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'where' },
          port: { type: 'number', default: 6667 },
        },
      },
      inputs: {
        chat: {
          type: 'chat-out',
          network: 'irc',
          label: 'chat-out of irc',
          optional: true,
          help: 'What the plugins send through its account',
        },
      },
      outputs: {
        chat: { type: 'chat-in', network: 'irc', label: 'chat-in of irc', optional: false },
      },
      interface: { reads: [], actions: [], commands: [] },
      secrets: ['irc_password'],
      configSecrets: ['token'],
      events: [],
    });
    expect(views[1]).not.toHaveProperty('config');
    expect(views[1]?.events).toEqual(['game.move', 'game.win']);
    // The plugin alone, as the editor's palette offers it: its manifest's account, no node's.
    expect(describePlugin(actor)).not.toHaveProperty('account');
    expect(describePlugin(irc)).toMatchObject({ plugin: 'irc', account: 'irc:me' });
    // A model connector says so (D117), for its `$` mark; the others say nothing of it.
    expect(describePlugin(irc)).not.toHaveProperty('model');
    expect(describePlugin({ ...irc, model: true })).toMatchObject({ model: true });
    // A parser's bot commands and a player's checklist (D137), as declared; none, nothing.
    expect(describePlugin(irc)).not.toHaveProperty('botCommands');
    expect(describePlugin(irc)).not.toHaveProperty('botUsername');
    expect(
      describePlugin({
        ...irc,
        botCommands: [{ command: '/play', turn: true }],
        botUsername: 'QuestBot',
        configPlays: { key: 'commands', input: 'parser', output: 'chat' },
      })
    ).toMatchObject({
      botCommands: [{ command: '/play', turn: true }],
      botUsername: 'QuestBot',
      configPlays: { key: 'commands', input: 'parser', output: 'chat' },
    });
    expect(views[1]?.outputs).toMatchObject({
      // An events output lists its plugin's types there, with their descriptions (D71).
      events: {
        type: 'events',
        namespace: 'game',
        types: [{ type: 'game.move' }, { type: 'game.win', help: 'Someone won' }],
      },
      interface: { type: 'interface', plugin: 'game', members: ['state.board'] },
    });
    const b = views[2];
    expect(b).toMatchObject({ id: 'actor-b', plugin: 'actor', account: 'x:y' });
    expect(b?.settingsSchema).toMatchObject({ properties: { loud: { default: false } } });
    expect(b?.inputs).toEqual({
      irc: { type: 'chat-in', label: 'chat-in of any network', optional: false },
      game: {
        type: 'interface',
        plugin: 'game',
        members: ['state.board'],
        label: 'interface of game',
        optional: false,
      },
      'game-events': { type: 'events', namespace: 'game', label: 'events of game', optional: true },
      helper: {
        type: 'interface',
        members: ['actions.help'],
        label: 'interface with actions.help',
        optional: true,
        help: 'any helper',
      },
      lobby: { type: 'chat-in', network: 'irc', label: 'chat-in of irc', optional: true },
      // Its chat commands, served by the connectors whose edges bind it (D109).
      commands: {
        type: 'commands',
        commands: ['poke'],
        label: 'commands',
        optional: true,
        help: 'Its chat commands: the connectors that answer them, where, and to whom',
      },
    });
    // Its chat-outs, named as its chat-ins: the two ends of each account.
    expect(b?.outputs).toMatchObject({
      irc: { type: 'chat-out', label: 'chat-out of any network', optional: false },
      lobby: { type: 'chat-out', network: 'irc', optional: true },
    });
    expect(b?.interface.reads).toMatchObject([{ name: 'status', help: 'how it is' }]);
    expect(b?.interface.actions).toMatchObject([
      {
        name: 'go',
        input: { properties: { to: { type: 'string' } } },
        output: { type: 'boolean' },
      },
      { name: 'stay' },
    ]);
    expect(b?.interface.actions[1]).not.toHaveProperty('output');
    expect(b?.interface.commands).toEqual([
      { name: 'poke', help: 'pokes', args: '<who>', owner: true },
    ]);
    // A node the graph does not hold (it cannot happen at run time) has its manifest's alone.
    expect(describeNodes([{ id: 'other', manifest: game }], graph)[0]).not.toHaveProperty(
      'account'
    );
  });
});

describe('a chat-out edge’s spacing (bot-os.md D73)', () => {
  it('is printed, by command, so that the history’s diffs show it', () => {
    const spaced: Graph = {
      ...graph,
      edges: [
        {
          from: 'actor-b.channel',
          to: 'irc.chat',
          type: 'chat-out',
          sends: ['#a'],
          commands: ['!go', '!look'],
          minIntervalS: { '!look': 60, '!go': 300 },
        },
      ],
    };
    expect(graphText(spaced)).toContain(
      'actor-b.channel → irc.chat (chat-out): sends #a; commands !go !look; spaced !go 300s !look 60s'
    );
  });

  it('prints that it lets photos through (D150)', () => {
    const photos: Graph = {
      ...graph,
      edges: [
        {
          from: 'actor-b.channel',
          to: 'irc.chat',
          type: 'chat-out',
          sends: ['#a'],
          commands: ['!go'],
          photos: true,
        },
      ],
    };
    expect(graphText(photos)).toContain(
      'actor-b.channel → irc.chat (chat-out): sends #a; commands !go; photos'
    );
  });
});
