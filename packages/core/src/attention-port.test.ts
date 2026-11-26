/**
 * The `attention` port (bot-os.md D133): a simulated person's attention, from the node that holds
 * it to each node that plays in its sittings; checked as any port, and run by `ctx.attention`.
 */
import { describe, expect, it } from 'vitest';
import { DevKit } from './devkit.ts';
import { defaultGraph, GraphError, type GraphInput, resolveGraph } from './graph.ts';
import { describePlugin } from './graph-view.ts';
import { type Manifest, parseManifest } from './manifest.ts';
import { definePlugin, type Plugin } from './plugin.ts';
import { describePort, mismatch, PORT_TYPE_INFO } from './ports.ts';

/** A person: it offers each player a greeting with its id. */
const person = (id = 'person'): Plugin =>
  definePlugin({
    manifest: {
      id,
      kinds: ['actor'],
      description: 'a person',
      outputs: { attention: { type: 'attention', help: 'its sittings' } },
    },
    create: () => ({ attention: (node: string) => ({ hello: () => `${id} sits with ${node}` }) }),
  });

/** A player of `person`'s sittings; `optional`, its input may be left unbound. */
const player = (id = 'player', optional = false): Plugin =>
  definePlugin({
    manifest: {
      id,
      kinds: ['actor'],
      description: 'a player',
      inputs: {
        attention: { type: 'attention', optional, bind: { node: 'person' } },
        other: { type: 'interface', plugin: 'person', optional: true },
      },
    },
    create: () => ({}),
  });

const manifests = (...plugins: Plugin[]): Map<string, Manifest> =>
  new Map(plugins.map((p) => [p.manifest.id, parseManifest(p.manifest)]));

const problems = (g: GraphInput, ms: Map<string, Manifest>): string[] => {
  try {
    resolveGraph(g, ms);
    return [];
  } catch (e) {
    return e instanceof GraphError ? e.problems : [String(e)];
  }
};

describe('the attention port type', () => {
  it('has its look, its words, and binds only another attention port', () => {
    expect(PORT_TYPE_INFO.attention).toMatchObject({ id: 'attention', shape: 'square' });
    expect(describePort({ type: 'attention', optional: false })).toBe('attention');
    const input = { type: 'attention', optional: false } as const;
    expect(mismatch(input, { type: 'attention' })).toBeUndefined();
    expect(mismatch(input, { type: 'interface', plugin: 'p', members: [] })).toBe(
      'interface of p cannot bind attention'
    );
    expect(
      mismatch(
        { type: 'interface', plugin: 'p', members: [], optional: false },
        {
          type: 'attention',
        }
      )
    ).toBe('attention cannot bind interface of p');
  });

  it('runs from one person to many players, one person to each, and is drawn as declared', () => {
    const ms = manifests(person(), player('a'), player('b'));
    const g = (edges: GraphInput['edges']): GraphInput => ({
      version: 2,
      nodes: [
        { id: 'person', plugin: 'person' },
        { id: 'a', plugin: 'a' },
        { id: 'b', plugin: 'b' },
      ],
      edges,
    });
    expect(
      problems(
        g([
          { from: 'person.attention', to: 'a.attention', type: 'attention' },
          { from: 'person', to: 'b.attention' },
        ]),
        ms
      )
    ).toEqual([]);
    expect(problems(g([{ from: 'person', to: 'a.attention' }]), ms)).toEqual([
      'node b: input port attention (attention) is not bound',
    ]);
    const twice = manifests(person(), person('other'), player('a'), player('b'));
    expect(
      problems(
        {
          version: 2,
          nodes: [
            { id: 'person', plugin: 'person' },
            { id: 'other', plugin: 'other' },
            { id: 'a', plugin: 'a' },
          ],
          edges: [
            { from: 'person', to: 'a.attention' },
            { from: 'other', to: 'a.attention' },
          ],
        },
        twice
      )
    ).toEqual(['node a: input port attention is bound twice']);
    expect(
      problems(
        g([
          { from: 'person', to: 'a.attention' },
          { from: 'person', to: 'b.attention', sends: ['@x'] },
          { from: 'person.interface', to: 'b.attention' },
        ]),
        ms
      )
    ).toEqual([
      'edge person → b.attention: only a chat-out edge carries sends, commands, minIntervalS and photos',
      'node b: input port attention: interface of person cannot bind attention (edge person.interface → b.attention)',
    ]);
    // The default graph binds it as its manifest says.
    expect(defaultGraph([...ms.values()]).edges).toContainEqual({
      from: 'person.attention',
      to: 'a.attention',
      type: 'attention',
    });
    const view = describePlugin(ms.get('person') as Manifest);
    expect(view.outputs['attention']).toEqual({
      type: 'attention',
      label: 'attention',
      optional: false,
      help: 'its sittings',
    });
    expect(describePlugin(ms.get('a') as Manifest).inputs['attention']).toEqual({
      type: 'attention',
      label: 'attention',
      optional: false,
    });
  });

  it('hands a player what its person offers it, by its id, and refuses one it has not', async () => {
    const seen: unknown[] = [];
    const watcher = (id: string, port?: string): Plugin => ({
      ...player(id),
      create: (ctx) => ({
        start: () => {
          try {
            seen.push(ctx.attention<{ hello(): string }>(port).hello());
          } catch (e) {
            seen.push((e as Error).message);
          }
        },
      }),
    });
    const kit = new DevKit({
      plugins: [person(), watcher('a'), watcher('b', 'nothing')],
    });
    await kit.start();
    expect(seen).toEqual(['person sits with a', 'b has no attention input nothing: add one']);
    await kit.stop();
    // An optional input left unbound: nothing to ask.
    const lone: Plugin = {
      ...player('lone', true),
      create: (ctx) => ({
        start: () => {
          try {
            ctx.attention();
          } catch (e) {
            seen.push((e as Error).message);
          }
        },
      }),
    };
    const solo = new DevKit({ plugins: [lone] });
    await solo.start();
    expect(seen.at(-1)).toBe('lone: its attention attention is not running');
    await solo.stop();
  });
});
