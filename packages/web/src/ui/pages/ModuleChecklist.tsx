/**
 * The modules a folder or a GitHub link holds, one row each, for the owner to check those to
 * install (bot-os.md D67): its id, its path in the folder or the repository, its version, how it
 * compares with the one installed (`new`, `update x → y`, `same version`, `older x → y`), and its
 * files, with those left out. Every row starts checked but a downgrade and a module that cannot be
 * installed (its error said).
 */
import type { ModuleCandidate } from '#src/ui/api.ts';

/** How a module found compares with the one of its id installed, in words. */
export function statusText(m: ModuleCandidate): string {
  switch (m.status) {
    case 'update':
      return `update ${m.installed ?? '?'} → ${m.version ?? '?'}`;
    case 'same':
      return 'same version';
    case 'older':
      return `older ${m.installed ?? '?'} → ${m.version ?? '?'}`;
    default:
      return 'new';
  }
}

/** The rows checked at first: all but downgrades and those with an error. */
export const firstChecked = (modules: readonly ModuleCandidate[]): Set<string> =>
  new Set(modules.filter((m) => m.error === undefined && m.status !== 'older').map((m) => m.path));

/** A size in bytes, for the owner. */
export const size = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 2 ** 20
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 2 ** 20).toFixed(1)} MiB`;

export interface ChecklistProps {
  modules: readonly ModuleCandidate[];
  checked: ReadonlySet<string>;
  setChecked: (next: Set<string>) => void;
  /** A module's path as shown (from inside the folder picked). */
  shown: (m: ModuleCandidate) => string;
  /** A module's size, when its files are at hand (a folder's). */
  bytes?: (m: ModuleCandidate) => number;
  /** Why a module cannot be sent, beyond its own error (a folder's module too large). */
  refused?: (m: ModuleCandidate) => string | undefined;
}

export function ModuleChecklist({
  modules,
  checked,
  setChecked,
  shown,
  bytes,
  refused,
}: ChecklistProps) {
  const toggle = (path: string, on: boolean): void => {
    const next = new Set(checked);
    if (on) next.add(path);
    else next.delete(path);
    setChecked(next);
  };
  return (
    <table className="checklist stack" aria-label="modules found">
      <thead>
        <tr>
          <th />
          <th>Module</th>
          <th>Path</th>
          <th>Version</th>
          <th>Status</th>
          <th>Files</th>
        </tr>
      </thead>
      <tbody>
        {modules.map((m) => {
          const why = m.error ?? refused?.(m);
          const label = m.id ?? shown(m);
          return (
            <tr key={m.path} className={why === undefined ? undefined : 'refused'}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`install ${label}`}
                  checked={why === undefined && checked.has(m.path)}
                  disabled={why !== undefined}
                  onChange={(e) => toggle(m.path, e.target.checked)}
                />
              </td>
              <td>
                <strong>{m.id ?? '?'}</strong>
                {m.description === undefined ? null : (
                  <div className="muted small">{m.description}</div>
                )}
                {why === undefined ? null : <div className="error small">{why}</div>}
              </td>
              <td data-label="Path">
                <code>{shown(m)}</code>
              </td>
              <td data-label="Version">{m.version ?? '?'}</td>
              <td data-label="Status">
                {m.error !== undefined && m.status === undefined ? null : (
                  <span className={`badge status-${m.status ?? 'new'}`}>{statusText(m)}</span>
                )}
              </td>
              <td data-label="Files">
                <span>
                  {`${m.files.length} ${m.files.length === 1 ? 'file' : 'files'}${bytes === undefined ? '' : `, ${size(bytes(m))}`}`}
                </span>
                {m.left.length === 0 ? null : (
                  <details className="left-out">
                    <summary>{m.left.length} left out</summary>
                    <ul>
                      {m.left.map((p) => (
                        <li key={p}>
                          <code>{p.slice(m.path === '' ? 0 : m.path.length + 1)}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
