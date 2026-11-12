/**
 * The plugins: the graph's node instances, in load order, each with its state (D64: running,
 * disabled, stopped with its stop, inactive with the node it needs, failed with why), read-only:
 * a node's state changes only in the graph editor, applied with Apply. Opened, its settings, its
 * own status and the reads and actions it declares (P11). The instance's off switch heads the page.
 */
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { PluginControl, Status } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';

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

function Row({ p, reload }: { p: PluginControl; reload: () => void }) {
  const [open, setOpen] = useState(false);
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
          <span className={`badge ${p.state}`}>
            {p.state === 'stopped' ? (
              <span className="warning-icon" role="img" aria-label="warning">
                ⚠{' '}
              </span>
            ) : null}
            {p.state}
          </span>
          {p.reason === undefined ? null : <span className="muted"> {p.reason}</span>}
          {p.stop === undefined ? null : (
            <span className="muted small">
              {' '}
              ({p.stop.source}, {p.stop.time.slice(0, 16).replace('T', ' ')} UTC)
            </span>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={3}>
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
      </p>
      <p className="muted small">
        A node is enabled, disabled or cleared of its stop, and a chat-out edge sent for real or as
        a dry run, in the <a href="#/graph">graph</a>, then applied.
      </p>
      <table>
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Kinds</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {s.plugins.map((p) => (
            <Row key={p.id} p={p} reload={status.reload} />
          ))}
        </tbody>
      </table>
    </>
  );
}
