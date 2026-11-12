import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeGitHub, sha } from '#test/github.ts';
import { manifestOf, tempDir, writeModule } from '#test/modules.ts';
import {
  CHECK_EVERY,
  GitHub,
  GitHubError,
  GitHubModules,
  moduleControls,
  newerTag,
  parseGitHubUrl,
} from './module-github.ts';
import { ModuleStore } from './module-store.ts';

const manifest = (id: string, version = '0.1.0', more: Record<string, unknown> = {}): string =>
  JSON.stringify(manifestOf(id, { version, plugins: ['src/p.ts'], ...more }));

const MAIN1 = sha('main1');
const MAIN2 = sha('main2');
const TAG1 = sha('tag1');
const TAG2 = sha('tag2');

/** A synthetic repository of two modules, a vendored copy and tests, at two commits of main. */
function repos() {
  const files = (v: string): Record<string, string> => ({
    'README.md': '# Example',
    'modules/dice/module.json': manifest('dice', v),
    'modules/dice/src/p.ts': 'export const plugins = [];',
    'modules/dice/src/p.test.ts': 'test',
    'modules/cards/module.json': manifest('cards', v),
    'modules/cards/src/p.ts': 'export const plugins = [];',
    'vendor/Shell/modules/x/module.json': manifest('x'),
  });
  return {
    'example/games': {
      defaultBranch: 'main',
      branches: { main: MAIN1, 'feature/new': MAIN2 },
      tags: { 'v0.1.0': TAG1, 'v0.2.0': TAG2, 'v0.3.0-rc.1': MAIN2, 'not-semver': MAIN2 },
      dates: {
        [MAIN1]: '2026-11-01T10:00:00Z',
        [MAIN2]: '2026-11-02T10:00:00Z',
        [TAG1]: '2026-10-01T10:00:00Z',
        [TAG2]: '2026-10-15T10:00:00Z',
      },
      trees: {
        [MAIN1]: files('0.1.0'),
        [MAIN2]: files('0.2.0'),
        [TAG1]: files('0.1.0'),
        [TAG2]: files('0.2.0'),
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a GitHub link', () => {
  it('is a repository’s, or a tree’s with its ref and path', () => {
    expect(parseGitHubUrl('https://github.com/example/games')).toEqual({ repo: 'example/games' });
    expect(parseGitHubUrl(' https://www.github.com/example/games.git/ ')).toEqual({
      repo: 'example/games',
    });
    expect(parseGitHubUrl('https://github.com/example/games/tree/main/modules/dice')).toEqual({
      repo: 'example/games',
      tree: ['main', 'modules', 'dice'],
    });
    for (const bad of [
      'nonsense',
      'https://gitlab.com/example/games',
      'https://github.com/example',
      'https://github.com/example/games/blob/main/x',
      'https://github.com/example/games/tree',
    ])
      expect(() => parseGitHubUrl(bad), bad).toThrow(GitHubError);
  });

  it('resolves to the default branch, a branch with slashes, a tag or a commit', async () => {
    const gh = fakeGitHub(repos());
    const github = new GitHub({ fetch: gh.fetch });
    expect(await github.resolve('https://github.com/example/games')).toEqual({
      kind: 'github',
      repo: 'example/games',
      ref: 'main',
      refType: 'branch',
      path: '',
      commit: MAIN1,
      commitDate: '2026-11-01T10:00:00Z',
    });
    expect(
      await github.resolve('https://github.com/example/games/tree/feature/new/modules/dice')
    ).toMatchObject({ ref: 'feature/new', refType: 'branch', path: 'modules/dice', commit: MAIN2 });
    expect(await github.resolve('https://github.com/example/games/tree/v0.1.0')).toMatchObject({
      ref: 'v0.1.0',
      refType: 'tag',
      path: '',
      commit: TAG1,
    });
    expect(
      await github.resolve(`https://github.com/example/games/tree/${MAIN2.slice(0, 7)}/modules`)
    ).toMatchObject({ ref: MAIN2, refType: 'commit', path: 'modules' });
    await expect(github.resolve('https://github.com/example/nothing')).rejects.toThrow(
      'github.com/example/nothing is not found (a private repository is not supported)'
    );
    await expect(github.resolve('https://github.com/example/games/tree/gone/x')).rejects.toThrow(
      'has no branch, tag or commit gone'
    );
    // No token: no authorization header.
    expect(gh.calls.every((c) => !c.includes('Bearer'))).toBe(true);
  });

  it('says so when a repository has no commit on its default branch', async () => {
    const gh = fakeGitHub({ 'example/empty': { defaultBranch: 'main' } });
    await expect(
      new GitHub({ fetch: gh.fetch }).resolve('https://github.com/example/empty')
    ).rejects.toThrow('example/empty has no commit on main');
  });

  it('sends a token when it has one', async () => {
    const gh = fakeGitHub(repos());
    await new GitHub({ fetch: gh.fetch, token: 't0ken' }).commit('example/games', 'main');
    expect(gh.calls).toEqual([
      'api.github.com/repos/example/games/commits?sha=main&per_page=1 Bearer t0ken',
    ]);
  });

  it('fetches the tarball once for a commit, its top directory stripped', async () => {
    const gh = fakeGitHub(repos());
    const github = new GitHub({ fetch: gh.fetch });
    const tree = await github.tree('example/games', MAIN1);
    expect(tree.listing.paths).toContain('modules/dice/src/p.ts');
    expect(Object.keys(tree.listing.manifests)).toEqual([
      'modules/dice/module.json',
      'modules/cards/module.json',
      'vendor/Shell/modules/x/module.json',
    ]);
    expect(Buffer.from(tree.files.get('README.md') ?? []).toString()).toBe('# Example');
    await github.tree('example/games', MAIN1);
    await github.tree('example/games', MAIN2);
    await github.tree('example/games', TAG1);
    await github.tree('example/games', MAIN1);
    expect(gh.calls.filter((c) => c.startsWith('codeload'))).toEqual([
      `codeload.github.com/example/games/tar.gz/${MAIN1}`,
      `codeload.github.com/example/games/tar.gz/${MAIN2}`,
      `codeload.github.com/example/games/tar.gz/${TAG1}`,
      // Only the last two are kept.
      `codeload.github.com/example/games/tar.gz/${MAIN1}`,
    ]);
    await expect(github.tree('example/games', sha('nowhere'))).rejects.toThrow(
      "GitHub's tarball of example/games: 404"
    );
  });

  it('waits out a rate limit, making no request until its reset', async () => {
    let now = Date.parse('2026-11-12T12:00:00Z');
    const gh = fakeGitHub(repos());
    const github = new GitHub({ fetch: gh.fetch, now: () => now });
    gh.fail = () =>
      new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 1800) },
      });
    const limit =
      "GitHub's rate limit is reached until 12:30 UTC (60 requests an hour without a token): try again then";
    await expect(github.commit('example/games', 'main')).rejects.toThrow(limit);
    delete gh.fail;
    await expect(github.commit('example/games', 'main')).rejects.toMatchObject({
      message: limit,
      status: 429,
    });
    expect(gh.calls).toHaveLength(1);
    now += 1800_000;
    expect(await github.commit('example/games', 'main')).toMatchObject({ commit: MAIN1 });
    // A Retry-After, as a secondary limit gives it.
    gh.fail = () => new Response('', { status: 429, headers: { 'retry-after': '60' } });
    const withToken = new GitHub({ fetch: gh.fetch, now: () => now, token: 't' });
    await expect(withToken.commit('example/games', 'main')).rejects.toThrow(
      "GitHub's rate limit is reached until 12:31 UTC: try again then"
    );
    // Neither: a minute.
    gh.fail = () => new Response('', { status: 429, headers: { 'x-ratelimit-remaining': '0' } });
    await expect(
      new GitHub({ fetch: gh.fetch, now: () => now }).commit('example/games', 'main')
    ).rejects.toThrow('12:31 UTC');
  });

  it('says what went wrong with the network or GitHub', async () => {
    const down = new GitHub({ fetch: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) });
    await expect(down.commit('example/games', 'main')).rejects.toMatchObject({
      message: 'GitHub could not be reached: getaddrinfo ENOTFOUND',
      status: 502,
    });
    const gh = fakeGitHub(repos());
    gh.fail = () => new Response('{"message":"Server Error"}', { status: 500 });
    await expect(new GitHub({ fetch: gh.fetch }).commit('example/games', 'main')).rejects.toThrow(
      'GitHub answered 500: Server Error'
    );
    gh.fail = () => new Response('<html>', { status: 403 });
    await expect(new GitHub({ fetch: gh.fetch }).commit('example/games', 'main')).rejects.toThrow(
      /^GitHub answered 403$/u
    );
    gh.fail = () => new Response('{}');
    expect(await new GitHub({ fetch: gh.fetch }).commit('example/games', 'main')).toBeUndefined();
    expect(await new GitHub({ fetch: gh.fetch }).tags('example/games')).toEqual([]);
    gh.fail = () => new Response('[{"sha":"x","commit":{}}]');
    expect(await new GitHub({ fetch: gh.fetch }).commit('example/games', 'main')).toEqual({
      commit: 'x',
    });
  });

  it('refuses a tarball too large', async () => {
    const huge = new GitHub({
      fetch: () => Promise.resolve(new Response(new Uint8Array(256 * 2 ** 20 + 1))),
    });
    await expect(huge.tree('example/games', MAIN1)).rejects.toThrow('tarball is over');
  });
});

describe('the newest tag', () => {
  const tags = ['v0.1.0', 'v0.2.0', '0.10.0', 'v1.0.0-rc.1', 'latest'].map((name) => ({ name }));
  it('is a newer semver tag, pre-releases only after a pre-release', () => {
    expect(newerTag(tags, 'v0.1.0')?.name).toBe('0.10.0');
    expect(newerTag(tags, 'v0.10.0')).toBeUndefined();
    expect(newerTag(tags, 'v1.0.0-alpha.1')?.name).toBe('v1.0.0-rc.1');
    expect(newerTag(tags, 'latest')).toBeUndefined();
  });
});

describe('modules from GitHub', () => {
  const setup = (more: { token?: string } = {}) => {
    const gh = fakeGitHub(repos());
    let now = Date.parse('2026-11-12T12:00:00Z');
    const store = new ModuleStore(path.join(tempDir(), 'modules'), () => now);
    const modules = new GitHubModules(
      store,
      new GitHub({ fetch: gh.fetch, now: () => now, ...more }),
      () => now
    );
    return { gh, store, modules, tick: (ms: number) => (now += ms) };
  };

  it('looks a link up: its modules, compared with those installed, vendor/ left out', async () => {
    const { store, modules } = setup();
    writeModule(store.dir, 'dice', manifestOf('dice', { version: '0.0.9' }));
    const found = await modules.lookup('https://github.com/example/games');
    expect(found.source).toMatchObject({ repo: 'example/games', ref: 'main', commit: MAIN1 });
    expect(found.modules.map((m) => [m.id, m.path, m.status, m.files.length, m.left])).toEqual([
      ['cards', 'modules/cards', 'new', 2, []],
      ['dice', 'modules/dice', 'update', 2, ['modules/dice/src/p.test.ts']],
    ]);
    // Inside a path: only what is under it.
    const one = await modules.lookup('https://github.com/example/games/tree/main/modules/dice');
    expect(one.modules.map((m) => m.id)).toEqual(['dice']);
  });

  it('installs a module at its commit, recording its source, from one download', async () => {
    const { gh, store, modules } = setup();
    const pick = {
      repo: 'example/games',
      ref: 'main',
      refType: 'branch' as const,
      commit: MAIN1,
      commitDate: '2026-11-01T10:00:00Z',
    };
    expect(await modules.install({ ...pick, path: 'modules/dice' })).toEqual({
      id: 'dice',
      version: '0.1.0',
      left: 1,
    });
    await modules.install({ ...pick, path: 'modules/cards' });
    expect(gh.calls.filter((c) => c.startsWith('codeload'))).toHaveLength(1);
    expect(gh.calls.filter((c) => c.startsWith('api'))).toHaveLength(0);
    expect(fs.readdirSync(path.join(store.dir, 'dice', 'src'))).toEqual(['p.ts']);
    expect(store.report().installed[1]?.source).toEqual({
      kind: 'github',
      repo: 'example/games',
      ref: 'main',
      refType: 'branch',
      path: 'modules/dice',
      commit: MAIN1,
      commitDate: '2026-11-01T10:00:00Z',
      installedAt: '2026-11-12T12:00:00.000Z',
    });
    // No commit: the ref's head; no ref type: a branch.
    await modules.install({ repo: 'example/games', ref: 'feature/new', path: 'modules/dice' });
    expect(store.report().installed[1]).toMatchObject({
      version: '0.2.0',
      previous: '0.1.0',
      source: { ref: 'feature/new', refType: 'branch', commit: MAIN2 },
    });
    await modules.install({ repo: 'example/games', ref: MAIN2, path: 'modules/cards' });
    expect(store.report().installed[0]?.source).toMatchObject({ refType: 'commit' });
  });

  it('refuses what is not a module of the source', async () => {
    const { modules } = setup();
    const base = { repo: 'example/games', ref: 'main', commit: MAIN1 };
    await expect(modules.install({ ...base, path: 'modules/none' })).rejects.toThrow(
      `no module at modules/none of example/games@${MAIN1.slice(0, 7)}`
    );
    await expect(modules.install({ ...base, path: '' })).rejects.toThrow('no module at the root');
    await expect(modules.install({ ...base, path: 'vendor/Shell/modules/x' })).rejects.toThrow(
      'no module at vendor/Shell/modules/x'
    );
    await expect(modules.install({ ...base, repo: 'not a repo', path: '' })).rejects.toThrow(
      'github: {"repo"'
    );
    await expect(modules.install({ ...base, commit: 'abc', path: '' })).rejects.toThrow('github:');
    await expect(
      modules.install({ repo: 'example/games', ref: 'gone', path: 'modules/dice' })
    ).rejects.toThrow('example/games has no branch, tag or commit gone');
  });

  it('refuses a module whose manifest does not read', async () => {
    const gh = fakeGitHub({
      'example/bad': { trees: { [MAIN1]: { 'module.json': '{' } } },
    });
    const modules = new GitHubModules(new ModuleStore(tempDir()), new GitHub({ fetch: gh.fetch }));
    await expect(
      modules.install({ repo: 'example/bad', ref: 'main', commit: MAIN1, path: '' })
    ).rejects.toThrow(/^module\.json: /u);
  });

  it('skips the modules removed: never checked, no update shown', async () => {
    const { gh, store, modules } = setup();
    const base = { repo: 'example/games', ref: 'main', refType: 'branch' as const };
    await modules.install({ ...base, commit: MAIN1, path: 'modules/dice' });
    await modules.install({ ...base, commit: MAIN1, path: 'modules/cards' });
    gh.repos['example/games']!.branches!.main = MAIN2;
    await modules.check();
    store.remove('dice');
    const report = modules.decorate(store.report());
    expect(report.installed.map((m) => [m.id, m.update?.commit])).toEqual([['cards', MAIN2]]);
    expect(report.removed).toEqual([
      expect.not.objectContaining({ update: expect.anything() as unknown }),
    ]);
    store.remove('cards');
    gh.calls.length = 0;
    await modules.check();
    expect(gh.calls).toEqual([]);
  });

  it('finds updates: a branch moved, a newer tag, each ref resolved once', async () => {
    const { gh, store, modules, tick } = setup();
    const base = { repo: 'example/games', ref: 'main', refType: 'branch' as const };
    await modules.install({ ...base, commit: MAIN1, path: 'modules/dice' });
    await modules.install({ ...base, commit: MAIN1, path: 'modules/cards' });
    expect(modules.decorate(store.report()).updates).toEqual({});
    gh.repos['example/games']!.branches!.main = MAIN2;
    gh.calls.length = 0;
    tick(60_000);
    expect(await modules.check()).toEqual({ checkedAt: '2026-11-12T12:01:00.000Z' });
    expect(gh.calls).toEqual(['api.github.com/repos/example/games/commits?sha=main&per_page=1']);
    const report = modules.decorate(store.report());
    expect(report.installed.map((m) => m.update)).toEqual([
      {
        ref: 'main',
        commit: MAIN2,
        commitDate: '2026-11-02T10:00:00Z',
        compare: `https://github.com/example/games/compare/${MAIN1}...${MAIN2}`,
      },
      expect.objectContaining({ commit: MAIN2 }),
    ]);
    // Updated: no update shown, with no new check.
    await modules.install({ ...base, commit: MAIN2, path: 'modules/dice' });
    expect(modules.decorate(store.report()).installed.map((m) => m.update?.commit)).toEqual([
      MAIN2,
      undefined,
    ]);

    // A tag: the newest semver tag after it, its date asked once.
    await modules.install({
      ...base,
      ref: 'v0.1.0',
      refType: 'tag',
      commit: TAG1,
      path: 'modules/cards',
    });
    gh.calls.length = 0;
    await modules.check();
    await modules.check();
    expect(gh.calls.filter((c) => c.includes('/tags'))).toHaveLength(2);
    expect(gh.calls.filter((c) => c.includes(`sha=${TAG2}`))).toHaveLength(1);
    expect(modules.decorate(store.report()).installed[0]?.update).toEqual({
      ref: 'v0.2.0',
      commit: TAG2,
      commitDate: '2026-10-15T10:00:00Z',
      compare: `https://github.com/example/games/compare/${TAG1}...${TAG2}`,
    });
    await modules.install({
      ...base,
      ref: 'v0.2.0',
      refType: 'tag',
      commit: TAG2,
      path: 'modules/cards',
    });
    await modules.check();
    expect(modules.decorate(store.report()).installed[0]?.update).toBeUndefined();
  });

  it('checks one at a time, says a rate limit, and makes no request until its reset', async () => {
    const { gh, modules, tick } = setup();
    await modules.install({
      repo: 'example/games',
      ref: 'main',
      commit: MAIN1,
      path: 'modules/dice',
    });
    await modules.install({
      repo: 'example/games',
      ref: 'feature/new',
      commit: MAIN2,
      path: 'modules/cards',
    });
    gh.calls.length = 0;
    gh.fail = () =>
      new Response('', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Date.parse('2026-11-12T13:00:00Z') / 1000),
        },
      });
    const [a, b] = await Promise.all([modules.check(), modules.check()]);
    expect(a).toBe(b);
    expect(a.error).toBe(
      "example/games main: GitHub's rate limit is reached until 13:00 UTC (60 requests an hour without a token): try again then"
    );
    // The first branch's refusal stops the check: one request.
    expect(gh.calls).toHaveLength(1);
    tick(60_000);
    await modules.check();
    expect(gh.calls).toHaveLength(1);
  });

  it('says a branch gone, and goes on with the others', async () => {
    const { gh, modules } = setup();
    await modules.install({
      repo: 'example/games',
      ref: 'feature/new',
      commit: MAIN2,
      path: 'modules/cards',
    });
    await modules.install({
      repo: 'example/games',
      ref: 'v0.1.0',
      refType: 'tag',
      commit: TAG1,
      path: 'modules/dice',
    });
    delete gh.repos['example/games']!.branches!['feature/new'];
    const check = await modules.check();
    expect(check.error).toBe('example/games feature/new: feature/new is not found');
  });

  it('checks at the start and every 6 hours, until stopped', async () => {
    vi.useFakeTimers();
    const { gh, modules } = setup();
    await modules.install({
      repo: 'example/games',
      ref: 'main',
      commit: MAIN1,
      path: 'modules/dice',
    });
    gh.calls.length = 0;
    modules.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(gh.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY);
    expect(gh.calls).toHaveLength(2);
    modules.stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY);
    expect(gh.calls).toHaveLength(2);
  });

  it('are the control API’s, with the store’s', async () => {
    const { store, modules } = setup();
    const controls = moduleControls(store, undefined, modules);
    expect(
      await controls.lookup?.('https://github.com/example/games/tree/main/modules/cards')
    ).toMatchObject({
      modules: [{ id: 'cards' }],
    });
    await controls.install({
      github: { repo: 'example/games', ref: 'main', path: 'modules/cards' },
    });
    expect(await controls.checkUpdates?.()).toMatchObject({
      installed: [{ id: 'cards' }],
      updates: { checkedAt: '2026-11-12T12:00:00.000Z' },
    });
    const plain = moduleControls(store, undefined);
    expect(plain.lookup).toBeUndefined();
    expect(() =>
      plain.install({ github: { repo: 'example/games', ref: 'main', path: '' } })
    ).toThrow('installing from GitHub is not offered here');
    expect(plain.report()).not.toHaveProperty('updates');
  });
});
