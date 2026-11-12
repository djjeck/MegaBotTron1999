/**
 * Modules from a GitHub link, and their updates (docs/bot-os-api.md §7.4, bot-os.md D67, #13). The
 * owner pastes a repository's link (its default branch), or a tree's (`/tree/<ref>`, with a path
 * or not); the shell resolves the ref to a commit through GitHub's API, fetches the repository's
 * tarball at that commit from codeload, and finds its modules as in a folder (module-files.ts).
 * Each module the owner checks is installed through the store (module-store.ts), as any install,
 * its source recorded: the repository, the ref, the module's path and the commit.
 *
 * Updates: a check resolves each ref once (a branch's head, or a repository's tags), at the start,
 * every 6 hours and when the owner asks; a module whose branch has moved, or whose tag has a newer
 * semver tag, has an update, which the owner installs or not. Nothing is installed or restarted
 * here on its own (P1).
 *
 * Unauthenticated, GitHub's API allows 60 requests an hour; a token (`github_token`, or
 * `GITHUB_TOKEN`) raises it. A rate limit reached is waited out: no request is made until its
 * reset, and each call says so. Public repositories only.
 */
import { type ModuleControls } from './control-server.ts';
import { findModules, type ModuleCandidate, type TreeListing } from './module-files.ts';
import { type ModulesLoad } from './module-loader.ts';
import {
  type GraphNodeRef,
  type ModuleFile,
  type ModuleOrigin,
  type ModulesReport,
  type ModuleStore,
  type ModuleUpdate,
  type UpdateCheck,
} from './module-store.ts';
import { MODULE_FILE, ModuleError } from './modules.ts';
import { compare, parseVersion, type Version } from './semver.ts';
import { MAX_UNPACKED, readTar } from './tar.ts';

const API = 'https://api.github.com';
const CODELOAD = 'https://codeload.github.com';
const WEB = 'https://github.com';
/** How often the shell checks for updates on its own. */
export const CHECK_EVERY = 6 * 3_600_000;

/** A refusal of GitHub's, or of the link, with the HTTP status the control API answers. */
export class GitHubError extends ModuleError {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A GitHub source resolved: the repository, the ref, the path in it, and the commit. */
export type GitHubSource = Extract<ModuleOrigin, { kind: 'github' }>;

/** A module of a GitHub source to install, as `POST /modules {"github": …}` names it. */
export interface GitHubPick {
  repo: string;
  ref: string;
  refType?: 'branch' | 'tag' | 'commit';
  /** The module's directory in the repository, '' for its root. */
  path: string;
  /** The commit; the ref's head when none. */
  commit?: string;
  commitDate?: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;

/** A link's repository (`<owner>/<repo>`) and what follows `/tree/` (none for the repository's). */
export function parseGitHubUrl(text: string): { repo: string; tree?: string[] } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new GitHubError(`${text} is not a link`, 400);
  }
  const parts = url.pathname.split('/').filter((p) => p !== '');
  const [owner = '', name = '', kind, ...rest] = parts.map(decodeURIComponent);
  const repo = `${owner}/${name.replace(/\.git$/u, '')}`;
  if (!/^(?:www\.)?github\.com$/u.test(url.hostname) || !REPO.test(repo))
    throw new GitHubError(
      'a GitHub link is https://github.com/<owner>/<repo>, or …/tree/<ref>/<path>',
      400
    );
  if (kind === undefined) return { repo };
  if (kind !== 'tree' || rest.length === 0)
    throw new GitHubError(`${text}: link the repository, or a folder (…/tree/<ref>/<path>)`, 400);
  return { repo, tree: rest };
}

/** A semver tag's version (`v1.2.3` or `1.2.3`). */
const tagVersion = (name: string): Version | undefined => parseVersion(name.replace(/^v/u, ''));

/**
 * The newest tag after `current` among `tags`, by semver: pre-releases count only when `current`
 * is one. None when `current` is not a semver tag, or none is newer.
 */
export function newerTag<T extends { name: string }>(
  tags: readonly T[],
  current: string
): T | undefined {
  const now = tagVersion(current);
  if (now === undefined) return undefined;
  let best: { tag: T; v: Version } | undefined;
  for (const tag of tags) {
    const v = tagVersion(tag.name);
    if (v === undefined || (v.pre.length > 0 && now.pre.length === 0)) continue;
    if (compare(v, now) > 0 && (best === undefined || compare(v, best.v) > 0)) best = { tag, v };
  }
  return best?.tag;
}

/** A repository's files at a commit: their listing, and each file's bytes. */
export interface GitHubTree {
  listing: TreeListing;
  files: Map<string, Uint8Array>;
}

export interface GitHubOptions {
  fetch?: typeof globalThis.fetch;
  /** A token for GitHub's API, to raise its rate limit; none needed. */
  token?: string;
  now?: () => number;
}

/** GitHub's API and codeload, as the module sources need them. */
export class GitHub {
  private readonly fetch: typeof globalThis.fetch;
  private readonly token: string | undefined;
  private readonly now: () => number;
  /** Until when the rate limit holds every request back. */
  private until = 0;
  private readonly trees = new Map<string, GitHubTree>();

  constructor(o: GitHubOptions = {}) {
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = o.token;
    this.now = o.now ?? Date.now;
  }

  private limited(): GitHubError {
    const at = new Date(this.until).toISOString().slice(11, 16);
    return new GitHubError(
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
      throw new GitHubError(`GitHub could not be reached: ${(e as Error).message}`, 502);
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
      throw new GitHubError(
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
  async resolve(link: string): Promise<GitHubSource> {
    const { repo, tree } = parseGitHubUrl(link);
    const missing = (what: string): GitHubError =>
      new GitHubError(`${what} (a private repository is not supported)`, 404);
    if (tree === undefined) {
      const info = (await this.api(`/repos/${repo}`)) as { default_branch?: unknown } | undefined;
      if (typeof info?.default_branch !== 'string')
        throw missing(`github.com/${repo} is not found`);
      const ref = info.default_branch;
      const c = await this.commit(repo, ref);
      if (c === undefined) throw missing(`${repo} has no commit on ${ref}`);
      return { kind: 'github', repo, ref, refType: 'branch', path: '', ...c };
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
        kind: 'github',
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
  async tree(repo: string, commit: string): Promise<GitHubTree> {
    const key = `${repo}@${commit}`;
    const kept = this.trees.get(key);
    if (kept !== undefined) return kept;
    const res = await this.get(`${CODELOAD}/${repo}/tar.gz/${commit}`, 120_000, false);
    if (!res.ok) throw new GitHubError(`GitHub's tarball of ${repo}: ${res.status}`, 502);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_UNPACKED)
      throw new GitHubError(`${repo}'s tarball is over ${MAX_UNPACKED} bytes`, 400);
    const files = new Map<string, Uint8Array>();
    const manifests: Record<string, string> = {};
    for (const entry of readTar(bytes)) {
      const rel = entry.path.split('/').slice(1).join('/');
      if (entry.type !== '0' || rel === '') continue;
      files.set(rel, entry.data);
      if (rel === MODULE_FILE || rel.endsWith(`/${MODULE_FILE}`))
        manifests[rel] = Buffer.from(entry.data).toString('utf8');
    }
    const tree = { listing: { paths: [...files.keys()], manifests }, files };
    this.trees.set(key, tree);
    for (const old of [...this.trees.keys()].slice(0, -2)) this.trees.delete(old);
    return tree;
  }
}

/** A link looked up: the source resolved, and the modules found under its path. */
export interface GitHubLookup {
  source: GitHubSource;
  modules: ModuleCandidate[];
}

const shortRef = (s: GitHubSource): string => `${s.repo}@${s.commit.slice(0, 7)}`;

/** The modules from GitHub: looked up, installed, and checked for updates. */
export class GitHubModules {
  private readonly store: ModuleStore;
  private readonly github: GitHub;
  private readonly now: () => number;
  /** Each branch's head, by `<repo> <branch>`, as the last check found it. */
  private readonly heads = new Map<string, { commit: string; commitDate?: string }>();
  /** Each tag's newer tag, by `<repo> <tag>`, as the last check found it. */
  private readonly newer = new Map<string, { ref: string; commit: string; commitDate?: string }>();
  private state: UpdateCheck = {};
  private running: Promise<UpdateCheck> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(store: ModuleStore, github: GitHub, now: () => number = Date.now) {
    this.store = store;
    this.github = github;
    this.now = now;
  }

  /** A link's modules, compared with those installed, for the owner to check. */
  async lookup(link: string): Promise<GitHubLookup> {
    const source = await this.github.resolve(link);
    const tree = await this.github.tree(source.repo, source.commit);
    return { source, modules: findModules(tree.listing, this.store.versions(), source.path) };
  }

  /** Installs one module of a GitHub source, at its commit (its ref's head when none is given). */
  async install(pick: GitHubPick): Promise<ReturnType<ModuleStore['install']>> {
    if (
      !REPO.test(pick.repo) ||
      pick.ref === '' ||
      (pick.commit !== undefined && !SHA.test(pick.commit))
    )
      throw new GitHubError('github: {"repo": "<owner>/<repo>", "ref", "path", "commit"?}', 400);
    const resolved =
      pick.commit === undefined
        ? await this.github.commit(pick.repo, pick.ref)
        : {
            commit: pick.commit,
            ...(pick.commitDate === undefined ? {} : { commitDate: pick.commitDate }),
          };
    if (resolved === undefined)
      throw new GitHubError(`${pick.repo} has no branch, tag or commit ${pick.ref}`, 404);
    const source: GitHubSource = {
      kind: 'github',
      repo: pick.repo,
      ref: pick.ref,
      refType: pick.refType ?? (SHA.test(pick.ref) ? 'commit' : 'branch'),
      path: pick.path,
      ...resolved,
    };
    const tree = await this.github.tree(source.repo, source.commit);
    const found = findModules(tree.listing, this.store.versions(), source.path).find(
      (m) => m.path === source.path
    );
    if (found === undefined)
      throw new ModuleError(`no module at ${source.path || 'the root'} of ${shortRef(source)}`);
    if (found.error !== undefined) throw new ModuleError(found.error);
    const files: ModuleFile[] = found.files.map((p) => ({
      path: source.path === '' ? p : p.slice(source.path.length + 1),
      content: tree.files.get(p) ?? new Uint8Array(),
    }));
    const done = this.store.install({ files }, source);
    const left = found.left.length + (done.left ?? 0);
    return left === 0 ? done : { ...done, left };
  }

  /**
   * Checks each GitHub source for a newer commit: each branch's head once, however many modules
   * follow it; each repository's tags once, for the modules installed from a tag. One check runs
   * at a time; a rate limit stops it, said in `error`.
   */
  check(): Promise<UpdateCheck> {
    this.running ??= this.checkNow().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkNow(): Promise<UpdateCheck> {
    this.state = { ...this.state, checking: true };
    const linked = Object.values(this.store.sources())
      .map((s) => s.current)
      .filter((s): s is GitHubSource & { installedAt: string } => s?.kind === 'github');
    const errors: string[] = [];
    const run = async (what: string, step: () => Promise<void>): Promise<boolean> => {
      try {
        await step();
        return true;
      } catch (e) {
        errors.push(`${what}: ${(e as Error).message}`);
        return !(e instanceof GitHubError && e.status === 429);
      }
    };
    const branches = new Set(
      linked.filter((s) => s.refType === 'branch').map((s) => `${s.repo} ${s.ref}`)
    );
    let going = true;
    for (const key of branches) {
      if (!going) break;
      const [repo = '', ref = ''] = key.split(' ');
      going = await run(`${repo} ${ref}`, async () => {
        const head = await this.github.commit(repo, ref);
        if (head === undefined) throw new GitHubError(`${ref} is not found`, 404);
        this.heads.set(key, head);
      });
    }
    const tagged = linked.filter((s) => s.refType === 'tag');
    for (const repo of new Set(tagged.map((s) => s.repo))) {
      if (!going) break;
      going = await run(`${repo} tags`, async () => {
        const tags = await this.github.tags(repo);
        for (const s of tagged.filter((t) => t.repo === repo)) {
          const tag = newerTag(tags, s.ref);
          const key = `${repo} ${s.ref}`;
          if (tag === undefined) {
            this.newer.delete(key);
            continue;
          }
          const c = this.newer.get(key)?.commit === tag.commit ? this.newer.get(key) : undefined;
          const commitDate =
            c?.commitDate ?? (await this.github.commit(repo, tag.commit))?.commitDate;
          this.newer.set(key, {
            ref: tag.name,
            commit: tag.commit,
            ...(commitDate === undefined ? {} : { commitDate }),
          });
        }
      });
    }
    this.state = {
      checkedAt: new Date(this.now()).toISOString(),
      ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
    };
    return this.state;
  }

  /** The update of a module's source, as the last check found it. */
  updateOf(source: ModuleOrigin | undefined): ModuleUpdate | undefined {
    if (source?.kind !== 'github') return undefined;
    const compareUrl = (to: string): string =>
      `${WEB}/${source.repo}/compare/${source.commit}...${to}`;
    const found =
      source.refType === 'branch'
        ? this.heads.get(`${source.repo} ${source.ref}`)
        : source.refType === 'tag'
          ? this.newer.get(`${source.repo} ${source.ref}`)
          : undefined;
    if (found === undefined || found.commit === source.commit) return undefined;
    return {
      ref: (found as { ref?: string }).ref ?? source.ref,
      commit: found.commit,
      ...(found.commitDate === undefined ? {} : { commitDate: found.commitDate }),
      compare: compareUrl(found.commit),
    };
  }

  /** The store's report, with each module's update and the last check. */
  decorate(report: ModulesReport): ModulesReport {
    return {
      ...report,
      installed: report.installed.map((m) => {
        const update = this.updateOf(m.source);
        return update === undefined ? m : { ...m, update };
      }),
      updates: this.state,
    };
  }

  /** Checks now, and every `every` ms until `stop`; the timer keeps no process alive. */
  start(every = CHECK_EVERY): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), every);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/**
 * The control API's module controls (control-server.ts) over a store, the modules the instance
 * loaded, and the GitHub sources when the wiring offers them.
 */
export function moduleControls(
  store: ModuleStore,
  load: ModulesLoad | undefined,
  github?: GitHubModules,
  nodes: () => readonly GraphNodeRef[] = () => []
): ModuleControls {
  const report = (): ModulesReport => {
    const r = store.report(load, nodes());
    return github === undefined ? r : github.decorate(r);
  };
  return {
    report,
    install: (source) => {
      if (!('github' in source)) return store.install(source);
      if (github === undefined) throw new ModuleError('installing from GitHub is not offered here');
      return github.install(source.github);
    },
    rollback: (id) => store.rollback(id),
    remove: (id) => store.remove(id, load, nodes()),
    plan: (listing) => store.plan(listing),
    ...(github === undefined
      ? {}
      : {
          lookup: (url: string) => github.lookup(url),
          checkUpdates: async () => {
            await github.check();
            return report();
          },
        }),
  };
}
