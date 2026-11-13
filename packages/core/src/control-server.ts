/**
 * The owner's control API over HTTP (docs/bot-os-api.md §4.11): the core's controls (`Controls`)
 * as JSON. One request handler (`controlHandler`), served twice by the instance's wiring: on the
 * container's loopback for `cli.ts` (`controlServer`; `docker exec … node src/cli.ts …`), which
 * nothing on the Docker network can reach, and under `/api/` by the web UI's server, only behind its
 * login (`@megabottron1999/web`). Nothing here knows of any plugin: the routes are the
 * controls', and each plugin's are its declared reads and actions.
 *
 * - `GET /status`: the instance (off or on) and each plugin: its state (bot-os.md D64: running,
 *   disabled, stopped with its stop, inactive with the node it needs, failed), settings, reads,
 *   actions, and its own `status` read if it declares one; `graph.refused`, why the saved graph
 *   did not run, when it did not.
 * - `GET /instance`: the instance's health: off or on, the process's uptime, Node's version and
 *   memory, the plugins and the accounts counted by state.
 * - `GET /accounts`: each connector instance, its account and its connection's status.
 * - `GET /accounts/<id>/surfaces?search=&limit=50`: the chats a connector can see, latest first
 *   (bot-os.md D63): `running` false until it runs, `listed` false if it cannot list them; 409
 *   with why when it cannot tell now (not connected).
 * - `GET /drift`: each parser's counts of what it read and could not read (§4.7).
 * - `GET /events?limit=100&type=core.&hours=24`: the event log's latest records, newest first,
 *   those whose type starts with `type` (when the wiring gives the log).
 * - `POST /off`, `POST /on`: the off switch; `POST /kill`: the kill switch.
 * - `GET /settings`, `POST /settings {"key": "verbose", "value": true}`: every setting, as in force.
 * - `GET /graph`: the graph the instance runs (§2.1), every edge written out.
 * - `GET /graph/view`: what the web UI's graph view draws: the graph, the port types' looks,
 *   and each node's ports, interface and the JSON Schemas of its config and settings.
 * - `GET /graph/file`: the saved graph (`<data>/graph.json`, §2.3) and its text, whether it
 *   differs from the one running, and its problems if it is refused.
 * - `POST /graph/check` with a graph as the body: its problems, each located (node, edge, port,
 *   config or setting), its text, and how it differs from the saved file; nothing is saved.
 * - `PUT /graph/file` with a graph as the body: checked, then saved, and kept as a version of the
 *   history; 400 with its problems when refused.
 * - `GET /graph/history`: the history's versions, newest first, each with its time, its summary
 *   and how the instance started on it; which one is current, and the last one that ran.
 * - `GET /graph/history/<id>`: one version: its graph and text, and the diff from the current
 *   graph to it, structured and line by line; 404 for none.
 * - `POST /graph/history/<id>/rollback`: that version written as the current graph, kept as a new
 *   version that names it (404 for none, 409 when it is the current graph already).
 * - `POST /graph/rollback`: the version before the current one back, as above (409 when none).
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
 * - `POST /plugins/<id>/kill`: that node's kill (D44): its own safety stop, then stopped (D64),
 *   kept in its instance until the owner clears it.
 * - `POST /plugins/<id>/clear-stop`: that node's stop cleared, for the next start (the editor's
 *   Clear stop, which Apply sends before its restart); 409 when it is not stopped.
 * - `GET /plugins/<id>/state/<name>?<field>=<value>`: a declared read, its input the query's fields.
 * - `GET /plugins/<id>/queue`: what waits in a connector's queue (D73), with each send's nodes and
 *   their cancel conditions; 404 for a node that is not a connector.
 * - `GET /plugins/<id>/view`: the state a node keeps, with its schema, for the viewer (D72); 404
 *   for a node that keeps none, 409 for one not running.
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
 *   `{"github": {"repo", "ref", "refType"?, "path", "commit"?}}` installs one module of a GitHub
 *   repository at a commit (bot-os.md D67). A folder's or a tarball's may name it (`"name"`), as
 *   its source.
 * - `POST /modules/plan` with a tree's listing (`{"paths": [...], "manifests": {"<path>": "<text>"}}`,
 *   as a folder picked gives it): the modules in it, each with its status against the one installed
 *   and the files it would install and leave out.
 * - `POST /modules/github {"url": "https://github.com/<owner>/<repo>[/tree/<ref>[/<path>]]"}`: the
 *   link resolved to a commit, and the modules found in the repository's tarball there, as above.
 * - `POST /modules/updates`: checks the GitHub sources for newer commits now, and answers the list.
 * - `POST /modules/<id>/rollback`: puts the previous version back (409 when there is none).
 * - `DELETE /modules/<id>`: removes a module, kept as its previous version for a rollback to
 *   restore (bot-os.md D68); 409 with why while the saved graph's nodes use its plugins or another
 *   module imports it, 404 for a module not installed. It takes effect at the next start.
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
import { type TreeListing } from './module-files.ts';
import { GitHubError, type GitHubPick } from './module-github.ts';
import { type ModuleFile, ModuleInUse, type ModuleSource } from './module-store.ts';
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

/** What `POST /modules` installs from: a module's source, or a module of a GitHub repository. */
export type ModuleRequest = ModuleSource | { github: GitHubPick };

/** A GitHub source's module, as `{"github": {…}}` names it. */
function githubPick(g: unknown): GitHubPick {
  const text = (key: string): string | undefined => {
    const v = field(g, key);
    return typeof v === 'string' ? v : undefined;
  };
  const refType = text('refType');
  const repo = text('repo');
  const ref = text('ref');
  const commit = text('commit');
  const commitDate = text('commitDate');
  if (repo === undefined || ref === undefined)
    throw new ModuleError('github: {"repo": "<owner>/<repo>", "ref", "path", "commit"?}');
  return {
    repo,
    ref,
    path: text('path') ?? '',
    ...(refType === 'branch' || refType === 'tag' || refType === 'commit' ? { refType } : {}),
    ...(commit === undefined ? {} : { commit }),
    ...(commitDate === undefined ? {} : { commitDate }),
  };
}

async function moduleSource(req: http.IncomingMessage): Promise<ModuleRequest> {
  if (TARBALL.test(req.headers['content-type'] ?? '')) return { tarball: await bytes(req) };
  const b = await body(req, Math.ceil(MAX_UPLOAD * 1.4));
  const dir = field(b, 'dir');
  const tarball = field(b, 'tarball');
  const files = field(b, 'files');
  const github = field(b, 'github');
  const name = field(b, 'name');
  const named = typeof name === 'string' && name !== '' ? { name } : {};
  if (typeof dir === 'string') return { dir };
  if (typeof tarball === 'string') return { tarball: Buffer.from(tarball, 'base64'), ...named };
  if (Array.isArray(files)) return { files: moduleFiles(files), ...named };
  if (typeof github === 'object' && github !== null) return { github: githubPick(github) };
  throw new ModuleError(
    'give a dir, a tarball in base64, files, a github module, or the tarball as the body'
  );
}

/** A tree's listing, as `POST /modules/plan` takes it. */
function treeListing(b: unknown): TreeListing {
  const paths = field(b, 'paths');
  const manifests = field(b, 'manifests');
  if (
    !Array.isArray(paths) ||
    !paths.every((p) => typeof p === 'string') ||
    typeof manifests !== 'object' ||
    manifests === null ||
    !Object.values(manifests).every((t) => typeof t === 'string')
  )
    throw new ModuleError('give {"paths": ["…"], "manifests": {"<path>": "<text>"}}');
  return { paths: paths as string[], manifests: manifests as Record<string, string> };
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
  /** Installs one module; a GitHub one only when the wiring offers `lookup`. */
  install(source: ModuleRequest): unknown;
  rollback(id: string): unknown;
  /** Removes a module; refused (`ModuleInUse`) while it is used, with why. */
  remove?(id: string): unknown;
  /** The modules in a tree's listing (module-files.ts). */
  plan?(listing: TreeListing): unknown;
  /** A GitHub link's modules (module-github.ts). */
  lookup?(url: string): Promise<unknown>;
  /** Checks the GitHub sources for updates now, and answers the list. */
  checkUpdates?(): Promise<unknown>;
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
      const history = /^\/graph\/history(?:\/([^/]+)(\/rollback)?)?$/u.exec(route);
      if (gf !== undefined && (route === '/graph/rollback' ? post : history !== null)) {
        const id = history?.[1] === undefined ? undefined : decodeURIComponent(history[1]);
        const rollingBack = history?.[2] !== undefined;
        try {
          if (route === '/graph/rollback') return reply(200, gf.rollback());
          if (id === undefined && !post) return reply(200, gf.history());
          if (id !== undefined && !post && !rollingBack) return reply(200, gf.version(id));
          if (id !== undefined && post && rollingBack) return reply(200, gf.rollbackTo(id));
        } catch (e) {
          if (e instanceof GraphFileError) return reply(e.status ?? 409, { error: e.message });
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
      const surfaces = /^\/accounts\/([^/]+)\/surfaces$/u.exec(route);
      if (!post && surfaces !== null) {
        const search = url.searchParams.get('search');
        const query = {
          ...(search === null ? {} : { search }),
          limit: bounded(url.searchParams.get('limit'), 50, 500),
        };
        let view: unknown;
        try {
          view = await controls.surfaces(decodeURIComponent(surfaces[1] ?? ''), query);
        } catch (e) {
          return reply(409, { error: e instanceof Error ? e.message : String(e) });
        }
        return view === undefined ? reply(404, { error: 'no such connector' }) : reply(200, view);
      }
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
      const moduleRoutes: Record<string, (() => Promise<unknown>) | undefined> = {
        'POST /modules': async () => mods?.install(await moduleSource(req)),
        'POST /modules/plan':
          mods?.plan === undefined
            ? undefined
            : async () => mods.plan?.(treeListing(await body(req))),
        'POST /modules/github':
          mods?.lookup === undefined
            ? undefined
            : async () => {
                const url = field(await body(req), 'url');
                if (typeof url !== 'string')
                  throw new ModuleError('give {"url": "<a GitHub link>"}');
                return mods.lookup?.(url);
              },
        'POST /modules/updates':
          mods?.checkUpdates === undefined
            ? undefined
            : () => mods.checkUpdates?.() as Promise<unknown>,
      };
      const moduleRoute = post ? moduleRoutes[`POST ${route}`] : undefined;
      if (mods !== undefined && route === '/modules' && !post) return reply(200, mods.report());
      if (mods !== undefined && moduleRoute !== undefined) {
        try {
          return reply(200, await moduleRoute());
        } catch (e) {
          if (e instanceof GitHubError) return reply(e.status, { error: e.message });
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
      const removing = /^\/modules\/([^/]+)$/u.exec(route);
      if (req.method === 'DELETE' && mods?.remove !== undefined && removing !== null) {
        try {
          return reply(200, mods.remove(decodeURIComponent(removing[1] ?? '')));
        } catch (e) {
          if (e instanceof ModuleInUse) return reply(409, { error: e.message });
          if (e instanceof ModuleError) return reply(404, { error: e.message });
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
      const m =
        /^\/plugins\/([^/]+)\/(clear-stop|kill|state|actions|view|queue)(?:\/([^/]+))?$/u.exec(
          route
        );
      if (m !== null) {
        const [, rawId = '', what, rawName] = m;
        const id = decodeURIComponent(rawId);
        const name = rawName === undefined ? undefined : decodeURIComponent(rawName);
        if (post && what === 'clear-stop' && name === undefined) {
          const refused = controls.clearStop(id);
          return refused === undefined
            ? reply(200, { cleared: id })
            : reply(409, { error: refused });
        }
        if (post && what === 'kill' && name === undefined) {
          const r = controls.killNode(id);
          return 'result' in r ? reply(200, r) : reply(409, r);
        }
        if (!post && what === 'state' && name !== undefined) {
          // A read's input is its query's parameters, each a text (`?path=inventory.items`).
          const input = Object.fromEntries(url.searchParams);
          const r = controls.read(id, name, input);
          return 'error' in r ? reply(404, r) : reply(200, r.value);
        }
        if (!post && what === 'queue' && name === undefined) {
          const r = controls.queue(id);
          return r === undefined ? reply(404, { error: `${id} is no connector` }) : reply(200, r);
        }
        if (!post && what === 'view' && name === undefined) {
          const r = controls.view(id);
          if (r === undefined) return reply(404, { error: `${id} keeps no state to view` });
          return 'error' in r ? reply(409, r) : reply(200, r.value);
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
