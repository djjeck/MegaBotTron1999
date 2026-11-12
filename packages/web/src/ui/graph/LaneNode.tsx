/**
 * A swimlane of the graph editor (docs/bot-os.md D69): a group's band, a tinted rounded box in the
 * group's colour (`lanes.ts`), its cards its children in React Flow, kept inside it. Its label, at
 * its top left, is a button: a click zooms to fit the lane, and resting the pointer (or the focus)
 * on it dims everything outside the lane but the edges and the connectors its cards reach. The
 * ungrouped nodes' lane has no label.
 */
import type { Node, NodeProps } from '@xyflow/react';
import { useReactFlow } from '@xyflow/react';
import type { CSSProperties } from 'react';

export interface LaneNodeData extends Record<string, unknown> {
  /** Its group; none for the ungrouped nodes' lane. */
  name?: string | undefined;
  /** Its colour, `r g b`. */
  colour: string;
  /** Its label rested on (its id), or left (undefined). */
  hover: (lane: string | undefined) => void;
}

export type LaneNodeType = Node<LaneNodeData, 'lane'>;

export function LaneNode({ id, data }: NodeProps<LaneNodeType>) {
  const flow = useReactFlow();
  const { name } = data;
  return (
    <div
      className={`lane${name === undefined ? ' ungrouped' : ''}`}
      style={{ '--lane': data.colour } as CSSProperties}
      role="group"
      aria-label={name === undefined ? 'lane of the ungrouped nodes' : `lane ${name}`}
    >
      {name === undefined ? null : (
        <button
          type="button"
          className="lane-label nodrag nopan"
          title={`${name}: zoom to this lane`}
          onClick={() => void flow.fitView({ nodes: [{ id }], duration: 300, padding: 0.08 })}
          onMouseEnter={() => data.hover(id)}
          onMouseLeave={() => data.hover(undefined)}
          onFocus={() => data.hover(id)}
          onBlur={() => data.hover(undefined)}
        >
          <span className="lane-dot" aria-hidden="true" />
          {name}
        </button>
      )}
    </div>
  );
}
