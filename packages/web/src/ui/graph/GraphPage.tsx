/**
 * The graph editor (P17, D55), the UI's home page and its main one: the instance's saved graph
 * (`GET /graph/file`) as a draft, drawn with React Flow, each plugin instance a node with its
 * ports, each binding an edge in its port type's colour (dashed when the input is optional), with a
 * rhombus at its midpoint that opens its panel (`PortEdge.tsx`), and on
 * each node its state (D64) and drift (`GET /status`, `GET /drift`).
 *
 * - **Add a node** from the plugins the instance offers (`GET /available`), choosing its id and its
 *   instance: fresh, kept already, or imported from an older data directory. It starts disabled,
 *   for the owner to set it up first (D64).
 * - **Wire it**: an edge dragged from an output to an input; a chat-in edge's chats, or a chat-out
 *   edge's chats and commands, set in its panel; a new chat-out edge is a dry run until the owner
 *   sends for real (D64). Every change is checked by the core as the load would
 *   (`POST /graph/check`), and each refusal shown where it is: on the edge, the port, the node or
 *   the field.
 * - **Configure it**: enabled or disabled, its config, settings and account in forms made from its
 *   schemas; a config key that names a secret is a choice of the secrets' names (`GET /secrets`).
 * - **Clear a stop** (D64): a stopped node's stop, cleared at the next Apply.
 * - **Remove it**: its instance is kept, and deleted after 7 days if no node uses it.
 * - **Review and apply**: the diff from the saved file and the stops cleared, then Apply
 *   (`PUT /graph/file`, each stop cleared, then a restart, which the UI waits through) or Revert (the draft back to the saved graph). A saved
 *   graph that differs from what runs (changed through the API, a rollback, or its restart failed)
 *   has its own banner with Apply. The versions before, and their rollback, are on the admin page
 *   (Admin → Graph history, D61).
 * - **Read it as text**: the Text tab, on the page's right edge, opens a side sheet with the draft
 *   printed (`POST /graph/check`'s `text`), read-only, with a copy button.
 *
 * The page is the map, filling the area between the app's bars: its minimap at the top right, what
 * the draft needs (its review, its problems, the selection and its kill) at the top left, the zoom
 * controls and the legend at the bottom left, and Add a node, a floating button, at the bottom
 * right. The panel of what is selected opens beside it (below it on a phone).
 *
 * A saved graph refused at the last start (`GET /status`, `graph.refused`) runs no node: it is
 * shown first, for the owner to fix. One or several running nodes selected can be killed (D44):
 * each is stopped (D64) until its stop is cleared here.
 *
 * Chats flow left to right (D60): a connector is drawn as two cards (`cards.ts`), its in card at
 * the left, whose chat-in output feeds the readers, and its out card at the right, whose chat-out
 * input takes the senders' edges. Either card selects the node; removing it removes both.
 *
 * A draft whose nodes name groups is drawn in swimlanes (D69, `layout.ts`, `lanes.ts`): each group
 * a band, a React Flow group node holding its cards, the connectors' cards outside every band. A
 * lane's label zooms to it; resting on a node or a lane's label dims what it does not reach.
 */
import type { Connection, Node } from '@xyflow/react';
import {
  Background,
  Controls,
  MiniMap,
  Panel,
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
  GraphNode,
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
import { cardsOf, cardTitle, isSplit, nodeOfCard, nodesOfCards, targetCard } from './cards.ts';
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
import { TextView } from './GraphText.tsx';
import type { LaneNodeType } from './LaneNode.tsx';
import { LaneNode } from './LaneNode.tsx';
import type { Hover } from './lanes.ts';
import { groupsOf, isLaneId, laneColours, laneId, lit, UNGROUPED_COLOUR } from './lanes.ts';
import type { Placed } from './layout.ts';
import { layout, swimlanes } from './layout.ts';
import { NodeDetails } from './NodeDetails.tsx';
import { Palette } from './Palette.tsx';
import type { PluginNodeType } from './PluginNode.tsx';
import { nodeHeight, PluginNode } from './PluginNode.tsx';
import type { PortEdgeData, PortEdgeType } from './PortEdge.tsx';
import { PortEdge } from './PortEdge.tsx';
import { Review } from './Review.tsx';
import '@xyflow/react/dist/style.css';

const NODE_TYPES = { plugin: PluginNode, lane: LaneNode };

/** What the canvas draws: the cards, and the lanes that hold them (D69). */
type CanvasNode = PluginNodeType | LaneNodeType;
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
  /** The nodes whose stop the draft clears, at the next Apply (D64). */
  const [clears, setClears] = useState<ReadonlySet<string>>(new Set());
  const [check, setCheck] = useState<GraphCheckView>();
  const [panel, setPanel] = useState<'palette' | 'review' | 'text' | AvailablePlugin>();
  const [busy, setBusy] = useState(false);
  /** Why the last Apply was refused. */
  const [refusedApply, setRefusedApply] = useState<{ error: string; problems: GraphProblem[] }>();
  const [restarting, setRestarting] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<PortEdgeType>([]);
  const [selected, setSelected] = useState<{ nodes: string[]; edges: string[] }>({
    nodes: [],
    edges: [],
  });
  const [said, setSaid] = useState<string>();
  /** What the pointer rests on, a node or a lane's label: the rest is dimmed (D69). */
  const [hover, setHover] = useState<Hover>();
  const hoverLane = useCallback(
    (lane: string | undefined) => setHover(lane === undefined ? undefined : { lane }),
    []
  );

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

  const kill = (ids: string[]): void => {
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Kill ${ids.join(', ')}: run each one's safety stop, then stop it until its stop is cleared here?`
      )
    )
      return;
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
  // A node whose ports its config declares (a script node, D74) is drawn as the check last saw
  // its config; any other, from its plugin.
  const declared = check?.views;
  const pluginOf = useCallback(
    (n: GraphNode) => declared?.[n.id] ?? plugins.get(n.plugin),
    [declared, plugins]
  );
  const views = useMemo(
    () => (draft?.nodes ?? []).map((n) => viewOf(n, pluginOf(n))),
    [draft, pluginOf]
  );
  const viewsById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);
  /** Each node's cards: one, or a connector's in and out cards (D60). */
  const cards = useMemo(() => views.flatMap(cardsOf), [views]);
  const selectedNodes = selected.nodes.join('\n');
  // The plugins' ports make the cards (and their heights): placed once they are known, or known not
  // to come, so that a first placement made without them does not stay.
  const pluginsKnown = available.data !== undefined || available.error !== undefined;
  useEffect(() => {
    if (draft === undefined || !pluginsKnown) return;
    const byId = new Map(cards.map((c) => [c.id, c]));
    const draftNodes = new Map(draft.nodes.map((n) => [n.id, n]));
    const ids = cards.map((c) => c.id);
    const links = draft.edges.map((e) => ({
      from: endOf(e.from).node,
      to: targetCard(e, viewsById),
    }));
    const height = (id: string): number =>
      nodeHeight((byId.get(id) as (typeof cards)[number]).view);
    const last = new Set(cards.filter((c) => c.side === 'out').map((c) => c.id));
    // A graph with groups is drawn in swimlanes (D69), its connectors' cards outside them; one
    // without, in columns alone.
    const groups = groupsOf(draft.nodes);
    let start: Map<string, Placed & { lane?: number }>;
    let lanes: LaneNodeType[] = [];
    if (groups.length === 0) start = layout(ids, links, height, last);
    else {
      const plan = swimlanes(ids, links, height, {
        first: new Set(cards.filter((c) => c.side === 'in').map((c) => c.id)),
        last,
        groupOf: (id) => draftNodes.get(byId.get(id)?.node ?? '')?.group,
      });
      // Coloured in the order of the lanes drawn: a group only connectors name draws none.
      const colours = laneColours(
        plan.lanes.flatMap((l) => (l.name === undefined ? [] : [l.name]))
      );
      start = plan.placed;
      lanes = plan.lanes.map((l) => ({
        id: laneId(l.name),
        type: 'lane' as const,
        position: { x: l.x, y: l.y },
        width: l.width,
        height: l.height,
        selectable: false,
        draggable: false,
        focusable: false,
        deletable: false,
        connectable: false,
        data: {
          name: l.name,
          colour:
            l.name === undefined ? UNGROUPED_COLOUR : (colours.get(l.name) ?? UNGROUPED_COLOUR),
          hover: hoverLane,
        },
      }));
    }
    const chosen = new Set(selectedNodes.split('\n'));
    setNodes((before) => {
      const was = new Map(before.map((n) => [n.id, n]));
      const cardNodes = cards.map((c): PluginNodeType => {
        const at = start.get(c.id);
        const lane = at?.lane === undefined ? undefined : lanes[at.lane]?.id;
        const portProblems: Record<string, string[]> = {};
        for (const [key, texts] of placed.ports)
          if (key.startsWith(`${c.node}.`)) {
            const port = key.slice(c.node.length + 1);
            if (port in c.view.inputs || port in c.view.outputs) portProblems[port] = texts;
          }
        const kept = was.get(c.id);
        const selectedHere = kept?.selected ?? false;
        // Kept where it was moved, while it stays in the same lane (its position is the lane's).
        const position =
          kept !== undefined && kept.parentId === lane
            ? kept.position
            : { x: at?.x ?? 0, y: at?.y ?? 0 };
        return {
          id: c.id,
          type: 'plugin' as const,
          position,
          ...(lane === undefined ? {} : { parentId: lane, extent: 'parent' as const }),
          selected: selectedHere,
          data: {
            view: c.view,
            live: live.get(c.node),
            drift: drifts.get(c.node),
            portTypes,
            disabled: draftNodes.get(c.node)?.disabled === true,
            cleared: clears.has(c.node),
            problems: placed.nodes.get(c.node) ?? [],
            portProblems,
            side: c.side,
            twinSelected: !selectedHere && c.side !== undefined && chosen.has(c.node),
          },
        };
      });
      // The lanes before their cards, as React Flow asks of parents.
      return [...lanes, ...cardNodes];
    });
  }, [
    draft,
    cards,
    viewsById,
    live,
    drifts,
    placed,
    portTypes,
    clears,
    setNodes,
    selectedNodes,
    pluginsKnown,
    hoverLane,
  ]);

  // The edges as React Flow draws them, kept as they were selected.
  useEffect(() => {
    const inputs = new Map(views.map((v) => [v.id, v.inputs]));
    const outputs = new Map(views.map((v) => [v.id, v.outputs]));
    const drawn = (draft?.edges ?? []).map((e): PortEdgeType => {
      const from = endOf(e.from);
      const to = endOf(e.to);
      // A chat-out edge is the sender's: dashed when its output is optional, whatever the
      // connector's input, which takes any number (D60).
      const input = to.port === undefined ? undefined : inputs.get(to.node)?.[to.port];
      const optional =
        input?.type === 'chat-out'
          ? from.port !== undefined && outputs.get(from.node)?.[from.port]?.optional === true
          : input?.optional === true;
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
        target: targetCard(e, viewsById),
        ...(to.port === undefined ? {} : { targetHandle: to.port }),
        className: `${e.type ?? ''}${optional ? ' optional' : ''}${problems.length > 0 ? ' refused' : ''}`,
        style: { stroke: colour, strokeWidth: 2, ...(optional ? { strokeDasharray: '6 4' } : {}) },
        data: {
          name: edgeKey(e),
          colour,
          type: e.type,
          problem: problems[0],
          dryRun: e.type === 'chat-out' && e.dryRun === true,
        },
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
  }, [draft, views, viewsById, placed, portTypes, setEdges]);

  // A hover dims what it does not reach (D69): the nodes and edges drawn with `dimmed`.
  const shown = useMemo(() => {
    const on = lit(
      hover,
      nodes.map((n) => ({
        id: n.id,
        node: n.type === 'plugin' ? nodeOfCard(n.id) : undefined,
        parentId: n.parentId,
      })),
      edges
    );
    if (on === undefined) return { nodes, edges };
    return {
      nodes: nodes.map((n) => (on.nodes.has(n.id) ? n : { ...n, className: 'dimmed' })),
      edges: edges.map((e) =>
        on.edges.has(e.id)
          ? e
          : {
              ...e,
              className: `${e.className ?? ''} dimmed`,
              data: { ...(e.data as PortEdgeData), dimmed: true },
            }
      ),
    };
  }, [hover, nodes, edges]);
  const hoverNode = useCallback(
    (_: unknown, n: Node) => setHover(n.type === 'plugin' ? { node: nodeOfCard(n.id) } : undefined),
    []
  );
  const leaveNode = useCallback(() => setHover(undefined), []);

  const selectionChanged = useCallback(
    ({ nodes: n, edges: e }: { nodes: CanvasNode[]; edges: PortEdgeType[] }) => {
      // A connector's two cards are one node; a lane is none.
      const next = {
        nodes: nodesOfCards(n.filter((x) => !isLaneId(x.id)).map((x) => x.id)),
        edges: e.map((x) => x.id),
      };
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

  const onConnect = (c: Connection): void =>
    change((g) => connect(g, edgeOf(c, plugins, g, declared)));

  const added = (n: NewNode): void => {
    // Its config starts filled with its defaults, written as if the owner had typed them; the node
    // starts disabled, for the owner to set it up first (D64).
    const config = withDefaults(plugins.get(n.plugin)?.configSchema, undefined);
    const node = { ...n, disabled: true };
    change((g) => addNode(g, Object.keys(config).length === 0 ? node : { ...node, config }));
    setPanel(undefined);
    setSaid(
      `${n.id} added, disabled, on the instance ${n.instance}: wire it, set it up, enable it, then review and apply`
    );
    instances.reload();
  };

  /**
   * Apply: the draft saved, each stop it clears cleared, then the instance restarted on it, unless
   * it runs already and no stop was cleared.
   */
  const apply = (): void => {
    if (draft === undefined) return;
    setBusy(true);
    setRefusedApply(undefined);
    const cleared = [...clears];
    api<{ saved: boolean; restart: boolean }>('/graph/file', draft, 'PUT')
      .then(async (r) => {
        for (const id of cleared) await api(`/plugins/${seg(id)}/clear-stop`, {});
        return r;
      })
      .then(
        (r) => {
          setBusy(false);
          savedRef.current = draft;
          setSaved(draft);
          setClears(new Set());
          setPanel(undefined);
          if (r.restart || cleared.length > 0) setRestarting(true);
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
    setClears(new Set());
    setRefusedApply(undefined);
    setPanel(undefined);
    setSelected({ nodes: [], edges: [] });
    if (dirty) setSaid('Reverted to the graph saved.');
  };

  const closeReview = useCallback(() => setPanel(undefined), []);

  /** Selects one edge alone, as a click on it does, so that its panel opens. */
  const openEdge = (key: string): void => {
    setNodes((ns) => ns.map((n) => (n.selected === true ? { ...n, selected: false } : n)));
    setEdges((es) => es.map((e) => ({ ...e, selected: e.id === key })));
    setSelected({ nodes: [], edges: [key] });
  };

  if (draft === undefined) return <p className="muted">{file.error ?? 'Loading…'}</p>;
  const dirty = saved === undefined || !sameGraph(draft, saved) || clears.size > 0;
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
  const killable = selected.nodes.filter((id) => live.get(id)?.state === 'running');
  const connectors = (available.data ?? []).filter((p) => p.kinds.includes('connector'));

  const textOpen = panel === 'text';
  let side = null;
  // The draft as text is a side sheet of its own, below.
  if (restarting || textOpen) side = null;
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
        clears={[...clears]}
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
    const view = viewOf(shownNode, pluginOf(shownNode));
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
        groups={groupsOf(draft.nodes)}
        change={(c) => change((g) => updateNode(g, shownNode.id, c))}
        remove={() => {
          const both = isSplit(view)
            ? ` Both its cards go, ${cardTitle(shownNode.id, 'in')} and ${cardTitle(shownNode.id, 'out')}: they are one node.`
            : '';
          if (
            !window.confirm(
              `Remove ${shownNode.id}?${both} Its instance ${instanceOf(shownNode)} is kept, with its state, and deleted after 7 days if no node uses it.`
            )
          )
            return;
          change((g) => removeNode(g, shownNode.id));
          setSelected({ nodes: [], edges: [] });
        }}
        kill={kill}
        saved={saved?.nodes.find((n) => n.id === shownNode.id)}
        edges={draft.edges}
        openEdge={openEdge}
        script={{ nodes: draft.nodes, viewOf: pluginOf, available: available.data ?? [] }}
        cleared={clears.has(shownNode.id)}
        clearStop={(clear) => {
          setRefusedApply(undefined);
          setClears((was) => {
            const next = new Set(was);
            if (clear) next.add(shownNode.id);
            else next.delete(shownNode.id);
            return next;
          });
        }}
      />
    );
  } else if (shownEdge !== undefined)
    side = (
      <EdgeDetails
        key={edgeKey(shownEdge)}
        edge={shownEdge}
        problems={placed.edges.get(edgeKey(shownEdge)) ?? []}
        connector={draft.nodes.find(
          (n) =>
            n.id === (shownEdge.type === 'chat-out' ? shownEdge.to : shownEdge.from).split('.')[0]
        )}
        change={(c) => change((g) => updateEdge(g, edgeKey(shownEdge), c))}
        remove={() => {
          change((g) => removeEdge(g, edgeKey(shownEdge)));
          setSelected({ nodes: [], edges: [] });
        }}
      />
    );

  const selection = [...selected.nodes, ...selected.edges];
  const needs =
    dirty ||
    (check !== undefined && !check.ok) ||
    status.data?.off === true ||
    selection.length > 0;

  return (
    <div className="graph-page">
      <div className="graph-notes">
        {refused.length === 0 ? null : (
          <div role="alert" className="banner bad">
            <strong>The saved graph was refused at the last start: no node runs.</strong> Fix it
            here, then review and apply it; or roll back to a version that ran, in{' '}
            <a href="#/graph-history">Admin → Graph history</a>.
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
      </div>
      <div className="graph-body">
        <div className="graph-canvas">
          <ReactFlow
            nodes={shown.nodes}
            edges={shown.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={selectionChanged}
            onConnect={onConnect}
            onNodeMouseEnter={hoverNode}
            onNodeMouseLeave={leaveNode}
            deleteKeyCode={null}
            multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
            selectionKeyCode="Shift"
            fitView
            // A graph of one node is not drawn at its largest: at most its own size.
            fitViewOptions={{ maxZoom: 1 }}
            minZoom={0.2}
          >
            <Background />
            {/* Each lane in its colour; the cards in the minimap's own (D69). */}
            <MiniMap
              pannable
              zoomable
              position="top-right"
              nodeColor={(n) =>
                n.type === 'lane' ? `rgb(${(n.data as { colour: string }).colour} / 35%)` : ''
              }
            />
            {needs ? (
              <Panel position="top-left" className="map-bar">
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
                {status.data?.off === true ? <span className="badge off">instance off</span> : null}
                {selection.length === 0 ? null : (
                  <span className="muted">Selected: {selection.join(', ')}</span>
                )}
                {killable.length === 0 ? null : (
                  <button type="button" className="danger" onClick={() => kill(killable)}>
                    Kill selected ({killable.length})
                  </button>
                )}
              </Panel>
            ) : null}
            {/* The zoom controls above the legend, both at the bottom left, clear of each other. */}
            <Panel position="bottom-left" className="map-corner">
              <Controls
                showInteractive={false}
                orientation="horizontal"
                style={{ position: 'static', margin: 0 }}
              />
              <div className="legend" role="group" aria-label="legend">
                {Object.values(portTypes).map((t) => (
                  <span key={t.id} className="legend-item" title={t.description}>
                    <span className={`port-sample ${t.shape}`} style={{ background: t.colour }} />
                    {t.id}
                  </span>
                ))}
                <span className="legend-item">
                  <span className="edge-sample optional" /> optional port
                </span>
                <span
                  className="legend-item"
                  title="a chat-out edge that logs what it would send, and sends nothing"
                >
                  <span className="rhombus-sample hollow" /> dry run
                </span>
              </div>
            </Panel>
            <Panel position="bottom-right">
              <button
                type="button"
                className="fab"
                aria-label="Add a node"
                title="Add a node"
                aria-expanded={panel === 'palette'}
                onClick={() => setPanel(panel === 'palette' ? undefined : 'palette')}
              >
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                  <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" fill="currentColor" />
                </svg>
              </button>
            </Panel>
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
      {/* The draft as text: a side sheet from the right, its tab riding on its edge (styles.css). */}
      <div className={textOpen ? 'side-sheet open' : 'side-sheet'}>
        <button
          type="button"
          className="sheet-tab"
          aria-expanded={textOpen}
          aria-controls="graph-text-sheet"
          title={textOpen ? 'Close the draft as text' : 'The draft as text'}
          onClick={() => setPanel(textOpen ? undefined : 'text')}
        >
          Text
        </button>
        <aside
          id="graph-text-sheet"
          className="details text"
          aria-label="the draft as text"
          aria-hidden={!textOpen}
          inert={!textOpen}
        >
          <h2>
            As text{' '}
            <button type="button" className="link" onClick={() => setPanel(undefined)}>
              close
            </button>
          </h2>
          <p className="muted small">
            The draft printed{dirty ? ', changes not applied included' : ''}: a node per line, then
            a line per value of its config, then an edge per line.
          </p>
          <TextView text={check?.text} label="the draft as text" />
        </aside>
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
