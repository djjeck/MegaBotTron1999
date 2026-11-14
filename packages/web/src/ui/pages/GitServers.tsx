/**
 * The self-hosted Git servers the shell may fetch modules from (bot-os.md D102, bot-os-api.md
 * §7.4), on the Modules page: each added, with the Docker secret its token is in (or none, for its
 * public repositories), and **Remove**; and a form to add one: its host, and its token's secret
 * picked from the secrets mounted, never a value typed. The shell adds it once it answers as a
 * Gitea-compatible API, and says why not otherwise (a certificate not trusted, a token refused).
 * GitHub is always allowed.
 */
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { GitServersReport } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import { useLoad } from '#src/ui/hooks.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function GitServers({ loggedOut }: { loggedOut: (note?: string) => void }) {
  const report = useLoad(
    () => api<GitServersReport>('/modules/hosts'),
    () => loggedOut(),
    60_000
  );
  const [host, setHost] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();

  const add = (e: FormEvent): void => {
    e.preventDefault();
    if (host.trim() === '') return;
    setBusy(true);
    setSaid(undefined);
    api<GitServersReport>('/modules/hosts', {
      host: host.trim(),
      ...(secret === '' ? {} : { secret }),
    })
      .then(
        () => {
          setSaid(`${host.trim()} added: paste a link on it above`);
          setHost('');
          setSecret('');
        },
        (err: unknown) => setSaid(`${host.trim()}: not added: ${message(err)}`)
      )
      .finally(() => {
        setBusy(false);
        report.reload();
      });
  };

  const remove = (name: string): void => {
    if (!window.confirm(`Remove ${name}? Nothing is fetched from it any more, its modules stay.`))
      return;
    api(`/modules/hosts/${seg(name)}`, undefined, 'DELETE')
      .then(
        () => setSaid(`${name} removed`),
        (err: unknown) => setSaid(`${name}: ${message(err)}`)
      )
      .finally(report.reload);
  };

  const r = report.data;
  return (
    <details open={r !== undefined && r.servers.length > 0}>
      <summary>Git servers</summary>
      <p className="muted small">
        Besides GitHub, the shell fetches modules only from the self-hosted Git servers added here
        (with a Gitea-compatible API). A private repository needs a token, kept as a Docker secret:
        mount it under <code>/run/secrets</code>, then pick its name. A server whose certificate is
        from a private CA needs that CA mounted and <code>NODE_EXTRA_CA_CERTS</code> set.
      </p>
      {report.error === undefined ? null : <p className="error small">{report.error}</p>}
      {said === undefined ? null : <p role="status">{said}</p>}
      {r === undefined || r.servers.length === 0 ? null : (
        <ul aria-label="Git servers">
          {r.servers.map((s) => (
            <li key={s.host}>
              <strong>{s.host}</strong>{' '}
              <span className="muted small">
                {s.secret === undefined ? (
                  'no token: public repositories only'
                ) : (
                  <>
                    token in the secret <code>{s.secret}</code>
                  </>
                )}
              </span>{' '}
              <button type="button" onClick={() => remove(s.host)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="inline">
        <input
          type="text"
          aria-label="Git server"
          placeholder="git.example.lan"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
        <select
          aria-label="token secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        >
          <option value="">No token (public repositories only)</option>
          {(r?.secrets ?? []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || host.trim() === ''}>
          {busy ? 'Adding…' : 'Add server'}
        </button>
      </form>
    </details>
  );
}
