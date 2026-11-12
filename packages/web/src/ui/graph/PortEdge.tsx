/**
 * One edge of the graph editor (D55): a curve from an output to an input in its port type's colour
 * (dashed when the input is optional), and at its midpoint a rhombus in the same colour, the
 * edge's handle. An edge carries configuration (a chat-in edge's reads, a chat-out edge's sends and
 * commands) that a line does not show; the rhombus says there is something to open. It is a button: a click, or
 * Enter or Space once focused, selects the edge (as a click on its line does) and so opens its
 * panel; it grows under the pointer and is ringed while its edge is selected. Drawn with React
 * Flow's custom-edge API: `BaseEdge` for the line, `EdgeLabelRenderer` for the rhombus, an HTML
 * element above the canvas, at the point `getBezierPath` gives for the label.
 *
 * A dry-run chat-out edge (D64) reads as disconnected: its rhombus is hollow, and its right-hand
 * part, from the rhombus to the connector, is greyed and dashed (the curve split at its midpoint,
 * `splitBezier`).
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
  /** A chat-out edge that is a dry run (D64): nothing it sends goes out. */
  dryRun?: boolean | undefined;
}

/** The grey of a dry run's disconnected part. */
export const DRY_RUN_GREY = '#9ca3af';

/**
 * A cubic Bézier path as `getBezierPath` writes it (`M x,y C x,y x,y x,y`) split at its midpoint,
 * where the rhombus sits (de Casteljau at ½): its two halves; undefined for a path of another
 * shape.
 */
export function splitBezier(path: string): [string, string] | undefined {
  const n = path.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/giu)?.map(Number);
  if (!/^M[^C]*C/u.test(path) || n?.length !== 8) return undefined;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = n as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const mid = (a: number, b: number): number => (a + b) / 2;
  const [ax, ay, bx, by, cx, cy] = [
    mid(x0, x1),
    mid(y0, y1),
    mid(x1, x2),
    mid(y1, y2),
    mid(x2, x3),
    mid(y2, y3),
  ];
  const [dx, dy, ex, ey] = [mid(ax, bx), mid(ay, by), mid(bx, cx), mid(by, cy)];
  const [mx, my] = [mid(dx, ex), mid(dy, ey)];
  return [
    `M${x0},${y0} C${ax},${ay} ${dx},${dy} ${mx},${my}`,
    `M${mx},${my} C${ex},${ey} ${cx},${cy} ${x3},${y3}`,
  ];
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
  const dryRun = data?.dryRun === true;
  const halves = dryRun ? splitBezier(path) : undefined;
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
        path={halves?.[0] ?? path}
        {...(props.style === undefined ? {} : { style: props.style })}
        {...(props.interactionWidth === undefined
          ? {}
          : { interactionWidth: props.interactionWidth })}
      />
      {halves === undefined ? null : (
        <>
          <path
            d={halves[1]}
            className="react-flow__edge-path dry-run-tail"
            data-testid={`dry run ${name}`}
            fill="none"
            style={{ stroke: DRY_RUN_GREY, strokeWidth: 2, strokeDasharray: '4 4' }}
          />
          <path
            d={halves[1]}
            className="react-flow__edge-interaction"
            fill="none"
            strokeOpacity={0}
            strokeWidth={props.interactionWidth ?? 20}
          />
        </>
      )}
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-handle nodrag nopan${selected ? ' selected' : ''}${problem === undefined ? '' : ' refused'}${dryRun ? ' dry-run' : ''}`}
          style={{ transform: at, '--edge-colour': colour } as CSSProperties}
          aria-label={`edge ${name}`}
          aria-pressed={selected}
          title={`${name}${data?.type === undefined ? '' : ` (${data.type})`}${dryRun ? ', a dry run: nothing goes out' : ''}: open its settings${problem === undefined ? '' : `\n✗ ${problem}`}`}
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
