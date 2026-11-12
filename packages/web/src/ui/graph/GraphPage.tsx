/**
 * The graph editor (P17, D55), the UI's home page and its main one: the instance's saved graph
 * (`GET /graph/file`) as a draft, drawn with React Flow, each plugin instance a node with its
 * ports, each binding an edge in its port type's colour (dashed when the input is optional), with a
 * rhombus at its midpoint that opens its panel (`PortEdge.tsx`), and on
 * each node its live state, mode and drift (`GET /status`, `GET /drift`).
 *
 * - **Add a node** from the plugins the instance offers (`GET /available`), choosing its id and its
 *   instance: fresh, kept already, or imported from an older data directory.
 * - **Wire it**: an edge dragged from an output to an input; a chat edge's chats and commands set in
 *   its panel. Every change is checked by the core as the load would (`POST /graph/check`), and
 *   each refusal shown where it is: on the edge, the port, the node or the field.
 * - **Configure it**: its config, settings, mode and account in forms made from its schemas; a
 *   config key that names a secret is a choice of the secrets' names (`GET /secrets`).
 * - **Remove it**: its instance is kept, and deleted after 7 days if no node uses it.
 * - **Review and apply**: the diff from the saved file, then Apply (`PUT /graph/file`, then a
 *   restart, which the UI waits through) or Revert (the draft back to the saved graph). A saved
 *   graph that differs from what runs (changed through the API, or its restart failed) has its own
 *   banner with Apply. Roll back puts the previous file back (`POST /graph/rollback`).
 *
 * A saved graph refused at the last start (`GET /status`, `graph.refused`) runs no node: it is
 * shown first, for the owner to fix. One or several running nodes selected can be killed (D44).
 */
import type { Connection } from '@xyflow/react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AvailablePlugin,
  DriftCounts,
  Graph,
  GraphCheckView,
  GraphFileView,
  GraphProblem,
  GraphViewData,
  InstanceInfo,
  PortTypeInfo,
  Status,
} from '#src/ui/api.ts';
import { api, ApiError, seg } from '#src/ui/api.ts';
import type { PageProps } from '#src/ui/App.tsx';
import { useLoad } from '#src/ui/hooks.ts';
import { Restart } from '#src/ui/Restart.tsx';
import type { NewNode } from './AddNode.tsx';
import { AddNode } from './AddNode.tsx';
import { withDefaults } from './defaults.ts';
import {
  addNode,
  asGraph,
  connect,
  edgeKey,
  edgeOf,
  EMPTY_GRAPH,
  endOf,
  instanceOf,
  placeProblems,
  removeEdge,
  removeNode,
  sameGraph,
  updateEdge,
  updateNode,
  viewOf,
} from './draft.ts';
import { EdgeDetails } from './EdgeDetails.tsx';
import { layout } from './layout.ts';
import { NodeDetails } from './NodeDetails.tsx';
import { Palette } from './Palette.tsx';
import type { PluginNodeType } from './PluginNode.tsx';
import { nodeHeight, PluginNode } from './PluginNode.tsx';
import type { PortEdgeType } from './PortEdge.tsx';
import { PortEdge } from './PortEdge.tsx';
import { Review } from './Review.tsx';
import '@xyflow/react/dist/style.css';

const NODE_TYPES = { plugin: PluginNode };
const EDGE_TYPES = { port: PortEdge };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long the draft rests before it is checked. */
const CHECK_AFTER_MS = 300;

export function GraphPage({
  loggedOut,
  restarted,
  checkAfterMs = CHECK_AFTER_MS,
}: PageProps & { checkAfterMs?: number }) {
  const file = useLoad(() => api<GraphFileView>('/graph/file'), loggedOut, 60_000);
  const available = useLoad(() => api<AvailablePlugin[]>('/available'), loggedOut, 600_000);
  const status = useLoad(() => api<Status>('/status'), loggedOut, 5_000);
  const drift = useLoad(() => api<DriftCounts[]>('/drift'), loggedOut, 10_000);
  const instances = useLoad(() => api<InstanceInfo[]>('/instances'), loggedOut, 60_000);
  const secrets = useLoad(() => api<{ names: string[] }>('/secrets'), loggedOut, 600_000);
  // The port types' looks (bot-os-api.md §2.1), as the core gives them with the running graph.
  const running = useLoad(() => api<GraphViewData | null>('/graph/view'), loggedOut, 600_000);
  const portTypes = useMemo(
    (): Record<string, PortTypeInfo> => running.data?.portTypes ?? {},
    [running.data]
  );

  /** The saved file's graph, as the draft last started from it. */
  const [saved, setSaved] = useState<Graph>();
  const [draft, setDraft] = useState<Graph>();
  const [check, setCheck] = useState<GraphCheckView>();
  const [panel, setPanel] = useState<'palette' | 'review' | AvailablePlugin>();
  const [busy, setBusy] = useState(false);
  /** Why the last Apply was refused. */
  const [refusedApply, setRefusedApply] = useState<{ error: string; problems: GraphProblem[] }>();
  const [restarting, setRestarting] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<PluginNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<PortEdgeType>([]);
  const [selected, setSelected] = useState<{ nodes: string[]; edges: string[] }>({
    nodes: [],
    edges: [],
  });
  const [said, setSaid] = useState<string>();

  // The draft starts as the saved file, once it is read; a reload of the file later (after a save
  // or a rollback) starts it again only when the owner has changed nothing.
  const savedRef = useRef<Graph>(undefined);
  const fileGraph = file.data;
  useEffect(() => {
    if (fileGraph === undefined) return;
    const next = asGraph(fileGraph.graph);
    const was = savedRef.current;
    if (was !== undefined && sameGraph(next, was)) return;
    savedRef.current = next;
    setSaved(next);
    setDraft((d) => (d === undefined || (was !== undefined && sameGraph(d, was)) ? next : d));
  }, [fileGraph]);

  // Each change of the draft checked by the core, once it rests.
  useEffect(() => {
    if (draft === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      api<GraphCheckView>('/graph/check', draft).then(
        (c) => {
          if (live) setCheck(c);
        },
        (e: unknown) => {
          if (live) setSaid(`check: ${message(e)}`);
        }
      );
    }, checkAfterMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, checkAfterMs]);

  const plugins = useMemo(
    () => new Map((available.data ?? []).map((p) => [p.id, p])),
    [available.data]
  );
  const live = useMemo(
    () => new Map((status.data?.plugins ?? []).map((p) => [p.id, p])),
    [status.data]
  );
  const drifts = useMemo(() => new Map((drift.data ?? []).map((d) => [d.parser, d])), [drift.data]);
  const placed = useMemo(() => placeProblems(check?.problems ?? []), [check]);
  const kept = useMemo(
    () => new Map((instances.data ?? []).map((i) => [i.id, i])),
    [instances.data]
  );

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

  // The nodes as React Flow draws them, kept where they were moved and as they were selected.
  const views = useMemo(
    () => (draft?.nodes ?? []).map((n) => viewOf(n, plugins.get(n.plugin))),
    [draft, plugins]
  );
  useEffect(() => {
    if (draft === undefined) return;
    const byId = new Map(views.map((v) => [v.id, v]));
    const start = layout(
      views.map((v) => v.id),
      draft.edges,
      (id) => nodeHeight(byId.get(id) as (typeof views)[number])
    );
    setNodes((before) => {
      const was = new Map(before.map((n) => [n.id, n]));
      return views.map((v) => {
        const portProblems: Record<string, string[]> = {};
        for (const [key, texts] of placed.ports)
          if (key.startsWith(`${v.id}.`)) portProblems[key.slice(v.id.length + 1)] = texts;
        return {
          id: v.id,
          type: 'plugin' as const,
          position: was.get(v.id)?.position ?? start.get(v.id) ?? { x: 0, y: 0 },
          selected: was.get(v.id)?.selected ?? false,
          data: {
            view: v,
            live: live.get(v.id),
            drift: drifts.get(v.id),
            portTypes,
            reinstate,
            problems: placed.nodes.get(v.id) ?? [],
            portProblems,
          },
        };
      });
    });
  }, [draft, views, live, drifts, placed, portTypes, reinstate, setNodes]);

  // The edges as React Flow draws them, kept as they were selected.
  useEffect(() => {
    const inputs = new Map(views.map((v) => [v.id, v.inputs]));
    const drawn = (draft?.edges ?? []).map((e): PortEdgeType => {
      const from = endOf(e.from);
      const to = endOf(e.to);
      const optional = to.port !== undefined && inputs.get(to.node)?.[to.port]?.optional === true;
      const problems = placed.edges.get(edgeKey(e)) ?? [];
      const colour =
        problems.length > 0
          ? '#b91c1c'
          : e.type === undefined
            ? 'gray'
            : (portTypes[e.type]?.colour ?? 'gray');
      return {
        id: edgeKey(e),
        type: 'port',
        source: from.node,
        ...(from.port === undefined ? {} : { sourceHandle: from.port }),
        target: to.node,
        ...(to.port === undefined ? {} : { targetHandle: to.port }),
        className: `${e.type ?? ''}${optional ? ' optional' : ''}${problems.length > 0 ? ' refused' : ''}`,
        style: { stroke: colour, strokeWidth: 2, ...(optional ? { strokeDasharray: '6 4' } : {}) },
        data: { name: edgeKey(e), colour, type: e.type, problem: problems[0] },
        // The rhombus at its midpoint is the edge's handle for the keyboard and the screen reader
        // (`PortEdge.tsx`); the line stays clickable.
        focusable: false,
        domAttributes: { 'aria-hidden': true },
      };
    });
    setEdges((before) => {
      const was = new Set(before.filter((e) => e.selected === true).map((e) => e.id));
      return drawn.map((e) => ({ ...e, selected: was.has(e.id) }));
    });
  }, [draft, views, placed, portTypes, setEdges]);

  const selectionChanged = useCallback(
    ({ nodes: n, edges: e }: { nodes: PluginNodeType[]; edges: PortEdgeType[] }) => {
      const next = { nodes: n.map((x) => x.id), edges: e.map((x) => x.id) };
      setSelected((was) =>
        was.nodes.join('\n') === next.nodes.join('\n') &&
        was.edges.join('\n') === next.edges.join('\n')
          ? was
          : next
      );
    },
    []
  );

  const change = (next: (g: Graph) => Graph): void => {
    setRefusedApply(undefined);
    setDraft((d) => next(d ?? EMPTY_GRAPH));
  };

  const onConnect = (c: Connection): void => change((g) => connect(g, edgeOf(c, plugins, g)));

  const added = (n: NewNode): void => {
    // Its config starts filled with its defaults, written as if the owner had typed them.
    const config = withDefaults(plugins.get(n.plugin)?.configSchema, undefined);
    change((g) => addNode(g, Object.keys(config).length === 0 ? n : { ...n, config }));
    setPanel(undefined);
    setSaid(
      `${n.id} added on the instance ${n.instance}: wire it, set it up, then review and apply`
    );
    instances.reload();
  };

  /** Apply: the draft saved, then the instance restarted on it, unless it runs already. */
  const apply = (): void => {
    if (draft === undefined) return;
    setBusy(true);
    setRefusedApply(undefined);
    api<{ saved: boolean; restart: boolean }>('/graph/file', draft, 'PUT').then(
      (r) => {
        setBusy(false);
        savedRef.current = draft;
        setSaved(draft);
        setPanel(undefined);
        if (r.restart) setRestarting(true);
        else {
          setSaid('Saved: it is what runs already, so no restart is needed.');
          file.reload();
        }
        instances.reload();
      },
      (e: unknown) => {
        setBusy(false);
        setRefusedApply({
          error: message(e),
          problems: e instanceof ApiError ? e.problems : [],
        });
      }
    );
  };

  /** Revert: the draft back to the saved graph, once confirmed if it has changes. */
  const revert = (dirty: boolean): void => {
    if (dirty && !window.confirm('Revert: drop every change made here, back to the graph saved?'))
      return;
    if (saved !== undefined) setDraft(saved);
    setRefusedApply(undefined);
    setPanel(undefined);
    setSelected({ nodes: [], edges: [] });
    if (dirty) setSaid('Reverted to the graph saved.');
  };

  const rollback = (): void => {
    if (
      !window.confirm(
        'Roll back: put the previous saved graph back in place of this one? (A second rollback goes forward again.)'
      )
    )
      return;
    api<{ problems?: unknown[] }>('/graph/rollback', {}).then(
      (r) => {
        setSaid(
          `Rolled back to the previous saved graph${r.problems === undefined ? '' : ', which the check refuses'}: apply it to run it.`
        );
        savedRef.current = undefined;
        setDraft(undefined);
        setSaved(undefined);
        file.reload();
      },
      (e: unknown) => setSaid(`rollback: ${message(e)}`)
    );
  };

  const closeReview = useCallback(() => setPanel(undefined), []);

  if (draft === undefined) return <p className="muted">{file.error ?? 'Loading…'}</p>;
  const dirty = saved === undefined || !sameGraph(draft, saved);
  const refused = status.data?.graph?.refused ?? [];
  const ids = new Set(draft.nodes.map((n) => n.id));
  const usedInstances = new Set(draft.nodes.map(instanceOf));
  const oneNode =
    selected.nodes.length === 1 && selected.edges.length <= 1 ? selected.nodes[0] : undefined;
  const shownNode = draft.nodes.find((n) => n.id === oneNode);
  const shownEdge =
    selected.nodes.length === 0 && selected.edges.length === 1
      ? draft.edges.find((e) => edgeKey(e) === selected.edges[0])
      : undefined;
  const killable = selected.nodes.filter((id) => live.has(id) && live.get(id)?.killed !== true);
  const connectors = (available.data ?? []).filter((p) => p.kinds.includes('connector'));

  let side = null;
  if (restarting) side = null;
  else if (panel === 'palette')
    side = (
      <Palette
        plugins={available.data ?? []}
        pick={(p) => setPanel(p)}
        close={() => setPanel(undefined)}
      />
    );
  else if (panel === 'review')
    side = (
      <Review
        check={check}
        dirty={dirty}
        busy={busy}
        refused={refusedApply}
        apply={apply}
        revert={() => revert(dirty)}
        close={closeReview}
      />
    );
  else if (panel !== undefined)
    side = (
      <AddNode
        key={panel.id}
        plugin={panel}
        nodes={ids}
        usedInstances={usedInstances}
        instances={instances.data ?? []}
        add={added}
        cancel={() => setPanel('palette')}
      />
    );
  else if (shownNode !== undefined) {
    const view = viewOf(shownNode, plugins.get(shownNode.plugin));
    side = (
      <NodeDetails
        key={shownNode.id}
        node={shownNode}
        view={view}
        live={live.get(shownNode.id)}
        drift={drifts.get(shownNode.id)}
        instance={kept.get(instanceOf(shownNode))}
        problems={[
          ...(placed.nodes.get(shownNode.id) ?? []),
          ...[...placed.ports].flatMap(([k, t]) => (k.startsWith(`${shownNode.id}.`) ? t : [])),
        ]}
        configErrors={placed.config.get(shownNode.id) ?? {}}
        settingErrors={placed.settings.get(shownNode.id) ?? {}}
        secretNames={secrets.data?.names ?? []}
        change={(c) => change((g) => updateNode(g, shownNode.id, c))}
        remove={() => {
          if (
            !window.confirm(
              `Remove ${shownNode.id}? Its instance ${instanceOf(shownNode)} is kept, with its state, and deleted after 7 days if no node uses it.`
            )
          )
            return;
          change((g) => removeNode(g, shownNode.id));
          setSelected({ nodes: [], edges: [] });
        }}
        kill={kill}
        reinstate={reinstate}
      />
    );
  } else if (shownEdge !== undefined)
    side = (
      <EdgeDetails
        key={edgeKey(shownEdge)}
        edge={shownEdge}
        problems={placed.edges.get(edgeKey(shownEdge)) ?? []}
        change={(c) => change((g) => updateEdge(g, edgeKey(shownEdge), c))}
        remove={() => {
          change((g) => removeEdge(g, edgeKey(shownEdge)));
          setSelected({ nodes: [], edges: [] });
        }}
      />
    );

  return (
    <div className="graph-page">
      {refused.length === 0 ? null : (
        <div role="alert" className="banner bad">
          <strong>The saved graph was refused at the last start: no node runs.</strong> Fix it here,
          then review and apply it; or roll back to the previous one.
          <ul>
            {refused.map((p) => (
              <li key={p.text}>{p.text}</li>
            ))}
          </ul>
        </div>
      )}
      {fileGraph?.error === undefined ? null : (
        <div role="alert" className="banner bad">
          {fileGraph.error}. Applying a graph here replaces it.
        </div>
      )}
      {dirty || fileGraph?.differs !== true || fileGraph.problems !== undefined ? null : (
        <div role="region" aria-label="not applied" className="banner warn">
          <strong>The saved graph is not what runs.</strong> It was changed outside this page (the
          API, a rollback), or the restart of the last Apply did not happen.{' '}
          <button type="button" className="primary" onClick={() => setRestarting(true)}>
            Apply (restart)
          </button>
        </div>
      )}
      <div className="toolbar">
        <button type="button" onClick={() => setPanel(panel === 'palette' ? undefined : 'palette')}>
          Add a node
        </button>
        {dirty ? (
          <>
            <strong className="warn">Changes not applied</strong>
            <button type="button" className="primary" onClick={() => setPanel('review')}>
              Review changes
            </button>
          </>
        ) : null}
        {check === undefined || check.ok ? null : (
          <span className="error">
            {check.problems.length} problem{check.problems.length === 1 ? '' : 's'}
          </span>
        )}
        <button type="button" onClick={rollback}>
          Roll back
        </button>
        {status.data?.off === true ? <span className="badge off">instance off</span> : null}
        <span className="muted">
          {selected.nodes.length + selected.edges.length === 0
            ? 'Select a node or an edge for its details; drag from an output to an input to wire them.'
            : `Selected: ${[...selected.nodes, ...selected.edges].join(', ')}`}
        </span>
        {killable.length === 0 ? null : (
          <button type="button" className="danger" onClick={() => kill(killable)}>
            Kill selected ({killable.length})
          </button>
        )}
      </div>
      <div className="toolbar legend">
        {Object.values(portTypes).map((t) => (
          <span key={t.id} className="legend-item" title={t.description}>
            <span className={`port-sample ${t.shape}`} style={{ background: t.colour }} />
            {t.id}
          </span>
        ))}
        <span className="legend-item">
          <span className="edge-sample optional" /> optional input
        </span>
      </div>
      {said === undefined ? null : (
        <p role="status" className="said">
          {said}
        </p>
      )}
      {status.error === undefined ? null : <p role="alert">{status.error}</p>}
      {placed.other.length === 0 ? null : (
        <ul className="problems" aria-label="other problems">
          {placed.other.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="graph-body">
        <div className="graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={selectionChanged}
            onConnect={onConnect}
            deleteKeyCode={null}
            multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
            selectionKeyCode="Shift"
            fitView
            // A graph of one node is not drawn at its largest: at most its own size.
            fitViewOptions={{ maxZoom: 1 }}
            minZoom={0.2}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {draft.nodes.length === 0 && panel === undefined ? (
            <div className="empty-state" role="region" aria-label="first step">
              <h2>Add your first node</h2>
              <p>
                A graph starts from its accounts: add a connector first, then what reads and acts
                through it.
              </p>
              <ul className="plugins">
                {connectors.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="plugin" onClick={() => setPanel(p)}>
                      <strong>{p.id}</strong>
                      <br />
                      <small>{p.description}</small>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="link" onClick={() => setPanel('palette')}>
                Every plugin
              </button>
            </div>
          ) : null}
        </div>
        {side}
      </div>
      {restarting ? (
        <Restart
          done={(note) => {
            setRestarting(false);
            if (restarted === undefined) setSaid(note);
            else restarted(note);
          }}
          loggedOut={(note) => loggedOut(note)}
          failed={(why) => {
            setRestarting(false);
            setSaid(`restart: ${why}`);
          }}
        />
      ) : null}
    </div>
  );
}
