/**
 * The node selected in the graph editor (D55): what it is, its instance and its live state, and,
 * editable for the draft, whether it is enabled (D64), its config
 * and the settings its instance starts with, in forms made from their schemas, each field with the
 * check's errors; a config key that names a secret (`configSecrets`) is a choice of the secrets'
 * names, and its secrets say whether each is provided and where from, never their values; a key
 * that names a chat (`configChats`) is picked in the chat picker (D96); a connector's
 * `chats` (what it monitors) is picked from its surfaces (D63), and once the
 * draft changes them, a reminder names its chat-in edges to update, each opening its panel. Then
 * the interface it declares (P11) and its removal, which keeps its instance. A stopped node (D64)
 * says why, when and by what, with **Clear stop**, a change of the draft that Apply makes; a
 * running one can be killed (D44). Its forms stay editable whatever its state. Its group (D69),
 * the lane it is drawn in, is picked among the draft's, or named anew. Its outputs say what they
 * carry (D71): an events output its event types, an interface output its members. A node up that
 * keeps a state (D72) shows it, drawn from its schema; a running connector, its queue (D73). Its
 * chat commands say where the commands edges serve them (D109), each chat by name, or that no edge
 * does; a connector's, which commands of which plugins it serves.
 *
 * What the Admin page showed of a node is here (D111): a connector's connection, as whom it runs;
 * its account, read-only under Advanced (D119: its node's id, nothing to type); what the node costs (D77), its share of the whole and whether it is among the
 * top three; and, while it runs, its own status, its settings in force, set at once, and its reads
 * and actions, called from the panel (`NodeControls.tsx`). A node whose plugin declares a page
 * (D112) has a link to it, while it runs.
 */
import { useState } from 'react';
import type {
  AccountControl,
  BotCommand,
  ConfigChatView,
  DriftCounts,
  EventTypeView,
  GraphEdge,
  GraphNode,
  InstanceInfo,
  JsonSchema,
  MemberView,
  NodeView,
  PluginControl,
  PluginView,
  PortView,
} from '#src/ui/api.ts';
import { isSplit } from './cards.ts';
import { ChatPicker, named, useSurfaces } from './ChatPicker.tsx';
import { ConnectorLogin } from './ConnectorLogin.tsx';
import type { Ranked } from './Costs.tsx';
import { CostLine } from './Costs.tsx';
import { withDefaults } from './defaults.ts';
import type { PortChange } from './draft.ts';
import { edgeKey, endOf, instanceOf } from './draft.ts';
import { MemberCall, NodeStatus, SettingsInForce } from './NodeControls.tsx';
import { heardTypes, Payloads } from './Payloads.tsx';
import { PlaysField } from './PlaysField.tsx';
import { ConnectorQueue } from './Queue.tsx';
import type { CustomControl } from './SchemaForm.tsx';
import { SchemaForm } from './SchemaForm.tsx';
import { exportScript } from './script/export.ts';
import { ExportDialog } from './script/ExportDialog.tsx';
import { ScriptEditor } from './script/ScriptEditor.tsx';
import { ScriptPorts } from './script/ScriptPorts.tsx';
import { scriptApi } from './script/types.ts';
import { SensitiveField } from './SensitiveField.tsx';
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

/**
 * The connector a config key's chat is picked from (D96): the node's own, or the one at the other
 * end of the edge from its chat-out `output` (or to its chat-in `input`) in the draft.
 */
export function chatConnector(
  node: string,
  spec: ConfigChatView,
  edges: readonly GraphEdge[]
): string | undefined {
  if (spec.output !== undefined) {
    const e = edges.find((x) => x.from === `${node}.${spec.output}` && x.type === 'chat-out');
    return e === undefined ? undefined : endOf(e.to).node;
  }
  if (spec.input !== undefined) {
    const e = edges.find((x) => x.to === `${node}.${spec.input}` && x.type === 'chat-in');
    return e === undefined ? undefined : endOf(e.from).node;
  }
  return node;
}

/** A chat key's value as the picker holds it: a list of names, whatever its type in the config. */
const chatValues = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
        .map(String)
    : typeof v === 'string' || typeof v === 'number'
      ? [String(v)]
      : [];

/**
 * The controls of a plugin's chat keys (D96, `configChats`): each picked in the chat picker from its
 * connector's chats; stored as its schema says (a number, a string, a list), and a template typed
 * where the key takes one (`{chat}`).
 */
function chatControls(
  node: string,
  specs: readonly ConfigChatView[],
  schema: JsonSchema | undefined,
  edges: readonly GraphEdge[]
): Record<string, CustomControl> {
  const props = (schema?.['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = (schema?.['required'] ?? []) as string[];
  return Object.fromEntries(
    specs.map((spec): [string, CustomControl] => {
      const type = props[spec.key]?.['type'];
      // A list, or a list or one chat (the reactor's `in`, #7): picked as a list.
      const options = (props[spec.key]?.['anyOf'] ?? []) as JsonSchema[];
      const many = type === 'array' || options.some((o) => o['type'] === 'array');
      const numeric = type === 'integer' || type === 'number';
      const connector = chatConnector(node, spec, edges);
      return [
        spec.key,
        (value, set) => {
          const template =
            spec.template === true && typeof value === 'string' && value.includes('{');
          return (
            <>
              <ChatPicker
                label={spec.key}
                connector={connector}
                noConnector={`Draw its ${spec.output ?? spec.input ?? ''} edge to a connector first, to pick from its chats.`}
                value={template ? [] : chatValues(value)}
                single={!many}
                optional={!required.includes(spec.key)}
                {...(spec.kinds === undefined ? {} : { kinds: spec.kinds })}
                sender={spec.sender === true}
                set={(v) => {
                  if (many) set(v.length === 0 ? undefined : v);
                  else if (v[0] === undefined) set(undefined);
                  else set(numeric ? Number(v[0]) : v[0]);
                }}
              />
              {spec.template === true ? (
                <label className="block small">
                  or a template of the event{' '}
                  <input
                    aria-label={`${spec.key} template`}
                    placeholder="{chat}"
                    value={template ? value : ''}
                    onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
                  />
                </label>
              ) : null}
            </>
          );
        },
      ];
    })
  );
}

function Ports(props: {
  title: string;
  ports: Record<string, PortView>;
  /** What each events input hears through its edges (#3), by port. */
  heard?: Readonly<Record<string, EventTypeView[]>>;
  config?: Readonly<Record<string, unknown>> | undefined;
}) {
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
            {p.type === 'events' && props.heard?.[name] !== undefined ? (
              <details className="heard" open>
                <summary>What it hears</summary>
                <Payloads types={heardTypes(props.heard[name], p, props.config)} />
              </details>
            ) : null}
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

function Members(props: {
  title: string;
  members: MemberView[];
  /** The running node's, called from here: its id, and the names its instance offers. */
  call?: { node: string; kind: 'read' | 'action'; names: readonly string[] } | undefined;
}) {
  if (props.members.length === 0) return null;
  const call = props.call;
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
            {call?.names.includes(m.name) === true ? (
              <MemberCall node={call.node} kind={call.kind} member={m} />
            ) : m.input === undefined || m.input['properties'] === undefined ? null : (
              <SchemaForm legend={`${m.name} input`} schema={m.input} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** A connector's chats, by their names where it lists them (D96), as an edge names them. */
function ChatNames(props: { connector: string; chats: readonly string[] }) {
  const s = useSurfaces(props.connector);
  const name = (c: string): string =>
    (s.state === 'listed' ? s.surfaces.find((x) => named(x, c))?.title : undefined) ?? c;
  return <>{props.chats.map(name).join(', ')}</>;
}

/** Where a commands edge answers (D109): its chats by name, every private chat, its senders. */
function Where(props: { edge: GraphEdge }) {
  const { edge } = props;
  const connector = endOf(edge.from).node;
  const chats = edge.chats ?? [];
  return (
    <>
      {chats.length === 0 && edge.privateChats !== true ? (
        'in no chat'
      ) : (
        <>
          in {chats.length === 0 ? null : <ChatNames connector={connector} chats={chats} />}
          {chats.length > 0 && edge.privateChats === true ? ' and ' : null}
          {edge.privateChats === true ? 'every private chat' : null}
        </>
      )}
      {edge.senders === undefined
        ? ', to anyone'
        : `, to ${edge.senders.map((x) => (x === 'owner' ? 'the owner' : x)).join(', ')}`}
      {edge.dryRun === true ? <span className="muted"> (a dry run)</span> : null}
    </>
  );
}

/**
 * A plugin's chat commands (P11), each with where the commands edges to its `commands` input
 * serve it (D109): by which connector, in which chats, to whom; none, no chat asks it.
 */
function ChatCommands(props: { node: string; members: MemberView[]; edges: readonly GraphEdge[] }) {
  if (props.members.length === 0) return null;
  const serving = props.edges.filter(
    (e) => e.type === 'commands' && endOf(e.to).node === props.node
  );
  return (
    <>
      <h4>Commands</h4>
      {serving.length === 0 ? (
        <p className="warning small" role="note" aria-label="commands served">
          No commands edge serves them: no chat asks it anything. Draw one from a connector’s{' '}
          <code>commands</code> output to its <code>commands</code> input.
        </p>
      ) : null}
      <ul aria-label="its commands">
        {props.members.map((m) => {
          const by = serving.filter((e) => e.serves === undefined || e.serves.includes(m.name));
          return (
            <li key={m.name}>
              <code>
                {m.name}
                {m.args === undefined ? '' : ` ${m.args}`}
              </code>{' '}
              {m.help}
              {m.owner === true ? <span className="muted"> (owner’s)</span> : null}
              {serving.length === 0 ? null : by.length === 0 ? (
                <div className="muted small">Served nowhere.</div>
              ) : (
                by.map((e) => (
                  <div key={edgeKey(e)} className="small">
                    By <code>{endOf(e.from).node}</code> <Where edge={e} />
                  </div>
                ))
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** A connector's commands edges (D109): the plugins whose commands it serves, where, to whom. */
function Served(props: { node: string; edges: readonly GraphEdge[] }) {
  const out = props.edges.filter((e) => e.type === 'commands' && endOf(e.from).node === props.node);
  if (out.length === 0) return null;
  return (
    <>
      <h4>Commands it serves</h4>
      <ul aria-label="commands it serves">
        {out.map((e) => (
          <li key={edgeKey(e)}>
            <code>{endOf(e.to).node}</code>:{' '}
            {e.serves === undefined ? 'every command' : e.serves.map((c) => `/${c}`).join(', ')}{' '}
            <Where edge={e} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Where a connector's secrets come from (#10): each secret it reads, by name (those its manifest
 * declares, and those its config's `configSecrets` keys name), whether it is provided, and its
 * source, a Docker secret today (§4.9). Never a value: the UI is given only the names provided
 * (`GET /secrets`); unknown until they are read.
 */
function SecretSources(props: {
  declared: readonly string[];
  keys: readonly string[];
  config: Readonly<Record<string, unknown>> | undefined;
  provided: readonly string[] | undefined;
}) {
  const rows: { name: string; why: string }[] = [
    ...props.declared.map((name) => ({ name, why: 'read by its plugin' })),
    ...props.keys.flatMap((key) => {
      const name = props.config?.[key];
      return typeof name === 'string' && name !== ''
        ? [{ name, why: `named by its config's ${key}` }]
        : [];
    }),
  ];
  if (rows.length === 0) return null;
  return (
    <section aria-label="its secrets">
      <h4>Secrets</h4>
      <ul className="secrets">
        {rows.map((r) => {
          const set = props.provided?.includes(r.name);
          return (
            <li key={`${r.name} ${r.why}`}>
              <code>{r.name}</code>{' '}
              {set === undefined ? (
                <span className="muted">(not known yet)</span>
              ) : set ? (
                <span className="ok">set</span>
              ) : (
                <strong className="error">not provided</strong>
              )}
              <span className="muted"> — {r.why}; a Docker secret</span>
            </li>
          );
        })}
      </ul>
      <small className="muted">
        Each is a Docker secret: a file of its name in the instance’s secrets directory (
        <code>/run/secrets</code> in the image). Its value is never shown here. A secret not
        provided fails the check and the start; it is added with the deployment’s Docker secrets,
        then a restart.
      </small>
    </section>
  );
}

/**
 * A connector's account (D119), folded under Advanced: nothing to type. It is its node's id on its
 * plugin's network (`<network>:<node id>`), shown without the network, which its plugin implies; a
 * node whose graph names another keeps it, and may go back to its id.
 */
export function AccountFold(props: {
  account: string | undefined;
  network: string | undefined;
  /** The account its graph node names, if any. */
  named: string | undefined;
  clear: () => void;
}) {
  const { account, network } = props;
  if (account === undefined) return null;
  const name =
    network !== undefined && account.startsWith(`${network}:`)
      ? account.slice(network.length + 1)
      : account;
  return (
    <details className="advanced" aria-label="advanced">
      <summary>Advanced</summary>
      <dl>
        <dt>Account</dt>
        <dd>
          <code aria-label="account">{name}</code>{' '}
          <span className="muted">
            {props.named === undefined
              ? '(its node’s id)'
              : `(named in its graph${network === undefined ? '' : ` on ${network}`})`}
          </span>
          {props.named === undefined ? null : (
            <>
              {' '}
              <button type="button" onClick={props.clear}>
                Use its node’s id
              </button>
            </>
          )}
        </dd>
      </dl>
      <small className="muted">
        What the instance knows this connection by, in its outbox, its event log and its errors.
        Nothing to set: it follows the node’s id, which no other node has.
      </small>
    </details>
  );
}

/**
 * The fields every connector's config shares (the core's `commandIntervalS`, `unansweredAt`,
 * `unansweredAtBy` and `liveGraceS`): its queue's spacing, its watchdog and its catch-up's grace,
 * which a first setup leaves at their defaults, so folded under Tuning (D122).
 */
export const CONNECTOR_TUNING = [
  'commandIntervalS',
  'unansweredAt',
  'unansweredAtBy',
  'liveGraceS',
];

/** The phase of a connector that needs a login (the core's `NEEDS_LOGIN`, D116). */
const NEEDS_LOGIN_PHASE = 'needs login';

/** The script plugin's id (D76): its nodes' config is edited as ports and code. */
const SCRIPT = 'script';

/**
 * A script node's ports, in a form, and its code, opened in its editor (D76, D78), its API typed
 * from the draft.
 */
function ScriptSection(props: {
  node: GraphNode;
  schema: JsonSchema | undefined;
  sources: NonNullable<Parameters<typeof NodeDetails>[0]['script']>;
  edges: readonly GraphEdge[];
  errors: Record<string, string[]>;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  change: (config: Record<string, unknown>, moved?: PortChange) => void;
}) {
  const { node, sources } = props;
  const config = withDefaults(props.schema, node.config);
  const api = scriptApi({
    node,
    nodes: sources.nodes,
    edges: props.edges,
    viewOf: sources.viewOf,
    available: sources.available,
  });
  const plugins = [
    ...new Map(
      [...sources.available, ...sources.nodes.filter((n) => n.id !== node.id).map(sources.viewOf)]
        .filter((v): v is PluginView => v !== undefined)
        .map((v) => [`${v.plugin}`, v])
    ).values(),
  ];
  const code = typeof config['code'] === 'string' ? config['code'] : '';
  const [exporting, setExporting] = useState(false);
  const lines = code === '' ? 0 : code.split('\n').length;
  return (
    <section className="script-section">
      <h3>Script</h3>
      <p>
        <button type="button" className="primary" onClick={() => props.setEditing(true)}>
          Edit script
        </button>{' '}
        <button type="button" onClick={() => setExporting(true)}>
          Export as plugin
        </button>{' '}
        <span className="muted small">
          {lines} line{lines === 1 ? '' : 's'} of TypeScript, in a worker of its own
        </span>
      </p>
      {(props.errors['code'] ?? []).length === 0 ? null : (
        <ul className="problems" aria-label="problems of its code">
          {(props.errors['code'] ?? []).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <ScriptPorts
        id={node.id}
        config={config}
        change={props.change}
        plugins={plugins}
        edges={props.edges}
        errors={props.errors}
      />
      {!exporting ? null : (
        <ExportDialog
          id={node.id}
          exported={exportScript(node.id, config, api)}
          close={() => setExporting(false)}
        />
      )}
      {!props.editing ? null : (
        <ScriptEditor
          id={node.id}
          code={code}
          api={api}
          problems={props.errors['code'] ?? []}
          keep={(c) => {
            props.change({ ...config, code: c });
            props.setEditing(false);
          }}
          close={() => props.setEditing(false)}
        />
      )}
    </section>
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
  /** A connector's account, as it runs (`GET /accounts`): as whom, and its connection. */
  account?: AccountControl | undefined;
  /** What it costs (D77), among the others. */
  cost?: Ranked | undefined;
  /** Reads its live state again, after a setting is set. */
  reloadLive?: () => void;
  /** The instance it names, if it is kept already. */
  instance?: InstanceInfo | undefined;
  problems: string[];
  /** The check's warnings on it (D89): they refuse nothing. */
  warnings?: string[];
  /** The event types each of its events inputs hears through its edges (#3), by port. */
  heard?: Readonly<Record<string, EventTypeView[]>>;
  configErrors: Record<string, string[]>;
  settingErrors: Record<string, string[]>;
  secretNames: readonly string[];
  /** The names of the secrets provided (`GET /secrets`), once read: what its secrets say of them. */
  provided?: readonly string[] | undefined;
  /** The draft's groups, in their lanes' order (D69). */
  groups: readonly string[];
  /**
   * The node changed; with a port renamed or removed (a script node's), its edges move or go with
   * it, at once.
   */
  change: (change: Partial<GraphNode>, moved?: PortChange) => void;
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
  /** Restarts the instance as Apply does: a connector's new login put in force (D116). */
  restart?: () => void;
  /** For a script node (D76, D78): the draft's nodes, each one's view, and the plugins offered. */
  script?: {
    nodes: readonly GraphNode[];
    viewOf: (node: GraphNode) => PluginView | undefined;
    available: readonly PluginView[];
  };
  /**
   * A player's (D137): the commands of the parser its edge binds, for its checklist; undefined,
   * none known, `missing` saying why.
   */
  plays?: { declared: readonly BotCommand[] | undefined; missing: string };
}) {
  const { node, view, live, drift, account } = props;
  const running = live?.state === 'running';
  const enabled = node.disabled !== true;
  const stop = live?.state === 'stopped' ? live.stop : undefined;
  const connector = view.kinds.includes('connector');
  const i = view.interface;
  const instance = instanceOf(node);
  // A connector's monitored chats are picked from its surfaces, not typed (D63).
  const picked = connector ? withoutChats(view.configSchema) : undefined;
  const chats = node.config?.[CHATS_KEY];
  const savedChats = props.saved?.config?.[CHATS_KEY];
  const [editing, setEditing] = useState(false);
  const scripted = view.plugin === SCRIPT && props.script !== undefined;
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
      {(props.warnings ?? []).length === 0 ? null : (
        <ul className="warnings" aria-label={`warnings of ${view.id}`}>
          {(props.warnings ?? []).map((w) => (
            <li key={w}>{w}</li>
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
        {account === undefined ? null : (
          <>
            <dt>Connection</dt>
            <dd>
              {(account.as ?? account.self) === undefined ? null : (
                <>as {account.as ?? account.self} </>
              )}
              {account.connection === undefined ? (
                <span className="muted">not connected</span>
              ) : (
                <>
                  <span className={`badge ${account.connection.state}`}>
                    {account.connection.state}
                  </span>{' '}
                  {account.connection.phase}
                  {account.connection.detail === undefined ? '' : `: ${account.connection.detail}`}
                </>
              )}
            </dd>
          </>
        )}
        {props.cost === undefined ? null : (
          <>
            <dt>Cost</dt>
            <dd>
              <CostLine cost={props.cost} />
            </dd>
          </>
        )}
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
                : stop.source === 'stalled'
                  ? 'the send-queue watchdog'
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
      {!running ? null : (
        <p>
          <button type="button" className="danger" onClick={() => props.kill([view.id])}>
            Kill {view.id}
          </button>
        </p>
      )}
      {view.login === true ? (
        // A stopped connector still logs in (D125): its login is the instance's, not its run's.
        running || stop !== undefined ? (
          <ConnectorLogin
            node={view.id}
            {...(props.restart === undefined ? {} : { restart: props.restart })}
          />
        ) : live === undefined ? (
          <p className="muted small">
            It logs in from here once it runs: <strong>Apply</strong>, and its Login shows here.
          </p>
        ) : (
          <p className="muted small">
            It logs in from here while it runs or is stopped; it is {live.state} now.
          </p>
        )
      ) : null}
      {running && live.status !== undefined ? <NodeStatus status={live.status} /> : null}
      {running && view.page !== undefined ? (
        <p>
          <a href={`#/node/${encodeURIComponent(view.id)}`}>Open its page: {view.page.title}</a>
        </p>
      ) : null}
      {running || live?.state === 'stopped' ? <NodeState id={view.id} /> : null}
      {connector && running ? <ConnectorQueue id={view.id} /> : null}
      {!scripted || props.script === undefined ? null : (
        <ScriptSection
          node={node}
          schema={view.configSchema}
          sources={props.script}
          edges={props.edges ?? []}
          errors={props.configErrors}
          editing={editing}
          setEditing={setEditing}
          change={(config, moved) => props.change({ config }, moved)}
        />
      )}
      <section hidden={scripted}>
        <h3>Config</h3>
        {view.login === true && (!running || account?.connection?.phase === NEEDS_LOGIN_PHASE) ? (
          <p className="note small" role="note">
            Log in first, above: its chats (its owner, its groups and people, those it monitors) are
            picked from the ones it sees once it is logged in and connected.
          </p>
        ) : null}
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
            {...(connector ? { folded: CONNECTOR_TUNING } : {})}
            custom={{
              ...chatControls(
                node.id,
                view.configChats ?? [],
                view.configSchema,
                props.edges ?? []
              ),
              // A player's commands, a checklist of its parser's (D137).
              ...(view.configPlays === undefined || props.plays === undefined
                ? {}
                : {
                    [view.configPlays.key]: ((value, set) => (
                      <PlaysField
                        name={(view.configPlays as { key: string }).key}
                        value={value}
                        set={set}
                        declared={props.plays?.declared}
                        missing={props.plays?.missing ?? ''}
                      />
                    )) satisfies CustomControl,
                  }),
              // A sensitive value is never shown back: set or not, replaced or cleared (D124).
              ...Object.fromEntries(
                (view.configSensitive ?? []).map((key): [string, CustomControl] => [
                  key,
                  (value, set) => <SensitiveField name={key} value={value} set={set} />,
                ])
              ),
            }}
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
        <SecretSources
          declared={view.secrets}
          keys={view.configSecrets}
          config={node.config}
          provided={props.provided}
        />
      </section>
      <section>
        <h3>Settings</h3>
        {live === undefined ? null : (
          <SettingsInForce settings={live.settings} reload={() => props.reloadLive?.()} />
        )}
        {view.settingsSchema === undefined ? (
          <p className="muted">no settings</p>
        ) : (
          <>
            <p className="muted small">
              What its instance starts with, while it keeps none of its own; a value set in force,
              above, wins. Applied with Apply.
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
        <Ports
          title="Inputs"
          ports={view.inputs}
          heard={props.heard ?? {}}
          config={withDefaults(view.configSchema, node.config)}
        />
        <Outputs ports={view.outputs} view={view} />
        <Members
          title="Reads"
          members={i.reads}
          call={
            running
              ? {
                  node: view.id,
                  kind: 'read',
                  // Its status is read already, in its Status section: no button to read it again.
                  names: live.reads.filter((r) => r !== 'status' || live.status === undefined),
                }
              : undefined
          }
        />
        <Members
          title="Actions"
          members={i.actions}
          call={running ? { node: view.id, kind: 'action', names: live.actions } : undefined}
        />
        <ChatCommands node={view.id} members={i.commands} edges={props.edges ?? []} />
        <Served node={view.id} edges={props.edges ?? []} />
      </section>
      {!connector ? null : (
        <AccountFold
          account={view.account}
          network={view.network}
          named={node.account}
          clear={() => props.change({ account: '' })}
        />
      )}
      <p>
        <button type="button" className="danger" onClick={props.remove}>
          Remove {view.id}
        </button>
      </p>
    </aside>
  );
}
