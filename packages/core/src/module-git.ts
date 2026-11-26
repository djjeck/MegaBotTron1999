/**
 * Modules from a repository's link, and their updates (docs/bot-os-api.md §7.4, bot-os.md D67,
 * D102): the hosts' common part. The owner pastes a repository's link, on GitHub (module-github.ts)
 * or on a self-hosted Git server they allowed (module-gitea.ts, module-hosts.ts); the shell resolves
 * the ref to a commit through the host's API, fetches the repository's tarball at that commit, and
 * finds its modules as in a folder (module-files.ts). Each module the owner checks is installed
 * through the store (module-store.ts), as any install, its source recorded: the host, the
 * repository, the ref, the module's path and the commit.
 *
 * Updates: a check resolves each ref once (a branch's head, or a repository's tags), at the start,
 * every 6 hours and when the owner asks; a module whose branch has moved, or whose tag has a newer
 * semver tag, has an update, which the owner installs or not. A branch that moved is compared with
 * the commit installed through the host's API, once for each pair of commits, and a module whose
 * own path the commits did not change is not flagged (#37); when the host's comparison cannot tell
 * (too many files, a history rewritten, an older server), the module is flagged, and says why.
 * Nothing is installed or restarted here on its own (P1).
 *
 * A host is an implementation of `GitHost`: GitHub's API, or a Gitea-compatible one. Another kind
 * (GitLab's) would be one more, and one more `api` of the `git` source.
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

/** How often the shell checks for updates on its own. */
export const CHECK_EVERY = 6 * 3_600_000;
/** GitHub's host, as its links name it. */
export const GITHUB_HOST = 'github.com';

/** A refusal of a host's, or of the link, with the HTTP status the control API answers. */
export class GitError extends ModuleError {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A host the owner has not allowed: the shell fetches nothing from it (403). */
export class HostNotAllowed extends GitError {
  constructor(host: string) {
    super(
      `${host} is not an allowed host: add it under Git servers on the Modules page (the shell fetches only from GitHub and the servers added there)`,
      403
    );
  }
}

/** A module's source on a repository's host: GitHub, or a self-hosted Git server. */
export type RepoSource = Extract<ModuleOrigin, { kind: 'github' | 'git' }>;

/** A ref resolved, on whichever host: the repository, the ref, the path in it, and the commit. */
export interface RepoRef {
  repo: string;
  ref: string;
  refType: 'branch' | 'tag' | 'commit';
  /** The directory in the repository, '' for its root. */
  path: string;
  commit: string;
  commitDate?: string;
}

/** A module of a repository to install, as `POST /modules {"git": …}` (or `{"github": …}`) names it. */
export interface RepoPick {
  /** The host, as its links name it; GitHub's when none. */
  host?: string;
  repo: string;
  ref: string;
  refType?: 'branch' | 'tag' | 'commit';
  /** The module's directory in the repository, '' for its root. */
  path: string;
  /** The commit; the ref's head when none. */
  commit?: string;
  commitDate?: string;
}

/** A repository's files at a commit: their listing, and each file's bytes. */
export interface RepoTree {
  listing: TreeListing;
  files: Map<string, Uint8Array>;
}

/**
 * What a range of commits changed: every path changed (both sides of a rename), or why the host's
 * comparison cannot tell, in which case every module that follows the ref is flagged.
 */
export type Changes = { files: readonly string[] } | { unknown: string };

/** Whether a module at `path` ('' for the root) has a file among `files`. */
export const touches = (files: readonly string[], path: string): boolean =>
  path === '' ? files.length > 0 : files.some((f) => f.startsWith(`${path}/`));

/** What the modules need of a repository's host. */
export interface GitHost {
  /** The host, as its links name it: `github.com`, `git.example.lan`. */
  readonly host: string;
  /** A link on this host resolved: its repository, ref (the default branch when none), path, commit. */
  resolve(link: URL): Promise<RepoRef>;
  /** The commit a ref names now (a branch's head, a tag's, a commit's own), or undefined. */
  commit(repo: string, ref: string): Promise<{ commit: string; commitDate?: string } | undefined>;
  /** A repository's semver tags, each with its commit. */
  tags(repo: string): Promise<{ name: string; commit: string }[]>;
  /** A repository's files at a commit. */
  tree(repo: string, commit: string): Promise<RepoTree>;
  /** The source recorded for a ref resolved on this host. */
  source(ref: RepoRef): RepoSource;
  /** The host's page comparing two commits. */
  compare(repo: string, from: string, to: string): string;
  /**
   * The paths changed from `from` to `to`, through the host's comparison API, or why they cannot be
   * told; it throws only for the host's own failures (unreachable, a rate limit, a token refused).
   */
  changes(repo: string, from: string, to: string): Promise<Changes>;
}

/** The host a link or a source names: one allowed, or `HostNotAllowed`. */
export type GitHosts = (host: string) => GitHost;

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export const SHA = /^[0-9a-f]{40}$/u;

/** The host a source was installed from. */
export const hostOf = (s: RepoSource): string => (s.kind === 'github' ? GITHUB_HOST : s.host);

/** A semver tag's version (`v1.2.3` or `1.2.3`). */
export const tagVersion = (name: string): Version | undefined =>
  parseVersion(name.replace(/^v/u, ''));

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

/** A repository's tarball read: its top directory stripped, its manifests' text kept. */
export function treeOf(bytes: Uint8Array, label: string): RepoTree {
  if (bytes.length > MAX_UNPACKED)
    throw new GitError(`${label}'s tarball is over ${MAX_UNPACKED} bytes`, 400);
  const files = new Map<string, Uint8Array>();
  const manifests: Record<string, string> = {};
  for (const entry of readTar(bytes)) {
    const rel = entry.path.split('/').slice(1).join('/');
    if (entry.type !== '0' || rel === '') continue;
    files.set(rel, entry.data);
    if (rel === MODULE_FILE || rel.endsWith(`/${MODULE_FILE}`))
      manifests[rel] = Buffer.from(entry.data).toString('utf8');
  }
  return { listing: { paths: [...files.keys()], manifests }, files };
}

/** The error codes of a certificate Node does not trust. */
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Why a host could not be reached, from `fetch`'s error (its `cause` holds the network's): a
 * certificate not trusted says how to trust it; anything else, what went wrong.
 */
export function unreachable(host: string, e: unknown): GitError {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code !== undefined && TLS_CODES.has(code))
    return new GitError(
      `${host}: the server's certificate isn't trusted (${code}): mount its CA and set NODE_EXTRA_CA_CERTS`,
      502
    );
  const why = typeof cause?.message === 'string' ? cause.message : (e as Error).message;
  return new GitError(`${host} could not be reached: ${why}`, 502);
}

/** A link's host, as the hosts are named: lower-case, with its port, GitHub's without `www.`. */
export function linkOf(text: string): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new GitError(`${text} is not a link`, 400);
  }
  if (url.protocol !== 'https:')
    throw new GitError(`${text}: a repository's link is https://<host>/<owner>/<repo>`, 400);
  if (url.host === `www.${GITHUB_HOST}`) url.host = GITHUB_HOST;
  return url;
}

/** A link looked up: the source resolved, and the modules found under its path. */
export interface RepoLookup {
  source: RepoSource;
  modules: ModuleCandidate[];
}

const shortRef = (s: RepoSource): string => `${s.repo}@${s.commit.slice(0, 7)}`;

/** The modules from repository links: looked up, installed, and checked for updates. */
export class GitModules {
  private readonly store: ModuleStore;
  private readonly hosts: GitHosts;
  private readonly now: () => number;
  /** Each branch's head, by `<host> <repo> <branch>`, as the last check found it. */
  private readonly heads = new Map<string, { commit: string; commitDate?: string }>();
  /**
   * What each range of commits changed, by `<host> <repo> <from> <to>`: kept while a branch's
   * modules still need it, since a range's changes never change.
   */
  private readonly changed = new Map<string, Changes>();
  /** Each tag's newer tag, by `<host> <repo> <tag>`, as the last check found it. */
  private readonly newer = new Map<string, { ref: string; commit: string; commitDate?: string }>();
  private state: UpdateCheck = {};
  private running: Promise<UpdateCheck> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(store: ModuleStore, hosts: GitHosts, now: () => number = Date.now) {
    this.store = store;
    this.hosts = hosts;
    this.now = now;
  }

  /** A link's modules, compared with those installed, for the owner to check. */
  async lookup(link: string): Promise<RepoLookup> {
    const url = linkOf(link);
    const host = this.hosts(url.host);
    const source = host.source(await host.resolve(url));
    const tree = await host.tree(source.repo, source.commit);
    return { source, modules: findModules(tree.listing, this.store.versions(), source.path) };
  }

  /** Installs one module of a repository, at its commit (its ref's head when none is given). */
  async install(pick: RepoPick): Promise<ReturnType<ModuleStore['install']>> {
    if (
      !REPO.test(pick.repo) ||
      pick.ref === '' ||
      (pick.commit !== undefined && !SHA.test(pick.commit))
    )
      throw new GitError('git: {"host"?, "repo": "<owner>/<repo>", "ref", "path", "commit"?}', 400);
    const host = this.hosts(pick.host ?? GITHUB_HOST);
    const resolved =
      pick.commit === undefined
        ? await host.commit(pick.repo, pick.ref)
        : {
            commit: pick.commit,
            ...(pick.commitDate === undefined ? {} : { commitDate: pick.commitDate }),
          };
    if (resolved === undefined)
      throw new GitError(`${host.host}/${pick.repo} has no branch, tag or commit ${pick.ref}`, 404);
    const source = host.source({
      repo: pick.repo,
      ref: pick.ref,
      refType: pick.refType ?? (SHA.test(pick.ref) ? 'commit' : 'branch'),
      path: pick.path,
      ...resolved,
    });
    const tree = await host.tree(source.repo, source.commit);
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
   * Checks each repository source for a newer commit: each branch's head once, however many
   * modules follow it; each repository's tags once, for the modules installed from a tag. One check
   * runs at a time; GitHub's rate limit stops it, said in `error`, as does each host's failure.
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
      .filter(
        (s): s is RepoSource & { installedAt: string } => s?.kind === 'github' || s?.kind === 'git'
      );
    const errors: string[] = [];
    /** The hosts that stopped this check: rate-limited, or not allowed. */
    const stopped = new Set<string>();
    const run = async (host: string, what: string, step: () => Promise<void>): Promise<void> => {
      if (stopped.has(host)) return;
      try {
        await step();
      } catch (e) {
        errors.push(`${what}: ${(e as Error).message}`);
        if (e instanceof HostNotAllowed || (e instanceof GitError && e.status === 429))
          stopped.add(host);
      }
    };
    const keyOf = (s: RepoSource, ref = s.ref): string => `${hostOf(s)} ${s.repo} ${ref}`;
    const branches = new Map(
      linked.filter((s) => s.refType === 'branch').map((s) => [keyOf(s), s])
    );
    for (const [key, s] of branches)
      await run(hostOf(s), `${s.repo} ${s.ref}`, async () => {
        const head = await this.hosts(hostOf(s)).commit(s.repo, s.ref);
        if (head === undefined) throw new GitError(`${s.ref} is not found`, 404);
        this.heads.set(key, head);
      });
    // Each module whose branch moved: what the commits changed, once for each range.
    const ranges = new Map<string, RepoSource & { to: string }>();
    for (const s of linked.filter((t) => t.refType === 'branch')) {
      const to = this.heads.get(keyOf(s))?.commit;
      if (to !== undefined && to !== s.commit)
        ranges.set(`${hostOf(s)} ${s.repo} ${s.commit} ${to}`, { ...s, to });
    }
    for (const key of this.changed.keys()) if (!ranges.has(key)) this.changed.delete(key);
    for (const [key, s] of ranges) {
      if (this.changed.has(key)) continue;
      await run(hostOf(s), `${s.repo} ${s.ref} compared`, async () => {
        this.changed.set(key, await this.hosts(hostOf(s)).changes(s.repo, s.commit, s.to));
      });
    }
    const tagged = linked.filter((s) => s.refType === 'tag');
    const repos = new Map(tagged.map((s) => [`${hostOf(s)} ${s.repo}`, s]));
    for (const [repoKey, first] of repos)
      await run(hostOf(first), `${first.repo} tags`, async () => {
        const host = this.hosts(hostOf(first));
        const tags = await host.tags(first.repo);
        for (const s of tagged.filter((t) => `${hostOf(t)} ${t.repo}` === repoKey)) {
          const tag = newerTag(tags, s.ref);
          const key = keyOf(s);
          if (tag === undefined) {
            this.newer.delete(key);
            continue;
          }
          const c = this.newer.get(key)?.commit === tag.commit ? this.newer.get(key) : undefined;
          const commitDate = c?.commitDate ?? (await host.commit(s.repo, tag.commit))?.commitDate;
          this.newer.set(key, {
            ref: tag.name,
            commit: tag.commit,
            ...(commitDate === undefined ? {} : { commitDate }),
          });
        }
      });
    this.state = {
      checkedAt: new Date(this.now()).toISOString(),
      ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
    };
    return this.state;
  }

  /** The update of a module's source, as the last check found it. */
  updateOf(source: ModuleOrigin | undefined): ModuleUpdate | undefined {
    if (source?.kind !== 'github' && source?.kind !== 'git') return undefined;
    const key = `${hostOf(source)} ${source.repo} ${source.ref}`;
    const found =
      source.refType === 'branch'
        ? this.heads.get(key)
        : source.refType === 'tag'
          ? this.newer.get(key)
          : undefined;
    if (found === undefined || found.commit === source.commit) return undefined;
    let unsure: string | undefined;
    if (source.refType === 'branch') {
      const changes = this.changed.get(
        `${hostOf(source)} ${source.repo} ${source.commit} ${found.commit}`
      );
      if (changes === undefined) unsure = 'the commits could not be compared';
      else if ('unknown' in changes) unsure = changes.unknown;
      else if (!touches(changes.files, source.path)) return undefined;
    }
    let host: GitHost;
    try {
      host = this.hosts(hostOf(source));
    } catch {
      return undefined; // a host no longer allowed: the check says so
    }
    return {
      ref: (found as { ref?: string }).ref ?? source.ref,
      commit: found.commit,
      ...(found.commitDate === undefined ? {} : { commitDate: found.commitDate }),
      compare: host.compare(source.repo, source.commit, found.commit),
      ...(unsure === undefined ? {} : { unsure }),
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

/** The self-hosted Git servers allowed, as the control API changes them (module-hosts.ts). */
export interface HostControls {
  /** The hosts allowed, and the Docker secrets' names a token may be picked from. */
  list(): unknown;
  /** Allows a host (or changes its token's secret), once it answers as a Gitea-compatible API. */
  add(entry: { host: string; secret?: string }): Promise<unknown>;
  /** Forgets a host. */
  remove(host: string): unknown;
}

/**
 * The control API's module controls (control-server.ts) over a store, the modules the instance
 * loaded, the repository sources and the hosts allowed, when the wiring offers them.
 */
export function moduleControls(
  store: ModuleStore,
  /** The modules loaded, or how to read them: none until the background load is done (D143). */
  loaded: ModulesLoad | (() => ModulesLoad | undefined) | undefined,
  git?: GitModules,
  nodes: () => readonly GraphNodeRef[] = () => [],
  hosts?: HostControls
): ModuleControls {
  const loadOf = (): ModulesLoad | undefined => (typeof loaded === 'function' ? loaded() : loaded);
  const report = (): ModulesReport => {
    const r = store.report(loadOf(), nodes());
    return git === undefined ? r : git.decorate(r);
  };
  return {
    report,
    install: (source) => {
      if (!('git' in source)) return store.install(source);
      if (git === undefined)
        throw new ModuleError('installing from a repository link is not offered here');
      return git.install(source.git);
    },
    rollback: (id) => store.rollback(id),
    remove: (id) => store.remove(id, loadOf(), nodes()),
    plan: (listing) => store.plan(listing),
    ...(git === undefined
      ? {}
      : {
          lookup: (url: string) => git.lookup(url),
          checkUpdates: async () => {
            await git.check();
            return report();
          },
        }),
    ...(hosts === undefined ? {} : { hosts }),
  };
}
