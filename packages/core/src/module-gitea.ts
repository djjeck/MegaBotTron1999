/**
 * A self-hosted Git server with a Gitea-compatible API, as a host of modules' repositories
 * (module-git.ts; docs/bot-os-api.md §7.4, bot-os.md D102, #48). The owner allows the host first
 * (module-hosts.ts), with the Docker secret holding its token, or none for public repositories;
 * then pastes a repository's link on it: `https://git.example.lan/<owner>/<repo>` (its default
 * branch), or a folder's, `…/src/branch/<branch>/<path>`, `…/src/tag/<tag>/<path>` or
 * `…/src/commit/<sha>/<path>`, as the server's pages link them.
 *
 * The API: `GET /api/v1/version` (whether it is one), `GET /api/v1/repos/<repo>` (its default
 * branch), `…/commits?sha=<ref>&limit=1` (a ref's commit and its date), `…/tags/<tag>` (whether a
 * ref is a tag), `…/tags` (the semver tags, for updates), `…/compare/<a>...<b>` (what a branch's
 * new commits changed, for updates) and `…/archive/<sha>.tar.gz` (the tarball).
 *
 * The token goes to this host only: as `Authorization: token …`, on requests to its own `https://`
 * origin; a redirect to another origin is followed without it. It is never put in a message.
 */
import {
  type Changes,
  GitError,
  type GitHost,
  REPO,
  type RepoRef,
  type RepoSource,
  type RepoTree,
  tagVersion,
  treeOf,
  unreachable,
} from './module-git.ts';

export interface GiteaOptions {
  /** The host, as its links name it, with its port if any: `git.example.lan`. */
  host: string;
  /** The token, read when needed (a Docker secret's value); none for public repositories. */
  token?: () => string | undefined;
  /** The name of the secret holding the token, for the messages; never its value. */
  secret?: string;
  fetch?: typeof globalThis.fetch;
}

/** The commits that a ref names on a page of the server's: `/src/<kind>/<ref>/<path>`. */
const SRC_KINDS = { branch: 'branch', tag: 'tag', commit: 'commit' } as const;

/** A link on a Gitea-compatible server: its repository, and the ref's kind and parts if any. */
export function parseGiteaUrl(link: URL): {
  repo: string;
  kind?: 'branch' | 'tag' | 'commit';
  tree?: string[];
} {
  const parts = link.pathname
    .split('/')
    .filter((p) => p !== '')
    .map(decodeURIComponent);
  const [owner = '', name = '', src, kind, ...rest] = parts;
  const repo = `${owner}/${name.replace(/\.git$/u, '')}`;
  const usage = `a link on ${link.host} is https://${link.host}/<owner>/<repo>, or a folder's: …/src/branch/<branch>/<path> (or src/tag/…, src/commit/…)`;
  if (!REPO.test(repo)) throw new GitError(usage, 400);
  if (src === undefined) return { repo };
  const k = kind === undefined ? undefined : SRC_KINDS[kind as keyof typeof SRC_KINDS];
  if (src !== 'src' || k === undefined || rest.length === 0) throw new GitError(usage, 400);
  return { repo, kind: k, tree: rest };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A Gitea-compatible server's API and archives, as the module sources need them. */
export class Gitea implements GitHost {
  readonly host: string;
  private readonly origin: string;
  private readonly token: () => string | undefined;
  private readonly secret: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly trees = new Map<string, RepoTree>();

  constructor(o: GiteaOptions) {
    this.host = o.host;
    this.origin = `https://${o.host}`;
    this.token = o.token ?? (() => undefined);
    this.secret = o.secret;
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * A GET, its redirects followed by hand (up to 5), so that the token goes only to this host's
   * own origin.
   */
  private async get(route: string, timeout: number): Promise<Response> {
    const token = this.token();
    let url = new URL(`${this.origin}${route}`);
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {
        'user-agent': 'megabottron1999',
        accept: 'application/json',
      };
      if (token !== undefined && url.origin === this.origin)
        headers['authorization'] = `token ${token}`;
      let res: Response;
      try {
        res = await this.fetch(url, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        throw unreachable(url.host, e);
      }
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || location === null) return res;
      if (hop >= 5) throw new GitError(`${this.host}: too many redirects`, 502);
      url = new URL(location, url);
    }
  }

  /** Why the server refused the token, or asks for one. */
  private refused(status: number, what: string): GitError {
    if (this.secret === undefined)
      return new GitError(
        `${this.host} asks for a token to read ${what}: give the host a token (its Docker secret, under Git servers on the Modules page)`,
        status
      );
    return new GitError(
      status === 401
        ? `${this.host} refused the token in the secret ${this.secret} (401): check it, or replace it`
        : `the token in the secret ${this.secret} may not read ${what} on ${this.host} (403)`,
      status
    );
  }

  /** An API call's JSON, or undefined for what is not there (404, 409 for an empty repository, 422). */
  private async api(route: string, what: string): Promise<unknown> {
    const res = await this.get(`/api/v1${route}`, 30_000);
    if (res.status === 404 || res.status === 409 || res.status === 422) return undefined;
    if (res.status === 401 || res.status === 403) throw this.refused(res.status, what);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      throw new GitError(
        `${this.host} answered ${res.status}${typeof body.message === 'string' ? `: ${body.message}` : ''}`,
        502
      );
    }
    return res.json();
  }

  /** The server's version: whether it answers as a Gitea-compatible API. */
  async version(): Promise<string> {
    const v = (await this.api('/version', 'its version')) as { version?: unknown } | undefined;
    if (typeof v?.version !== 'string')
      throw new GitError(
        `${this.host} is not a Gitea-compatible server: it has no /api/v1/version`,
        400
      );
    return v.version;
  }

  async commit(
    repo: string,
    ref: string
  ): Promise<{ commit: string; commitDate?: string } | undefined> {
    const list = await this.api(
      `/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&limit=1&stat=false&verification=false&files=false`,
      repo
    );
    const first = (Array.isArray(list) ? list[0] : undefined) as
      { sha?: unknown; commit?: { committer?: { date?: unknown } } } | undefined;
    if (typeof first?.sha !== 'string') return undefined;
    const date = first.commit?.committer?.date;
    return { commit: first.sha, ...(typeof date === 'string' ? { commitDate: date } : {}) };
  }

  /** Not found: a repository missing, or private and not readable without the token. */
  private missing(repo: string): GitError {
    return new GitError(
      this.secret === undefined
        ? `${this.host}/${repo} is not found, or is private: a private repository needs a token (its Docker secret, under Git servers on the Modules page)`
        : `${this.host}/${repo} is not found, or the token in the secret ${this.secret} cannot read it`,
      404
    );
  }

  async resolve(link: URL): Promise<RepoRef> {
    const { repo, kind, tree } = parseGiteaUrl(link);
    const info = (await this.api(`/repos/${repo}`, repo)) as
      { default_branch?: unknown } | undefined;
    if (info === undefined) throw this.missing(repo);
    if (tree === undefined || kind === undefined) {
      const ref = typeof info.default_branch === 'string' ? info.default_branch : '';
      const c = ref === '' ? undefined : await this.commit(repo, ref);
      if (c === undefined) throw new GitError(`${this.host}/${repo} has no commit yet`, 404);
      return { repo, ref, refType: 'branch', path: '', ...c };
    }
    // A branch or a tag may hold slashes (`feature/x`): the shortest that names a commit is the ref.
    for (let n = 1; n <= Math.min(tree.length, 5); n++) {
      const ref = tree.slice(0, n).join('/');
      const c = await this.commit(repo, ref);
      if (c === undefined) continue;
      return {
        repo,
        ref: kind === 'commit' ? c.commit : ref,
        refType: kind,
        path: tree.slice(n).join('/'),
        ...c,
      };
    }
    throw new GitError(`${this.host}/${repo} has no ${kind} ${tree[0]}`, 404);
  }

  async tags(repo: string): Promise<{ name: string; commit: string }[]> {
    const all: { name: string; commit: string }[] = [];
    for (let page = 1; page <= 10; page++) {
      const list = await this.api(`/repos/${repo}/tags?page=${page}&limit=50`, repo);
      const got = Array.isArray(list)
        ? (list as { name?: unknown; commit?: { sha?: unknown } }[])
        : [];
      for (const t of got)
        if (
          typeof t.name === 'string' &&
          typeof t.commit?.sha === 'string' &&
          tagVersion(t.name) !== undefined
        )
          all.push({ name: t.name, commit: t.commit.sha });
      if (got.length < 50) break;
    }
    return all;
  }

  /** A repository's files at a commit, from its archive; the last two are kept. */
  async tree(repo: string, commit: string): Promise<RepoTree> {
    const key = `${repo}@${commit}`;
    const kept = this.trees.get(key);
    if (kept !== undefined) return kept;
    const res = await this.get(`/api/v1/repos/${repo}/archive/${commit}.tar.gz`, 120_000);
    if (res.status === 401 || res.status === 403) throw this.refused(res.status, repo);
    if (res.status === 404) throw this.missing(repo);
    if (!res.ok) throw new GitError(`${this.host}'s archive of ${repo}: ${res.status}`, 502);
    const tree = treeOf(new Uint8Array(await res.arrayBuffer()), repo);
    this.trees.set(key, tree);
    for (const old of [...this.trees.keys()].slice(0, -2)) this.trees.delete(old);
    return tree;
  }

  source(ref: RepoRef): RepoSource {
    return { kind: 'git', host: this.host, api: 'gitea', ...ref };
  }

  compare(repo: string, from: string, to: string): string {
    return `${this.origin}/${repo}/compare/${from}...${to}`;
  }

  /**
   * What `from..to` changed, from the server's comparison (`GET /api/v1/repos/<repo>/compare/
   * <from>...<to>`): its commits, each with its parents and the files it changed against its first
   * parent. Their union holds every file `to` changed since `from` when `from` is on `to`'s
   * first-parent line within them; otherwise (a history rewritten, `from` reached only through a
   * merge's other parent) it is not told, nor when a commit lists no files (a server older than the
   * comparison's `files`) or the commits are not all listed.
   */
  async changes(repo: string, from: string, to: string): Promise<Changes> {
    const body = (await this.api(
      `/repos/${repo}/compare/${from}...${to}?verification=false&files=true`,
      repo
    )) as { total_commits?: unknown; commits?: unknown } | undefined;
    const short = `${from.slice(0, 7)}...${to.slice(0, 7)}`;
    if (body === undefined || !Array.isArray(body.commits))
      return { unknown: `${this.host} could not compare ${short}` };
    const list = body.commits as {
      sha?: unknown;
      parents?: { sha?: unknown }[];
      files?: { filename?: unknown }[];
    }[];
    if (typeof body.total_commits === 'number' && body.total_commits !== list.length)
      return { unknown: `${this.host}'s comparison ${short} lists only some of its commits` };
    const firstParent = new Map<string, unknown>();
    const files = new Set<string>();
    for (const c of list) {
      if (typeof c.sha !== 'string') return { unknown: `${this.host}'s comparison did not read` };
      firstParent.set(c.sha, Array.isArray(c.parents) ? c.parents[0]?.sha : undefined);
      if (!Array.isArray(c.files))
        return { unknown: `${this.host}'s comparison lists no files (an older server)` };
      for (const f of c.files) if (typeof f.filename === 'string') files.add(f.filename);
    }
    let at: unknown = to;
    for (let n = 0; n <= list.length && at !== from && typeof at === 'string'; n++)
      at = firstParent.get(at);
    if (at !== from)
      return {
        unknown: `the commit installed is not on the branch's first-parent line (its history rewritten, or merged in)`,
      };
    return { files: [...files] };
  }
}
