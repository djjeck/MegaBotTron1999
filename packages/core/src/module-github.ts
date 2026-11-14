/**
 * GitHub, as a host of modules' repositories (module-git.ts; docs/bot-os-api.md §7.4, bot-os.md
 * D67, #13). The owner pastes a repository's link (its default branch), or a tree's
 * (`/tree/<ref>`, with a path or not); the shell resolves the ref to a commit through GitHub's API,
 * and fetches the repository's tarball at that commit from codeload.
 *
 * Unauthenticated, GitHub's API allows 60 requests an hour; a token (`github_token`, or
 * `GITHUB_TOKEN`) raises it. A rate limit reached is waited out: no request is made until its
 * reset, and each call says so. Public repositories only; a private one is on a self-hosted Git
 * server (module-gitea.ts, D102).
 */
import {
  GitError,
  type GitHost,
  GITHUB_HOST,
  REPO,
  type RepoRef,
  type RepoSource,
  type RepoTree,
  tagVersion,
  treeOf,
  unreachable,
} from './module-git.ts';

const API = 'https://api.github.com';
const CODELOAD = 'https://codeload.github.com';
const WEB = 'https://github.com';

/** A GitHub source resolved: the repository, the ref, the path in it, and the commit. */
export type GitHubSource = Extract<RepoSource, { kind: 'github' }>;

/** A link's repository (`<owner>/<repo>`) and what follows `/tree/` (none for the repository's). */
export function parseGitHubUrl(text: string): { repo: string; tree?: string[] } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new GitError(`${text} is not a link`, 400);
  }
  const parts = url.pathname.split('/').filter((p) => p !== '');
  const [owner = '', name = '', kind, ...rest] = parts.map(decodeURIComponent);
  const repo = `${owner}/${name.replace(/\.git$/u, '')}`;
  if (!/^(?:www\.)?github\.com$/u.test(url.hostname) || !REPO.test(repo))
    throw new GitError(
      'a GitHub link is https://github.com/<owner>/<repo>, or …/tree/<ref>/<path>',
      400
    );
  if (kind === undefined) return { repo };
  if (kind !== 'tree' || rest.length === 0)
    throw new GitError(`${text}: link the repository, or a folder (…/tree/<ref>/<path>)`, 400);
  return { repo, tree: rest };
}

export interface GitHubOptions {
  fetch?: typeof globalThis.fetch;
  /** A token for GitHub's API, to raise its rate limit; none needed. */
  token?: string;
  now?: () => number;
}

/** GitHub's API and codeload, as the module sources need them. */
export class GitHub implements GitHost {
  readonly host = GITHUB_HOST;
  private readonly fetch: typeof globalThis.fetch;
  private readonly token: string | undefined;
  private readonly now: () => number;
  /** Until when the rate limit holds every request back. */
  private until = 0;
  private readonly trees = new Map<string, RepoTree>();

  constructor(o: GitHubOptions = {}) {
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = o.token;
    this.now = o.now ?? Date.now;
  }

  private limited(): GitError {
    const at = new Date(this.until).toISOString().slice(11, 16);
    return new GitError(
      `GitHub's rate limit is reached until ${at} UTC${this.token === undefined ? ' (60 requests an hour without a token)' : ''}: try again then`,
      429
    );
  }

  private async get(url: string, timeout: number, api: boolean): Promise<Response> {
    if (this.until > this.now()) throw this.limited();
    const headers: Record<string, string> = { 'user-agent': 'megabottron1999' };
    if (api) {
      headers['accept'] = 'application/vnd.github+json';
      headers['x-github-api-version'] = '2022-11-28';
      if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      res = await this.fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw unreachable(GITHUB_HOST, e);
    }
    const after = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (
      (res.status === 403 || res.status === 429) &&
      (res.headers.get('x-ratelimit-remaining') === '0' || after > 0)
    ) {
      this.until =
        after > 0 ? this.now() + after * 1000 : reset > 0 ? reset * 1000 : this.now() + 60_000;
      throw this.limited();
    }
    return res;
  }

  /** An API call's JSON, or undefined for a 404 or a 422 (a ref or a repository not there). */
  private async api(route: string): Promise<unknown> {
    const res = await this.get(`${API}${route}`, 30_000, true);
    if (res.status === 404 || res.status === 422) return undefined;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      throw new GitError(
        `GitHub answered ${res.status}${typeof body.message === 'string' ? `: ${body.message}` : ''}`,
        502
      );
    }
    return res.json();
  }

  /** The commit a ref names now (a branch's head, a tag's, a commit's own), or undefined. */
  async commit(
    repo: string,
    ref: string
  ): Promise<{ commit: string; commitDate?: string } | undefined> {
    const list = await this.api(`/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=1`);
    const first = (Array.isArray(list) ? list[0] : undefined) as
      { sha?: unknown; commit?: { committer?: { date?: unknown } } } | undefined;
    if (typeof first?.sha !== 'string') return undefined;
    const date = first.commit?.committer?.date;
    return { commit: first.sha, ...(typeof date === 'string' ? { commitDate: date } : {}) };
  }

  /** A link resolved: its repository, ref (the default branch for a repository's), path, commit. */
  async resolve(link: URL): Promise<RepoRef> {
    const { repo, tree } = parseGitHubUrl(link.href);
    const missing = (what: string): GitError =>
      new GitError(`${what} (a private repository is not supported)`, 404);
    if (tree === undefined) {
      const info = (await this.api(`/repos/${repo}`)) as { default_branch?: unknown } | undefined;
      if (typeof info?.default_branch !== 'string')
        throw missing(`github.com/${repo} is not found`);
      const ref = info.default_branch;
      const c = await this.commit(repo, ref);
      if (c === undefined) throw missing(`${repo} has no commit on ${ref}`);
      return { repo, ref, refType: 'branch', path: '', ...c };
    }
    // A ref may hold slashes (`feature/x`): the shortest that names a commit is the ref.
    for (let n = 1; n <= Math.min(tree.length, 5); n++) {
      const ref = tree.slice(0, n).join('/');
      const c = await this.commit(repo, ref);
      if (c === undefined) continue;
      const refType =
        /^[0-9a-f]{7,40}$/u.test(ref) && c.commit.startsWith(ref)
          ? 'commit'
          : (await this.api(`/repos/${repo}/git/ref/tags/${encodeURIComponent(ref)}`)) === undefined
            ? 'branch'
            : 'tag';
      return {
        repo,
        ref: refType === 'commit' ? c.commit : ref,
        refType,
        path: tree.slice(n).join('/'),
        ...c,
      };
    }
    throw missing(`github.com/${repo} is not found, or has no branch, tag or commit ${tree[0]}`);
  }

  /** A repository's semver tags, each with its commit. */
  async tags(repo: string): Promise<{ name: string; commit: string }[]> {
    const list = await this.api(`/repos/${repo}/tags?per_page=100`);
    return (Array.isArray(list) ? (list as { name?: unknown; commit?: { sha?: unknown } }[]) : [])
      .map((t) => ({ name: t.name, commit: t.commit?.sha }))
      .filter(
        (t): t is { name: string; commit: string } =>
          typeof t.name === 'string' &&
          typeof t.commit === 'string' &&
          tagVersion(t.name) !== undefined
      );
  }

  /**
   * A repository's files at a commit, from codeload's tarball (not the API's, nor its rate limit),
   * its top directory stripped; the last two are kept, for the installs that follow a look.
   */
  async tree(repo: string, commit: string): Promise<RepoTree> {
    const key = `${repo}@${commit}`;
    const kept = this.trees.get(key);
    if (kept !== undefined) return kept;
    const res = await this.get(`${CODELOAD}/${repo}/tar.gz/${commit}`, 120_000, false);
    if (!res.ok) throw new GitError(`GitHub's tarball of ${repo}: ${res.status}`, 502);
    const tree = treeOf(new Uint8Array(await res.arrayBuffer()), repo);
    this.trees.set(key, tree);
    for (const old of [...this.trees.keys()].slice(0, -2)) this.trees.delete(old);
    return tree;
  }

  source(ref: RepoRef): GitHubSource {
    return { kind: 'github', ...ref };
  }

  compare(repo: string, from: string, to: string): string {
    return `${WEB}/${repo}/compare/${from}...${to}`;
  }
}
