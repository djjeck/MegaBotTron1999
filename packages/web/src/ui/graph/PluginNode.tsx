/**
 * One node of the graph editor: a plugin instance, its inputs on the left and its outputs on
 * the right, each port drawn in its type's shape and colour (`PORT_TYPE_INFO`), and its state
 * (D64): running, with its parser's drift; **disabled** in the draft, greyed; **stopped** (a safety
 * stop, drift, the owner's kill or stop), in red tones with a warning icon and its reason;
 * **inactive** for a node it needs that is down, greyed with its reason; failed, with why; or not
 * running (added, or not applied yet). An edge is dragged from an output to an input; a node or a
 * port the check refuses is marked, with why; one it warns of (D89), in the warning's own colour,
 * with what. A connector is drawn as two cards, its in card and
 * its out card (`cards.ts`, D60): each is titled with its side, and shows itself selected while
 * its twin is. A node that keeps a state (D72) shows a line of it, from its pins. A connector's
 * cards show its account's connection (D111): connected, connecting or closed, with its step. A
 * node whose plugin declares a widget (D112) shows it in a line while it runs, its card a line
 * taller for it whatever its state, so that the map does not move as nodes start and stop.
 */
import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type {
  AccountControl,
  DriftCounts,
  NodeView,
  PluginControl,
  PortTypeInfo,
  PortView,
} from '#src/ui/api.ts';
import type { CardSide } from './cards.ts';
import { cardTitle } from './cards.ts';
import { WidgetLine } from './Widget.tsx';

export interface PluginNodeData extends Record<string, unknown> {
  view: NodeView;
  live?: PluginControl | undefined;
  drift?: DriftCounts | undefined;
  /** A connector's connection, as its account runs (`GET /accounts`). */
  connection?: AccountControl['connection'];
  portTypes: Record<string, PortTypeInfo>;
  /** Disabled in the draft (D64). */
  disabled?: boolean;
  /** Its stop cleared in the draft, for the next Apply. */
  cleared?: boolean;
  /** The check's problems with the node itself, and with each of its ports by name. */
  problems?: string[];
  portProblems?: Record<string, string[]>;
  /** The check's warnings (D89) on the node, and on each of its ports by name: they refuse nothing. */
  warnings?: string[];
  portWarnings?: Record<string, string[]>;
  /** A line more about some of its ports, by name: where its commands are served (D109). */
  portNotes?: Record<string, string>;
  /** A connector's in or out card; none for a node of one card. */
  side?: CardSide;
  /** Its node is selected through its other card. */
  twinSelected?: boolean;
}

export type PluginNodeType = Node<PluginNodeData, 'plugin'>;

/** The height of a node's head and of each row of ports, for the layout. */
export const HEAD_HEIGHT = 110;
export const PORT_ROW = 22;
/** The line a widget takes in a node's head (D112). */
export const WIDGET_ROW = 20;

/** Where a node's ports start: below its head, and its widget's line if it declares one. */
const headOf = (view: NodeView): number =>
  HEAD_HEIGHT + (view.widget === undefined ? 0 : WIDGET_ROW);

/** A node's height, from its head and its ports. */
export const nodeHeight = (view: NodeView): number =>
  headOf(view) +
  PORT_ROW * Math.max(Object.keys(view.inputs).length, Object.keys(view.outputs).length);

function Port(props: {
  name: string;
  port: PortView;
  side: 'in' | 'out';
  index: number;
  /** Where the ports start: below the head. */
  head: number;
  info: PortTypeInfo | undefined;
  problems: string[] | undefined;
  warnings: string[] | undefined;
  note?: string | undefined;
}) {
  const { name, port, side, index, head, info, problems = [], warnings = [], note } = props;
  const top = head + PORT_ROW * index + PORT_ROW / 2;
  const title =
    `${name}: ${port.label}${port.optional ? ' (optional)' : ''}${port.help === undefined ? '' : ` — ${port.help}`}` +
    (note === undefined ? '' : `\n${note}`) +
    problems.map((p) => `\n✗ ${p}`).join('') +
    warnings.map((w) => `\n⚠ ${w}`).join('');
  const refused = problems.length > 0 ? ' refused' : warnings.length > 0 ? ' warned' : '';
  return (
    <>
      <Handle
        id={name}
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        className={`port ${info?.shape ?? 'square'}${port.optional ? ' optional' : ''}${refused}`}
        style={{ top, background: info?.colour ?? 'gray' }}
        title={title}
        data-testid={`port ${side} ${name}`}
      />
      <span
        className={`port-name ${side}${refused}`}
        style={{ top: top - PORT_ROW / 2 }}
        title={title}
      >
        {name}
      </span>
    </>
  );
}

/** How a node's state is drawn (D64): its class, its badge, and why, if it says. */
export function stateOf(
  live: PluginControl | undefined,
  disabled: boolean,
  cleared = false
): { look: string; badge: string; why?: string } {
  if (disabled)
    return {
      look: 'disabled',
      badge: 'disabled',
      ...(live !== undefined && live.state !== 'disabled' ? { why: 'from the next Apply' } : {}),
    };
  if (live === undefined)
    return { look: '', badge: 'not running', why: 'added, or not applied yet' };
  if (live.state === 'stopped' && live.stop !== undefined)
    return cleared
      ? { look: 'stopped cleared', badge: 'stopped', why: 'its stop cleared at the next Apply' }
      : { look: 'stopped', badge: 'stopped', why: live.reason ?? live.stop.reason };
  if (live.state === 'inactive')
    return {
      look: 'inactive',
      badge: 'inactive',
      ...(live.reason === undefined ? {} : { why: live.reason }),
    };
  if (live.state === 'disabled')
    return { look: '', badge: 'enabled', why: 'disabled until the next Apply' };
  return {
    look: live.state === 'failed' ? 'failed' : '',
    badge: live.state,
    ...(live.reason === undefined ? {} : { why: live.reason }),
  };
}

export function PluginNode({ data, selected }: NodeProps<PluginNodeType>) {
  const {
    view,
    live,
    drift,
    connection,
    portTypes,
    problems = [],
    portProblems = {},
    warnings = [],
    portWarnings = {},
    portNotes = {},
    side,
  } = data;
  const state = stateOf(live, data.disabled === true, data.cleared === true);
  const greyed = state.look === 'disabled' || state.look === 'inactive';
  const title = cardTitle(view.id, side);
  const shown = selected || data.twinSelected === true;
  const inputs = Object.entries(view.inputs);
  const outputs = Object.entries(view.outputs);
  return (
    <div
      className={`plugin-node${state.look === '' ? '' : ` state-${state.look.replace(' ', ' state-')}`}${shown ? ' selected' : ''}${problems.length > 0 ? ' refused' : warnings.length > 0 ? ' warned' : ''}${side === undefined ? '' : ` card-${side}`}`}
      style={{ height: nodeHeight(view) }}
      aria-label={`node ${title}`}
      aria-disabled={greyed}
    >
      <div className="head">
        <strong>{title}</strong>
        {view.plugin === view.id ? null : <span className="muted"> {view.plugin}</span>}
        <div className="muted small">{view.kinds.join(', ')}</div>
        <div>
          <span
            className={`badge ${state.badge.replace(' ', '-')}`}
            {...(state.why === undefined ? {} : { title: state.why })}
          >
            {state.look === 'stopped' ? (
              <span className="warning-icon" role="img" aria-label="warning">
                ⚠{' '}
              </span>
            ) : null}
            {state.badge}
          </span>
          {drift === undefined ? null : (
            <span className={`badge ${drift.tripped ? 'failed' : 'drift'}`} title="drift (P5)">
              drift {drift.recent}/{drift.unread}
            </span>
          )}
          {connection === undefined ? null : (
            <span
              className={`badge ${connection.state}`}
              title={`its connection: ${connection.phase}${connection.detail === undefined ? '' : `: ${connection.detail}`}`}
            >
              {connection.state}
            </span>
          )}
        </div>
        {state.why === undefined || state.badge === 'not running' ? (
          live?.summary === undefined ? null : (
            <div className="state-summary small" title={live.summary}>
              {live.summary}
            </div>
          )
        ) : (
          <div className="state-why small" title={state.why}>
            {state.why}
          </div>
        )}
        {view.widget === undefined ||
        live?.state !== 'running' ||
        live.widget === undefined ? null : (
          <WidgetLine widget={view.widget} reads={view.interface.reads} value={live.widget} />
        )}
        {problems.length > 0 ? (
          <div className="error small" title={problems.join('\n')}>
            ✗ {problems[0]}
          </div>
        ) : warnings.length > 0 ? (
          <div className="warning small" title={warnings.join('\n')}>
            ⚠ {warnings[0]}
          </div>
        ) : null}
      </div>
      {inputs.map(([name, port], i) => (
        <Port
          key={name}
          name={name}
          port={port}
          side="in"
          index={i}
          head={headOf(view)}
          info={portTypes[port.type]}
          problems={portProblems[name]}
          warnings={portWarnings[name]}
          note={portNotes[name]}
        />
      ))}
      {outputs.map(([name, port], i) => (
        <Port
          key={name}
          name={name}
          port={port}
          side="out"
          index={i}
          head={headOf(view)}
          info={portTypes[port.type]}
          problems={portProblems[name]}
          warnings={portWarnings[name]}
        />
      ))}
    </div>
  );
}
