/**
 * The collection (docs/bot-os.md D155): its config, its node's manifest, its records checked and
 * kept, its media kept by their hash and cleaned up, a schema changed under kept records, its
 * interface read by another node, and the dev kit's seed. The cast is made up: the hosts of a
 * `postcard` plugin, each a name, a role, a behaviour, a setting and a face.
 */
import {
  BYTES_KEY,
  bytesJson,
  definePlugin,
  DevKit,
  fakeMedia,
  type GraphInput,
  jsonSchema,
  type Media,
  type MediaResult,
  parseManifest,
  type PluginContext,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import {
  type CollectionChange,
  collectionConfig,
  collectionManifest,
  collectionPlugin,
  type CollectionRecord,
  type CollectionSchema,
  collectionSeed,
  keptValueProblem,
  mediaFileName,
  RECORDS_DOC,
} from '#src/collection.ts';

const MB = 2 ** 20;

/** The cast's schema: the example of the decision. */
const CAST = {
  fields: [
    { name: 'name', type: 'text', required: true, unique: true },
    { name: 'role', type: 'choice', options: ['seller', 'character'] },
    { name: 'behaviour', type: 'text', long: true, help: 'How they act, in a line or two' },
    { name: 'setting', type: 'text', long: true },
    { name: 'face', type: 'media', kinds: ['image'], maxBytes: 10 * MB },
  ],
};

interface Reader {
  state: {
    list(): CollectionRecord[];
    get(q: { id: string }): CollectionRecord | null;
    schema(): CollectionSchema;
    media(q: { id: string }): MediaResult;
  };
  actions: { add(q: { values: Record<string, unknown> }): CollectionRecord };
}

/** A node that reads the cast through its interface input, as `postcard` would. */
function postcard(): { plugin: ReturnType<typeof definePlugin>; ctx: () => PluginContext } {
  let held: PluginContext | undefined;
  return {
    plugin: definePlugin({
      manifest: {
        id: 'postcard',
        version: '0.1.0',
        kinds: ['actor'],
        description: 'Draws a host for each card',
        inputs: {
          cast: {
            type: 'interface',
            plugin: 'collection',
            members: ['state.list', 'state.get', 'state.schema', 'state.media', 'actions.add'],
          },
        },
      },
      create: (ctx) => {
        held = ctx;
        return {};
      },
    }),
    ctx: () => held as PluginContext,
  };
}

async function run(
  o: {
    config?: unknown;
    documents?: Record<string, unknown>;
    files?: Record<string, Media>;
  } = {}
) {
  const reader = postcard();
  const graph: GraphInput = {
    version: 2,
    nodes: [
      { id: 'cast', plugin: 'collection', config: (o.config ?? CAST) as Record<string, unknown> },
      { id: 'postcard', plugin: 'postcard' },
    ],
    edges: [{ from: 'cast.interface', to: 'postcard.cast' }],
  };
  const lines: string[] = [];
  const kit = new DevKit({
    plugins: [collectionPlugin(), reader.plugin],
    graph,
    print: (l) => lines.push(l),
    ...(o.documents === undefined ? {} : { documents: { cast: o.documents } }),
    ...(o.files === undefined ? {} : { files: { cast: o.files } }),
  });
  await kit.start();
  const act = (name: string, input: unknown) => kit.core.controls.act('cast', name, input);
  const read = (name: string, input?: unknown) => kit.core.controls.read('cast', name, input);
  const files = () => kit.core.controls.files('cast')?.files.map((f) => f.name) ?? [];
  const changes = (): CollectionChange[] =>
    kit.log.records
      .filter((r) => r.type === 'cast.changed')
      .map((r) => ({ change: r['change'], id: r['id'] }) as CollectionChange);
  const use = () => reader.ctx().use<Reader>('cast');
  return { kit, act, read, files, changes, use, lines };
}

/** A media as the panel sends it: its bytes as JSON carries them. */
const wire = (m: Media): unknown => JSON.parse(JSON.stringify(m, bytesJson)) as unknown;

describe('collectionConfig', () => {
  it('takes the cast’s schema, its defaults filled in', () => {
    const c = collectionConfig.parse(CAST);
    expect(c.fields[0]).toMatchObject({ name: 'name', required: true, unique: true, long: false });
    expect(c.fields[4]).toMatchObject({ type: 'media', kinds: ['image'], maxBytes: 10 * MB });
  });

  it.each([
    [{ fields: [] }, 'fields'],
    [{ fields: [{ name: 'role', type: 'choice' }] }, 'a choice needs its options'],
    [{ fields: [{ name: 'role', type: 'choice', options: ['a', 'a'] }] }, 'listed twice'],
    [{ fields: [{ name: 'face', type: 'media', unique: true }] }, 'cannot be unique'],
    [{ fields: [{ name: 'name', type: 'text', options: ['a'] }] }, 'options is for a choice'],
    [{ fields: [{ name: 'name', type: 'text', maxBytes: 3 }] }, 'maxBytes is for a media'],
    [{ fields: [{ name: 'n', type: 'number', long: true }] }, 'long is for a text'],
    [
      {
        fields: [
          { name: 'a', type: 'text' },
          { name: 'a', type: 'number' },
        ],
      },
      'a is named twice',
    ],
    [{ fields: [{ name: 'a', type: 'number' }], title: 'a' }, 'a is no text field'],
    [{ fields: [{ name: 'Bad name', type: 'text' }] }, 'expected a name'],
  ])('refuses %j', (config, why) => {
    const r = collectionConfig.safeParse(config);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(why);
  });
});

describe('collectionManifest', () => {
  it('declares its reads, its actions made from its fields, and <node>.changed', () => {
    const m = parseManifest(collectionManifest(collectionConfig.parse(CAST), 'cast'));
    expect(m.games.registers).toEqual(['cast']);
    expect(Object.keys(m.events)).toEqual(['cast.changed']);
    expect(m.outputs['interface']).toMatchObject({
      plugin: 'collection',
      members: [
        'state.list',
        'state.get',
        'state.schema',
        'state.media',
        'actions.add',
        'actions.update',
        'actions.remove',
        'actions.reorder',
      ],
    });
    const add = jsonSchema(m.interface.actions?.['add']?.input as never);
    const values = (add['properties'] as Record<string, Record<string, unknown>>)['values'] as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(values.required).toEqual(['name']);
    expect(values.properties['face']?.['media']).toEqual({ kinds: ['image'], maxBytes: 10 * MB });
    expect(values.properties['behaviour']).toMatchObject({
      long: true,
      description: 'How they act, in a line or two',
    });
    expect(values.properties['role']?.['enum']).toEqual(['seller', 'character']);
    const update = jsonSchema(m.interface.actions?.['update']?.input as never);
    expect(
      (update['properties'] as Record<string, Record<string, unknown>>)['values']?.['required']
    ).toBeUndefined();
  });

  it('says each media field’s limits on the field itself, as the control API serves it (#74)', () => {
    const kit = new DevKit({ plugins: [collectionPlugin()] });
    const fields = [
      { name: 'face', type: 'media', kinds: ['image'], maxBytes: 10 * MB },
      { name: 'badge', type: 'media', required: true },
      { name: 'card', type: 'media', help: 'Its picture in the lists' },
    ];
    const served = JSON.parse(
      JSON.stringify(
        kit.core.nodeViews({
          version: 2,
          nodes: [{ id: 'cast', plugin: 'collection', config: { fields } }],
          edges: [],
        })
      )
    ) as Record<
      string,
      { interface: { actions: { name: string; input: Record<string, unknown> }[] } }
    >;
    for (const action of ['add', 'update']) {
      const input = served['cast']?.interface.actions.find((a) => a.name === action)?.input ?? {};
      const values = (input['properties'] as Record<string, Record<string, unknown>>)['values'] as {
        properties: Record<string, Record<string, unknown>>;
      };
      // No definition to follow, no wrapper to look into: the key is where the form reads it.
      expect(JSON.stringify(input)).not.toMatch(/\$ref|\$defs|allOf|anyOf/u);
      expect(values.properties['face']?.['media']).toEqual({ kinds: ['image'], maxBytes: 10 * MB });
      expect(values.properties['badge']?.['media']).toEqual({});
      expect(values.properties['card']).toMatchObject({
        media: {},
        description: 'Its picture in the lists',
      });
    }
  });

  it('makes what it can of a config its schema refuses', () => {
    const m = parseManifest(
      collectionManifest({ fields: [{ name: 'ok', type: 'text' }, { name: 'bad' }, 'x'] }, 'c')
    );
    const add = jsonSchema(m.interface.actions?.['add']?.input as never);
    expect(
      Object.keys(
        ((add['properties'] as Record<string, Record<string, unknown>>)['values']?.['properties'] ??
          {}) as object
      )
    ).toEqual(['ok']);
    expect(parseManifest(collectionManifest({}, 'c')).id).toBe('collection');
  });
});

describe('a collection’s events, heard from the edge alone (D156)', () => {
  it('reaches a plugin whose events input takes its namespace from its edge', async () => {
    const heard: string[] = [];
    const bound: (string | undefined)[] = [];
    const watcher = definePlugin({
      manifest: {
        id: 'postcard',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'Remakes its cards when its cast changes',
        inputs: {
          'cast-events': { type: 'events', namespace: { edge: true }, optional: true },
        },
      },
      create: (ctx) => {
        bound.push(ctx.bus.namespace('cast-events'));
        ctx.bus.subscribeTo('cast-events', 'changed', (e) =>
          heard.push(`${e.type} ${String(e['change'])} ${String(e['id'])}`)
        );
        return {};
      },
    });
    const kit = new DevKit({
      plugins: [collectionPlugin(), watcher],
      graph: {
        version: 2,
        nodes: [
          { id: 'hosts', plugin: 'collection', config: CAST as Record<string, unknown> },
          { id: 'postcard', plugin: 'postcard' },
        ],
        // No config names the collection: the edge alone binds it.
        edges: [{ from: 'hosts.events', to: 'postcard.cast-events' }],
      },
    });
    await kit.start();
    await kit.core.controls.act('hosts', 'add', { values: { name: 'Ada' } });
    expect(bound).toEqual(['hosts']);
    expect(heard).toEqual(['hosts.changed added r1']);
    await kit.stop();
  });
});

describe('a collection’s records', () => {
  it('adds, updates, reorders and removes, each announced as <node>.changed', async () => {
    const t = await run();
    const ada = await t.act('add', { values: { name: 'Ada', role: 'seller' } });
    expect(ada).toEqual({
      output: { id: 'r1', position: 0, values: { name: 'Ada', role: 'seller' } },
    });
    await t.act('add', { values: { name: 'Bo' } });
    await t.act('add', { values: { name: 'Cy' }, position: 0 });
    expect((t.read('list') as { value: CollectionRecord[] }).value.map((r) => r.id)).toEqual([
      'r3',
      'r1',
      'r2',
    ]);
    const up = await t.act('update', {
      id: 'r1',
      values: { behaviour: 'Haggles, then gives in' },
      unset: ['role'],
    });
    expect(up).toEqual({
      output: {
        id: 'r1',
        position: 1,
        values: { name: 'Ada', behaviour: 'Haggles, then gives in' },
      },
    });
    const moved = (await t.act('reorder', { id: 'r3', position: 9 })) as {
      output: CollectionRecord[];
    };
    expect(moved.output.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(await t.act('remove', { id: 'r2' })).toMatchObject({ output: { id: 'r2' } });
    // An id is never reused.
    expect(await t.act('add', { values: { name: 'Di' } })).toMatchObject({ output: { id: 'r4' } });
    expect(t.read('get', { id: 'r2' })).toEqual({ value: null });
    expect(t.read('get', { id: 'r4' })).toMatchObject({ value: { position: 2 } });
    expect(t.changes()).toEqual([
      { change: 'added', id: 'r1' },
      { change: 'added', id: 'r2' },
      { change: 'added', id: 'r3' },
      { change: 'updated', id: 'r1' },
      { change: 'reordered', id: 'r3' },
      { change: 'removed', id: 'r2' },
      { change: 'added', id: 'r4' },
    ]);
    await t.kit.stop();
  });

  it('refuses what its schema does not take, saying why', async () => {
    const t = await run();
    await t.act('add', { values: { name: 'Ada' } });
    // The schema's own checks: the control API's 400.
    expect(await t.act('add', { values: { role: 'seller' } })).toMatchObject({
      error: expect.stringContaining('name') as string,
    });
    expect(await t.act('add', { values: { name: 'Bo', role: 'villain' } })).toMatchObject({
      error: expect.stringContaining('role') as string,
    });
    expect(await t.act('add', { values: { name: 'Bo', hat: 'red' } })).toMatchObject({
      error: expect.stringContaining('hat') as string,
    });
    // The collection's: a 409.
    expect(await t.act('add', { values: { name: ' ada ' } })).toEqual({
      error: 'name: ada is record r1’s already',
      refused: true,
    });
    expect(await t.act('update', { id: 'r1', unset: ['name'] })).toEqual({
      error: 'name is required: it cannot be cleared',
      refused: true,
    });
    expect(await t.act('update', { id: 'r1', unset: ['hat'] })).toMatchObject({
      error: 'hat: no such field',
    });
    expect(await t.act('update', { id: 'r9', values: {} })).toMatchObject({
      error: 'no record r9',
    });
    expect(await t.act('remove', { id: 'r9' })).toMatchObject({ error: 'no record r9' });
    // Its own name again is its own.
    expect(await t.act('update', { id: 'r1', values: { name: 'ADA' } })).toMatchObject({
      output: { values: { name: 'ADA' } },
    });
    await t.kit.stop();
  });

  it('checks a caller through its interface as the owner’s panel', async () => {
    const t = await run();
    const cast = t.use();
    expect(cast.actions.add({ values: { name: 'Ada' } })).toMatchObject({ id: 'r1' });
    expect(() => cast.actions.add({ values: { role: 'seller' } })).toThrow('name: required');
    expect(() => cast.actions.add({ values: { name: 'Bo', role: 'villain' } })).toThrow(/^role: /u);
    expect(() => cast.actions.add({ values: 'nonsense' } as never)).toThrow('expected an object');
    expect(cast.state.schema().title).toBe('name');
    expect(cast.state.schema().fields.map((f) => f.name)).toEqual([
      'name',
      'role',
      'behaviour',
      'setting',
      'face',
    ]);
    expect(cast.state.list()).toHaveLength(1);
    expect(cast.state.get({ id: 'r1' })?.values).toEqual({ name: 'Ada' });
    await t.kit.stop();
  });
});

describe('every type of field', () => {
  it('takes a number, a yes or no and a list; names a record by its title field', async () => {
    const t = await run({
      config: {
        fields: [
          { name: 'note', type: 'text' },
          { name: 'line', type: 'text', required: true },
          { name: 'age', type: 'number', unique: true },
          { name: 'retired', type: 'boolean' },
          { name: 'tags', type: 'list' },
        ],
        title: 'line',
      },
    });
    expect(t.use().state.schema().title).toBe('line');
    expect(
      await t.act('add', { values: { line: 'Hi', age: 40, retired: false, tags: ['a', 'b'] } })
    ).toMatchObject({
      output: { values: { line: 'Hi', age: 40, retired: false, tags: ['a', 'b'] } },
    });
    expect(await t.act('add', { values: { line: 'Ho', age: 40 } })).toMatchObject({
      error: 'age: 40 is record r1’s already',
    });
    expect(await t.act('add', { values: { line: 'Ho', age: 'old' } })).toHaveProperty('error');
    await t.kit.stop();
  });

  it('has no title without a text field', async () => {
    const t = await run({ config: { fields: [{ name: 'age', type: 'number' }] } });
    expect(t.use().state.schema()).toEqual({
      fields: [{ name: 'age', type: 'number', required: false, unique: false, long: false }],
    });
    await t.kit.stop();
  });
});

describe('a collection’s media', () => {
  it('keeps the bytes once, by their hash, the record a reference; answers them as MediaResult', async () => {
    const t = await run();
    const face = fakeMedia('image/png', { size: 300, width: 64, height: 48 });
    const r = (await t.act('add', { values: { name: 'Ada', face: wire(face) } })) as {
      output: CollectionRecord;
    };
    const ref = r.output.values['face'] as { id: string; mime: string };
    expect(ref).toEqual({
      id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string,
      mime: 'image/png',
      width: 64,
      height: 48,
    });
    expect(t.files()).toEqual([mediaFileName(ref.id)]);
    expect(mediaFileName(ref.id)).toMatch(/^sha256-[0-9a-f]{64}$/u);
    // The same bytes for another record: one file.
    await t.act('add', { values: { name: 'Bo', face: wire(face) } });
    expect(t.files()).toHaveLength(1);
    const got = t.use().state.media({ id: ref.id });
    expect(got).toMatchObject({ ok: true, media: { mime: 'image/png', width: 64, height: 48 } });
    expect(got.ok && got.media?.data).toEqual(face.data);
    // Through the control API, its bytes as JSON carries them.
    const json = JSON.parse(JSON.stringify(t.read('media', { id: ref.id }), bytesJson)) as {
      value: { media: { data: Record<string, string> } };
    };
    expect(typeof json.value.media.data[BYTES_KEY]).toBe('string');
    expect(t.use().state.media({ id: `sha256:${'0'.repeat(64)}` })).toEqual({
      ok: true,
      media: null,
    });
    expect(t.use().state.media({ id: 'r1' })).toEqual({
      ok: false,
      error: 'r1 is no media id (sha256:…)',
    });
    // Replaced on one, removed with the other: its file goes with the last reference.
    const other = fakeMedia('image/jpeg', { size: 100 });
    await t.act('update', { id: 'r1', values: { face: wire(other) } });
    expect(t.files()).toHaveLength(2);
    await t.act('remove', { id: 'r2' });
    expect(t.files()).toHaveLength(1);
    await t.act('update', { id: 'r1', unset: ['face'] });
    expect(t.files()).toEqual([]);
    await t.kit.stop();
  });

  it('refuses media past its field’s limits', async () => {
    const t = await run({
      config: {
        fields: [
          { name: 'name', type: 'text' },
          { name: 'face', type: 'media', kinds: ['image'], mimes: ['image/png'], maxBytes: 100 },
        ],
      },
    });
    const add = (m: Media) => t.act('add', { values: { face: wire(m) } });
    expect(await add(fakeMedia('image/png', { size: 101 }))).toMatchObject({
      error: expect.stringContaining('more than the 100 B taken here') as string,
    });
    expect(await add(fakeMedia('application/pdf'))).toMatchObject({
      error: expect.stringContaining('not image') as string,
    });
    expect(await add(fakeMedia('image/jpeg'))).toMatchObject({
      error: expect.stringContaining('not a type taken here') as string,
    });
    expect(await add({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' })).toMatchObject({
      error: expect.stringContaining('its bytes are not image/png') as string,
    });
    expect(t.files()).toEqual([]);
    expect(await add(fakeMedia('image/png', { size: 100 }))).toHaveProperty('output');
    await t.kit.stop();
  });

  it('says why a media’s file is gone', async () => {
    const seed = collectionSeed([{ name: 'Ada', face: fakeMedia() }]);
    const t = await run({ documents: seed.documents });
    const [ada] = (t.read('list') as { value: CollectionRecord[] }).value;
    expect(ada?.incomplete).toEqual(['face: its file is gone']);
    const id = (
      (seed.documents[RECORDS_DOC] as { records: { values: { face: { id: string } } }[] })
        .records[0] as { values: { face: { id: string } } }
    ).values.face.id;
    expect(t.use().state.media({ id })).toEqual({ ok: false, error: `the file of ${id} is gone` });
    await t.kit.stop();
  });
});

describe('a schema changed under kept records', () => {
  it('drops a field gone, flags what no longer fits, starts all the same', async () => {
    const face = fakeMedia('image/png');
    const seed = collectionSeed([
      { name: 'Ada', role: 'villain', hat: 'red', face },
      { name: 'ada', role: 'seller' },
      { role: 'character', face: fakeMedia('application/pdf') },
    ]);
    const orphan = fakeMedia('image/gif');
    const files = { ...seed.files, [`sha256-${'a'.repeat(64)}`]: orphan, 'notes.txt': orphan };
    const t = await run({ documents: seed.documents, files });
    const list = (t.read('list') as { value: CollectionRecord[] }).value;
    expect(list).toEqual([
      {
        id: 'r1',
        position: 0,
        values: { name: 'Ada', face: expect.objectContaining({ mime: 'image/png' }) as object },
        incomplete: ['role: "villain" is not one of seller, character'],
      },
      {
        id: 'r2',
        position: 1,
        values: { name: 'ada', role: 'seller' },
        incomplete: ['name: ada is an earlier record’s'],
      },
      {
        id: 'r3',
        position: 2,
        values: { role: 'character' },
        incomplete: ['name is required', 'face: application/pdf is not image'],
      },
    ]);
    // The field gone is dropped, kept so; the orphan media is deleted, another file kept.
    expect(t.files().sort()).toEqual([...Object.keys(seed.files), 'notes.txt'].sort());
    expect(t.lines.join('\n')).toContain('1 value(s) of fields no longer in its schema dropped');
    expect(t.lines.join('\n')).toContain('3 record(s), 3 incomplete');
    // An update that fixes it completes it; the value it no longer took is replaced.
    expect(await t.act('update', { id: 'r1', values: { role: 'seller' } })).toMatchObject({
      output: { values: { role: 'seller' } },
    });
    expect((t.read('get', { id: 'r1' }) as { value: CollectionRecord }).value.incomplete).toBe(
      undefined
    );
    // The next record takes the next number.
    expect(await t.act('add', { values: { name: 'Cy' } })).toMatchObject({ output: { id: 'r4' } });
    await t.kit.stop();
  });

  it('reads a store with no records, or a broken one, as empty', async () => {
    const t = await run({ documents: { [RECORDS_DOC]: 'nonsense' } });
    expect(t.read('list')).toEqual({ value: [] });
    expect(await t.act('add', { values: { name: 'Ada' } })).toMatchObject({ output: { id: 'r1' } });
    await t.kit.stop();
    const u = await run({ documents: { [RECORDS_DOC]: { records: [{ id: 'r7', values: {} }] } } });
    expect(await u.act('add', { values: { name: 'Ada' } })).toMatchObject({ output: { id: 'r2' } });
    await u.kit.stop();
  });
});

describe('keptValueProblem', () => {
  const size = (): number => 10;
  it.each([
    [{ type: 'text' }, 'x', undefined],
    [{ type: 'text' }, ' ', 'not a text'],
    [{ type: 'number' }, 2, undefined],
    [{ type: 'number' }, '2', 'not a number'],
    [{ type: 'boolean' }, false, undefined],
    [{ type: 'boolean' }, 'no', 'not yes or no'],
    [{ type: 'list' }, ['a'], undefined],
    [{ type: 'list' }, [1], 'not a list of texts'],
    [{ type: 'media' }, 'x', 'not a media'],
    [
      { type: 'media', mimes: ['image/png'] },
      { id: `sha256:${'b'.repeat(64)}`, mime: 'image/gif' },
      'image/gif is not a type taken (image/png)',
    ],
    [
      { type: 'media', maxBytes: 5 },
      { id: `sha256:${'b'.repeat(64)}`, mime: 'image/gif' },
      '10 bytes, more than the 5 taken',
    ],
    [{ type: 'media' }, { id: `sha256:${'b'.repeat(64)}`, mime: 'image/gif' }, undefined],
  ])('%j: %j', (f, v, why) => {
    const spec = { name: 'f', required: false, unique: false, long: false, ...f } as never;
    expect(keptValueProblem(spec, v, size)).toBe(why);
  });
});

describe('collectionSeed', () => {
  it('makes the records’ document and their media files, ids in order', () => {
    const face = fakeMedia('image/png', { width: 3 });
    const seed = collectionSeed([{ name: 'Ada', face }, { name: 'Bo' }]);
    const doc = seed.documents[RECORDS_DOC] as {
      next: number;
      records: { id: string; values: Record<string, unknown> }[];
    };
    expect(doc.next).toBe(3);
    expect(doc.records.map((r) => r.id)).toEqual(['r1', 'r2']);
    const ref = doc.records[0]?.values['face'] as { id: string; width: number };
    expect(ref.width).toBe(3);
    expect(seed.files[mediaFileName(ref.id)]).toEqual({ data: face.data, mime: 'image/png' });
  });
});
