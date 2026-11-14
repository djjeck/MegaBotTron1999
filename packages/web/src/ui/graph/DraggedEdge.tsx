/**
 * The edge being dragged from an output (#4): a curve as the edges are drawn, red and dashed while
 * it rests on a port that cannot take it (`bindProblem`, which React Flow asks through the editor's
 * `isValidConnection`), so that a mismatch shows before the drop, which it then refuses.
 */
import type { ConnectionLineComponentProps } from '@xyflow/react';
import { getBezierPath } from '@xyflow/react';

/** The refusal's red, as a refused edge is drawn. */
const REFUSED = '#b91c1c';

export function DraggedEdge(props: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: props.fromX,
    sourceY: props.fromY,
    sourcePosition: props.fromPosition,
    targetX: props.toX,
    targetY: props.toY,
    targetPosition: props.toPosition,
  });
  const refused = props.connectionStatus === 'invalid';
  return (
    <path
      className={`dragged-edge${refused ? ' refused' : ''}`}
      d={path}
      fill="none"
      stroke={refused ? REFUSED : 'currentColor'}
      strokeWidth={2}
      {...(refused ? { strokeDasharray: '6 4' } : {})}
    />
  );
}
