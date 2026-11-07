/**
 * The details of the node selected in the graph view: what it is, its live state, its config
 * and its settings in forms made from their schemas (read-only until the editor), and the
 * interface it declares: its ports, reads, actions and commands (P11). A killed node (D44) says so,
 * with its reinstatement; its forms stay as they are.
 */
import type { DriftCounts, MemberView, NodeView, PluginControl, PortView } from '#src/ui/api.ts';
import { SchemaForm } from './SchemaForm.tsx';

function Ports(props: { title: string; ports: Record<string, PortView> }) {
  const entries = Object.entries(props.ports);
  if (entries.length === 0) return null;
  return (
    <>
      <h4>{props.title}</h4>
      <ul>
        {entries.map(([name, p]) => (
          <li key={name}>
            <code>{name}</code> {p.label}
            {p.optional ? <span className="muted"> (optional)</span> : null}
            {p.help === undefined ? null : <span className="muted"> — {p.help}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Members(props: { title: string; members: MemberView[] }) {
  if (props.members.length === 0) return null;
  return (
    <>
      <h4>{props.title}</h4>
      <ul>
        {props.members.map((m) => (
          <li key={m.name}>
            <code>
              {m.name}
              {m.args === undefined ? '' : ` ${m.args}`}
            </code>{' '}
            {m.help}
            {m.owner === true ? <span className="muted"> (owner’s)</span> : null}
            {m.input === undefined || m.input['properties'] === undefined ? null : (
              <SchemaForm legend={`${m.name} input`} schema={m.input} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** A setting's value by its key: the surfaces name another plugin's `<id>.<key>` (§4.10). */
function settingsOf(id: string, live: PluginControl | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(live?.settings ?? {}))
    out[name.startsWith(`${id}.`) ? name.slice(id.length + 1) : name] = value;
  return out;
}

export function NodeDetails(props: {
  view: NodeView;
  live?: PluginControl | undefined;
  drift?: DriftCounts | undefined;
  kill: (ids: string[]) => void;
  reinstate: (id: string) => void;
}) {
  const { view, live, drift } = props;
  const killed = live?.killed === true;
  const i = view.interface;
  return (
    <aside className="details" aria-label={`details of ${view.id}`}>
      <h2>{view.id}</h2>
      <p>
        {view.description}{' '}
        <span className="muted">
          ({view.plugin} {view.version}; {view.kinds.join(', ')})
        </span>
      </p>
      <dl>
        {view.account === undefined ? null : (
          <>
            <dt>Account</dt>
            <dd>{view.account}</dd>
          </>
        )}
        <dt>State</dt>
        <dd>
          {live === undefined ? '…' : killed ? 'killed' : live.state}
          {live?.reason === undefined || killed ? null : (
            <span className="muted"> {live.reason}</span>
          )}
        </dd>
        <dt>Mode</dt>
        <dd>{live?.mode ?? <span className="muted">sends nothing</span>}</dd>
        {drift === undefined ? null : (
          <>
            <dt>Drift</dt>
            <dd>
              {drift.read} read, {drift.unread} unread ({drift.recent} recent)
              {drift.tripped ? <strong className="error"> tripped</strong> : null}
            </dd>
          </>
        )}
      </dl>
      {killed ? (
        <p className="killed-note">
          Killed: it sends nothing until reinstated.{' '}
          <button type="button" className="reinstate" onClick={() => props.reinstate(view.id)}>
            Reinstate
          </button>
        </p>
      ) : (
        <p>
          <button
            type="button"
            className="danger"
            disabled={live === undefined}
            onClick={() => props.kill([view.id])}
          >
            Kill {view.id}
          </button>
        </p>
      )}
      <section>
        <h3>Config</h3>
        {view.configSchema === undefined ? (
          <p className="muted">no config</p>
        ) : (
          <SchemaForm legend="config" schema={view.configSchema} value={view.config} />
        )}
      </section>
      <section>
        <h3>Settings</h3>
        {view.settingsSchema === undefined ? (
          <p className="muted">no settings</p>
        ) : (
          <SchemaForm
            legend="settings"
            schema={view.settingsSchema}
            value={settingsOf(view.id, live)}
          />
        )}
      </section>
      <section>
        <h3>Interface</h3>
        <Ports title="Inputs" ports={view.inputs} />
        <Ports title="Outputs" ports={view.outputs} />
        <Members title="Reads" members={i.reads} />
        <Members title="Actions" members={i.actions} />
        <Members title="Commands" members={i.commands} />
      </section>
    </aside>
  );
}
