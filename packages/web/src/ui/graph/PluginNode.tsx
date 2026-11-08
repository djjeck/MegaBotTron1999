/**
 * One node of the graph editor: a plugin instance, its inputs on the left and its outputs on
 * the right, each port drawn in its type's shape and colour (`PORT_TYPE_INFO`), and its live state:
 * running or paused, its mode, its parser's drift, or not running (added, or not applied yet). A
 * killed node (D44) is drawn disabled, with its reinstatement at hand. An edge is dragged from an
 * output to an input; a node or a port the check refuses is marked, with why.
 */
import type { Node, NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { DriftCounts, NodeView, PluginControl, PortTypeInfo, PortView } from '#src/ui/api.ts';

export interface PluginNodeData extends Record<string, unknown> {
  view: NodeView;
  live?: PluginControl | undefined;
  drift?: DriftCounts | undefined;
  portTypes: Record<string, PortTypeInfo>;
  reinstate: (id: string) => void;
  /** The check's problems with the node itself, and with each of its ports by name. */
  problems?: string[];
  portProblems?: Record<string, string[]>;
}

export type PluginNodeType = Node<PluginNodeData, 'plugin'>;

/** The height of a node's head and of each row of ports, for the layout. */
export const HEAD_HEIGHT = 110;
export const PORT_ROW = 22;

/** A node's height, from its ports. */
export const nodeHeight = (view: NodeView): number =>
  HEAD_HEIGHT +
  PORT_ROW * Math.max(Object.keys(view.inputs).length, Object.keys(view.outputs).length);

function Port(props: {
  name: string;
  port: PortView;
  side: 'in' | 'out';
  index: number;
  info: PortTypeInfo | undefined;
  problems: string[] | undefined;
}) {
  const { name, port, side, index, info, problems = [] } = props;
  const top = HEAD_HEIGHT + PORT_ROW * index + PORT_ROW / 2;
  const title =
    `${name}: ${port.label}${port.optional ? ' (optional)' : ''}${port.help === undefined ? '' : ` — ${port.help}`}` +
    problems.map((p) => `\n✗ ${p}`).join('');
  const refused = problems.length > 0 ? ' refused' : '';
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

export function PluginNode({ data, selected }: NodeProps<PluginNodeType>) {
  const { view, live, drift, portTypes, problems = [], portProblems = {} } = data;
  const killed = live?.killed === true;
  const inputs = Object.entries(view.inputs);
  const outputs = Object.entries(view.outputs);
  return (
    <div
      className={`plugin-node${killed ? ' killed' : ''}${selected ? ' selected' : ''}${problems.length > 0 ? ' refused' : ''}`}
      style={{ height: nodeHeight(view) }}
      aria-label={`node ${view.id}`}
      aria-disabled={killed}
    >
      <div className="head">
        <strong>{view.id}</strong>
        {view.plugin === view.id ? null : <span className="muted"> {view.plugin}</span>}
        <div className="muted small">{view.kinds.join(', ')}</div>
        <div>
          {live === undefined ? (
            <span className="badge" title="not running: added, or not applied yet">
              not running
            </span>
          ) : (
            <span className={`badge ${killed ? 'killed' : live.state}`}>
              {killed ? 'killed' : live.state}
            </span>
          )}
          {live?.mode === undefined ? null : <span className="badge mode">{live.mode}</span>}
          {drift === undefined ? null : (
            <span className={`badge ${drift.tripped ? 'failed' : 'drift'}`} title="drift (P5)">
              drift {drift.recent}/{drift.unread}
            </span>
          )}
        </div>
        {killed ? (
          <button
            type="button"
            className="reinstate nodrag"
            onClick={(e) => {
              e.stopPropagation();
              data.reinstate(view.id);
            }}
          >
            Reinstate
          </button>
        ) : null}
        {problems.length > 0 ? (
          <div className="error small" title={problems.join('\n')}>
            ✗ {problems[0]}
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
          info={portTypes[port.type]}
          problems={portProblems[name]}
        />
      ))}
      {outputs.map(([name, port], i) => (
        <Port
          key={name}
          name={name}
          port={port}
          side="out"
          index={i}
          info={portTypes[port.type]}
          problems={portProblems[name]}
        />
      ))}
    </div>
  );
}
