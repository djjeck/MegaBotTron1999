import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, PluginView } from '#src/ui/api.ts';
import { portsOf, scriptApi, scriptDts, tsType } from './types.ts';

/** A made-up game's state node, as `GET /available` describes it. */
const STATE: PluginView = {
  plugin: 'quest-state',
  version: '0.1.0',
  description: 'The inventory at @QuestBot',
  kinds: ['stats'],
  inputs: {},
  outputs: {
    events: {
      type: 'events',
      namespace: 'quest-state',
      label: 'events of quest-state',
      optional: false,
      types: [
        {
          type: 'quest-state.changed',
          help: 'Its state changed',
          schema: {
            type: 'object',
            properties: {
              sections: { type: 'array', items: { type: 'string' } },
              refreshed: { type: 'array', items: { type: 'string' } },
              event: {
                type: 'object',
                properties: { type: { type: 'string' }, t: { type: 'number' } },
                required: ['type', 't'],
              },
            },
            required: ['sections', 'refreshed'],
          },
        },
      ],
    },
    interface: {
      type: 'interface',
      plugin: 'quest-state',
      members: ['state.get', 'state.count'],
      label: 'interface of quest-state',
      optional: false,
    },
  },
  interface: {
    reads: [
      {
        name: 'get',
        help: 'The state, or the value at a dotted path',
        input: { type: 'object', properties: { path: { type: 'string' } } },
        output: {},
      },
      {
        name: 'count',
        help: 'How many of an item',
        input: {
          type: 'object',
          properties: { name: { type: 'string', description: 'The item' } },
          required: ['name'],
        },
        output: { type: 'number' },
      },
    ],
    actions: [],
    commands: [],
  },
  secrets: [],
  configSecrets: [],
  events: ['quest-state.changed'],
};

const examine: GraphNode = {
  id: 'examine',
  plugin: 'script',
  config: {
    inputs: {
      'state-events': { type: 'events', namespace: 'quest-state' },
      state: {
        type: 'interface',
        plugin: 'quest-state',
        members: ['state.get', 'state.count', 'state.missing'],
        help: 'The inventory',
      },
      loose: { type: 'interface', members: ['actions.go'] },
    },
    outputs: { chat: { type: 'chat-out', commands: ['/look'], minIntervalS: { '/look': 30 } } },
    events: { looked: { help: 'An item looked at', fields: { item: 'string', n: 'number' } } },
  },
};
const nodes: GraphNode[] = [
  { id: 'quest-state', plugin: 'quest-state' },
  examine,
  { id: 'tg', plugin: 'tg' },
];
const edges: GraphEdge[] = [
  { from: 'quest-state.events', to: 'examine.state-events' },
  { from: 'quest-state.interface', to: 'examine.state' },
  { from: 'examine.chat', to: 'tg.chat', sends: ['@QuestBot'], commands: ['/look'] },
];
const sources = {
  node: examine,
  nodes,
  edges,
  viewOf: (n: GraphNode) => (n.plugin === 'quest-state' ? STATE : undefined),
  available: [STATE],
};

/** The diagnostics of a script typed by a `.d.ts`, as the editor's TypeScript would give them. */
function diagnostics(dts: string, code: string): string[] {
  const files: Record<string, string> = { '/api.d.ts': dts, '/script.ts': code };
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    moduleDetection: ts.ModuleDetectionKind.Force,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (f) => files[f] ?? read(f);
  host.fileExists = (f) => f in files || ts.sys.fileExists(f);
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v) =>
    f in files ? ts.createSourceFile(f, files[f] as string, v) : get(f, v);
  const program = ts.createProgram(['/api.d.ts', '/script.ts'], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('a JSON Schema as a TypeScript type', () => {
  it('writes what zod writes', () => {
    expect(tsType({ type: 'string' })).toBe('string');
    expect(tsType({ type: 'integer' })).toBe('number');
    expect(tsType({ const: 'a' })).toBe('"a"');
    expect(tsType({ enum: ['a', 1] })).toBe('"a" | 1');
    expect(tsType({ enum: [] })).toBe('never');
    expect(tsType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(tsType({ allOf: [{ type: 'object' }, { type: 'object' }] })).toBe(
      'Record<string, unknown> & Record<string, unknown>'
    );
    expect(tsType({ type: ['string', 'number'] })).toBe('string | number');
    expect(
      tsType({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } })
    ).toBe('(string | number)[]');
    expect(tsType({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'boolean' }] })).toBe(
      '[string, boolean]'
    );
    expect(tsType({ type: 'object', properties: {}, additionalProperties: false })).toBe('{}');
    expect(
      tsType({
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'number' },
      })
    ).toBe('{\n  [key: string]: number;\n}');
    expect(
      tsType({ type: 'object', properties: { 'a-b': { type: 'string' } }, required: ['a-b'] })
    ).toBe('{\n  "a-b": string;\n}');
    expect(tsType({})).toBe('unknown');
    expect(tsType(undefined)).toBe('unknown');
  });
});

describe('a script node’s API', () => {
  it('reads its ports from its config, leaving out what is not of their form', () => {
    expect(portsOf(undefined)).toEqual({ inputs: {}, outputs: {}, events: {} });
    expect(
      portsOf({
        inputs: { a: 1, b: { type: 'other' }, c: { type: 'events', optional: true } },
        outputs: {
          o: 'x',
          p: { commands: ['/a', 3], minIntervalS: { '/a': 'x', '/b': 2 }, network: 'irc' },
        },
        events: { e: 'x', f: { fields: { g: 'string', h: 1 } } },
      })
    ).toEqual({
      inputs: { c: { type: 'events', namespace: '', optional: true } },
      outputs: {
        p: { type: 'chat-out', network: 'irc', commands: ['/a'], minIntervalS: { '/b': 2 } },
      },
      events: { f: { help: '', fields: { g: 'string' } } },
    });
  });

  it('lists its ports with what their other ends offer', () => {
    const api = scriptApi(sources);
    expect(api.events).toEqual([
      {
        port: 'state-events',
        namespace: 'quest-state',
        from: ['quest-state'],
        types: [
          expect.objectContaining({
            type: 'quest-state.changed',
            help: 'Its state changed',
            port: 'state-events',
          }),
        ],
      },
    ]);
    expect(api.interfaces[0]).toMatchObject({
      port: 'state',
      from: 'quest-state',
      help: 'The inventory',
      members: [
        { name: 'state.get', help: 'The state, or the value at a dotted path' },
        { name: 'state.count', help: 'How many of an item' },
        { name: 'state.missing', unknown: true },
      ],
    });
    expect(api.interfaces[1]).toEqual({
      port: 'loose',
      members: [{ name: 'actions.go', unknown: true }],
    });
    expect(api.outputs).toEqual([
      { port: 'chat', commands: ['/look'], spacing: { '/look': 30 }, to: 'tg' },
    ]);
    expect(api.own).toEqual([
      {
        type: 'examine.looked',
        help: 'An item looked at',
        fields: { item: 'string', n: 'number' },
      },
    ]);
    // Unbound: an events input's types from every plugin offering its namespace; an interface's from its plugin.
    const loose = scriptApi({ ...sources, edges: [] });
    expect(loose.events[0]?.types.map((t) => t.type)).toEqual(['quest-state.changed']);
    expect(loose.interfaces[0]?.from).toBe('quest-state');
    expect(loose.outputs[0]?.to).toBeUndefined();
  });

  it('types the API so that a correct script checks, and a wrong one does not', () => {
    const dts = scriptDts(scriptApi(sources), 'examine');
    expect(dts).toContain('/** How many of an item */');
    expect(dts).toContain('/** The item */');
    const good = `
      on('quest-state.changed', async (e) => {
        const sections: string[] = e.sections;
        const t: number | undefined = e.event?.t;
        const n: number = await use('state').state.count({ name: 'lantern' });
        const whole: unknown = await use('state').state.get({});
        const q = enqueue('chat', '@QuestBot', '/look lantern', { cancel: { on: 'quest-state.changed', withinMs: 1000 } });
        const r = await q;
        if (r.outcome === 'sent') log.info(sections, t, n, whole, q.status());
        publish('examine.looked', { item: 'lantern', n });
        store.write('seen', [store.read<string[]>('seen') ?? []]);
        log(clock.now(), new Date().getTime());
      });
      on('quest-state', (e) => log(e.type));
      on('examine.looked', (e) => log(e.item));
      await outbox('chat').enqueue('@QuestBot', '/look x');
    `;
    expect(diagnostics(dts, good)).toEqual([]);
    const bad = `
      on('quest-state.changed', (e) => { e.nothing; });
      on('cards.dealt', () => {});
      use('state').state.count({ nom: 'x' });
      use('nowhere');
      enqueue('other', '@QuestBot', '/look');
      publish('examine.looked', { item: 1, n: 2 });
      const x: number = process.pid;
    `;
    expect(diagnostics(dts, bad).length).toBeGreaterThanOrEqual(7);
  });

  it('types a script with no ports at all', () => {
    const dts = scriptDts(
      scriptApi({ ...sources, node: { id: 'bare', plugin: 'script' } }),
      'bare'
    );
    expect(diagnostics(dts, `log('hello'); store.names();`)).toEqual([]);
    expect(diagnostics(dts, `enqueue('chat', 'a', 'b');`).length).toBe(1);
  });
});
