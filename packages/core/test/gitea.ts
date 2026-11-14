/**
 * A fake of a self-hosted Git server's Gitea-compatible API for tests: `fetch` answered from
 * synthetic repositories, public or private, each call kept with the token it carried. Nothing
 * reaches the network. Hosts are made up (`git.example.lan`).
 */
import { type FakeRepo, githubTarball } from './github.ts';

export interface FakeGiteaRepo extends FakeRepo {
  /** Readable only with the token. */
  private?: boolean;
}

export interface FakeGiteaOptions {
  /** The token the server takes; any other is refused (401). */
  token?: string;
  /** Its version, or none: not a Gitea-compatible server (404). */
  version?: string | null;
  /** The archives redirect to this host (a storage server), which serves them. */
  archivesAt?: string;
}

export interface FakeGitea {
  fetch: typeof globalThis.fetch;
  /** Every URL fetched, `<host><path><search>`, with ` token <t>` when one was sent. */
  calls: string[];
  repos: Record<string, FakeGiteaRepo>;
  /** Answers every call with this, or throws it, when set. */
  fail?: () => Response | Error;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A `fetch` failing as Node's does when a server's certificate is not trusted. */
export const tlsFailure = (code = 'SELF_SIGNED_CERT_IN_CHAIN'): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code }),
  });

export function fakeGitea(
  host: string,
  repos: Record<string, FakeGiteaRepo>,
  o: FakeGiteaOptions = {}
): FakeGitea {
  const fake: FakeGitea = { calls: [], repos, fetch: undefined as unknown as typeof fetch };
  const find = (r: FakeRepo, ref: string): string | undefined =>
    r.branches?.[ref] ??
    r.tags?.[ref] ??
    Object.keys(r.dates ?? {}).find((c) => ref.length >= 7 && c.startsWith(ref));
  const archive = (repo: string, commit: string): Response => {
    const files = repos[repo]?.trees?.[commit];
    return files === undefined
      ? json({ message: 'Not Found' }, 404)
      : new Response(githubTarball(repo, commit, files));
  };
  fake.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    fake.calls.push(
      `${url.host}${url.pathname}${url.search}${auth === undefined ? '' : ` ${auth}`}`
    );
    const failed = fake.fail?.();
    if (failed instanceof Error) return Promise.reject(failed);
    if (failed !== undefined) return Promise.resolve(failed);
    if (o.archivesAt !== undefined && url.host === o.archivesAt) {
      const [repo = '', commit = ''] = url.pathname.slice(1).split('@');
      return Promise.resolve(archive(repo, commit));
    }
    if (url.host !== host) return Promise.resolve(json({ message: 'Not Found' }, 404));
    if (auth !== undefined && auth !== `token ${o.token}`)
      return Promise.resolve(json({ message: 'user does not exist' }, 401));
    const authed = auth !== undefined;
    const parts = url.pathname
      .split('/')
      .filter((p) => p !== '')
      .map(decodeURIComponent);
    if (parts[0] !== 'api' || parts[1] !== 'v1')
      return Promise.resolve(json({ message: 'Not Found' }, 404));
    if (parts[2] === 'version')
      return Promise.resolve(
        o.version === null
          ? json({ message: 'Not Found' }, 404)
          : json({ version: o.version ?? '1.21.0' })
      );
    const [, , , owner = '', name = '', what, ...rest] = parts;
    const repo = `${owner}/${name}`;
    const r = repos[repo];
    if (r === undefined || (r.private === true && !authed))
      return Promise.resolve(json({ message: 'Not Found' }, 404));
    if (what === undefined) return Promise.resolve(json({ default_branch: r.defaultBranch }));
    if (what === 'commits') {
      const c = find(r, url.searchParams.get('sha') ?? '');
      return Promise.resolve(
        c === undefined
          ? json({ message: 'Not Found' }, 404)
          : json([{ sha: c, commit: { committer: { date: r.dates?.[c] } } }])
      );
    }
    if (what === 'tags') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const all = Object.entries(r.tags ?? {}).map(([n, c]) => ({ name: n, commit: { sha: c } }));
      return Promise.resolve(json(all.slice((page - 1) * limit, page * limit)));
    }
    if (what === 'archive') {
      const commit = (rest[0] ?? '').replace(/\.tar\.gz$/u, '');
      if (o.archivesAt !== undefined)
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://${o.archivesAt}/${repo}@${commit}` },
          })
        );
      return Promise.resolve(archive(repo, commit));
    }
    return Promise.resolve(json({ message: 'Not Found' }, 404));
  };
  return fake;
}
