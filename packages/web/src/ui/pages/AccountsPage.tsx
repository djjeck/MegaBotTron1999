/** The accounts the instance holds: each connector instance and its connection's status. */
import type { AccountControl } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

export function AccountsPage({ loggedOut }: PageProps) {
  const accounts = useLoad(() => api<AccountControl[]>('/accounts'), loggedOut);
  const list = accounts.data;
  if (list === undefined) return <p className="muted">{accounts.error ?? 'Loading…'}</p>;
  if (list.length === 0) return <p className="muted">No connector runs.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Account</th>
          <th>Connector</th>
          <th>As</th>
          <th>Connection</th>
          <th>Plugin</th>
        </tr>
      </thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.id}>
            <td>{a.account ?? '—'}</td>
            <td>{a.id === a.plugin ? a.id : `${a.id} (${a.plugin})`}</td>
            <td>{a.self ?? '—'}</td>
            <td>
              {a.connection === undefined ? (
                '—'
              ) : (
                <>
                  <span className={`badge ${a.connection.state}`}>{a.connection.state}</span>{' '}
                  {a.connection.phase}
                  {a.connection.detail === undefined ? '' : `: ${a.connection.detail}`}
                </>
              )}
            </td>
            <td>
              <span className={`badge ${a.state}`}>{a.state}</span>
              {a.reason === undefined ? '' : ` ${a.reason}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
