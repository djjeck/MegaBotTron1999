import type http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { manifestOf, tarOf, tempDir, writeModule } from '#test/modules.ts';
import { VirtualClock } from './clock.ts';
import { controlServer } from './control-server.ts';
import { Core } from './core.ts';
import { ModuleStore } from './module-store.ts';
import { definePlugin, type Plugin } from './plugin.ts';

const plugin = (id: string, description = 'A test plugin'): Plugin =>
  definePlugin({
    manifest: { id, version: '0.2.0', kinds: ['stats'], description },
    create: () => ({}),
  });

describe('the plugins available', () => {
  it('are the image’s and the modules’, each with its module', async () => {
    const core = new Core({
      clock: new VirtualClock(0),
      graph: { version: 2, nodes: [], edges: [] },
    });
    const broken = { manifest: { id: 'Broken' }, create: () => ({}) } as unknown as Plugin;
    core.register(plugin('image-plugin'));
    core.registerModule('dice', [plugin('dice-stats', 'Counts rolls'), broken]);
    const available = core.available();
    expect(available).toMatchObject([
      {
        id: 'image-plugin',
        plugin: 'image-plugin',
        version: '0.2.0',
        description: 'A test plugin',
        kinds: ['stats'],
        // What the editor draws and forms a node of it with.
        inputs: {},
        outputs: { interface: { type: 'interface', optional: false } },
        secrets: [],
        configSecrets: [],
        events: [],
      },
      {
        id: 'dice-stats',
        version: '0.2.0',
        description: 'Counts rolls',
        kinds: ['stats'],
        module: 'dice',
      },
    ]);
    expect(available).toHaveLength(2);
    expect(available[0]).not.toHaveProperty('module');
  });
});

describe('the control API’s modules', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('lists, installs from a directory or a tarball, and rolls back', async () => {
    const core = new Core({
      clock: new VirtualClock(0),
      graph: { version: 2, nodes: [], edges: [] },
    });
    core.register(plugin('image-plugin'));
    await core.start();
    const store = new ModuleStore(tempDir());
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      available: () => core.available(),
      secrets: () => ['api_key'],
      modules: {
        report: () => store.report(),
        install: (s) => store.install(s),
        rollback: (id) => store.rollback(id),
      },
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const call = async (p: string, body?: string | Uint8Array, type = 'application/json') => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        ...(body === undefined ? {} : { method: 'POST', body, headers: { 'content-type': type } }),
      });
      return [res.status, await res.json()] as const;
    };
    const tarball = (v: string) =>
      zlib.gzipSync(
        tarOf([{ name: 'module.json', data: JSON.stringify(manifestOf('dice', { version: v })) }])
      );

    expect(await call('/available')).toEqual([
      200,
      [
        expect.objectContaining({
          id: 'image-plugin',
          version: '0.2.0',
          description: 'A test plugin',
          kinds: ['stats'],
        }),
      ],
    ]);
    expect(await call('/secrets')).toEqual([200, { names: ['api_key'] }]);
    const dir = writeModule(tempDir(), 'dice', manifestOf('dice'));
    expect(await call('/modules', JSON.stringify({ dir }))).toEqual([
      200,
      { id: 'dice', version: '0.1.0' },
    ]);
    expect(await call('/modules', tarball('0.2.0'), 'application/gzip')).toEqual([
      200,
      { id: 'dice', version: '0.2.0', previous: '0.1.0' },
    ]);
    const b64 = JSON.stringify({ tarball: tarball('0.3.0').toString('base64') });
    expect((await call('/modules', b64))[1]).toEqual({
      id: 'dice',
      version: '0.3.0',
      previous: '0.2.0',
    });
    expect(await call('/modules')).toEqual([
      200,
      {
        installed: [
          {
            id: 'dice',
            version: '0.3.0',
            provides: '@example/dice',
            imports: {},
            plugins: [],
            previous: '0.2.0',
          },
        ],
        failures: [],
        restart: true,
      },
    ]);
    expect(await call('/modules/dice/rollback', '')).toEqual([
      200,
      { id: 'dice', version: '0.2.0', previous: '0.3.0' },
    ]);
    expect(await call('/modules/cards/rollback', '')).toEqual([
      409,
      { error: 'cards has no previous version' },
    ]);
    const files = (v: string, ...more: { path: string; content: string }[]) =>
      JSON.stringify({
        files: [
          {
            path: 'dice/module.json',
            content: Buffer.from(JSON.stringify(manifestOf('dice', { version: v }))).toString(
              'base64'
            ),
          },
          ...more,
        ],
      });
    expect(await call('/modules', files('0.4.0'))).toEqual([
      200,
      { id: 'dice', version: '0.4.0', previous: '0.2.0' },
    ]);
    expect(await call('/modules', files('0.5.0', { path: 'dice/../../x', content: '' }))).toEqual([
      400,
      { error: "dice/../../x leaves the module's directory" },
    ]);
    expect(await call('/modules', JSON.stringify({ files: [{ path: 'module.json' }] }))).toEqual([
      400,
      { error: 'files: each is {"path": "…", "content": "<base64>"}' },
    ]);
    expect(await call('/modules', JSON.stringify({}))).toEqual([
      400,
      { error: 'give a dir, a tarball in base64, files, or the tarball as the body' },
    ]);
    expect(await call('/modules', JSON.stringify({ dir: path.join(store.dir, 'x') }))).toEqual([
      400,
      { error: `${path.join(store.dir, 'x')} is not a directory` },
    ]);
  });

  it('refuses an upload too large, and passes other errors on', async () => {
    const core = new Core({
      clock: new VirtualClock(0),
      graph: { version: 2, nodes: [], edges: [] },
    });
    await core.start();
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      modules: {
        report: () => ({}),
        install: () => {
          throw new Error('disk full');
        },
        rollback: () => {
          throw new Error('disk full');
        },
      },
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const post = async (p: string, body: string | Uint8Array, type = 'application/json') => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        body,
        headers: { 'content-type': type },
      });
      return [res.status, await res.json()] as const;
    };
    expect(await post('/modules', JSON.stringify({ dir: '/x' }))).toEqual([
      400,
      { error: 'Error: disk full' },
    ]);
    expect(await post('/modules/dice/rollback', '')).toEqual([400, { error: 'Error: disk full' }]);
    const half = Buffer.alloc(32 * 2 ** 20 + 1).toString('base64');
    const files = [
      { path: 'a', content: half },
      { path: 'b', content: half },
    ];
    expect(await post('/modules', JSON.stringify({ files }))).toEqual([
      400,
      { error: `the files are over ${64 * 2 ** 20} bytes` },
    ]);
    const big = new Uint8Array(64 * 2 ** 20 + 1);
    expect(await post('/modules', big, 'application/octet-stream')).toEqual([
      400,
      { error: `the body is over ${64 * 2 ** 20} bytes` },
    ]);
  });
});
