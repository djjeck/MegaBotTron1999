import type { Plugin } from '@megabottron1999/core';
import { DevKit, FakeConnector, fakeConnectorPlugin } from '@megabottron1999/core';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginView } from '#src/ui/api.ts';
import { exportScript } from './export.ts';
import { scriptApi } from './types.ts';

const GAME: PluginView = {
  plugin: 'quest',
  version: '0.1.0',
  description: 'A made-up game',
  kinds: ['parser'],
  inputs: {},
  outputs: {
    events: {
      type: 'events',
      namespace: 'quest',
      label: 'events of quest',
      optional: false,
      types: [
        {
          type: 'quest.gain',
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      ],
    },
  },
  interface: {
    reads: [
      {
        name: 'count',
        help: 'How many',
        input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        output: { type: 'number' },
      },
    ],
    actions: [],
    commands: [],
  },
  secrets: [],
  configSecrets: [],
  events: ['quest.gain'],
};

const CONFIG = {
  inputs: {
    'quest-events': { type: 'events', namespace: 'quest' },
    game: { type: 'interface', plugin: 'quest', members: ['state.count'] },
  },
  outputs: { chat: { type: 'chat-out', commands: ['/look'], minIntervalS: { '/look': 5 } } },
  events: {
    looked: { help: 'An item looked at', fields: { item: 'string', n: 'number', x: 'other' } },
  },
  code: `const seen = new Set<string>();
on('quest.gain', async (e) => {
  if (seen.has(e.name)) return;
  seen.add(e.name);
  const n: number = await use('game').state.count({ name: e.name });
  const r = await enqueue('chat', '@QuestBot', \`/look \${e.name}\`);
  log.info('looked', e.name, r.outcome, { n });
  console.warn('stored', store.names().length, clock.now() >= 0);
  publish('examine.looked', { item: e.name, n, x: null });
});
on('quest', () => { throw new Error('every event'); });
`,
};

const api = scriptApi({
  node: { id: 'examine', plugin: 'script', config: CONFIG },
  nodes: [{ id: 'quest', plugin: 'quest' }],
  edges: [
    { from: 'quest.events', to: 'examine.quest-events' },
    { from: 'quest.interface', to: 'examine.game' },
  ],
  viewOf: () => GAME,
  available: [GAME],
});
const exported = exportScript('examine', CONFIG, api);
// Written beside this test, so that its imports resolve as a module's would against the shell.
const file = path.join(import.meta.dirname, `.exported-${process.pid}.tmp.ts`);
fs.writeFileSync(file, exported.plugin);
afterAll(() => fs.rmSync(file, { force: true }));

describe('a script node exported as a plugin (D79)', () => {
  it('is named after its node, with its module’s manifest', () => {
    expect(exported.fileName).toBe('examine.ts');
    expect(JSON.parse(exported.moduleJson)).toEqual({
      id: 'examine',
      version: '0.1.0',
      api: '1',
      provides: '@example/examine',
      description: 'Exported from the script node examine',
      plugins: ['src/plugins/examine.ts'],
    });
    expect(exported.plugin).toContain("kinds: ['actor']");
    expect(exported.plugin).toContain(
      '"examine.looked": z.object({ "item": z.string(), "n": z.number(), "x": z.unknown() }).describe("An item looked at")'
    );
    expect(
      exportScript('bare', {}, { events: [], interfaces: [], outputs: [], own: [] }).plugin
    ).toContain("kinds: ['stats']");
  });

  it('type-checks as the repository’s strict TypeScript does', () => {
    const options: ts.CompilerOptions = {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    };
    const program = ts.createProgram([file], options);
    const problems = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === file)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(problems).toEqual([]);
  }, 60_000);

  it('runs as the script did, on the dev kit', async () => {
    const { plugins } = (await import(file)) as { plugins: Plugin[] };
    const connector = new FakeConnector({ account: 'telegram:alice' });
    let gain: ((name: string) => void) | undefined;
    const lines: string[] = [];
    const kit = new DevKit({
      print: (l) => lines.push(l),
      plugins: [
        fakeConnectorPlugin('tg', connector),
        {
          manifest: {
            id: 'quest',
            version: '0.1.0',
            kinds: ['parser'],
            description: 'A made-up game',
            games: { registers: ['quest'] },
            events: { 'quest.gain': z.object({ name: z.string() }) },
            interface: {
              state: {
                count: {
                  help: 'How many',
                  input: z.object({ name: z.string() }),
                  output: z.number(),
                },
              },
            },
          },
          create: (ctx) => {
            gain = (name) => ctx.bus.publish('quest.gain', { name });
            return { interface: { state: { count: () => 1 } } };
          },
        },
        ...plugins,
      ],
      graph: {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'tg' },
          { id: 'quest', plugin: 'quest' },
          { id: 'examine', plugin: 'examine' },
        ],
        edges: [
          { from: 'quest.events', to: 'examine.quest-events' },
          { from: 'quest.interface', to: 'examine.game' },
          { from: 'examine.chat', to: 'tg.chat', sends: ['@QuestBot'], commands: ['/look'] },
        ],
      },
    });
    await kit.start();
    connector.open();
    gain?.('lantern');
    await new Promise((r) => setTimeout(r, 20));
    expect(connector.sent).toEqual([{ chat: '@QuestBot', text: '/look lantern' }]);
    expect(lines).toEqual(
      expect.arrayContaining([
        'examine: looked lantern sent {"n":1}',
        'examine: warning: stored 0 true',
        'examine: warning: a handler threw: Error: every event',
      ])
    );
    expect(kit.log.records.find((r) => r.type === 'examine.looked')).toMatchObject({
      item: 'lantern',
      n: 1,
    });
    await kit.stop();
  });
});
