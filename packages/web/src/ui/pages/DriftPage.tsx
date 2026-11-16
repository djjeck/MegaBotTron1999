/**
 * The drift reports (P5, §4.7): each parser's counts of what it read and could not read, whether
 * it tripped the pause of what acts on it, and the latest messages it could not read, from the
 * event log (`core.drift`), by parser: those of the version it runs now (`GET /status`), and those
 * of earlier versions folded under one line.
 */
import type { DriftCounts, LogEntry, Status } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

const when = (t: number): string => new Date(t).toLocaleString();

/** A parser's reports: those of the version it runs (or of none known), and the earlier ones. */
interface ParserReports {
  parser: string;
  version?: string | undefined;
  current: LogEntry[];
  earlier: LogEntry[];
}

/**
 * The reports by parser, in the order of each one's latest: a report of another version than the
 * one its parser runs now is an earlier version's, left behind by an upgrade. A report of no
 * version (written before they had one), or of a parser whose version is not known, is current.
 */
function byParser(records: readonly LogEntry[], versions: ReadonlyMap<string, string>) {
  const groups = new Map<string, ParserReports>();
  for (const r of records) {
    const parser = String(r['plugin'] ?? '');
    let g = groups.get(parser);
    if (g === undefined) {
      g = { parser, version: versions.get(parser), current: [], earlier: [] };
      groups.set(parser, g);
    }
    const v = r['version'];
    (typeof v === 'string' && g.version !== undefined && v !== g.version
      ? g.earlier
      : g.current
    ).push(r);
  }
  return [...groups.values()];
}

function Reports({ records }: { records: readonly LogEntry[] }) {
  return (
    <ul className="log">
      {records.map((r, i) => (
        <li key={`${r.t}-${i}`}>
          <time>{when(r.t)}</time> {String(r['event'] ?? '')}
          {typeof r['version'] === 'string' ? (
            <span className="muted"> ({r['version']})</span>
          ) : null}
          {r['text'] === undefined ? null : <pre>{String(r['text'])}</pre>}
          {r['reason'] === undefined ? null : <span>: {String(r['reason'])}</span>}
          {Array.isArray(r['paused']) && r['paused'].length > 0 ? (
            <span>; paused {(r['paused'] as unknown[]).map(String).join(', ')}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function DriftPage({ loggedOut }: PageProps) {
  const counts = useLoad(() => api<DriftCounts[]>('/drift'), loggedOut);
  // The version each node runs, to tell a parser's reports of an earlier version apart.
  const status = useLoad(() => api<Status>('/status'), loggedOut);
  const reports = useLoad(
    () => api<LogEntry[]>('/events?type=core.drift&limit=50&hours=168'),
    loggedOut
  );
  const versions = new Map(
    (status.data?.plugins ?? []).flatMap((p) =>
      p.version === undefined ? [] : [[p.id, p.version] as const]
    )
  );
  return (
    <>
      {counts.data === undefined ? (
        <p className="muted">{counts.error ?? 'Loading…'}</p>
      ) : counts.data.length === 0 ? (
        <p className="muted">No parser has reported since the start.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Parser</th>
              <th>Read</th>
              <th>Unread</th>
              <th>Unread in the window</th>
              <th>Tripped</th>
            </tr>
          </thead>
          <tbody>
            {counts.data.map((c) => (
              <tr key={c.parser}>
                <td>{c.parser}</td>
                <td>{c.read}</td>
                <td>{c.unread}</td>
                <td>{c.recent}</td>
                <td>{c.tripped ? <span className="badge failed">tripped</span> : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Latest reports (7 days)</h2>
      {reports.data === undefined ? (
        <p className="muted">{reports.error ?? 'Loading…'}</p>
      ) : reports.data.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        byParser(reports.data, versions).map((g) => (
          <section key={g.parser}>
            {g.parser === '' ? null : (
              <h3>
                {g.parser}
                {g.version === undefined ? null : <span className="muted"> {g.version}</span>}
              </h3>
            )}
            {g.current.length === 0 ? null : <Reports records={g.current} />}
            {g.earlier.length === 0 ? null : (
              <details>
                <summary>{g.earlier.length} from earlier versions</summary>
                <Reports records={g.earlier} />
              </details>
            )}
          </section>
        ))
      )}
    </>
  );
}
