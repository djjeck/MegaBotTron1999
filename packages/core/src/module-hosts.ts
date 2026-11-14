/**
 * The hosts the shell fetches modules from (docs/bot-os-api.md §7.4, bot-os.md D102, #48): GitHub,
 * always, and the self-hosted Git servers the owner has added, each with the Docker secret that
 * holds its token, or none for its public repositories. Nothing is fetched from any other host.
 *
 * The owner adds a server on the Modules page (`POST /modules/hosts`): its host (`git.example.lan`,
 * with a port if it has one) and the name of a Docker secret, picked from those mounted (never a
 * value typed). It is added once it answers as a Gitea-compatible API (`GET /api/v1/version`), with
 * the token if one is named. The list is kept in the core's store (`<data>/core/git-servers.json`):
 * hosts and secrets' names, never a token. A token is read from its secret when a request needs it
 * (`Secrets.read`, which remembers it, so that it is redacted from everything logged), and sent to
 * its host only (module-gitea.ts). A secret named for a host is no longer offered to the
 * connectors' configs (the wiring's `GET /secrets`).
 */
import {
  GitError,
  type GitHost,
  GITHUB_HOST,
  type HostControls,
  HostNotAllowed,
} from './module-git.ts';
import { Gitea } from './module-gitea.ts';

/** A self-hosted Git server allowed: its host, its API's kind, and its token's secret if any. */
export interface GitServer {
  host: string;
  api: 'gitea';
  /** The Docker secret holding its token; none for public repositories only. */
  secret?: string;
}

/** The servers allowed, and the secrets' names a token may be picked from. */
export interface GitServersReport {
  servers: GitServer[];
  secrets: string[];
}

export interface GitHostListOptions {
  /** Where the list is kept: the core's store. */
  store: { read(name: string): unknown; write(name: string, value: unknown): void };
  /** GitHub, always allowed. */
  github: GitHost;
  /** A Docker secret's value, by its name (`Secrets.read`). */
  read: (name: string) => string | undefined;
  /** The names of the Docker secrets a token may be picked from (the shell's own left out). */
  names: () => string[];
  fetch?: typeof globalThis.fetch;
}

/** The core store's document of the servers allowed. */
export const SERVERS_DOC = 'git-servers';

/**
 * A host as the owner types it, normalised as links name it: `git.example.lan`, `GIT.example.lan:3000`,
 * `https://git.example.lan/` are taken; a path, `http://` or credentials are refused.
 */
export function hostName(text: string): string {
  const t = text.trim().replace(/\/+$/u, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(t) && !/^https:\/\//iu.test(t))
    throw new GitError(`${text}: a Git server is reached over https only`, 400);
  let url: URL;
  try {
    url = new URL(/^https:\/\//iu.test(t) ? t : `https://${t}`);
  } catch {
    throw new GitError(`${text} is not a host: give it as git.example.lan`, 400);
  }
  if (
    url.pathname !== '/' ||
    url.username !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    t === ''
  )
    throw new GitError(
      `${text} is not a host: give it as git.example.lan (a server under a path is not supported)`,
      400
    );
  if (url.host === GITHUB_HOST || url.host === `www.${GITHUB_HOST}`)
    throw new GitError('GitHub is always allowed: no need to add it', 400);
  return url.host;
}

/** The hosts allowed: GitHub's, and the servers the owner added. */
export class GitHostList implements HostControls {
  private readonly o: GitHostListOptions;
  private readonly hosts = new Map<string, Gitea>();

  constructor(o: GitHostListOptions) {
    this.o = o;
  }

  /** The servers allowed, as kept. */
  servers(): GitServer[] {
    const kept = this.o.store.read(SERVERS_DOC) as { servers?: unknown } | undefined;
    return (Array.isArray(kept?.servers) ? (kept.servers as GitServer[]) : []).filter(
      (s) => typeof s.host === 'string' && s.api === 'gitea'
    );
  }

  /** The secrets' names the servers' tokens are in: none of them is a connector's to name. */
  secrets(): string[] {
    return this.servers().flatMap((s) => (s.secret === undefined ? [] : [s.secret]));
  }

  list(): GitServersReport {
    return { servers: this.servers(), secrets: this.o.names() };
  }

  private gitea(s: GitServer): Gitea {
    const secret = s.secret;
    return new Gitea({
      host: s.host,
      ...(secret === undefined ? {} : { secret, token: () => this.o.read(secret) }),
      ...(this.o.fetch === undefined ? {} : { fetch: this.o.fetch }),
    });
  }

  /** The host a link or a source names, if it is allowed. */
  readonly get = (host: string): GitHost => {
    const name = host.toLowerCase();
    if (name === GITHUB_HOST) return this.o.github;
    const kept = this.hosts.get(name);
    if (kept !== undefined) return kept;
    const server = this.servers().find((s) => s.host === name);
    if (server === undefined) throw new HostNotAllowed(name);
    const made = this.gitea(server);
    this.hosts.set(name, made);
    return made;
  };

  /**
   * Adds a server, or changes its token's secret: once it answers as a Gitea-compatible API, with
   * the token if one is named.
   */
  async add(entry: { host: string; secret?: string }): Promise<GitServersReport> {
    const host = hostName(entry.host);
    const secret = entry.secret === '' ? undefined : entry.secret;
    if (secret !== undefined && !this.o.names().includes(secret))
      throw new GitError(
        `no Docker secret ${secret}: pick one of those mounted under /run/secrets`,
        400
      );
    if (secret !== undefined && this.o.read(secret) === undefined)
      throw new GitError(`the secret ${secret} does not read`, 400);
    const server: GitServer = { host, api: 'gitea', ...(secret === undefined ? {} : { secret }) };
    await this.gitea(server).version();
    this.save([...this.servers().filter((s) => s.host !== host), server]);
    return this.list();
  }

  /** Forgets a server: nothing is fetched from it any more, its modules' updates not checked. */
  remove(host: string): GitServersReport {
    const name = host.toLowerCase();
    if (!this.servers().some((s) => s.host === name))
      throw new GitError(`${host} is not a Git server added`, 404);
    this.save(this.servers().filter((s) => s.host !== name));
    return this.list();
  }

  private save(servers: GitServer[]): void {
    this.hosts.clear();
    this.o.store.write(SERVERS_DOC, {
      servers: [...servers].sort((a, b) => a.host.localeCompare(b.host)),
    });
  }
}
