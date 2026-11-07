/**
 * The graph view (P17), the UI's home page: the instance drawn as its graph, each plugin
 * instance a node with its ports, each binding an edge in its port type's colour (dashed when the
 * input is optional), and on each node its live state, mode and drift. Selecting a node shows its
 * details; selecting one or several (a click with Shift, Ctrl or Cmd, or a box drawn with Shift)
 * offers to kill them, each with its own safety stop (D44). A killed node is drawn disabled, with
 * its reinstatement at hand.
 *
 * Drawn with React Flow (`@xyflow/react`), which the editor needs for dragging edges; read-only
 * here: nodes can be moved about and selected, ports cannot be connected.
 */
import type { Edge } from '@xyflow/react';
import { Background, Controls, MiniMap, ReactFlow, useNodesState } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DriftCounts, GraphViewData, Status } from '#src/ui/api.ts';
import { api, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';
import { layout } from './layout.ts';
import { NodeDetails } from './NodeDetails.tsx';
import type { PluginNodeType } from './PluginNode.tsx';
import { nodeHeight, PluginNode } from './PluginNode.tsx';
import '@xyflow/react/dist/style.css';

const NODE_TYPES = { plugin: PluginNode };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The graph's edges, as React Flow draws them. */
function edgesOf(data: GraphViewData): Edge[] {
  const inputs = new Map(data.nodes.map((n) => [n.id, n.inputs]));
  return data.graph.edges.map((e) => {
    const [source = '', sourceHandle = ''] = e.from.split('.');
    const [target = '', targetHandle = ''] = e.to.split('.');
    const optional = inputs.get(target)?.[targetHandle]?.optional === true;
    const colour = e.type === undefined ? 'gray' : data.portTypes[e.type].colour;
    return {
      id: `${e.from}->${e.to}`,
      source,
      sourceHandle,
      target,
      targetHandle,
      className: `${e.type ?? ''}${optional ? ' optional' : ''}`,
      style: { stroke: colour, strokeWidth: 2, ...(optional ? { strokeDasharray: '6 4' } : {}) },
      focusable: false,
    };
  });
}

export function GraphPage({ loggedOut }: PageProps) {
  const view = useLoad(() => api<GraphViewData | null>('/graph/view'), loggedOut, 60_000);
  const status = useLoad(() => api<Status>('/status'), loggedOut, 5_000);
  const drift = useLoad(() => api<DriftCounts[]>('/drift'), loggedOut, 10_000);
  const [nodes, setNodes, onNodesChange] = useNodesState<PluginNodeType>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [said, setSaid] = useState<string>();
  // React Flow calls it on every change of its own; the selection is kept only when it changed.
  const selectionChanged = useCallback(({ nodes: chosen }: { nodes: PluginNodeType[] }) => {
    const ids = chosen.map((n) => n.id);
    setSelected((was) => (was.join('\n') === ids.join('\n') ? was : ids));
  }, []);

  const reinstate = useCallback(
    (id: string): void => {
      api(`/plugins/${seg(id)}/resume`, {})
        .then(
          () => setSaid(`${id} reinstated`),
          (e: unknown) => setSaid(`${id}: ${message(e)}`)
        )
        .finally(status.reload);
    },
    [status.reload]
  );

  const kill = (ids: string[]): void => {
    if (ids.length === 0) return;
    if (!window.confirm(`Kill ${ids.join(', ')}: run each one's safety stop?`)) return;
    void (async () => {
      const results: string[] = [];
      for (const id of ids)
        try {
          results.push((await api<{ result: string }>(`/plugins/${seg(id)}/kill`, {})).result);
        } catch (e) {
          results.push(`${id}: ${message(e)}`);
        }
      setSaid(results.join('; '));
      status.reload();
    })();
  };

  const data = view.data;
  const live = useMemo(
    () => new Map((status.data?.plugins ?? []).map((p) => [p.id, p])),
    [status.data]
  );
  const drifts = useMemo(() => new Map((drift.data ?? []).map((d) => [d.parser, d])), [drift.data]);

  // The nodes, kept where they were moved and as they were selected, their live state renewed.
  useEffect(() => {
    if (data === undefined || data === null) return;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const start = layout(
      data.nodes.map((n) => n.id),
      data.graph.edges,
      (id) => nodeHeight(byId.get(id) as (typeof data.nodes)[number])
    );
    setNodes((before) => {
      const was = new Map(before.map((n) => [n.id, n]));
      return data.nodes.map((n) => ({
        id: n.id,
        type: 'plugin' as const,
        position: was.get(n.id)?.position ?? start.get(n.id) ?? { x: 0, y: 0 },
        selected: was.get(n.id)?.selected ?? false,
        data: {
          view: n,
          live: live.get(n.id),
          drift: drifts.get(n.id),
          portTypes: data.portTypes,
          reinstate,
        },
      }));
    });
  }, [data, live, drifts, reinstate, setNodes]);

  const edges = useMemo(() => (data === undefined || data === null ? [] : edgesOf(data)), [data]);

  if (data === undefined) return <p className="muted">{view.error ?? 'Loading…'}</p>;
  if (data === null) return <p className="muted">The instance has not loaded its graph yet.</p>;
  // The details of one node; with several selected, the toolbar names them.
  const shown = selected.length === 1 ? data.nodes.find((n) => n.id === selected[0]) : undefined;
  const killable = selected.filter((id) => live.get(id)?.killed !== true);
  return (
    <div className="graph-page">
      <div className="toolbar">
        <span className="legend">
          {Object.values(data.portTypes).map((t) => (
            <span key={t.id} className="legend-item" title={t.description}>
              <span className={`port-sample ${t.shape}`} style={{ background: t.colour }} />
              {t.id}
            </span>
          ))}
          <span className="legend-item">
            <span className="edge-sample optional" /> optional input
          </span>
        </span>
        {status.data?.off === true ? <span className="badge off">instance off</span> : null}
        <span className="muted">
          {selected.length === 0
            ? 'Select a node for its details; Shift, Ctrl or Cmd to select several.'
            : `Selected: ${selected.join(', ')}`}
        </span>
        {killable.length === 0 ? null : (
          <button type="button" className="danger" onClick={() => kill(killable)}>
            Kill selected ({killable.length})
          </button>
        )}
      </div>
      {said === undefined ? null : (
        <p role="status" className="said">
          {said}
        </p>
      )}
      {status.error === undefined ? null : <p role="alert">{status.error}</p>}
      <div className="graph-body">
        <div className="graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onSelectionChange={selectionChanged}
            nodesConnectable={false}
            edgesFocusable={false}
            multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
            selectionKeyCode="Shift"
            fitView
            minZoom={0.2}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        {shown === undefined ? null : (
          <NodeDetails
            view={shown}
            live={live.get(shown.id)}
            drift={drifts.get(shown.id)}
            kill={kill}
            reinstate={reinstate}
          />
        )}
      </div>
    </div>
  );
}
