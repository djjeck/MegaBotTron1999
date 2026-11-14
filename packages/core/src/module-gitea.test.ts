import { describe, expect, it } from 'vitest';
import { fakeGitea, tlsFailure } from '#test/gitea.ts';
import { sha } from '#test/github.ts';
import { manifestOf } from '#test/modules.ts';
import { GitError } from './module-git.ts';
import { Gitea, parseGiteaUrl } from './module-gitea.ts';

const HOST = 'git.example.lan';
const MAIN = sha('g-main');
const NEXT = sha('g-next');
const TAG = sha('g-tag');

const manifest = (id: string): string => JSON.stringify(manifestOf(id, { plugins: ['src/p.ts'] }));

const files = {
  'modules/dice/module.json': manifest('dice'),
  'modules/dice/src/p.ts': 'export const plugins = [];',
  'vendor/Other/module.json': manifest('other'),
};

const repos = () => ({
  'example/games': {
    defaultBranch: 'main',
    branches: { main: MAIN, 'feature/new': NEXT },
    tags: { 'v0.1.0': TAG },
    dates: {
      [MAIN]: '2026-11-01T10:00:00Z',
      [NEXT]: '2026-11-02T10:00:00Z',
      [TAG]: '2026-10-01T10:00:00Z',
    },
    trees: { [MAIN]: files, [NEXT]: files, [TAG]: files },
  },
  'example/secret': {
    private: true,
    defaultBranch: 'main',
    branches: { main: MAIN },
    dates: { [MAIN]: '2026-11-01T10:00:00Z' },
    trees: { [MAIN]: files },
  },
  'example/empty': {},
});

const link = (path: string): URL => new URL(`https://${HOST}/${path}`);

describe('a link on a Gitea-compatible server', () => {
  it('is a repository’s, or a folder’s on a branch, a tag or a commit', () => {
    expect(parseGiteaUrl(link('example/games'))).toEqual({ repo: 'example/games' });
    expect(parseGiteaUrl(link('example/games.git'))).toEqual({ repo: 'example/games' });
    expect(parseGiteaUrl(link('example/games/src/branch/feature/new/modules'))).toEqual({
      repo: 'example/games',
      kind: 'branch',
      tree: ['feature', 'new', 'modules'],
    });
    expect(parseGiteaUrl(link('example/games/src/tag/v0.1.0'))).toMatchObject({ kind: 'tag' });
    for (const bad of [
      'example',
      'example/games/issues',
      'example/games/src/odd/x',
      'example/games/src/branch',
    ])
      expect(() => parseGiteaUrl(link(bad)), bad).toThrow(GitError);
  });

  it('resolves to the default branch, a branch with slashes, a tag or a commit', async () => {
    const g = new Gitea({ host: HOST, fetch: fakeGitea(HOST, repos()).fetch });
    expect(await g.resolve(link('example/games'))).toEqual({
      repo: 'example/games',
      ref: 'main',
      refType: 'branch',
      path: '',
      commit: MAIN,
      commitDate: '2026-11-01T10:00:00Z',
    });
    expect(
      await g.resolve(link('example/games/src/branch/feature/new/modules/dice'))
    ).toMatchObject({ ref: 'feature/new', refType: 'branch', path: 'modules/dice', commit: NEXT });
    expect(await g.resolve(link('example/games/src/tag/v0.1.0'))).toMatchObject({
      ref: 'v0.1.0',
      refType: 'tag',
      commit: TAG,
    });
    expect(
      await g.resolve(link(`example/games/src/commit/${NEXT.slice(0, 8)}/modules`))
    ).toMatchObject({ ref: NEXT, refType: 'commit', path: 'modules' });
    await expect(g.resolve(link('example/games/src/branch/gone/x'))).rejects.toMatchObject({
      message: `${HOST}/example/games has no branch gone`,
      status: 404,
    });
    await expect(g.resolve(link('example/empty'))).rejects.toThrow(
      `${HOST}/example/empty has no commit yet`
    );
    expect(
      g.source({ repo: 'a/b', ref: 'main', refType: 'branch', path: '', commit: MAIN })
    ).toEqual({
      kind: 'git',
      host: HOST,
      api: 'gitea',
      repo: 'a/b',
      ref: 'main',
      refType: 'branch',
      path: '',
      commit: MAIN,
    });
    expect(g.compare('a/b', 'x', 'y')).toBe(`https://${HOST}/a/b/compare/x...y`);
  });

  it('tells a private repository without a token from one missing, and a token refused', async () => {
    const fake = fakeGitea(HOST, repos(), { token: 'good-token-1' });
    const anonymous = new Gitea({ host: HOST, fetch: fake.fetch });
    await expect(anonymous.resolve(link('example/secret'))).rejects.toMatchObject({
      message: `${HOST}/example/secret is not found, or is private: a private repository needs a token (its Docker secret, under Git servers on the Modules page)`,
      status: 404,
    });
    const withToken = (token: string) =>
      new Gitea({ host: HOST, secret: 'git_example_token', token: () => token, fetch: fake.fetch });
    expect(await withToken('good-token-1').resolve(link('example/secret'))).toMatchObject({
      commit: MAIN,
    });
    await expect(withToken('good-token-1').resolve(link('example/none'))).rejects.toThrow(
      `${HOST}/example/none is not found, or the token in the secret git_example_token cannot read it`
    );
    const refused = withToken('bad-token-2').resolve(link('example/secret'));
    await expect(refused).rejects.toMatchObject({
      message: `${HOST} refused the token in the secret git_example_token (401): check it, or replace it`,
      status: 401,
    });
    await expect(refused).rejects.not.toThrow('bad-token-2');
  });

  it('says a token is asked for, or not allowed, by the status the server answers', async () => {
    const answer = (status: number) =>
      (() => Promise.resolve(new Response('{}', { status }))) as typeof fetch;
    await expect(
      new Gitea({ host: HOST, fetch: answer(401) }).commit('a/b', 'main')
    ).rejects.toThrow(`${HOST} asks for a token to read a/b: give the host a token`);
    await expect(
      new Gitea({ host: HOST, secret: 's_token', token: () => 'x', fetch: answer(403) }).commit(
        'a/b',
        'main'
      )
    ).rejects.toMatchObject({
      message: `the token in the secret s_token may not read a/b on ${HOST} (403)`,
      status: 403,
    });
    await expect(new Gitea({ host: HOST, fetch: answer(403) }).tree('a/b', MAIN)).rejects.toThrow(
      'asks for a token'
    );
    await expect(new Gitea({ host: HOST, fetch: answer(500) }).tree('a/b', MAIN)).rejects.toThrow(
      `${HOST}'s archive of a/b: 500`
    );
    await expect(new Gitea({ host: HOST, fetch: answer(404) }).tree('a/b', MAIN)).rejects.toThrow(
      'is not found, or is private'
    );
    const failing = (() =>
      Promise.resolve(new Response('{"message":"boom"}', { status: 500 }))) as typeof fetch;
    await expect(new Gitea({ host: HOST, fetch: failing }).commit('a/b', 'main')).rejects.toThrow(
      `${HOST} answered 500: boom`
    );
    await expect(
      new Gitea({ host: HOST, fetch: answer(502) }).commit('a/b', 'main')
    ).rejects.toThrow(`${HOST} answered 502`);
  });

  it('sends its token to its own host only, a redirect elsewhere followed without it', async () => {
    const fake = fakeGitea(HOST, repos(), {
      token: 'good-token-1',
      archivesAt: 'files.example.lan',
    });
    const g = new Gitea({
      host: HOST,
      secret: 's_token',
      token: () => 'good-token-1',
      fetch: fake.fetch,
    });
    const tree = await g.tree('example/secret', MAIN);
    expect(tree.listing.paths).toContain('modules/dice/module.json');
    expect(await g.tree('example/secret', MAIN)).toBe(tree);
    expect(fake.calls).toEqual([
      `${HOST}/api/v1/repos/example/secret/archive/${MAIN}.tar.gz token good-token-1`,
      `files.example.lan/example/secret@${MAIN}`,
    ]);
    const loop = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: '/again' } })
      )) as typeof fetch;
    await expect(new Gitea({ host: HOST, fetch: loop }).commit('a/b', 'main')).rejects.toThrow(
      `${HOST}: too many redirects`
    );
  });

  it('lists its semver tags, page by page', async () => {
    const tags: Record<string, string> = { 'not-semver': MAIN };
    for (let i = 0; i < 60; i++) tags[`v0.${i}.0`] = MAIN;
    const fake = fakeGitea(HOST, { 'example/many': { tags } });
    const got = await new Gitea({ host: HOST, fetch: fake.fetch }).tags('example/many');
    expect(got).toHaveLength(60);
    expect(fake.calls.filter((c) => c.includes('/tags?'))).toHaveLength(2);
  });

  it('says whether it is a Gitea-compatible server, and when its certificate is not trusted', async () => {
    expect(await new Gitea({ host: HOST, fetch: fakeGitea(HOST, {}).fetch }).version()).toBe(
      '1.21.0'
    );
    await expect(
      new Gitea({ host: HOST, fetch: fakeGitea(HOST, {}, { version: null }).fetch }).version()
    ).rejects.toThrow(`${HOST} is not a Gitea-compatible server: it has no /api/v1/version`);
    const tls = fakeGitea(HOST, {});
    tls.fail = () => tlsFailure();
    await expect(new Gitea({ host: HOST, fetch: tls.fetch }).version()).rejects.toMatchObject({
      message: `${HOST}: the server's certificate isn't trusted (SELF_SIGNED_CERT_IN_CHAIN): mount its CA and set NODE_EXTRA_CA_CERTS`,
      status: 502,
    });
    const down = fakeGitea(HOST, {});
    down.fail = () =>
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND git.example.lan'), {
          code: 'ENOTFOUND',
        }),
      });
    await expect(new Gitea({ host: HOST, fetch: down.fetch }).version()).rejects.toThrow(
      `${HOST} could not be reached: getaddrinfo ENOTFOUND git.example.lan`
    );
  });
});
