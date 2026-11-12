import type http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeGitHub, sha } from '#test/github.ts';
import { manifestOf, tarOf, tempDir, writeModule } from '#test/modules.ts';
import { VirtualClock } from './clock.ts';
import { controlServer, type ModuleControls } from './control-server.ts';
import { Core } from './core.ts';
import { GitHub, GitHubModules, moduleControls } from './module-github.ts';
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
      modules: moduleControls(store, undefined),
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
            source: { kind: 'tarball', installedAt: expect.any(String) as unknown },
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
      {
        error:
          'give a dir, a tarball in base64, files, a github module, or the tarball as the body',
      },
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

describe('the control API’s modules from a tree and from GitHub', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  const serve = async (modules: ModuleControls) => {
    const core = new Core({
      clock: new VirtualClock(0),
      graph: { version: 2, nodes: [], edges: [] },
    });
    await core.start();
    server = controlServer({ controls: core.controls, settings: core.settings, modules });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return async (p: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json' },
      });
      return [res.status, await res.json()] as const;
    };
  };

  it('plans a folder, looks a link up, installs from it, and checks for updates', async () => {
    const commit = sha('one');
    const gh = fakeGitHub({
      'example/games': {
        defaultBranch: 'main',
        branches: { main: commit },
        dates: { [commit]: '2026-11-01T00:00:00Z' },
        trees: {
          [commit]: {
            'modules/dice/module.json': JSON.stringify(manifestOf('dice')),
            'modules/dice/src/a.test.ts': '',
          },
        },
      },
    });
    const store = new ModuleStore(tempDir());
    const post = await serve(
      moduleControls(store, undefined, new GitHubModules(store, new GitHub({ fetch: gh.fetch })))
    );
    expect(
      await post('/modules/plan', {
        paths: ['games/dice/module.json', 'games/dice/src/a.ts'],
        manifests: { 'games/dice/module.json': JSON.stringify(manifestOf('dice')) },
      })
    ).toEqual([
      200,
      [
        {
          path: 'games/dice',
          id: 'dice',
          version: '0.1.0',
          status: 'new',
          files: ['games/dice/module.json', 'games/dice/src/a.ts'],
          left: [],
        },
      ],
    ]);
    expect(await post('/modules/plan', { paths: [1], manifests: {} })).toEqual([
      400,
      { error: 'give {"paths": ["…"], "manifests": {"<path>": "<text>"}}' },
    ]);
    expect(await post('/modules/plan', { paths: [] })).toMatchObject([400, {}]);
    const [status, found] = await post('/modules/github', {
      url: 'https://github.com/example/games',
    });
    expect(status).toBe(200);
    expect(found).toMatchObject({
      source: { repo: 'example/games', ref: 'main', commit },
      modules: [{ id: 'dice', left: ['modules/dice/src/a.test.ts'] }],
    });
    expect(await post('/modules/github', {})).toEqual([
      400,
      { error: 'give {"url": "<a GitHub link>"}' },
    ]);
    expect(await post('/modules/github', { url: 'https://github.com/example/none' })).toEqual([
      404,
      { error: 'github.com/example/none is not found (a private repository is not supported)' },
    ]);
    expect(
      await post('/modules', {
        github: {
          repo: 'example/games',
          ref: 'main',
          refType: 'branch',
          path: 'modules/dice',
          commit,
          commitDate: 'x',
        },
      })
    ).toEqual([200, { id: 'dice', version: '0.1.0', left: 1 }]);
    expect(await post('/modules', { github: { repo: 'example/games' } })).toEqual([
      400,
      { error: 'github: {"repo": "<owner>/<repo>", "ref", "path", "commit"?}' },
    ]);
    expect(
      await post('/modules', { github: { repo: 'example/games', ref: 'main', refType: 'odd' } })
    ).toEqual([400, { error: 'no module at the root of example/games@' + commit.slice(0, 7) }]);
    const [, report] = await post('/modules/updates');
    expect(report).toMatchObject({
      installed: [{ id: 'dice', source: { kind: 'github', commitDate: 'x' } }],
      updates: { checkedAt: expect.any(String) as unknown },
    });
  });

  it('offers no plan, link or check where the wiring does not', async () => {
    const post = await serve({ report: () => ({}), install: () => ({}), rollback: () => ({}) });
    expect(await post('/modules/plan', { paths: [], manifests: {} })).toEqual([
      404,
      { error: 'not found' },
    ]);
    expect(await post('/modules/github', { url: 'x' })).toEqual([404, { error: 'not found' }]);
    expect(await post('/modules/updates')).toEqual([404, { error: 'not found' }]);
  });
});
