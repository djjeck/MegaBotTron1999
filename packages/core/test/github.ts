/**
 * A fake of GitHub's API and codeload for tests: `fetch` answered from synthetic repositories, each
 * call kept. Nothing reaches the network.
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { tarOf } from './modules.ts';

export interface FakeRepo {
  defaultBranch?: string;
  /** Each branch's head commit. */
  branches?: Record<string, string>;
  /** Each tag's commit. */
  tags?: Record<string, string>;
  /** Each commit's date. */
  dates?: Record<string, string>;
  /** Each commit's files, by path from the repository's root. */
  trees?: Record<string, Record<string, string>>;
  /**
   * The comparison's answer for `<from>...<to>`, as the host's API sends it; by default, the paths
   * whose content differs between the two trees, `to` ahead of `from` by one commit.
   */
  compare?: Record<string, unknown>;
}

/** The paths whose content differs between two of a repository's trees. */
export function treeDiff(r: FakeRepo, from: string, to: string): string[] {
  const a = r.trees?.[from] ?? {};
  const b = r.trees?.[to] ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();
}

export interface FakeGitHub {
  fetch: typeof globalThis.fetch;
  /** Every URL fetched, with its authorization header if any. */
  calls: string[];
  repos: Record<string, FakeRepo>;
  /** Answers every call with this, when set (a rate limit, an error). */
  fail?: () => Response;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A commit's sha for tests: 40 hex digits from a short name. */
export const sha = (name: string): string => createHash('sha1').update(name).digest('hex');

/** A repository's tarball at a commit, as codeload makes it: one top directory, gzipped. */
export function githubTarball(repo: string, commit: string, files: Record<string, string>): Buffer {
  const top = `${repo.replace('/', '-')}-${commit.slice(0, 7)}`;
  return zlib.gzipSync(
    tarOf([
      { name: 'pax_global_header', type: 'g', data: `52 comment=${commit}\n` },
      { name: `${top}/` },
      ...Object.entries(files).map(([name, data]) => ({ name: `${top}/${name}`, data })),
    ])
  );
}

export function fakeGitHub(repos: Record<string, FakeRepo>): FakeGitHub {
  const gh: FakeGitHub = { calls: [], repos, fetch: undefined as unknown as typeof fetch };
  const find = (r: FakeRepo, ref: string): string | undefined =>
    r.branches?.[ref] ??
    r.tags?.[ref] ??
    Object.keys(r.dates ?? {}).find((c) => ref.length >= 7 && c.startsWith(ref));
  gh.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    gh.calls.push(`${url.host}${url.pathname}${url.search}${auth === undefined ? '' : ` ${auth}`}`);
    if (gh.fail !== undefined) return Promise.resolve(gh.fail());
    const parts = url.pathname
      .split('/')
      .filter((p) => p !== '')
      .map(decodeURIComponent);
    if (url.host === 'codeload.github.com') {
      const [owner = '', name = '', , commit = ''] = parts;
      const files = repos[`${owner}/${name}`]?.trees?.[commit];
      return Promise.resolve(
        files === undefined
          ? new Response('not found', { status: 404 })
          : new Response(githubTarball(`${owner}/${name}`, commit, files))
      );
    }
    const [, owner = '', name = '', what, ...rest] = parts;
    const r = repos[`${owner}/${name}`];
    if (r === undefined) return Promise.resolve(json({ message: 'Not Found' }, 404));
    if (what === undefined) return Promise.resolve(json({ default_branch: r.defaultBranch }));
    if (what === 'commits') {
      const c = find(r, url.searchParams.get('sha') ?? '');
      return Promise.resolve(
        c === undefined
          ? json({ message: 'Not Found' }, 404)
          : json([{ sha: c, commit: { committer: { date: r.dates?.[c] } } }])
      );
    }
    if (what === 'git') {
      const tag = rest.slice(2).join('/');
      return Promise.resolve(
        r.tags?.[tag] === undefined
          ? json({ message: 'Not Found' }, 404)
          : json({ ref: `refs/tags/${tag}` })
      );
    }
    if (what === 'tags')
      return Promise.resolve(
        json(Object.entries(r.tags ?? {}).map(([n, c]) => ({ name: n, commit: { sha: c } })))
      );
    if (what === 'compare') {
      const range = rest.join('/');
      const [from = '', to = ''] = range.split('...');
      if (r.compare?.[range] !== undefined) return Promise.resolve(json(r.compare[range]));
      return Promise.resolve(
        r.trees?.[from] === undefined || r.trees[to] === undefined
          ? json({ message: 'Not Found' }, 404)
          : json({
              status: 'ahead',
              total_commits: 1,
              files: treeDiff(r, from, to).map((filename) => ({ filename, status: 'modified' })),
            })
      );
    }
    return Promise.resolve(json({ message: 'Not Found' }, 404));
  };
  return gh;
}
