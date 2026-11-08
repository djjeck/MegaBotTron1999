/**
 * The modules (bot-os.md D49, D53; bot-os-api.md §7.4): each installed, with its version, the
 * version the running instance loaded and the one kept for a rollback; those the instance refused
 * at its start, with why; and whether a restart is needed to load what is installed. A module is
 * installed from its `.tar.gz` (sent as base64, `POST /modules`) and rolled back to its previous
 * version (`POST /modules/<id>/rollback`); either takes effect at the next restart, offered here.
 */
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { ModulesReport } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';
import { Restart } from '#src/ui/Restart.tsx';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Bytes as base64, in chunks that `String.fromCharCode` takes. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function ModulesPage({ loggedOut }: PageProps) {
  const report = useLoad(() => api<ModulesReport>('/modules'), loggedOut, 30_000);
  const [file, setFile] = useState<File>();
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const install = (e: FormEvent): void => {
    e.preventDefault();
    if (file === undefined) return;
    setBusy(true);
    file
      .arrayBuffer()
      .then((b) =>
        api<{ id: string; version: string; previous?: string }>('/modules', {
          tarball: base64(new Uint8Array(b)),
        })
      )
      .then(
        (r) =>
          setSaid(
            `${r.id} ${r.version} installed${r.previous === undefined ? '' : ` (${r.previous} kept for a rollback)`}: restart to load it`
          ),
        (err: unknown) => setSaid(`not installed: ${message(err)}`)
      )
      .finally(() => {
        setBusy(false);
        report.reload();
      });
  };

  const rollback = (id: string, previous: string): void => {
    if (!window.confirm(`Roll ${id} back to ${previous}? (A second rollback goes forward again.)`))
      return;
    api(`/modules/${seg(id)}/rollback`, {})
      .then(
        () => setSaid(`${id} rolled back to ${previous}: restart to load it`),
        (err: unknown) => setSaid(`${id}: ${message(err)}`)
      )
      .finally(report.reload);
  };

  const r = report.data;
  return (
    <>
      {r?.restart === true ? (
        <p role="alert" className="banner warn">
          A restart is needed to load the modules as installed.{' '}
          <button type="button" onClick={() => setRestarting(true)}>
            Apply (restart)
          </button>
        </p>
      ) : null}
      {said === undefined ? null : <p role="status">{said}</p>}
      {report.error === undefined ? null : <p role="alert">{report.error}</p>}
      <form onSubmit={install}>
        <label>
          Install a module (<code>.tar.gz</code>, as <code>git archive --prefix=&lt;id&gt;/</code>{' '}
          makes it)
          <input
            type="file"
            aria-label="module tarball"
            accept=".tar.gz,.tgz,.tar,application/gzip"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
        </label>
        <button type="submit" disabled={file === undefined || busy}>
          Install
        </button>
      </form>
      {r === undefined ? (
        <p className="muted">Loading…</p>
      ) : r.installed.length === 0 ? (
        <p className="muted">No module is installed.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th>Installed</th>
              <th>Running</th>
              <th>Previous</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.installed.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.id}</strong>
                  {m.description === undefined ? null : (
                    <div className="muted small">{m.description}</div>
                  )}
                  {m.error === undefined ? null : <div className="error small">{m.error}</div>}
                </td>
                <td>{m.version ?? '?'}</td>
                <td>{m.loaded ?? <span className="muted">not loaded</span>}</td>
                <td>{m.previous ?? <span className="muted">none</span>}</td>
                <td>
                  {m.previous === undefined ? null : (
                    <button type="button" onClick={() => rollback(m.id, m.previous as string)}>
                      Roll back to {m.previous}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r === undefined || r.failures.length === 0 ? null : (
        <>
          <h2>Refused at the last start</h2>
          <ul className="problems" aria-label="modules refused">
            {r.failures.map((f) => (
              <li key={f.id}>
                <strong>{f.id}</strong>: {f.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {restarting ? (
        <Restart
          done={(note) => loggedOut(note)}
          failed={(why) => {
            setRestarting(false);
            setSaid(`restart: ${why}`);
          }}
        />
      ) : null}
    </>
  );
}
