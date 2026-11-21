/**
 * What a running node offers its owner, in its panel (docs/bot-os.md P11, D111): its own account of
 * itself (`status`, the read it declares under that name), the settings in force, each set at once
 * as `/set` does in chat (`POST /settings`), and each read and action it declares, called with its
 * input filled in a form made from its schema (`GET /plugins/<id>/state/<name>`, its input as the
 * query's fields; `POST /plugins/<id>/actions/<name>`, its input as the body), its answer shown
 * under it. Each of these is the running instance's, not the draft's: nothing here waits for Apply.
 */
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { MemberView } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import { BYTES_KEY } from './MediaField.tsx';
import { SchemaForm } from './SchemaForm.tsx';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/**
 * A value as JSON, bytes (`{ "$bytes": "<base64>" }`, an answer's media, D155) said by their size
 * rather than printed.
 */
const show = (v: unknown): string =>
  JSON.stringify(
    v,
    (k, x: unknown) =>
      k === BYTES_KEY && typeof x === 'string' ? `${Math.floor((x.length * 3) / 4)} bytes` : x,
    2
  ) ?? 'null';

/** Its own account of itself, as its `status` read gives it. */
export function NodeStatus({ status }: { status: unknown }) {
  return (
    <section>
      <h3>Status</h3>
      <pre className="said" aria-label="its status">
        {show(status)}
      </pre>
    </section>
  );
}

/** One setting in force, with a field to set it as the chat command does (`/set key value`). */
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
      (err: unknown) => props.changed(`${props.name}: ${message(err)}`)
    );
  };
  return (
    <form className="inline" onSubmit={submit}>
      <label>
        <code>{props.name}</code>
        <input aria-label={props.name} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="submit" aria-label={`Set ${props.name}`}>
        Set
      </button>
    </form>
  );
}

/** The settings in force on the running instance, each set at once. */
export function SettingsInForce(props: {
  settings: Readonly<Record<string, unknown>>;
  /** After a setting is set (or refused): the status is read again. */
  reload: () => void;
}) {
  const [said, setSaid] = useState<string>();
  const entries = Object.entries(props.settings);
  if (entries.length === 0) return null;
  return (
    <div className="in-force" role="group" aria-label="settings in force">
      <h4>In force</h4>
      <p className="muted small">
        The values its instance runs with, set at once, as <code>/set</code> does in chat, and kept
        by its instance across restarts.
      </p>
      {entries.map(([name, value]) => (
        <Setting
          key={name}
          name={name}
          value={value}
          changed={(text) => {
            setSaid(text);
            props.reload();
          }}
        />
      ))}
      {said === undefined ? null : (
        <p role="status" className="said">
          {said}
        </p>
      )}
    </div>
  );
}

/** A read's input as the query's fields: each a string, or JSON for anything else. */
export function query(input: Readonly<Record<string, unknown>>): string {
  const fields = Object.entries(input).map(([k, v]): [string, string] => [
    k,
    typeof v === 'string' ? v : JSON.stringify(v),
  ]);
  return fields.length === 0 ? '' : `?${new URLSearchParams(fields).toString()}`;
}

/**
 * A read or an action the running node declares, called from its panel: its input in a form made
 * from its schema, a button, and its answer, or why not.
 */
export function MemberCall(props: { node: string; kind: 'read' | 'action'; member: MemberView }) {
  const { node, kind, member: m } = props;
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const call = (): void => {
    const done = api<unknown>(
      kind === 'read'
        ? `/plugins/${seg(node)}/state/${seg(m.name)}${query(input)}`
        : `/plugins/${seg(node)}/actions/${seg(m.name)}`,
      kind === 'read' ? undefined : input
    );
    done.then(
      (out) => setSaid({ ok: true, text: show(out) }),
      (err: unknown) => setSaid({ ok: false, text: message(err) })
    );
  };
  const verb = kind === 'read' ? 'Read' : 'Run';
  return (
    <div className="member-call">
      {m.input === undefined || m.input['properties'] === undefined ? null : (
        <SchemaForm
          legend={`${m.name} input`}
          schema={m.input}
          value={input}
          onChange={setInput}
          node={node}
        />
      )}
      <button type="button" onClick={call}>
        {verb} {m.name}
      </button>
      {said === undefined ? null : (
        <pre
          className={said.ok ? 'said' : 'said error'}
          role="status"
          aria-label={`${m.name} answer`}
        >
          {said.text}
        </pre>
      )}
    </div>
  );
}
