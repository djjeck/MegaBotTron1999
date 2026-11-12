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
  PREVIOUS_GRAPH_FILE,
  readGraphFile,
  writeGraphFile,
} from './graph-view.ts';
import { parseManifest } from './manifest.ts';

const graph: Graph = {
  version: 2,
  nodes: [
    { id: 'irc', plugin: 'irc', config: { host: 'znc', nick: 'me' } },
    { id: 'game', plugin: 'game' },
    {
      id: 'actor-b',
      plugin: 'actor',
      account: 'x:y',
      instance: 'actor-1',
      disabled: true,
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
        '  actor-b (actor), instance actor-1, disabled, account x:y',
        '    config.a: "x"',
        '    config.z: {"a":[2],"b":1}',
        '    settings.verbose: true',
        '  game (game)',
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

  it('is written to the data volume, keeping the one before when it changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-'));
    expect(writeGraphFile(dir, graph)).toBe(true);
    expect(readGraphFile(path.join(dir, GRAPH_FILE))).toEqual(graph);
    expect(writeGraphFile(dir, graph)).toBe(false);
    expect(fs.existsSync(path.join(dir, PREVIOUS_GRAPH_FILE))).toBe(false);
    const next = { ...graph, edges: [] };
    expect(writeGraphFile(dir, next)).toBe(true);
    expect(readGraphFile(path.join(dir, GRAPH_FILE))).toEqual(next);
    // The versions before are the history's: no previous file.
    expect(fs.existsSync(path.join(dir, PREVIOUS_GRAPH_FILE))).toBe(false);
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
    requires: ['irc', 'game'],
    reach: [{ connector: 'irc', sends: ['#a'] }],
    uses: { game: ['state.board'] },
    games: { consumes: ['game'] },
    inputs: {
      helper: { type: 'interface', members: ['actions.help'], optional: true, help: 'any helper' },
      lobby: { type: 'chat', network: 'irc', optional: true },
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
    events: { 'game.win': z.object({}), 'game.move': z.object({}) },
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
      account: 'irc:me',
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
    expect(views[1]?.outputs).toMatchObject({
      events: { type: 'events', namespace: 'game' },
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
    });
    // Its old chat inputs are chat-out outputs too, of the same names (module API 1).
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
