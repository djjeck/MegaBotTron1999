/**
 * What an older data directory offers (bot-os.md D54, bot-os-api.md §8), mounted read-only: its
 * stores, each imported as a node's instance when the node is added in the graph editor; and its
 * event log, imported here in one action, with a table that renames the types written before they
 * were namespaced (`message` → `<namespace>.message`). The core lists those types and, where a
 * plugin of this instance registers a type of that name, suggests it (`GET /legacy/events`); the
 * table starts from those suggestions, and a type left without a new name is skipped, counted, for
 * the import to be run again.
 */
import { useEffect, useState } from 'react';
import type { LegacyEventTypes, LegacyReport } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Imported {
  days: number;
  imported: number;
  present: number;
  skipped: Record<string, number>;
}

export function ImportPage({ loggedOut }: PageProps) {
  const report = useLoad(() => api<LegacyReport>('/legacy'), loggedOut, 600_000);
  const types = useLoad(() => api<LegacyEventTypes>('/legacy/events'), loggedOut, 600_000);
  const [names, setNames] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Imported | string>();
  const [busy, setBusy] = useState(false);

  // Each old type's new name starts as the core's one suggestion.
  useEffect(() => {
    const t = types.data?.types;
    if (t === undefined) return;
    setNames((was) => {
      const next = { ...was };
      for (const [old, { suggest }] of Object.entries(t))
        if (next[old] === undefined && suggest.length === 1) next[old] = suggest[0] as string;
      return next;
    });
  }, [types.data]);

  const unmounted = report.error !== undefined && report.data === undefined;
  if (unmounted)
    return (
      <p className="muted">
        {report.error === 'not found'
          ? 'This instance has no import from an older data directory.'
          : report.error}{' '}
        Mount an older data directory read-only at <code>/legacy</code> (<code>LEGACY_DIR</code>) to
        import from it.
      </p>
    );
  const r = report.data;
  if (r === undefined) return <p className="muted">Loading…</p>;
  const table = Object.entries(types.data?.types ?? {});

  const importEvents = (): void => {
    const renames = Object.fromEntries(Object.entries(names).filter(([, v]) => v.trim() !== ''));
    setBusy(true);
    api<Imported>('/legacy/events/import', { types: renames }).then(
      (out) => {
        setBusy(false);
        setResult(out);
      },
      (e: unknown) => {
        setBusy(false);
        setResult(message(e));
      }
    );
  };

  return (
    <>
      <p>
        From <code>{r.dir}</code>, read-only: nothing is imported unasked, and nothing is written
        there.
      </p>
      <h2>Stores</h2>
      <p className="muted">
        Each is imported as the instance of a node, when the node is added in the graph (“Imported
        from the older data directory”).
      </p>
      {r.stores.length === 0 ? (
        <p className="muted">No store.</p>
      ) : (
        <ul>
          {r.stores.map((s) => (
            <li key={s.id}>
              <code>{s.id}</code>: {s.documents.length} documents, version {s.version}
              {s.settings ? ', settings' : ''}
              {s.mode === undefined ? '' : `, was ${s.mode}`}
            </li>
          ))}
        </ul>
      )}
      <h2>Event log</h2>
      {r.events.days === 0 ? (
        <p className="muted">No event log.</p>
      ) : (
        <>
          <p>
            {r.events.days} days, {r.events.first} to {r.events.last}. Each record is imported once:
            the import may be run again.
          </p>
          {table.length === 0 ? (
            <p className="muted">Every type is namespaced already: nothing to rename.</p>
          ) : (
            <table aria-label="type renames">
              <thead>
                <tr>
                  <th>Old type</th>
                  <th>Records</th>
                  <th>Imported as</th>
                </tr>
              </thead>
              <tbody>
                {table.map(([old, t]) => (
                  <tr key={old}>
                    <td>
                      <code>{old}</code>
                    </td>
                    <td>{t.count}</td>
                    <td>
                      <input
                        aria-label={`rename ${old}`}
                        list={`suggest-${old}`}
                        placeholder="<namespace>.<name>, or empty to skip"
                        value={names[old] ?? ''}
                        onChange={(e) => setNames({ ...names, [old]: e.target.value.trim() })}
                      />
                      <datalist id={`suggest-${old}`}>
                        {t.suggest.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" disabled={busy} onClick={importEvents}>
            Import the event log
          </button>
          {result === undefined ? null : typeof result === 'string' ? (
            <p role="alert">{result}</p>
          ) : (
            <p role="status">
              {result.imported} records imported, {result.present} there already, over {result.days}{' '}
              days
              {Object.keys(result.skipped).length === 0
                ? '.'
                : `; skipped, not namespaced: ${Object.entries(result.skipped)
                    .map(([t, n]) => `${t} (${n})`)
                    .join(', ')}.`}
            </p>
          )}
        </>
      )}
    </>
  );
}
