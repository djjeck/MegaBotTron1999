/**
 * The node selected in the graph editor (D55): what it is, its instance and its live state, and,
 * editable for the draft, whether it is enabled (D64), its account (a connector's), its config
 * and the settings its instance starts with, in forms made from their schemas, each field with the
 * check's errors; a config key that names a secret (`configSecrets`) is a choice of the secrets'
 * names; a connector's `chats` (what it monitors) is picked from its surfaces (D63), and once the
 * draft changes them, a reminder names its chat-in edges to update, each opening its panel. Then
 * the interface it declares (P11) and its removal, which keeps its instance. A stopped node (D64)
 * says why, when and by what, with **Clear stop**, a change of the draft that Apply makes; a
 * running one can be killed (D44). Its forms stay editable whatever its state. Its group (D69),
 * the lane it is drawn in, is picked among the draft's, or named anew. Its outputs say what they
 * carry (D71): an events output its event types, an interface output its members. A node up that
 * keeps a state (D72) shows it, drawn from its schema; a running connector, its queue (D73).
 */
import { useState } from 'react';
import type {
  DriftCounts,
  EventTypeView,
  GraphEdge,
  GraphNode,
  InstanceInfo,
  JsonSchema,
  MemberView,
  NodeView,
  PluginControl,
  PortView,
} from '#src/ui/api.ts';
import { isSplit } from './cards.ts';
import { withDefaults } from './defaults.ts';
import { instanceOf } from './draft.ts';
import { ConnectorQueue } from './Queue.tsx';
import { SchemaForm } from './SchemaForm.tsx';
import { signature } from './signature.ts';
import { NodeState } from './StateViewer.tsx';
import { CHATS_KEY, MonitoredChats } from './Surfaces.tsx';

/** A config schema without its `chats` list, which the picker shows; undefined: it has none. */
function withoutChats(schema: JsonSchema | undefined): JsonSchema | undefined {
  const props = schema?.['properties'] as Record<string, JsonSchema> | undefined;
  if (props?.[CHATS_KEY]?.['type'] !== 'array') return undefined;
  const { [CHATS_KEY]: _, ...rest } = props;
  return { ...schema, properties: rest };
}

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

/**
 * Its outputs (bot-os.md D71), each by what it carries rather than its type, which the graph draws:
 * an events output, the event types its plugin publishes there, each with its description; an
 * interface output, its members' names, in a disclosure that opens on each one's signature and
 * help; any other, its port in words.
 */
function Outputs(props: { ports: Record<string, PortView>; view: NodeView }) {
  const entries = Object.entries(props.ports);
  if (entries.length === 0) return null;
  const members = new Map<string, MemberView>([
    ...props.view.interface.reads.map((m): [string, MemberView] => [`state.${m.name}`, m]),
    ...props.view.interface.actions.map((m): [string, MemberView] => [`actions.${m.name}`, m]),
  ]);
  return (
    <>
      <h4>Outputs</h4>
      <ul className="outputs">
        {entries.map(([name, p]) => (
          <li key={name}>
            <code>{name}</code>{' '}
            {p.type === 'events' ? (
              <EventTypes types={p.types ?? []} />
            ) : p.type === 'interface' ? (
              <InterfaceMembers names={p.members} members={members} />
            ) : (
              <>
                {p.label}
                {p.optional ? <span className="muted"> (optional)</span> : null}
                {p.help === undefined ? null : <span className="muted"> — {p.help}</span>}
                {p.type === 'chat-out' && p.commands !== undefined ? (
                  <DeclaredCommands commands={p.commands} spacing={p.minIntervalS ?? {}} />
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The commands a chat-out output declares it sends (D74), each with its spacing if it says one. */
function DeclaredCommands(props: {
  commands: readonly string[];
  spacing: Readonly<Record<string, number>>;
}) {
  return (
    <ul aria-label="commands it sends">
      {props.commands.map((c) => (
        <li key={c}>
          <code>{c}</code>
          {props.spacing[c] === undefined ? null : (
            <span className="muted"> — at most once every {props.spacing[c]} s in a chat</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function EventTypes(props: { types: readonly EventTypeView[] }) {
  if (props.types.length === 0) return <span className="muted">publishes no event type</span>;
  return (
    <ul aria-label="event types">
      {props.types.map((t) => (
        <li key={t.type}>
          <code>{t.type}</code>
          {t.help === undefined ? null : <span className="muted"> — {t.help}</span>}
        </li>
      ))}
    </ul>
  );
}

function InterfaceMembers(props: { names: readonly string[]; members: Map<string, MemberView> }) {
  if (props.names.length === 0) return <span className="muted">no reads or actions</span>;
  return (
    <details className="members">
      <summary>{props.names.join(', ')}</summary>
      <ul>
        {props.names.map((n) => {
          const m = props.members.get(n);
          return (
            <li key={n}>
              <code>{m === undefined ? n : signature(n, m)}</code>
              {m === undefined || m.help === '' ? null : <span className="muted"> — {m.help}</span>}
            </li>
          );
        })}
      </ul>
    </details>
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

/** The choice of a new group, in the Group field. */
const NEW_GROUP = '\u0000new';

/**
 * A node's group (D69): none, one of the draft's, or a new one named in a field and set with Set
 * (or Enter), trimmed. A connector is drawn outside the lanes whatever its group: it says so.
 */
function GroupField(props: {
  group: string | undefined;
  groups: readonly string[];
  connector: boolean;
  set: (group: string | undefined) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const named = name.trim();
  const add = (): void => {
    if (named === '') return;
    props.set(named);
    setAdding(false);
    setName('');
  };
  const groups =
    props.group === undefined || props.groups.includes(props.group)
      ? props.groups
      : [...props.groups, props.group];
  return (
    <div className="field group-field">
      <label>
        Group
        <select
          aria-label="group"
          value={adding ? NEW_GROUP : (props.group ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            setAdding(v === NEW_GROUP);
            if (v !== NEW_GROUP) props.set(v === '' ? undefined : v);
          }}
        >
          <option value="">none</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
          <option value={NEW_GROUP}>new group…</option>
        </select>
      </label>
      {adding ? (
        <span className="group-new">
          <input
            aria-label="new group"
            value={name}
            placeholder="its name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
          <button type="button" disabled={named === ''} onClick={add}>
            Set
          </button>
        </span>
      ) : null}
      <small className="muted">
        {props.connector
          ? 'A connector is drawn outside the lanes, its cards at the map’s left and right edges: its group is kept in the file, and ignored by the drawing.'
          : 'The lane it is drawn in; it changes nothing that runs.'}{' '}
        Applied with Apply.
      </small>
    </div>
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
  /** The draft's groups, in their lanes' order (D69). */
  groups: readonly string[];
  change: (change: Partial<GraphNode>) => void;
  remove: () => void;
  kill: (ids: string[]) => void;
  /** Its stop cleared in the draft (D64), for the next Apply. */
  cleared: boolean;
  /** Clears its stop in the draft, or keeps it again. */
  clearStop: (clear: boolean) => void;
  /** The node as the saved graph has it; undefined: new in the draft. */
  saved?: GraphNode | undefined;
  /** The draft's edges, for the chat-in edges to update when its chats change. */
  edges?: readonly GraphEdge[];
  /** Selects an edge, by its key, opening its panel. */
  openEdge?: (key: string) => void;
}) {
  const { node, view, live, drift } = props;
  const enabled = node.disabled !== true;
  const stop = live?.state === 'stopped' ? live.stop : undefined;
  const connector = view.kinds.includes('connector');
  const i = view.interface;
  const instance = instanceOf(node);
  // A connector's monitored chats are picked from its surfaces, not typed (D63).
  const picked = connector ? withoutChats(view.configSchema) : undefined;
  const chats = node.config?.[CHATS_KEY];
  const savedChats = props.saved?.config?.[CHATS_KEY];
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
          {live === undefined ? 'not running' : live.state}
          {live?.reason === undefined ? null : <span className="muted"> {live.reason}</span>}
        </dd>
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
      <div className="field state-switch">
        <label className="choice">
          <input
            type="checkbox"
            role="switch"
            aria-label="enabled"
            checked={enabled}
            onChange={(e) => props.change({ disabled: e.target.checked ? undefined : true })}
          />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
        <small className="muted">
          {enabled
            ? 'It starts with the instance. Disable it to keep it, its config and its edges, not running.'
            : 'It does not start; its config and edges are still checked, and the nodes that need it are inactive.'}{' '}
          Applied with Apply.
        </small>
      </div>
      <GroupField
        group={node.group}
        groups={props.groups}
        connector={isSplit(view)}
        set={(group) => props.change({ group })}
      />
      {stop === undefined ? null : (
        <div className={`stop-note${props.cleared ? ' cleared' : ''}`} role="note">
          <p>
            <span className="warning-icon" role="img" aria-label="warning">
              ⚠
            </span>{' '}
            <strong>Stopped</strong> by{' '}
            {stop.source === 'safety'
              ? 'its safety stop'
              : stop.source === 'drift'
                ? 'drift'
                : 'the owner'}{' '}
            at {stop.time.slice(0, 16).replace('T', ' ')} UTC: {stop.reason}. It stays stopped
            across restarts until its stop is cleared.
          </p>
          {props.cleared ? (
            <p>
              Its stop is cleared at the next Apply.{' '}
              <button type="button" onClick={() => props.clearStop(false)}>
                Keep it stopped
              </button>
            </p>
          ) : (
            <p>
              <button type="button" className="primary" onClick={() => props.clearStop(true)}>
                Clear stop
              </button>
            </p>
          )}
        </div>
      )}
      {live?.state !== 'running' ? null : (
        <p>
          <button type="button" className="danger" onClick={() => props.kill([view.id])}>
            Kill {view.id}
          </button>
        </p>
      )}
      {live?.state === 'running' || live?.state === 'stopped' ? <NodeState id={view.id} /> : null}
      {connector && live?.state === 'running' ? <ConnectorQueue id={view.id} /> : null}
      {!connector ? null : (
        <section>
          <h3>Account</h3>
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
        </section>
      )}
      <section>
        <h3>Config</h3>
        {view.configSchema === undefined ? (
          <p className="muted">no config</p>
        ) : (
          <SchemaForm
            legend="config"
            schema={picked === undefined ? view.configSchema : picked}
            // Unset fields shown with their defaults, written with the first change (`defaults.ts`).
            value={withDefaults(view.configSchema, node.config)}
            onChange={(config) => props.change({ config })}
            secretKeys={view.configSecrets}
            secretNames={props.secretNames}
            errors={props.configErrors}
          />
        )}
        {picked === undefined ? null : (
          <MonitoredChats
            connector={view.id}
            value={Array.isArray(chats) ? (chats as string[]) : undefined}
            saved={Array.isArray(savedChats) ? (savedChats as string[]) : undefined}
            edges={props.edges ?? []}
            {...(props.openEdge === undefined ? {} : { openEdge: props.openEdge })}
            set={(v) => {
              const { [CHATS_KEY]: _, ...rest } = node.config ?? {};
              props.change({ config: v === undefined ? rest : { ...rest, [CHATS_KEY]: v } });
            }}
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
        <Outputs ports={view.outputs} view={view} />
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
