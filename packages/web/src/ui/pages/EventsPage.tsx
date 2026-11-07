/**
 * The event log's latest records (§4.4), newest first, those of a type that starts with the filter
 * (`core.`, `core.drift`, a game's namespace). Records are shown as the log holds them, secrets
 * already redacted by the core.
 */
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { LogEntry } from '#src/ui/api.ts';
import { api } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

/** A record's fields but its type and time, in one line. */
function fields(r: LogEntry): string {
  const { type: _type, t: _t, ...rest } = r;
  const text = JSON.stringify(rest);
  return text === '{}' ? '' : text;
}

function Records(props: PageProps & { type: string; limit: number }) {
  const { type, limit, loggedOut } = props;
  const events = useLoad(
    () => api<LogEntry[]>(`/events?limit=${limit}&type=${encodeURIComponent(type)}`),
    loggedOut
  );
  const list = events.data;
  if (list === undefined) return <p className="muted">{events.error ?? 'Loading…'}</p>;
  if (list.length === 0) return <p className="muted">No record in the last 24 hours.</p>;
  return (
    <ul className="log">
      {list.map((r, i) => (
        <li key={`${r.t}-${i}`}>
          <time>{new Date(r.t).toLocaleString()}</time> <strong>{r.type}</strong>{' '}
          <code>{fields(r)}</code>
        </li>
      ))}
    </ul>
  );
}

export function EventsPage({ loggedOut }: PageProps) {
  const [draft, setDraft] = useState('');
  const [type, setType] = useState('');
  const [limit, setLimit] = useState(100);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setType(draft.trim());
  };
  return (
    <>
      <form className="inline" onSubmit={submit}>
        <label>
          Type starts with
          <input value={draft} placeholder="core." onChange={(e) => setDraft(e.target.value)} />
        </label>
        <label>
          Show
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>
      {/* A new filter is a new list, loaded afresh. */}
      <Records key={`${type}|${limit}`} type={type} limit={limit} loggedOut={loggedOut} />
    </>
  );
}
