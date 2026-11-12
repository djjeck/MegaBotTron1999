/**
 * One edge of the graph editor (D55): a curve from an output to an input in its port type's colour
 * (dashed when the input is optional), and at its midpoint a rhombus in the same colour, the
 * edge's handle. An edge carries configuration (a chat edge's reads, sends and commands) that a
 * line does not show; the rhombus says there is something to open. It is a button: a click, or
 * Enter or Space once focused, selects the edge (as a click on its line does) and so opens its
 * panel; it grows under the pointer and is ringed while its edge is selected. Drawn with React
 * Flow's custom-edge API: `BaseEdge` for the line, `EdgeLabelRenderer` for the rhombus, an HTML
 * element above the canvas, at the point `getBezierPath` gives for the label.
 */
import type { Edge, EdgeProps } from '@xyflow/react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useStoreApi } from '@xyflow/react';
import type { CSSProperties } from 'react';

export interface PortEdgeData extends Record<string, unknown> {
  /** The edge's name, `from → to`. */
  name: string;
  /** Its port type's colour, or the refusal's. */
  colour: string;
  /** Its port type, when known. */
  type?: string | undefined;
  /** The first of the check's problems with it, if it has one. */
  problem?: string | undefined;
}

export type PortEdgeType = Edge<PortEdgeData, 'port'>;

export function PortEdge(props: EdgeProps<PortEdgeType>) {
  const { id, data, selected = false } = props;
  const store = useStoreApi();
  const [path, x, y] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const name = data?.name ?? id;
  const colour = data?.colour ?? 'gray';
  const problem = data?.problem;
  const select = (): void => {
    const { addSelectedEdges } = store.getState();
    store.setState({ nodesSelectionActive: false });
    addSelectedEdges([id]);
  };
  const at = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(props.style === undefined ? {} : { style: props.style })}
        {...(props.interactionWidth === undefined
          ? {}
          : { interactionWidth: props.interactionWidth })}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-handle nodrag nopan${selected ? ' selected' : ''}${problem === undefined ? '' : ' refused'}`}
          style={{ transform: at, '--edge-colour': colour } as CSSProperties}
          aria-label={`edge ${name}`}
          aria-pressed={selected}
          title={`${name}${data?.type === undefined ? '' : ` (${data.type})`}: open its settings${problem === undefined ? '' : `\n✗ ${problem}`}`}
          onClick={select}
        >
          <span className="rhombus" aria-hidden="true" />
        </button>
        {problem === undefined ? null : (
          <div
            className="edge-problem"
            style={{ transform: `translate(-50%, 0) translate(${x}px, ${y + 12}px)` }}
          >
            ✗ {problem}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
