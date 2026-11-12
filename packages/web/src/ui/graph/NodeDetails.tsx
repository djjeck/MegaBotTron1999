/**
 * The node selected in the graph editor (D55): what it is, its instance and its live state, and,
 * editable for the draft, its account (a connector's), the mode its instance starts in, its config
 * and the settings its instance starts with, in forms made from their schemas, each field with the
 * check's errors; a config key that names a secret (`configSecrets`) is a choice of the secrets'
 * names. Then the interface it declares (P11) and its removal, which keeps its instance. A killed
 * node (D44) says so, with its reinstatement; its forms stay editable as any other's.
 */
import type {
  DriftCounts,
  GraphNode,
  InstanceInfo,
  MemberView,
  Mode,
  NodeView,
  PluginControl,
  PortView,
} from '#src/ui/api.ts';
import { withDefaults } from './defaults.ts';
import { instanceOf } from './draft.ts';
import { SchemaForm } from './SchemaForm.tsx';

/** The modes a node's instance may start in (P10); unset, it starts `read-only`. */
const MODES: Record<Mode, string> = {
  'read-only': 'read-only: sends nothing',
  'dry-run': 'dry-run: records, sends nothing',
  live: 'live: sends',
};

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

const when = (t: number | undefined): string =>
  t === undefined ? 'never' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');

export function NodeDetails(props: {
  node: GraphNode;
  view: NodeView;
  live?: PluginControl | undefined;
  drift?: DriftCounts | undefined;
  /** The instance it names, if it is kept already. */
  instance?: InstanceInfo | undefined;
  problems: string[];
  configErrors: Record<string, string[]>;
  settingErrors: Record<string, string[]>;
  secretNames: readonly string[];
  change: (change: Partial<GraphNode>) => void;
  remove: () => void;
  kill: (ids: string[]) => void;
  reinstate: (id: string) => void;
}) {
  const { node, view, live, drift } = props;
  const killed = live?.killed === true;
  const connector = view.kinds.includes('connector');
  const i = view.interface;
  const instance = instanceOf(node);
  return (
    <aside className="details" aria-label={`details of ${view.id}`}>
      <h2>{view.id}</h2>
      <p>
        {view.description}{' '}
        <span className="muted">
          ({view.plugin} {view.version}; {view.kinds.join(', ')})
        </span>
      </p>
      {props.problems.length === 0 ? null : (
        <ul className="problems" aria-label={`problems of ${view.id}`}>
          {props.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <dl>
        <dt>Instance</dt>
        <dd>
          <code>{instance}</code>{' '}
          <span className="muted">
            {props.instance === undefined
              ? '(fresh: made at its first start)'
              : `(kept; last referenced ${when(props.instance.referenced)})`}
          </span>
        </dd>
        <dt>State</dt>
        <dd>
          {live === undefined ? 'not running' : killed ? 'killed' : live.state}
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
      {live === undefined ? null : killed ? (
        <p className="killed-note">
          Killed: it sends nothing until reinstated.{' '}
          <button type="button" className="reinstate" onClick={() => props.reinstate(view.id)}>
            Reinstate
          </button>
        </p>
      ) : (
        <p>
          <button type="button" className="danger" onClick={() => props.kill([view.id])}>
            Kill {view.id}
          </button>
        </p>
      )}
      <section>
        <h3>Node</h3>
        {connector ? (
          <div className="field">
            <label>
              <code>account</code>
              <input
                aria-label="account"
                value={node.account ?? ''}
                placeholder={view.account}
                onChange={(e) => props.change({ account: e.target.value })}
              />
            </label>
            <small className="muted">
              {'<network>:<name>'}; the plugin’s own ({view.account ?? 'none'}) when empty
            </small>
          </div>
        ) : (
          <div className="field">
            <label>
              <code>mode</code>
              <select
                aria-label="mode"
                value={node.mode ?? ''}
                onChange={(e) =>
                  props.change({ mode: (e.target.value || undefined) as Mode | undefined })
                }
              >
                <option value="">(unset: read-only)</option>
                {Object.entries(MODES).map(([m, help]) => (
                  <option key={m} value={m}>
                    {help}
                  </option>
                ))}
              </select>
            </label>
            <small className="muted">
              The mode its instance starts in, while it keeps none of its own (P10).
            </small>
          </div>
        )}
      </section>
      <section>
        <h3>Config</h3>
        {view.configSchema === undefined ? (
          <p className="muted">no config</p>
        ) : (
          <SchemaForm
            legend="config"
            schema={view.configSchema}
            // Unset fields shown with their defaults, written with the first change (`defaults.ts`).
            value={withDefaults(view.configSchema, node.config)}
            onChange={(config) => props.change({ config })}
            secretKeys={view.configSecrets}
            secretNames={props.secretNames}
            errors={props.configErrors}
          />
        )}
        {view.secrets.length === 0 ? null : (
          <p className="muted small">Secrets it reads: {view.secrets.join(', ')}</p>
        )}
      </section>
      <section>
        <h3>Settings</h3>
        {view.settingsSchema === undefined ? (
          <p className="muted">no settings</p>
        ) : (
          <>
            <p className="muted small">
              What its instance starts with, while it keeps none of its own; the owner’s later
              changes (Admin: Plugins) win.
            </p>
            <SchemaForm
              legend="settings"
              schema={view.settingsSchema}
              value={node.settings}
              onChange={(settings) => props.change({ settings })}
              errors={props.settingErrors}
            />
          </>
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
      <p>
        <button type="button" className="danger" onClick={props.remove}>
          Remove {view.id}
        </button>
      </p>
    </aside>
  );
}
