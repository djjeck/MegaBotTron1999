/**
 * The plugins: the graph's node instances, in load order, each with its state, its mode and
 * a control for it (P10), a resume when the core paused it (P5), and, opened, its settings, its own
 * status and the reads and actions it declares (P11). The instance's off switch heads the page:
 * there is no plugin's own off in the core (a partial kill is the graph view's, D44).
 */
import type { Mode } from '@megabottron1999/core';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { PluginControl, Status } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

/**
 * The modes (P10), each with what it does: a record of the core's type, so that a mode added to the
 * core fails the type check here. The app imports none of the core's modules, only its types.
 */
const MODES: Record<Mode, string> = {
  'read-only': 'read-only: sends nothing',
  'dry-run': 'dry-run: records, sends nothing',
  live: 'live: sends',
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const show = (v: unknown): string => JSON.stringify(v, null, 2) ?? 'null';

/** One setting, with a field to set it as the chat command would (`/set key value`). */
function Setting(props: { name: string; value: unknown; changed: (said: string) => void }) {
  const [text, setText] = useState(
    typeof props.value === 'string' ? props.value : JSON.stringify(props.value)
  );
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // A plain string.
    }
    api('/settings', { key: props.name, value }).then(
      () => props.changed(`${props.name} set`),
      (err: unknown) => props.changed(message(err))
    );
  };
  return (
    <form className="inline" onSubmit={submit}>
      <label>
        <code>{props.name}</code>
        <input aria-label={props.name} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="submit">Set</button>
    </form>
  );
}

/** A declared action, called with its input as JSON. */
function Action(props: { id: string; name: string; done: (said: string) => void }) {
  const [input, setInput] = useState('{}');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    let body: unknown;
    try {
      body = JSON.parse(input);
    } catch {
      props.done(`${props.name}: the input is not JSON`);
      return;
    }
    api(`/plugins/${seg(props.id)}/actions/${seg(props.name)}`, body).then(
      (out) => props.done(`${props.name}: ${show(out)}`),
      (err: unknown) => props.done(`${props.name}: ${message(err)}`)
    );
  };
  return (
    <form className="inline" onSubmit={submit}>
      <label>
        <code>{props.name}</code>
        <input
          aria-label={`${props.name} input`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      <button type="submit">Run</button>
    </form>
  );
}

function Details({ p, reload }: { p: PluginControl; reload: () => void }) {
  const [said, setSaid] = useState<string>();
  const read = (name: string): void => {
    api(`/plugins/${seg(p.id)}/state/${seg(name)}`).then(
      (v) => setSaid(`${name}: ${show(v)}`),
      (err: unknown) => setSaid(`${name}: ${message(err)}`)
    );
  };
  const after = (text: string): void => {
    setSaid(text);
    reload();
  };
  const settings = Object.entries(p.settings);
  return (
    <div className="details">
      <p>{p.description}</p>
      {p.status === undefined ? null : <pre>{show(p.status)}</pre>}
      {settings.length === 0 ? null : (
        <section>
          <h3>Settings</h3>
          {settings.map(([name, value]) => (
            <Setting key={name} name={name} value={value} changed={after} />
          ))}
        </section>
      )}
      {p.reads.length === 0 ? null : (
        <section>
          <h3>Reads</h3>
          {p.reads.map((name) => (
            <button key={name} type="button" onClick={() => read(name)}>
              {name}
            </button>
          ))}
        </section>
      )}
      {p.actions.length === 0 ? null : (
        <section>
          <h3>Actions</h3>
          {p.actions.map((name) => (
            <Action key={name} id={p.id} name={name} done={after} />
          ))}
        </section>
      )}
      {said === undefined ? null : (
        <pre role="status" className="said">
          {said}
        </pre>
      )}
    </div>
  );
}

function Row({ p, off, reload }: { p: PluginControl; off: boolean; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const post = (route: string, body: unknown): void => {
    setError(undefined);
    api(route, body).then(reload, (e: unknown) => setError(message(e)));
  };
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className="link"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {p.id}
          </button>
          {p.plugin === p.id ? null : <span className="muted"> ({p.plugin})</span>}
        </td>
        <td>{p.kinds.join(', ')}</td>
        <td>
          <span className={`badge ${p.state}`}>{p.state}</span>
          {p.reason === undefined ? null : <span className="muted"> {p.reason}</span>}
          {p.state === 'paused' ? (
            <button type="button" onClick={() => post(`/plugins/${seg(p.id)}/resume`, {})}>
              Resume
            </button>
          ) : null}
        </td>
        <td>
          {p.mode === undefined ? (
            <span className="muted">sends nothing</span>
          ) : (
            <select
              aria-label={`${p.id} mode`}
              value={p.mode}
              disabled={off}
              onChange={(e) => post(`/plugins/${seg(p.id)}/mode`, { mode: e.target.value })}
            >
              {Object.entries(MODES).map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {error === undefined ? null : (
            <span role="alert" className="error">
              {' '}
              {error}
            </span>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={4}>
            <Details p={p} reload={reload} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function PluginsPage({ loggedOut }: PageProps) {
  const status = useLoad(() => api<Status>('/status'), loggedOut);
  const s = status.data;
  if (s === undefined) return <p className="muted">{status.error ?? 'Loading…'}</p>;
  const power = (route: string): void => {
    api(route, {}).then(status.reload, status.reload);
  };
  return (
    <>
      <p>
        The instance is <strong>{s.off ? 'off' : 'on'}</strong>{' '}
        <button type="button" onClick={() => power(s.off ? '/on' : '/off')}>
          {s.off ? 'Turn on' : 'Turn off'}
        </button>
        {s.off ? <span className="muted"> (modes change only while on)</span> : null}
      </p>
      <table>
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Kinds</th>
            <th>State</th>
            <th>Mode</th>
          </tr>
        </thead>
        <tbody>
          {s.plugins.map((p) => (
            <Row key={p.id} p={p} off={s.off} reload={status.reload} />
          ))}
        </tbody>
      </table>
    </>
  );
}
