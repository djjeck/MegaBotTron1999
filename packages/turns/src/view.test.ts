/**
 * The generic view (docs/bot-os.md D170): its config, its node's manifest, and a view of a
 * collection in a running graph, its sections checked against the node wired to it.
 */
import { describeNodes, DevKit, parseManifest } from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { collectionPlugin } from './collection.ts';
import { viewConfig, viewManifest, viewPlugin } from './view.ts';

/** A made-up cast of characters, as a collection keeps it. */
const CAST = { title: 'name', fields: [{ name: 'name', type: 'text', required: true }] };

/** A view of the cast: a table of its records, and one record by the page's choice. */
const DASHBOARD = {
  title: 'The cast',
  inputs: { cast: { plugin: 'collection' } },
  selector: { from: 'cast', read: 'list', value: 'id', label: 'values.name' },
  sections: [
    { show: 'table', from: 'cast', read: 'list', columns: ['values.name'] },
    { show: 'keyValue', from: 'cast', read: 'get', input: { id: '$selector' } },
  ],
};

const graph = (
  config: Record<string, unknown>,
  edges = [{ from: 'cast.interface', to: 'home.cast' }]
) => ({
  version: 2 as const,
  nodes: [
    { id: 'cast', plugin: 'collection', config: CAST },
    { id: 'home', plugin: 'view', path: 'cast', config },
  ],
  edges,
});

describe('viewConfig', () => {
  it('starts empty: a title, no input, no section', () => {
    expect(viewConfig.parse({})).toEqual({ title: 'View', inputs: {}, sections: [] });
  });

  it('takes inputs by plugin or by contract, a selector and sections', () => {
    const c = viewConfig.parse(DASHBOARD);
    expect(c.inputs['cast']).toEqual({ type: 'interface', plugin: 'collection', members: [] });
    expect(c.sections).toHaveLength(2);
  });
});

describe('viewManifest', () => {
  it('makes each input an optional interface input, with the members its sections use', () => {
    const m = parseManifest(viewManifest(DASHBOARD));
    expect(m.kinds).toEqual(['view']);
    expect(m.inputs['cast']).toMatchObject({
      type: 'interface',
      plugin: 'collection',
      optional: true,
      members: ['state.list', 'state.get'],
    });
    expect(m.view).toMatchObject({ title: 'The cast', selector: { read: 'list' } });
  });

  it('takes its theme from its config (D175)', () => {
    const theme = { light: { accent: '#0f766e' }, density: 'spacious' as const };
    expect(viewManifest({ theme }).view).toEqual({ title: 'View', sections: [], theme });
  });

  it('is the base view for a config it cannot read: the config’s check says why', () => {
    expect(viewManifest({ title: 3 }).view).toEqual({ title: 'View', sections: [] });
    expect(viewManifest({ inputs: { cast: { members: ['x'] } } }).inputs).toBeUndefined();
  });

  it('refuses a section that reads no input of its own', () => {
    expect(() => parseManifest(viewManifest({ ...DASHBOARD, inputs: {} }))).toThrow(
      'view.sections.0.from: cast is not among its interface inputs'
    );
  });
});

/** The running graph's nodes, as `GET /graph/view` describes them. */
const views = (kit: DevKit) =>
  describeNodes(
    kit.core.controls.nodes(),
    kit.core.graph() ?? { version: 2, nodes: [], edges: [] }
  );

describe('a view node (D170)', () => {
  it('runs nothing, with its inputs wired by the owner alone', async () => {
    const kit = new DevKit({
      plugins: [collectionPlugin(), viewPlugin()],
      graph: graph(DASHBOARD),
    });
    await kit.start();
    const view = views(kit).find((n) => n.id === 'home');
    expect(view).toMatchObject({
      kinds: ['view'],
      view: { title: 'The cast' },
      served: { path: 'cast', bound: { cast: 'cast' } },
    });
    expect(views(kit).find((n) => n.id === 'cast')?.shownIn).toEqual([
      { node: 'home', path: 'cast' },
    ]);
    await kit.stop();
  });

  it('starts with nothing wired, and an empty page', async () => {
    const kit = new DevKit({
      plugins: [collectionPlugin(), viewPlugin()],
      graph: graph({}, []),
    });
    await kit.start();
    expect(views(kit).find((n) => n.id === 'home')).toMatchObject({
      view: { title: 'View', sections: [] },
      served: { path: 'cast', bound: {} },
    });
    await kit.stop();
  });

  it('is refused when its sections do not fit the node wired to it', async () => {
    const wrong = {
      ...DASHBOARD,
      selector: undefined,
      sections: [{ show: 'counter', from: 'cast', read: 'list', path: 'nothing' }],
    };
    const kit = new DevKit({ plugins: [collectionPlugin(), viewPlugin()], graph: graph(wrong) });
    await expect(kit.start()).rejects.toThrow(
      'node home: view sections.0.path: the read list has no nothing (from cast, bound to cast)'
    );
  });
});
