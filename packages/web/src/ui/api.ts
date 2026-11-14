/**
 * The UI's way to the instance: the core's control API under `/api/` (docs/bot-os-api.md §4.11),
 * as the UI's server serves it behind the login. The shapes are the core's own types, so that the
 * pages show what the plugins declare and nothing else (P11).
 */
import type {
  AccountControl,
  AvailablePlugin,
  CoalescedView,
  DiffLine,
  DriftCounts,
  EventTypeView,
  GitHubLookup,
  Graph,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphProblem,
  GraphStart,
  GraphVersionMeta,
  InstalledModule,
  InstanceInfo,
  JsonSchema,
  LogEntry,
  MemberView,
  ModuleCandidate,
  ModulesReport,
  NodeCost,
  NodeView,
  PluginControl,
  PluginView,
  PortType,
  PortTypeInfo,
  PortView,
  QueueEntryView,
  RemovedModule,
  SectionFreshness,
  StateView,
  Surface,
  SurfacesView,
} from '@megabottron1999/core';

export type {
  AccountControl,
  AvailablePlugin,
  CoalescedView,
  DiffLine,
  DriftCounts,
  EventTypeView,
  GitHubLookup,
  Graph,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphProblem,
  GraphStart,
  GraphVersionMeta,
  InstalledModule,
  InstanceInfo,
  JsonSchema,
  LogEntry,
  MemberView,
  ModuleCandidate,
  ModulesReport,
  NodeCost,
  NodeView,
  PluginControl,
  PluginView,
  PortType,
  PortTypeInfo,
  PortView,
  QueueEntryView,
  RemovedModule,
  SectionFreshness,
  StateView,
  Surface,
  SurfacesView,
};

/** What the graph view draws, as `GET /graph/view` gives it; null before the load. */
export interface GraphViewData {
  graph: Graph;
  portTypes: Record<PortType, PortTypeInfo>;
  nodes: NodeView[];
}

/** The instance's health, as `GET /instance` gives it. */
export interface InstanceHealth {
  off: boolean;
  /** The release it runs; absent from an older instance. */
  version?: string;
  /** The commit its image was built from, when known. */
  commit?: string;
  uptimeS: number;
  node: string;
  memoryMb: { rss: number; heap: number };
  plugins: Record<string, number>;
  accounts: Record<string, number>;
}

/** The instance and its plugins, as `GET /status` gives them; `graph.refused`, why the saved graph did not run. */
export interface Status {
  off: boolean;
  plugins: PluginControl[];
  graph?: { refused: GraphProblem[] };
}

/** The saved graph, as `GET /graph/file` gives it (docs/bot-os-api.md §2.3). */
export interface GraphFileView {
  exists: boolean;
  graph?: unknown;
  error?: string;
  problems?: GraphProblem[];
  /** What its check warns of (bot-os.md D89); none: nothing. */
  warnings?: GraphProblem[];
  /** Whether a restart would change what runs. */
  differs: boolean;
  /** The graph printed (`graphText`), when the file reads. */
  text?: string;
}

/**
 * A graph checked, as `POST /graph/check` gives it: its problems, its warnings, its diff from the
 * saved file, and the graph printed (`graphText`).
 */
export interface GraphCheckView {
  ok: boolean;
  problems: GraphProblem[];
  /** What it warns of (bot-os.md D89), which refuses nothing; none: nothing. */
  warnings?: GraphProblem[];
  diff: GraphDiff;
  text?: string;
  /**
   * The nodes whose ports their config declares (a script node, bot-os.md D74), by id, each drawn
   * as the draft's config declares it.
   */
  views?: Record<string, PluginView>;
}

/** The graph's history, as `GET /graph/history` gives it (docs/bot-os-api.md §2.3). */
export interface GraphHistoryView {
  /** Newest first. */
  versions: GraphVersionMeta[];
  /** The version that is the saved graph, if one is. */
  current?: string;
  /** The newest version the instance last started cleanly on. */
  lastGood?: string;
  keep: { days: number; latest: number };
}

/**
 * One version, as `GET /graph/history/<id>` gives it: its graph and text, and how the saved graph
 * would change to it (`diff`, `lines`); `problems`, if the check refuses it now.
 */
export interface GraphVersionView extends GraphVersionMeta {
  graph: unknown;
  current: boolean;
  diff: GraphDiff;
  text: string;
  currentText: string;
  lines: DiffLine[];
  problems?: GraphProblem[];
}

/** A refusal of the API: its status and why, and the problems it names, if any (a graph refused). */
export class ApiError extends Error {
  readonly status: number;
  readonly problems: GraphProblem[];

  constructor(status: number, message: string, problems: GraphProblem[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

/**
 * Calls the API: a GET, or a POST (a PUT with `method`) of `body` as JSON, or a DELETE (`method`,
 * with no body). Throws an `ApiError` for a refusal.
 */
export async function api<T>(
  route: string,
  body?: unknown,
  method: 'POST' | 'PUT' | 'DELETE' = 'POST'
): Promise<T> {
  const res = await fetch(
    `api${route}`,
    method === 'DELETE'
      ? // No body, but the type the server asks of every change (its same-origin rule).
        { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' } }
      : body === undefined
        ? { credentials: 'same-origin' }
        : {
            method,
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
  );
  let value: unknown = null;
  try {
    value = await res.json();
  } catch {
    // No JSON: the status says it.
  }
  if (!res.ok) {
    const { error, problems } = (value ?? {}) as { error?: unknown; problems?: unknown };
    throw new ApiError(
      res.status,
      typeof error === 'string' ? error : `HTTP ${res.status}`,
      Array.isArray(problems) ? (problems as GraphProblem[]) : []
    );
  }
  return value as T;
}

/** A path segment, encoded. */
export const seg = (s: string): string => encodeURIComponent(s);
