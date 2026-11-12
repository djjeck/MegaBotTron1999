/**
 * The owner's control API over HTTP (docs/bot-os-api.md §4.11): the core's controls (`Controls`)
 * as JSON. One request handler (`controlHandler`), served twice by the instance's wiring: on the
 * container's loopback for `cli.ts` (`controlServer`; `docker exec … node src/cli.ts …`), which
 * nothing on the Docker network can reach, and under `/api/` by the web UI's server, only behind its
 * login (`@megabottron1999/web`). Nothing here knows of any plugin: the routes are the
 * controls', and each plugin's are its declared reads and actions.
 *
 * - `GET /status`: the instance (off or on) and each plugin: its state, mode, settings, reads,
 *   actions, and its own `status` read if it declares one; `graph.refused`, why the saved graph
 *   did not run, when it did not.
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
 * - `GET /graph/file`: the saved graph (`<data>/graph.json`, §2.3), whether it differs from the one
 *   running, and its problems if it is refused.
 * - `POST /graph/check` with a graph as the body: its problems, each located (node, edge, port,
 *   config or setting), and how it differs from the saved file; nothing is saved.
 * - `PUT /graph/file` with a graph as the body: checked, then saved, the file before kept as
 *   `graph.previous.json`; 400 with its problems when refused.
 * - `POST /graph/rollback`: the previous version back (409 when there is none).
 * - `GET /legacy`: what an older data directory mounted read-only offers to import (§8): its
 *   stores, and its event log's days; 404 when none is mounted.
 * - `GET /legacy/events`: its event log's types that are not namespaced, counted, each with the
 *   types registered here it may be renamed to.
 * - `POST /instances/import {"from": "<store>", "instance"?: "<id>", "plugin"?: "<id>"}`: a store
 *   of it copied into a fresh instance; 409 for an instance kept already.
 * - `POST /legacy/events/import {"types"?: {"old": "ns.new"}, "since"?: <ms>}`: its event log
 *   merged into this instance's.
 * - `POST /restart`: the instance stops, its state kept, and exits to be started again: how a
 *   saved graph, or a module installed, takes effect.
 * - `POST /plugins/<id>/mode {"mode": "live"}`, `POST /plugins/<id>/resume`.
 * - `POST /plugins/<id>/kill`: that node's kill (D44): its own safety stop, then paused as killed
 *   until its resume reinstates it.
 * - `GET /plugins/<id>/state/<name>`: a declared read.
 * - `POST /plugins/<id>/actions/<name>` with the action's input as the body: its output, a 400 for
 *   an input its schema refuses, a 409 when the plugin refuses, with why.
 *
 * - `GET /available`: the plugins the instance offers, the image's and the modules' (§7), each
 *   with its ports, schemas, interface, secrets and event types, for the editor.
 * - `GET /secrets`: the names of the Docker secrets provided, never their values (§4.9).
 * - `GET /instances`: the plugin instances kept, each with its plugin and whether a node uses it.
 * - `GET /modules`: the modules installed, with the version each had loaded, and those refused at
 *   the start with why.
 * - `POST /modules`: installs a module, from `{"dir": "/path/in/the/container"}`, from
 *   `{"tarball": "<base64 of a .tar.gz or .tar>"}`, from its files one by one
 *   (`{"files": [{"path": "module.json", "content": "<base64>"}, …]}`, as a folder picked in a
 *   browser gives them), or from the tarball itself as the body (`content-type: application/gzip`,
 *   `application/x-tar` or `application/octet-stream`); it is loaded at the next start. 400 with
 *   why for what is not a module.
 * - `POST /modules/<id>/rollback`: puts the previous version back (409 when there is none).
 *
 * Ids and names in a path may be URL-encoded.
 */
import http from 'node:http';
import { type Controls } from './controls.ts';
import { type AvailablePlugin } from './core.ts';
import { type LogEntry } from './event-log.ts';
import { type Graph } from './graph.ts';
import { type GraphFileControls, GraphFileError } from './graph-file.ts';
import { describeNodes } from './graph-view.ts';
import { type InstanceInfo } from './instance-registry.ts';
import { LegacyError } from './legacy.ts';
import { type ModuleFile, type ModuleSource } from './module-store.ts';
import { ModuleError } from './modules.ts';
import { PORT_TYPE_INFO } from './ports.ts';
import { type SettingsRegistry } from './settings.ts';

/** The largest module uploaded, in bytes (base64 in JSON is a third more). */
export const MAX_UPLOAD = 64 * 2 ** 20;

/** A request's body, refused past `max` bytes. */
async function bytes(req: http.IncomingMessage, max = MAX_UPLOAD): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new ModuleError(`the body is over ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function body(req: http.IncomingMessage, max?: number): Promise<unknown> {
  const text = (await bytes(req, max)).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

const TARBALL = /^application\/(?:gzip|x-gzip|x-tar|octet-stream)\b/iu;

/** A module's files uploaded one by one (`{"files": [{path, content}]}`), within `MAX_UPLOAD`. */
function moduleFiles(files: unknown[]): ModuleFile[] {
  let total = 0;
  return files.map((f) => {
    const p = field(f, 'path');
    const content = field(f, 'content');
    if (typeof p !== 'string' || typeof content !== 'string')
      throw new ModuleError('files: each is {"path": "…", "content": "<base64>"}');
    const bytes = Buffer.from(content, 'base64');
    total += bytes.length;
    if (total > MAX_UPLOAD) throw new ModuleError(`the files are over ${MAX_UPLOAD} bytes`);
    return { path: p, content: bytes };
  });
}

/** What `POST /modules` installs from. */
async function moduleSource(req: http.IncomingMessage): Promise<ModuleSource> {
  if (TARBALL.test(req.headers['content-type'] ?? '')) return { tarball: await bytes(req) };
  const b = await body(req, Math.ceil(MAX_UPLOAD * 1.4));
  const dir = field(b, 'dir');
  const tarball = field(b, 'tarball');
  const files = field(b, 'files');
  if (typeof dir === 'string') return { dir };
  if (typeof tarball === 'string') return { tarball: Buffer.from(tarball, 'base64') };
  if (Array.isArray(files)) return { files: moduleFiles(files) };
  throw new ModuleError('give a dir, a tarball in base64, files, or the tarball as the body');
}

/** The import from an older data directory (legacy.ts), as the wiring offers it. */
export interface LegacyControls {
  report(): unknown;
  eventTypes(): unknown;
  importStore(request: unknown): unknown;
  importEvents(request: unknown): unknown;
}

/** The owner's changes to the modules (module-store.ts), as the wiring offers them. */
export interface ModuleControls {
  report(): unknown;
  install(source: ModuleSource): unknown;
  rollback(id: string): unknown;
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
  /** The plugins the instance offers (`core.available()`). */
  available?: () => AvailablePlugin[];
  /** The modules: listed, installed, rolled back (§7). */
  modules?: ModuleControls;
  /** The names of the secrets provided (never their values), for a connector's config (§4.9). */
  secrets?: () => string[];
  /** The plugin instances kept, apart from the nodes (`core.instances()`, §2.2). */
  instances?: () => InstanceInfo[];
  /** The saved graph's file: read, checked, saved, rolled back (§2.3). */
  graphFile?: GraphFileControls;
  /** An older data directory's stores and event log, imported (§8). */
  legacy?: LegacyControls;
  /**
   * Applies the saved graph: the instance stops, its state kept, and exits for its supervisor
   * (Docker's `restart: unless-stopped`) to start it again. Called once the answer has gone.
   */
  restart?: () => void;
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
      const put = req.method === 'PUT';
      const gf = o.graphFile;
      if (!post && !put && route === '/status') {
        const refused = gf?.problems() ?? [];
        return reply(200, {
          ...controls.status(),
          ...(refused.length === 0 ? {} : { graph: { refused } }),
        });
      }
      if (gf !== undefined && route === '/graph/file' && (put || !post)) {
        if (!put) return reply(200, gf.file());
        try {
          return reply(200, gf.save(await body(req)));
        } catch (e) {
          if (e instanceof GraphFileError)
            return reply(400, { error: e.message, problems: e.problems });
          throw e;
        }
      }
      if (gf !== undefined && post && route === '/graph/check')
        return reply(200, gf.check(await body(req)));
      if (gf !== undefined && post && route === '/graph/rollback') {
        try {
          return reply(200, gf.rollback());
        } catch (e) {
          if (e instanceof GraphFileError) return reply(409, { error: e.message });
          throw e;
        }
      }
      const legacy = o.legacy;
      const imports: Record<string, ((b: unknown) => unknown) | undefined> = {
        'GET /legacy': legacy === undefined ? undefined : () => legacy.report(),
        'GET /legacy/events': legacy === undefined ? undefined : () => legacy.eventTypes(),
        'POST /instances/import': legacy === undefined ? undefined : (b) => legacy.importStore(b),
        'POST /legacy/events/import':
          legacy === undefined ? undefined : (b) => legacy.importEvents(b),
      };
      const run = imports[`${post ? 'POST' : (req.method ?? 'GET')} ${route}`];
      if (run !== undefined) {
        try {
          return reply(200, run(post ? await body(req) : undefined));
        } catch (e) {
          if (e instanceof LegacyError) return reply(e.status, { error: e.message });
          throw e;
        }
      }
      if (post && route === '/restart' && o.restart !== undefined) {
        const restart = o.restart;
        res.on('finish', () => restart());
        return reply(200, { restarting: true });
      }
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
      if (!post && route === '/available' && o.available !== undefined)
        return reply(200, o.available());
      if (!post && route === '/secrets' && o.secrets !== undefined)
        return reply(200, { names: o.secrets() });
      if (!post && route === '/instances' && o.instances !== undefined)
        return reply(200, o.instances());
      const mods = o.modules;
      if (mods !== undefined && route === '/modules') {
        if (!post) return reply(200, mods.report());
        try {
          return reply(200, mods.install(await moduleSource(req)));
        } catch (e) {
          if (e instanceof ModuleError) return reply(400, { error: e.message });
          throw e;
        }
      }
      const rollback = /^\/modules\/([^/]+)\/rollback$/u.exec(route);
      if (post && mods !== undefined && rollback !== null) {
        try {
          return reply(200, mods.rollback(decodeURIComponent(rollback[1] ?? '')));
        } catch (e) {
          if (e instanceof ModuleError) return reply(409, { error: e.message });
          throw e;
        }
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
