/**
 * The modules (bot-os.md D49, D53, D67; bot-os-api.md §7.4): each installed, with its version, its
 * source (a folder, a tarball, or a GitHub repository at a commit, linked) and when it was
 * installed, the version the running instance loaded and the one kept for a rollback; those the
 * instance refused at its start, with why; and whether a restart is needed to load what is
 * installed.
 *
 * Installing: a folder picked or dropped, or a GitHub link pasted, may hold one module or several
 * (a repository's root). The modules found (`POST /modules/plan` for a folder, `POST /modules/github`
 * for a link) are listed for the owner to check, each with how it compares with the one installed;
 * the checked ones are installed one by one (`POST /modules` each: a folder's files, as base64, or
 * the module's GitHub source at its commit), each on its own, and the page says how each went. A
 * module's `.tar.gz` is installed as before. The modules from GitHub are checked for updates (by
 * the shell every 6 hours, or **Check for updates**): one with a newer commit says so, links
 * GitHub's comparison, and **Update** installs it, as any install. Nothing is installed or
 * restarted but by the owner; the restart is offered here.
 *
 * Removing (bot-os.md D68): **Remove**, once confirmed, moves the module aside as its previous
 * version (`DELETE /modules/<id>`); it is listed as removed, with **Restore** (its rollback), until
 * an install of its id replaces it. The button is disabled, its reason shown on hover, while a node
 * of the saved graph uses one of its plugins or another module imports it.
 */
import type { DragEvent, FormEvent } from 'react';
import { useRef, useState } from 'react';
import type {
  GitHubLookup,
  InstalledModule,
  ModuleCandidate,
  ModulesReport,
  RemovedModule,
} from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';
import type { FolderFile } from '#src/ui/module-folder.ts';
import {
  droppedFiles,
  folderName,
  listing,
  MAX_MODULE_BYTES,
  moduleFiles,
  pickedFiles,
  shownPath,
} from '#src/ui/module-folder.ts';
import { Restart } from '#src/ui/Restart.tsx';
import { firstChecked, ModuleChecklist } from './ModuleChecklist.tsx';

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

/** A time for the owner: `2026-11-12 14:05 UTC`. */
export const when = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const day = (iso: string): string => iso.slice(0, 10);
const short = (commit: string): string => commit.slice(0, 7);

/** What the owner is choosing from: a folder's modules, or a GitHub link's. */
type Found =
  | { kind: 'folder'; name: string; files: FolderFile[]; modules: ModuleCandidate[] }
  | { kind: 'github'; lookup: GitHubLookup; modules: ModuleCandidate[] };

/** How one install went. */
interface Outcome {
  label: string;
  ok: boolean;
  text: string;
}

type Source = NonNullable<InstalledModule['source']>;
type GitHubOrigin = Extract<Source, { kind: 'github' }>;

/** A GitHub source's folder at its commit. */
const githubTree = (s: { repo: string; commit: string; path: string }): string =>
  `https://github.com/${s.repo}/tree/${s.commit}${s.path === '' ? '' : `/${s.path}`}`;

/** Where a module came from, for the owner. */
function SourceCell({ source }: { source: Source | undefined }) {
  if (source === undefined) return <span className="muted">unknown</span>;
  const at = <div className="muted small">installed {when(source.installedAt)}</div>;
  if (source.kind === 'github')
    return (
      <>
        <a href={githubTree(source)} target="_blank" rel="noreferrer">
          {source.repo}
          {source.path === '' ? '' : `/${source.path}`}
        </a>{' '}
        <span className="muted small">
          {source.refType === 'commit' ? '' : `${source.ref} `}@ <code>{short(source.commit)}</code>
        </span>
        {at}
      </>
    );
  const what =
    source.kind === 'directory'
      ? `directory ${source.path}`
      : `${source.kind === 'folder' ? 'folder upload' : 'tarball'}${source.name === undefined ? '' : ` ${source.name}`}`;
  return (
    <>
      {what}
      {at}
    </>
  );
}

/** The confirmation of a removal, naming the module and how to undo it. */
function ConfirmRemove(props: {
  m: InstalledModule;
  busy: boolean;
  confirm: () => void;
  cancel: () => void;
}) {
  const { m } = props;
  const name = `${m.id}${m.version === undefined ? '' : ` ${m.version}`}`;
  return (
    <div className="overlay">
      <div className="card review" role="dialog" aria-modal="true" aria-label="remove module">
        <h2>Remove {name}?</h2>
        <p>
          <strong>{m.id}</strong> is moved aside, as its previous version
          {m.previous === undefined ? '' : `, in place of ${m.previous}`}: <strong>Restore</strong>{' '}
          puts it back, until another install of {m.id} replaces it.
        </p>
        <p className="muted small">
          {m.loaded === undefined
            ? 'The running instance has not loaded it.'
            : 'Its plugins run until the next start: restart to apply the removal.'}
        </p>
        <p className="actions">
          <button type="button" className="danger" disabled={props.busy} onClick={props.confirm}>
            {props.busy ? 'Removing…' : `Remove ${m.id}`}
          </button>
          <button type="button" disabled={props.busy} onClick={props.cancel}>
            Cancel
          </button>
        </p>
      </div>
    </div>
  );
}

export function ModulesPage({ loggedOut, restarted }: PageProps) {
  const report = useLoad(() => api<ModulesReport>('/modules'), loggedOut, 30_000);
  const [file, setFile] = useState<File>();
  const [found, setFound] = useState<Found>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [link, setLink] = useState('');
  const [dragging, setDragging] = useState(false);
  const [said, setSaid] = useState<string>();
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState<string>();
  const [restarting, setRestarting] = useState(false);
  const [removing, setRemoving] = useState<InstalledModule>();
  const picker = useRef<HTMLInputElement>(null);

  const start = (what: string): void => {
    setSaid(undefined);
    setOutcomes([]);
    setBusy(what);
  };

  /** Shows the modules found, the downgrades and the refused unchecked. */
  const show = (f: Found): void => {
    setFound(f);
    setChecked(firstChecked(f.modules));
    if (f.modules.length === 0)
      setSaid(
        f.kind === 'folder'
          ? `no module.json in ${f.name || 'the folder'}: choose a module's folder, or a repository's that holds modules`
          : `no module.json under ${f.lookup.source.repo}${f.lookup.source.path === '' ? '' : `/${f.lookup.source.path}`} (vendor/ and tests aside)`
      );
  };

  /**
   * Installs modules one by one, each on its own (one refused does not stop the others), and says
   * how each went; the restart is then offered once.
   */
  const installEach = async (
    items: { label: string; body: () => Promise<unknown>; left?: number }[]
  ): Promise<void> => {
    const done: Outcome[] = [];
    for (const [i, item] of items.entries()) {
      setBusy(`Installing ${i + 1} of ${items.length}: ${item.label}…`);
      try {
        const r = await api<Installed>('/modules', await item.body());
        done.push({
          label: item.label,
          ok: true,
          text: `${r.id} ${r.version} installed${r.previous === undefined ? '' : ` (${r.previous} kept for a rollback)`}${item.left === undefined || item.left === 0 ? '' : `, ${item.left} files left out`}`,
        });
      } catch (err) {
        done.push({
          label: item.label,
          ok: false,
          text: `${item.label}: not installed: ${message(err)}`,
        });
      }
    }
    setOutcomes(done);
    setBusy(undefined);
    report.reload();
  };

  const install = (e: FormEvent): void => {
    e.preventDefault();
    if (file === undefined) return;
    start('Installing…');
    void installEach([
      {
        label: file.name,
        body: async () => ({
          tarball: base64(new Uint8Array(await file.arrayBuffer())),
          name: file.name,
        }),
      },
    ]);
  };

  /** Reads a folder's paths and manifests, and asks which modules it holds. */
  const choose = (files: Promise<FolderFile[]>): void => {
    setFound(undefined);
    start('Reading the folder…');
    files
      .then(async (all) => {
        if (all.length === 0) throw new Error('the folder is empty');
        const modules = await api<ModuleCandidate[]>('/modules/plan', await listing(all));
        show({ kind: 'folder', name: folderName(all), files: all, modules });
      })
      .catch((err: unknown) => setSaid(`the folder does not read: ${message(err)}`))
      .finally(() => setBusy(undefined));
  };

  const lookUp = (e: FormEvent): void => {
    e.preventDefault();
    if (link.trim() === '') return;
    setFound(undefined);
    start('Looking up…');
    api<GitHubLookup>('/modules/github', { url: link.trim() })
      .then((lookup) => show({ kind: 'github', lookup, modules: lookup.modules }))
      .catch((err: unknown) => setSaid(`the link: ${message(err)}`))
      .finally(() => setBusy(undefined));
  };

  const folderBytes = (m: ModuleCandidate): number =>
    found?.kind === 'folder' ? moduleFiles(m, found.files).bytes : 0;

  /** Why a folder's module cannot be sent: its files over the upload's limit. */
  const tooBig = (m: ModuleCandidate): string | undefined =>
    folderBytes(m) > MAX_MODULE_BYTES
      ? `over ${MAX_MODULE_BYTES / 2 ** 20} MiB: list what it ships in its module.json's files`
      : undefined;

  /** Whether a module found is checked, and can be installed. */
  const chosen = (m: ModuleCandidate): boolean =>
    m.error === undefined && tooBig(m) === undefined && checked.has(m.path);

  const installChecked = (): void => {
    if (found === undefined) return;
    const picked = found.modules.filter(chosen);
    setFound(undefined);
    start('Installing…');
    void installEach(
      picked.map((m) => {
        const label = m.id ?? m.path;
        if (found.kind === 'github') {
          const s = found.lookup.source;
          return {
            label,
            left: m.left.length,
            body: () =>
              Promise.resolve({
                github: {
                  repo: s.repo,
                  ref: s.ref,
                  refType: s.refType,
                  path: m.path,
                  commit: s.commit,
                  ...(s.commitDate === undefined ? {} : { commitDate: s.commitDate }),
                },
              }),
          };
        }
        const { files } = moduleFiles(m, found.files);
        const from = (p: string): string => (m.path === '' ? p : p.slice(m.path.length + 1));
        return {
          label,
          left: m.left.length,
          body: async () => ({
            files: await Promise.all(
              files.map(async ({ path, file: one }) => ({
                path: from(path),
                content: base64(new Uint8Array(await one.arrayBuffer())),
              }))
            ),
            name: m.path,
          }),
        };
      })
    );
  };

  /** Installs the updates found, each from its source at its newer commit. */
  const update = (modules: readonly InstalledModule[]): void => {
    start('Updating…');
    void installEach(
      modules.flatMap((m) => {
        const s = m.source as GitHubOrigin | undefined;
        const u = m.update;
        if (s?.kind !== 'github' || u === undefined) return [];
        return [
          {
            label: m.id,
            body: () =>
              Promise.resolve({
                github: {
                  repo: s.repo,
                  ref: u.ref,
                  refType: s.refType,
                  path: s.path,
                  commit: u.commit,
                  ...(u.commitDate === undefined ? {} : { commitDate: u.commitDate }),
                },
              }),
          },
        ];
      })
    );
  };

  const checkUpdates = (): void => {
    start('Checking…');
    api<ModulesReport>('/modules/updates', {})
      .then(
        (r) => {
          const n = r.installed.filter((m) => m.update !== undefined).length;
          setSaid(
            r.updates?.error === undefined
              ? n === 0
                ? 'No update: every module from GitHub is at its newest commit.'
                : `${n} ${n === 1 ? 'update' : 'updates'} available.`
              : undefined
          );
        },
        (err: unknown) => setSaid(`the check: ${message(err)}`)
      )
      .finally(() => {
        setBusy(undefined);
        report.reload();
      });
  };

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
      setFound(undefined);
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

  const remove = (m: InstalledModule): void => {
    setBusy(`Removing ${m.id}…`);
    api(`/modules/${seg(m.id)}`, undefined, 'DELETE')
      .then(
        () =>
          setSaid(
            `${m.id} removed: ${m.loaded === undefined ? 'Restore puts it back' : 'restart to apply it, or Restore to put it back'}`
          ),
        (err: unknown) => setSaid(`${m.id}: not removed: ${message(err)}`)
      )
      .finally(() => {
        setRemoving(undefined);
        setBusy(undefined);
        report.reload();
      });
  };

  const restore = (m: RemovedModule): void => {
    const name = `${m.id}${m.version === undefined ? '' : ` ${m.version}`}`;
    if (!window.confirm(`Restore ${name}? It is installed again, and loaded at the next start.`))
      return;
    api(`/modules/${seg(m.id)}/rollback`, {})
      .then(
        () => setSaid(`${name} restored: restart to load it`),
        (err: unknown) => setSaid(`${m.id}: ${message(err)}`)
      )
      .finally(report.reload);
  };

  const r = report.data;
  const removed = r?.removed ?? [];
  const updates = r?.installed.filter((m) => m.update !== undefined) ?? [];
  const linked = r?.installed.some((m) => m.source?.kind === 'github') === true;
  const toInstall = found?.modules.filter(chosen).length ?? 0;
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
      {outcomes.length === 0 ? null : (
        <ul className="outcomes" aria-label="installs">
          {outcomes.map((o) => (
            <li key={o.label} className={o.ok ? 'ok' : 'error'}>
              {o.text}
            </li>
          ))}
        </ul>
      )}
      {report.error === undefined ? null : <p role="alert">{report.error}</p>}
      <section
        aria-label="install modules"
        className={dragging ? 'drop dragging' : 'drop'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <h2>Install modules</h2>
        <p>
          Choose a module&apos;s folder, or a repository&apos;s that holds several (a clone or a
          downloaded ZIP), or drop it here; or paste a GitHub link. Every <code>module.json</code>{' '}
          is found, but under <code>vendor/</code>; each module&apos;s tests are left out, unless
          its <code>module.json</code> lists its <code>files</code>.
        </p>
        <div className="install-ways">
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
          <button
            type="button"
            className="primary"
            disabled={busy !== undefined}
            onClick={() => picker.current?.click()}
          >
            Choose folder
          </button>
          <form onSubmit={lookUp} className="inline link">
            <input
              type="url"
              aria-label="GitHub link"
              placeholder="https://github.com/<owner>/<repo>[/tree/<ref>/<path>]"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <button type="submit" disabled={busy !== undefined || link.trim() === ''}>
              Look up
            </button>
          </form>
        </div>
        {busy === undefined ? null : (
          <p className="muted" role="progressbar" aria-label="working">
            {busy}
          </p>
        )}
        {found === undefined || found.modules.length === 0 ? null : (
          <div className="picked" aria-label="modules picked">
            <p>
              {found.kind === 'folder' ? (
                <>
                  {found.modules.length} {found.modules.length === 1 ? 'module' : 'modules'} in{' '}
                  <strong>{found.name || 'the folder'}</strong>
                </>
              ) : (
                <>
                  {found.modules.length} {found.modules.length === 1 ? 'module' : 'modules'} in{' '}
                  <a href={githubTree(found.lookup.source)} target="_blank" rel="noreferrer">
                    {found.lookup.source.repo}
                  </a>{' '}
                  at {found.lookup.source.ref} <code>{short(found.lookup.source.commit)}</code>
                  {found.lookup.source.commitDate === undefined
                    ? null
                    : ` (${day(found.lookup.source.commitDate)})`}
                </>
              )}
            </p>
            <div className="table-scroll">
              <ModuleChecklist
                modules={found.modules}
                checked={checked}
                setChecked={setChecked}
                shown={(m) =>
                  found.kind === 'folder' ? shownPath(m.path, found.name) : m.path || '.'
                }
                {...(found.kind === 'folder' ? { bytes: folderBytes, refused: tooBig } : {})}
              />
            </div>
            <button
              type="button"
              className="primary"
              disabled={busy !== undefined || toInstall === 0}
              onClick={installChecked}
            >
              Install {toInstall} {toInstall === 1 ? 'module' : 'modules'}
            </button>
            <button type="button" disabled={busy !== undefined} onClick={() => setFound(undefined)}>
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
            <button type="submit" disabled={file === undefined || busy !== undefined}>
              Install
            </button>
          </form>
        </details>
      </section>
      {linked ? (
        <div className="updates-bar" aria-label="updates">
          <button type="button" disabled={busy !== undefined} onClick={checkUpdates}>
            Check for updates
          </button>
          {updates.length === 0 ? null : (
            <button
              type="button"
              className="primary"
              disabled={busy !== undefined}
              onClick={() => update(updates)}
            >
              Update all ({updates.length})
            </button>
          )}
          <span className="muted small">
            {r?.updates?.checkedAt === undefined
              ? 'not checked yet'
              : `checked ${when(r.updates.checkedAt)}; the shell checks every 6 hours`}
          </span>
          {r?.updates?.error === undefined ? null : (
            <p role="alert" className="small">
              {r.updates.error}
            </p>
          )}
        </div>
      ) : null}
      {r === undefined ? (
        <p className="muted">Loading…</p>
      ) : r.installed.length === 0 && removed.length === 0 ? (
        <p className="muted">No module is installed.</p>
      ) : (
        <div className="table-scroll">
          <table className="modules stack" aria-label="modules installed">
            <thead>
              <tr>
                <th>Module</th>
                <th>Installed</th>
                <th>Source</th>
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
                  <td data-label="Installed">{m.version ?? '?'}</td>
                  <td data-label="Source">
                    <SourceCell source={m.source} />
                    {m.update === undefined ? null : (
                      <div className="update small">
                        update available:{' '}
                        <a href={m.update.compare} target="_blank" rel="noreferrer">
                          <code>{short(m.update.commit)}</code>
                          {m.update.commitDate === undefined
                            ? ''
                            : ` (${day(m.update.commitDate)})`}
                        </a>
                        {m.source?.kind === 'github' && m.update.ref !== m.source.ref
                          ? ` ${m.update.ref}`
                          : ''}
                      </div>
                    )}
                  </td>
                  <td data-label="Running">
                    {m.loaded ?? <span className="muted">not loaded</span>}
                  </td>
                  <td data-label="Previous">{m.previous ?? <span className="muted">none</span>}</td>
                  <td>
                    {m.update === undefined ? null : (
                      <button
                        type="button"
                        className="primary"
                        disabled={busy !== undefined}
                        onClick={() => update([m])}
                      >
                        Update
                      </button>
                    )}
                    {m.previous === undefined ? null : (
                      <button type="button" onClick={() => rollback(m.id, m.previous as string)}>
                        Roll back to {m.previous}
                      </button>
                    )}
                    <span className="tip" data-tip={m.inUse}>
                      <button
                        type="button"
                        disabled={busy !== undefined || m.inUse !== undefined}
                        aria-describedby={m.inUse === undefined ? undefined : `in-use-${m.id}`}
                        onClick={() => setRemoving(m)}
                      >
                        Remove
                      </button>
                      {m.inUse === undefined ? null : (
                        <span id={`in-use-${m.id}`} hidden>
                          {m.inUse}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {removed.map((m) => (
                <tr key={`removed ${m.id}`} className="removed">
                  <td>
                    <strong>{m.id}</strong>
                    {m.description === undefined ? null : (
                      <div className="muted small">{m.description}</div>
                    )}
                    {m.error === undefined ? null : <div className="error small">{m.error}</div>}
                  </td>
                  <td data-label="Installed">
                    <span className="tag">removed</span>
                  </td>
                  <td data-label="Source">
                    <SourceCell source={m.source} />
                  </td>
                  <td data-label="Running">
                    {m.loaded ?? <span className="muted">not loaded</span>}
                  </td>
                  <td data-label="Previous">{m.version ?? '?'}</td>
                  <td>
                    <button type="button" disabled={busy !== undefined} onClick={() => restore(m)}>
                      Restore{m.version === undefined ? '' : ` ${m.version}`}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      {removing === undefined ? null : (
        <ConfirmRemove
          m={removing}
          busy={busy !== undefined}
          confirm={() => remove(removing)}
          cancel={() => setRemoving(undefined)}
        />
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
