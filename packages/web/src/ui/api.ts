/**
 * The UI's way to the instance: the core's control API under `/api/` (docs/bot-os-api.md §4.11),
 * as the UI's server serves it behind the login. The shapes are the core's own types, so that the
 * pages show what the plugins declare and nothing else (P11).
 */
import type {
  AccountControl,
  AvailablePlugin,
  DriftCounts,
  Graph,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphProblem,
  InstanceInfo,
  JsonSchema,
  LegacyEventTypes,
  LegacyReport,
  LogEntry,
  MemberView,
  Mode,
  ModulesReport,
  NodeView,
  PluginControl,
  PluginView,
  PortType,
  PortTypeInfo,
  PortView,
} from '@megabottron1999/core';

export type {
  AccountControl,
  AvailablePlugin,
  DriftCounts,
  Graph,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphProblem,
  InstanceInfo,
  JsonSchema,
  LegacyEventTypes,
  LegacyReport,
  LogEntry,
  MemberView,
  Mode,
  ModulesReport,
  NodeView,
  PluginControl,
  PluginView,
  PortType,
  PortTypeInfo,
  PortView,
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
  /** Whether a restart would change what runs. */
  differs: boolean;
}

/** A graph checked, as `POST /graph/check` gives it: its problems, and its diff from the saved file. */
export interface GraphCheckView {
  ok: boolean;
  problems: GraphProblem[];
  diff: GraphDiff;
}

/** A refusal of the API: its status and why. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Calls the API: a GET, or a POST (a PUT with `method`) of `body` as JSON. Throws an `ApiError` for
 * a refusal.
 */
export async function api<T>(
  route: string,
  body?: unknown,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  const res = await fetch(
    `api${route}`,
    body === undefined
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
    const error = (value as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`);
  }
  return value as T;
}

/** A path segment, encoded. */
export const seg = (s: string): string => encodeURIComponent(s);
