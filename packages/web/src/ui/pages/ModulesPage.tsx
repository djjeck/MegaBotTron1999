/**
 * The modules (bot-os.md D49, D53; bot-os-api.md §7.4): each installed, with its version, the
 * version the running instance loaded and the one kept for a rollback; those the instance refused
 * at its start, with why; and whether a restart is needed to load what is installed. A module is
 * installed from its folder, picked or dropped on the page and shown (its `module.json`'s id,
 * version and description) before the owner confirms, then sent file by file as base64; or from its
 * `.tar.gz` (sent as base64). Both are `POST /modules`. One is rolled back to its previous version
 * (`POST /modules/<id>/rollback`); either takes effect at the next restart, offered here.
 */
import type { DragEvent, FormEvent } from 'react';
import { useRef, useState } from 'react';
import type { ModulesReport } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';
import type { FolderFile, ModuleFolder } from '#src/ui/module-folder.ts';
import { droppedFiles, pickedFiles, readFolder } from '#src/ui/module-folder.ts';
import { Restart } from '#src/ui/Restart.tsx';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Bytes as base64, in chunks that `String.fromCharCode` takes. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface Installed {
  id: string;
  version: string;
  previous?: string;
}

/** A size in bytes, for the owner. */
const size = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 2 ** 20
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 2 ** 20).toFixed(1)} MiB`;

export function ModulesPage({ loggedOut, restarted }: PageProps) {
  const report = useLoad(() => api<ModulesReport>('/modules'), loggedOut, 30_000);
  const [file, setFile] = useState<File>();
  const [folder, setFolder] = useState<ModuleFolder>();
  const [dragging, setDragging] = useState(false);
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  /** Sends what the owner confirmed, and says what came of it. */
  const send = (body: () => Promise<unknown>): void => {
    setBusy(true);
    body()
      .then((b) => api<Installed>('/modules', b))
      .then(
        (r) => {
          setFolder(undefined);
          setSaid(
            `${r.id} ${r.version} installed${r.previous === undefined ? '' : ` (${r.previous} kept for a rollback)`}: restart to load it`
          );
        },
        (err: unknown) => setSaid(`not installed: ${message(err)}`)
      )
      .finally(() => {
        setBusy(false);
        report.reload();
      });
  };

  const install = (e: FormEvent): void => {
    e.preventDefault();
    if (file === undefined) return;
    send(async () => ({ tarball: base64(new Uint8Array(await file.arrayBuffer())) }));
  };

  /** Reads a folder's files, for the owner to see which module it is before installing it. */
  const choose = (files: Promise<FolderFile[]>): void => {
    setSaid(undefined);
    setFolder(undefined);
    files
      .then(readFolder)
      .then(setFolder, (err: unknown) => setSaid(`the folder does not read: ${message(err)}`));
  };

  const installFolder = (f: ModuleFolder): void =>
    send(async () => ({
      files: await Promise.all(
        f.files.map(async ({ path, file: one }) => ({
          path,
          content: base64(new Uint8Array(await one.arrayBuffer())),
        }))
      ),
    }));

  const drop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    // The entries must be taken while the drop is handled: the list is gone after it.
    const entries = [...e.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null);
    if (entries.length === 0) return;
    const one = entries.length === 1 ? entries[0] : undefined;
    const tar = one?.isFile === true && /\.(?:tar\.gz|tgz|tar)$/iu.test(one.name);
    if (tar) {
      setFolder(undefined);
      (one as FileSystemFileEntry).file((f) => {
        setFile(f);
        setSaid(`${f.name}: install it below, from a .tar.gz`);
      });
      return;
    }
    choose(droppedFiles(entries));
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
      <section
        aria-label="install a module"
        className={dragging ? 'drop dragging' : 'drop'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <h2>Install a module</h2>
        <p>
          Choose the module&apos;s folder (the one that holds its <code>module.json</code>, from a
          clone or a downloaded ZIP), or drop it here. Its <code>.git</code> and{' '}
          <code>node_modules</code> are left out.
        </p>
        <input
          ref={(el) => {
            picker.current = el;
            el?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          hidden
          aria-label="module folder"
          onChange={(e) => {
            const list = e.target.files;
            if (list !== null && list.length > 0) choose(Promise.resolve(pickedFiles(list)));
            e.target.value = '';
          }}
        />
        <button type="button" className="primary" onClick={() => picker.current?.click()}>
          Choose folder
        </button>
        {folder === undefined ? null : (
          <div className="picked" aria-label="module picked">
            {folder.manifest === undefined ? null : (
              <dl>
                <dt>Module</dt>
                <dd>
                  <strong>{folder.manifest.id}</strong> {folder.manifest.version}
                </dd>
                {folder.manifest.description === undefined ? null : (
                  <>
                    <dt>Description</dt>
                    <dd>{folder.manifest.description}</dd>
                  </>
                )}
                <dt>Files</dt>
                <dd>
                  {folder.files.length} from {folder.name}/, {size(folder.bytes)}
                </dd>
              </dl>
            )}
            {folder.error === undefined ? null : (
              <p role="alert" className="error">
                {folder.error}
              </p>
            )}
            {folder.manifest === undefined || folder.error !== undefined ? null : (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => installFolder(folder)}
              >
                {busy ? 'Installing…' : `Install ${folder.manifest.id} ${folder.manifest.version}`}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setFolder(undefined)}>
              Cancel
            </button>
          </div>
        )}
        <details open={file !== undefined}>
          <summary>Or install a module&apos;s tarball</summary>
          <form onSubmit={install} className="inline">
            <label>
              A <code>.tar.gz</code>, as <code>git archive --prefix=&lt;id&gt;/</code> makes it
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
        </details>
      </section>
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
          done={(note) => {
            setRestarting(false);
            if (restarted === undefined) setSaid(note);
            else restarted(note);
          }}
          loggedOut={(note) => loggedOut(note)}
          failed={(why) => {
            setRestarting(false);
            setSaid(`restart: ${why}`);
          }}
        />
      ) : null}
    </>
  );
}
