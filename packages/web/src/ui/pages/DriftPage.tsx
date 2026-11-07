/**
 * The drift reports (P5, §4.7): each parser's counts of what it read and could not read, whether
 * it tripped the pause of what acts on it, and the latest messages it could not read, from the
 * event log (`core.drift`).
 */
import type { DriftCounts, LogEntry } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

const when = (t: number): string => new Date(t).toLocaleString();

export function DriftPage({ loggedOut }: PageProps) {
  const counts = useLoad(() => api<DriftCounts[]>('/drift'), loggedOut);
  const reports = useLoad(
    () => api<LogEntry[]>('/events?type=core.drift&limit=50&hours=168'),
    loggedOut
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
        <ul className="log">
          {reports.data.map((r, i) => (
            <li key={`${r.t}-${i}`}>
              <time>{when(r.t)}</time> <strong>{String(r['plugin'] ?? '')}</strong>{' '}
              {String(r['event'] ?? '')}
              {r['text'] === undefined ? null : <pre>{String(r['text'])}</pre>}
              {r['reason'] === undefined ? null : <span>: {String(r['reason'])}</span>}
              {Array.isArray(r['paused']) && r['paused'].length > 0 ? (
                <span>; paused {(r['paused'] as unknown[]).map(String).join(', ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
