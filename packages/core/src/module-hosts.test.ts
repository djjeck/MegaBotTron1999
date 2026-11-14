import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeGitea } from '#test/gitea.ts';
import { fakeGitHub, sha } from '#test/github.ts';
import { manifestOf, tempDir } from '#test/modules.ts';
import { GitModules, HostNotAllowed, moduleControls } from './module-git.ts';
import { GitHub } from './module-github.ts';
import { GitHostList, hostName, SERVERS_DOC } from './module-hosts.ts';
import { ModuleStore } from './module-store.ts';
import { Stores } from './store.ts';

const HOST = 'git.example.lan';
const MAIN1 = sha('h-main1');
const MAIN2 = sha('h-main2');
const TAG1 = sha('h-tag1');
const TAG2 = sha('h-tag2');

const manifest = (id: string, version: string): string =>
  JSON.stringify(manifestOf(id, { version, plugins: ['src/p.ts'] }));
const tree = (v: string): Record<string, string> => ({
  'modules/dice/module.json': manifest('dice', v),
  'modules/dice/src/p.ts': 'export const plugins = [];',
  'modules/dice/src/p.test.ts': 'test',
  'vendor/Shell/modules/x/module.json': manifest('x', v),
});

/** A private repository on a self-hosted server, a GitHub one beside it, and the hosts allowed. */
function setup(o: { secrets?: Record<string, string> } = {}) {
  const secrets = o.secrets ?? { git_example_token: 'good-token-1', other_token: 'other-token-2' };
  const gitea = fakeGitea(
    HOST,
    {
      'example/games': {
        private: true,
        defaultBranch: 'main',
        branches: { main: MAIN1 },
        tags: { 'v0.1.0': TAG1 },
        dates: {
          [MAIN1]: '2026-11-01T10:00:00Z',
          [MAIN2]: '2026-11-02T10:00:00Z',
          [TAG1]: '2026-10-01T10:00:00Z',
          [TAG2]: '2026-10-15T10:00:00Z',
        },
        trees: {
          [MAIN1]: tree('0.1.0'),
          [MAIN2]: tree('0.2.0'),
          [TAG1]: tree('0.1.0'),
          [TAG2]: tree('0.2.0'),
        },
      },
    },
    { token: 'good-token-1' }
  );
  const gh = fakeGitHub({});
  const other = fakeGitea('code.example.lan', {});
  const fetch = ((input, init) => {
    const host = new URL(String(input)).host;
    return (host.endsWith('github.com') ? gh : host === 'code.example.lan' ? other : gitea).fetch(
      input,
      init
    );
  }) as typeof globalThis.fetch;
  const store = new Stores().open('core');
  const read: string[] = [];
  const list = new GitHostList({
    store,
    github: new GitHub({ fetch }),
    read: (name) => {
      read.push(name);
      return secrets[name];
    },
    names: () => Object.keys(secrets),
    fetch,
  });
  const now = Date.parse('2026-11-12T12:00:00Z');
  const modules = new ModuleStore(path.join(tempDir(), 'modules'), () => now);
  const git = new GitModules(modules, list.get, () => now);
  return { gitea, gh, store, list, modules, git, read, fetch };
}

describe('a Git server’s host, as the owner types it', () => {
  it('is normalised, and refused when it is not a host over https', () => {
    expect(hostName(' git.example.lan ')).toBe(HOST);
    expect(hostName('https://GIT.example.lan/')).toBe(HOST);
    expect(hostName('git.example.lan:3000')).toBe('git.example.lan:3000');
    expect(() => hostName('http://git.example.lan')).toThrow('reached over https only');
    expect(() => hostName('git.example.lan/sub')).toThrow('a server under a path is not supported');
    expect(() => hostName('alice@git.example.lan')).toThrow('is not a host');
    expect(() => hostName('')).toThrow('is not a host');
    expect(() => hostName('git example')).toThrow('is not a host');
    expect(() => hostName('github.com')).toThrow('GitHub is always allowed');
  });
});

describe('the hosts allowed', () => {
  it('are GitHub and the servers added, each probed, kept as names, never tokens', async () => {
    const { list, store, gitea } = setup();
    expect(list.list()).toEqual({ servers: [], secrets: ['git_example_token', 'other_token'] });
    expect(list.get('github.com').host).toBe('github.com');
    expect(() => list.get(HOST)).toThrow(HostNotAllowed);
    expect(() => list.get(HOST)).toThrow(
      `${HOST} is not an allowed host: add it under Git servers on the Modules page`
    );
    expect(await list.add({ host: `https://${HOST}`, secret: 'git_example_token' })).toEqual({
      servers: [{ host: HOST, api: 'gitea', secret: 'git_example_token' }],
      secrets: ['git_example_token', 'other_token'],
    });
    expect(gitea.calls).toEqual([`${HOST}/api/v1/version token good-token-1`]);
    expect(JSON.stringify(store.read(SERVERS_DOC))).not.toContain('good-token-1');
    expect(list.get('GIT.example.lan').host).toBe(HOST);
    expect(list.get(HOST)).toBe(list.get(HOST));
    expect(list.secrets()).toEqual(['git_example_token']);
    // A second server, public: no secret.
    await list.add({ host: 'code.example.lan', secret: '' });
    expect(list.servers().map((s) => [s.host, s.secret])).toEqual([
      ['code.example.lan', undefined],
      [HOST, 'git_example_token'],
    ]);
    // Kept: another list over the same store has them.
    expect(list.remove('code.example.lan').servers).toHaveLength(1);
    expect(() => list.remove('code.example.lan')).toThrow(
      'code.example.lan is not a Git server added'
    );
  });

  it('refuses a secret not mounted, or not readable, and a token the server refuses', async () => {
    const { list } = setup({ secrets: { git_example_token: 'bad-token-3', empty: '' } });
    await expect(list.add({ host: HOST, secret: 'nope' })).rejects.toThrow(
      'no Docker secret nope: pick one of those mounted under /run/secrets'
    );
    const unreadable = new GitHostList({
      store: new Stores().open('core'),
      github: new GitHub(),
      read: () => undefined,
      names: () => ['ghost'],
    });
    await expect(unreadable.add({ host: HOST, secret: 'ghost' })).rejects.toThrow(
      'the secret ghost does not read'
    );
    await expect(list.add({ host: HOST, secret: 'git_example_token' })).rejects.toMatchObject({
      message: `${HOST} refused the token in the secret git_example_token (401): check it, or replace it`,
      status: 401,
    });
    expect(list.servers()).toEqual([]);
    expect(unreadable.servers()).toEqual([]);
  });
});

describe('modules from a self-hosted Git server', () => {
  it('are looked up, installed with their source, and checked for updates', async () => {
    const { list, git, modules, gitea, read } = setup();
    // Not allowed yet: nothing fetched.
    await expect(git.lookup(`https://${HOST}/example/games`)).rejects.toMatchObject({
      status: 403,
    });
    expect(gitea.calls).toEqual([]);
    await list.add({ host: HOST, secret: 'git_example_token' });
    const found = await git.lookup(`https://${HOST}/example/games`);
    expect(found.source).toEqual({
      kind: 'git',
      host: HOST,
      api: 'gitea',
      repo: 'example/games',
      ref: 'main',
      refType: 'branch',
      path: '',
      commit: MAIN1,
      commitDate: '2026-11-01T10:00:00Z',
    });
    // vendor/ is skipped, as for a folder.
    expect(found.modules.map((m) => [m.id, m.path, m.left])).toEqual([
      ['dice', 'modules/dice', ['modules/dice/src/p.test.ts']],
    ]);
    expect(read).toContain('git_example_token');
    // Every request went to the host, with its token.
    expect(gitea.calls.every((c) => c.startsWith(HOST) && c.endsWith(' token good-token-1'))).toBe(
      true
    );
    const installed = await git.install({
      host: HOST,
      repo: 'example/games',
      ref: 'main',
      refType: 'branch',
      path: 'modules/dice',
      commit: MAIN1,
    });
    expect(installed).toMatchObject({ id: 'dice', version: '0.1.0', left: 1 });
    expect(modules.sources()['dice']?.current).toMatchObject({
      kind: 'git',
      host: HOST,
      commit: MAIN1,
    });
    // The branch moves: an update, linked to the server's comparison.
    gitea.repos['example/games']!.branches = { main: MAIN2 };
    const report = git.decorate(modules.report(undefined));
    expect(report.installed[0]?.update).toBeUndefined();
    await git.check();
    expect(git.decorate(modules.report(undefined)).installed[0]?.update).toEqual({
      ref: 'main',
      commit: MAIN2,
      commitDate: '2026-11-02T10:00:00Z',
      compare: `https://${HOST}/example/games/compare/${MAIN1}...${MAIN2}`,
    });
    // A module installed from a tag: a newer semver tag is its update.
    gitea.repos['example/games']!.tags = { 'v0.1.0': TAG1, 'v0.2.0': TAG2 };
    await git.install({
      host: HOST,
      repo: 'example/games',
      ref: 'v0.1.0',
      refType: 'tag',
      path: 'modules/dice',
    });
    await git.check();
    expect(git.decorate(modules.report(undefined)).installed[0]?.update).toMatchObject({
      ref: 'v0.2.0',
      commit: TAG2,
      commitDate: '2026-10-15T10:00:00Z',
    });
    // The server removed: its modules are not checked, and the check says why.
    list.remove(HOST);
    const state = await git.check();
    expect(state.error).toContain(`${HOST} is not an allowed host`);
    expect(git.decorate(modules.report(undefined)).installed[0]?.update).toBeUndefined();
    await expect(
      git.install({ host: HOST, repo: 'example/games', ref: 'main', path: 'modules/dice' })
    ).rejects.toThrow(HostNotAllowed);
  });

  it('says a ref gone on the server, and installs from a ref’s head', async () => {
    const { list, git } = setup();
    await list.add({ host: HOST, secret: 'git_example_token' });
    await expect(
      git.install({ host: HOST, repo: 'example/games', ref: 'gone', path: 'modules/dice' })
    ).rejects.toMatchObject({
      message: `${HOST}/example/games has no branch, tag or commit gone`,
      status: 404,
    });
    expect(
      await git.install({ host: HOST, repo: 'example/games', ref: 'main', path: 'modules/dice' })
    ).toMatchObject({ id: 'dice' });
  });

  it('are the control API’s: the hosts listed, added and removed', async () => {
    const { list, git, modules } = setup();
    const controls = moduleControls(modules, undefined, git, () => [], list);
    expect(controls.hosts?.list()).toMatchObject({ servers: [] });
    await controls.hosts?.add({ host: HOST, secret: 'git_example_token' });
    expect(
      await controls.lookup?.(`https://${HOST}/example/games/src/branch/main/modules/dice`)
    ).toMatchObject({
      modules: [{ id: 'dice' }],
    });
    expect(controls.hosts?.remove(HOST)).toMatchObject({ servers: [] });
    expect(moduleControls(modules, undefined, git).hosts).toBeUndefined();
  });

  it('refuses a link that is not https, or not a link', async () => {
    const { git } = setup();
    await expect(git.lookup('http://git.example.lan/example/games')).rejects.toThrow(
      'a repository’s link is https://<host>/<owner>/<repo>'.replace('’', "'")
    );
    await expect(git.lookup('nothing')).rejects.toThrow('nothing is not a link');
  });
});
