/**
 * The owner's control API over HTTP (docs/bot-os-api.md §4.11): the core's controls (`Controls`)
 * as JSON. One request handler (`controlHandler`), served twice by the instance's wiring: on the
 * container's loopback for `cli.ts` (`controlServer`; `docker exec … node src/cli.ts …`), which
 * nothing on the Docker network can reach, and under `/api/` by the web UI's server, only behind its
 * login (`@megabottron1999/web`). Nothing here knows of any plugin: the routes are the
 * controls', and each plugin's are its declared reads and actions.
 *
 * - `GET /status`: the instance (off or on) and each plugin: its state, mode, settings, reads,
 *   actions, and its own `status` read if it declares one.
 * - `GET /instance`: the instance's health: off or on, the process's uptime, Node's version and
 *   memory, the plugins and the accounts counted by state.
 * - `GET /accounts`: each connector instance, its account and its connection's status.
 * - `GET /drift`: each parser's counts of what it read and could not read (§4.7).
 * - `GET /events?limit=100&type=core.&hours=24`: the event log's latest records, newest first,
 *   those whose type starts with `type` (when the wiring gives the log).
 * - `POST /off`, `POST /on`: the off switch; `POST /kill`: the kill switch.
 * - `GET /settings`, `POST /settings {"key": "verbose", "value": true}`: every setting, as in force.
 * - `GET /graph`: the graph the instance runs (§2.1), every edge written out.
 * - `GET /graph/view`: what the web UI's graph view draws: the graph, the port types' looks,
 *   and each node's ports, interface and the JSON Schemas of its config and settings.
 * - `POST /plugins/<id>/mode {"mode": "live"}`, `POST /plugins/<id>/resume`.
 * - `POST /plugins/<id>/kill`: that node's kill (D44): its own safety stop, then paused as killed
 *   until its resume reinstates it.
 * - `GET /plugins/<id>/state/<name>`: a declared read.
 * - `POST /plugins/<id>/actions/<name>` with the action's input as the body: its output, a 400 for
 *   an input its schema refuses, a 409 when the plugin refuses, with why.
 *
 * Ids and names in a path may be URL-encoded.
 */
import http from 'node:http';
import { type Controls } from './controls.ts';
import { type LogEntry } from './event-log.ts';
import { type Graph } from './graph.ts';
import { describeNodes } from './graph-view.ts';
import { PORT_TYPE_INFO } from './ports.ts';
import { type SettingsRegistry } from './settings.ts';

async function body(req: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

const field = (v: unknown, key: string): unknown =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined;

export interface ControlOptions {
  controls: Controls;
  settings: SettingsRegistry;
  /** The graph the instance runs (`core.graph()`), its secrets redacted. */
  graph?: () => Graph | undefined;
  /** The event log's records from `from` to `to`, in time order (`EventLog.recordsSince`). */
  records?: (from: number, to: number) => LogEntry[];
  /** The time now, for the event log's span. */
  now?: () => number;
}

const HOUR = 3_600_000;

/** A whole number from the query, within bounds, else the default. */
function bounded(v: string | null, fallback: number, max: number): number {
  const n = v === null ? Number.NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** How many of `states` are in each state. */
function byState(states: { state: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { state } of states) out[state] = (out[state] ?? 0) + 1;
  return out;
}

/** The control API as a request handler, for any server. */
export function controlHandler(
  o: ControlOptions
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { controls, settings } = o;
  return (req, res) => {
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(`${JSON.stringify(value)}\n`);
    };
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://control');
      const route = url.pathname;
      const post = req.method === 'POST';
      if (!post && route === '/status') return reply(200, controls.status());
      if (!post && route === '/instance') {
        const { off, plugins } = controls.status();
        const memory = process.memoryUsage();
        return reply(200, {
          off,
          uptimeS: Math.round(process.uptime()),
          node: process.version,
          memoryMb: {
            rss: Math.round(memory.rss / 2 ** 20),
            heap: Math.round(memory.heapUsed / 2 ** 20),
          },
          plugins: byState(plugins),
          accounts: byState(
            controls.accounts().map((a) => ({ state: a.connection?.state ?? a.state }))
          ),
        });
      }
      if (!post && route === '/accounts') return reply(200, controls.accounts());
      if (!post && route === '/drift') return reply(200, controls.drift());
      if (!post && route === '/events' && o.records !== undefined) {
        const limit = bounded(url.searchParams.get('limit'), 100, 1000);
        const hours = bounded(url.searchParams.get('hours'), 24, 24 * 7);
        const type = url.searchParams.get('type') ?? '';
        const now = (o.now ?? Date.now)();
        const records = o.records(now - hours * HOUR, now).filter((r) => r.type.startsWith(type));
        return reply(200, records.slice(-limit).reverse());
      }
      if (!post && route === '/graph' && o.graph !== undefined)
        return reply(200, o.graph() ?? null);
      if (!post && route === '/graph/view' && o.graph !== undefined) {
        const graph = o.graph();
        if (graph === undefined) return reply(200, null);
        return reply(200, {
          graph,
          portTypes: PORT_TYPE_INFO,
          nodes: describeNodes(controls.nodes(), graph),
        });
      }
      if (post && route === '/off') return reply(200, { off: true, result: controls.turnOff() });
      if (post && route === '/on') return reply(200, { off: false, result: controls.turnOn() });
      if (post && route === '/kill') return reply(200, { result: controls.kill().text });
      if (route === '/settings') {
        if (post) {
          const b = await body(req);
          const refused = settings.set(String(field(b, 'key')), field(b, 'value'));
          if (refused !== undefined) return reply(400, { error: refused });
        }
        return reply(200, settings.current());
      }
      const m = /^\/plugins\/([^/]+)\/(mode|resume|kill|state|actions)(?:\/([^/]+))?$/u.exec(route);
      if (m !== null) {
        const [, rawId = '', what, rawName] = m;
        const id = decodeURIComponent(rawId);
        const name = rawName === undefined ? undefined : decodeURIComponent(rawName);
        if (post && what === 'mode' && name === undefined) {
          const mode = field(await body(req), 'mode');
          const refused = controls.setMode(id, mode);
          return refused === undefined ? reply(200, { mode }) : reply(409, { error: refused });
        }
        if (post && what === 'resume' && name === undefined) {
          const refused = controls.resume(id);
          return refused === undefined
            ? reply(200, { resumed: id })
            : reply(409, { error: refused });
        }
        if (post && what === 'kill' && name === undefined) {
          const r = controls.killNode(id);
          return 'result' in r ? reply(200, r) : reply(409, r);
        }
        if (!post && what === 'state' && name !== undefined) {
          const r = controls.read(id, name);
          return 'error' in r ? reply(404, r) : reply(200, r.value);
        }
        if (post && what === 'actions' && name !== undefined) {
          const r = await controls.act(id, name, await body(req));
          if ('output' in r) return reply(200, r.output ?? null);
          return reply(r.refused === true ? 409 : 400, { error: r.error });
        }
      }
      reply(404, { error: 'not found' });
    };
    handle().catch((err: unknown) => reply(400, { error: String(err) }));
  };
}

/** The control API on a server of its own: the wiring's, on the loopback, for `cli.ts`. */
export function controlServer(o: ControlOptions): http.Server {
  return http.createServer(controlHandler(o));
}
