/**
 * The image's entry point (the Dockerfile's CMD): the core, with the connectors registered, the
 * owner's control API and the web UI, and no game. Everything it calls is tested; this file is
 * wiring, left out of coverage.
 *
 * It serves first (docs/bot-os.md D143): the control API, the health endpoint and the web UI are up
 * before any plugin package, module or connector is loaded, so that the owner always reaches the
 * UI, whatever a plugin does. Then, in the background (`bootstrap`), each of the image's plugin
 * packages is imported on its own (the connectors, attention and the player, the reactor, the
 * script node and owner-notice), then the modules installed under `/data/modules/<id>/` (D49,
 * docs/bot-os-api.md §7); one that fails to load is named, with why, and only the nodes of its
 * plugins are held. The graph is the saved one, `/data/graph.json` (D50, docs/bot-os-api.md §2.3),
 * each node's state in its instance under `/data/instances/`. No file: no node runs until the owner
 * adds one. A file refused: no node runs, and a `graph-refused` notice says why, in the editor's
 * events panel. An error nothing caught is told, and the process goes on (`guard`).
 */
import {
  bootstrap,
  controlHandler,
  Core,
  CORE_STORE,
  CoreEventLog,
  GitHostList,
  GitHub,
  GitModules,
  GraphFile,
  graphFileControls,
  guard,
  healthServer,
  KEY_SECRET,
  loadModules,
  moduleControls,
  type ModulesLoad,
  ModuleStore,
  type PackageSpec,
  Secrets,
  shutdown,
  Stores,
  wallClock,
} from '@megabottron1999/core';
import { startWebUi } from '@megabottron1999/web/server/web-server.ts';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { format } from 'node:util';

const env = process.env;
// The release it runs (the root package.json's version) and the commit its image was built from
// (BUILD_COMMIT, the Dockerfile's build argument, set by the Publish workflow), for GET /instance
// and the web UI's bottom bar, and the owner's start notice.
const build = {
  version: (
    JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version,
  ...(env['BUILD_COMMIT'] ? { commit: env['BUILD_COMMIT'] } : {}),
};
const dataDir = env['LOG_DIR'] || '/data';
const port = (name: string, fallback: number): number => {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : fallback;
};

// The Docker secrets (packages/core/src/secrets.ts): read by the core for the connectors that
// declare them, and taken out of everything printed and logged.
const secrets = new Secrets(env['SECRETS_DIR'] || '/run/secrets');
for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  const print = console[method].bind(console);
  console[method] = (...args: unknown[]) => print(secrets.redact(format(...args)));
}
// How much a plugin instance's files may take (ctx.store.files, docs/bot-os.md D149), in MB: a file
// (FILE_MAX_MB) and all of an instance's (FILES_MAX_MB); the core's defaults, 16 and 256, unless set.
const megabytes = (name: string): number | undefined => {
  const n = Number(env[name]);
  return env[name] && Number.isFinite(n) && n > 0 ? Math.round(n * 2 ** 20) : undefined;
};
const fileMax = megabytes('FILE_MAX_MB');
const filesMax = megabytes('FILES_MAX_MB');
const events = new CoreEventLog(dataDir);
const clock = wallClock();
// The instance's composition, saved in the volume (D50): read at load, edited by the owner.
const graphFile = new GraphFile(dataDir, () => clock.now());

const core = new Core({
  clock,
  // The release and commit, for the owner's start notice (owner-notice, docs/bot-os.md D92).
  build,
  dataDir,
  fileLimits: {
    ...(fileMax === undefined ? {} : { file: fileMax }),
    ...(filesMax === undefined ? {} : { total: filesMax }),
  },
  secrets,
  graphFile,
  // What the plugins read back of the log: a replay of recent history, a fresh instance's first
  // reading of the whole log (ctx.events).
  events,
  print: (line) => console.log(line),
  record: (r) => events.write(secrets.redactDeep(r)),
});
// The plugin packages the image offers, each imported on its own in the background (D143): one that
// fails to load holds only the nodes of its plugins. The connectors (docs/bot-os-api.md §5), each
// built from its node's config alone; a node gives each its own account. Attention too, one node
// per person, and the player, as many nodes as there are bots (each on its own instance), each
// built from its config alone (docs/bot-os.md D134); the players' parsers are a game's, from the
// game's grammar, so they come from a module. And the reactor, one node per reaction, each from
// its config alone.
const packages: PackageSpec[] = [
  {
    name: '@megabottron1999/connectors/plugins/irc.ts',
    load: async () => [(await import('@megabottron1999/connectors/plugins/irc.ts')).ircPlugin()],
  },
  {
    name: '@megabottron1999/connectors/plugins/telegram-bot.ts',
    load: async () => [
      (await import('@megabottron1999/connectors/plugins/telegram-bot.ts')).telegramBotPlugin(),
    ],
  },
  {
    name: '@megabottron1999/connectors/plugins/telegram-user.ts',
    load: async () => [
      (await import('@megabottron1999/connectors/plugins/telegram-user.ts')).telegramUserPlugin(),
    ],
  },
  {
    name: '@megabottron1999/connectors/plugins/anthropic.ts',
    load: async () => [
      (await import('@megabottron1999/connectors/plugins/anthropic.ts')).anthropicPlugin(),
    ],
  },
  {
    name: '@megabottron1999/turns/attention.ts',
    load: async () => [(await import('@megabottron1999/turns/attention.ts')).attentionPlugin()],
  },
  {
    name: '@megabottron1999/turns/player.ts',
    load: async () => [(await import('@megabottron1999/turns/player.ts')).playerPlugin()],
  },
  {
    name: '@megabottron1999/turns/reactor.ts',
    load: async () => [(await import('@megabottron1999/turns/reactor.ts')).reactorPlugin()],
  },
  // Script nodes (docs/bot-os.md D76): the owner's code, each in a worker thread of its own.
  {
    name: '@megabottron1999/turns/script-plugin.ts',
    load: async () => [(await import('@megabottron1999/turns/script-plugin.ts')).scriptPlugin()],
  },
  // What needs the owner's attention, told through a connector (docs/bot-os.md D91).
  {
    name: '@megabottron1999/turns/owner-notice.ts',
    load: async () => [
      (await import('@megabottron1999/turns/owner-notice.ts')).ownerNoticePlugin(),
    ],
  },
];
// The modules (docs/bot-os-api.md §7): each one refused is named, with why, and the others load.
const modules = new ModuleStore(path.join(dataDir, 'modules'), () => clock.now());
/** The modules loaded, once the background start has (D143). */
let loaded: ModulesLoad | undefined;
// An error nothing caught is told, naming the module or package its stack names, and the process
// goes on (D143).
guard(core, process, () => loaded?.modules ?? []);

// Modules from repository links, checked for updates at the start and every 6 hours; only the
// owner installs one (docs/bot-os.md D67, D102). GitHub is always allowed; a GitHub token is
// optional: the `github_token` secret, or `GITHUB_TOKEN`, raises the API's limit of 60 requests an
// hour. The self-hosted Git servers are those the owner adds on the Modules page, each with the
// Docker secret of its token (kept in the core's store as names, never values).
const GITHUB_TOKEN_SECRET = 'github_token';
const githubToken = secrets.read(GITHUB_TOKEN_SECRET) ?? (env['GITHUB_TOKEN'] || undefined);
if (githubToken !== undefined) secrets.remember(githubToken);
/** The Docker secrets that are the shell's own: never a connector's, nor a Git server's token. */
const shellSecrets = new Set(['web_ui_password', KEY_SECRET, GITHUB_TOKEN_SECRET]);
const gitHosts = new GitHostList({
  store: new Stores(dataDir).open(CORE_STORE),
  github: new GitHub({
    ...(githubToken === undefined ? {} : { token: githubToken }),
    now: () => clock.now(),
  }),
  read: (name) => secrets.read(name),
  names: () => secrets.names().filter((n) => !shellSecrets.has(n)),
});
const gitModules = new GitModules(modules, gitHosts.get, () => clock.now());

// The owner's control API (packages/core/src/control-server.ts): one handler, served on the
// container's loopback, and under `/api/` by the web UI, only behind its login.
const controlApi = controlHandler({
  controls: core.controls,
  settings: core.settings,
  // Its sensitive config values hidden (D124), its secrets redacted.
  graph: () => secrets.redactDeep(core.hideSensitive(core.graph())),
  records: (from, to) => events.recordsSince(from, to),
  available: () => core.available(),
  // The names of the Docker secrets a connector's config may name, never their values; the UI's
  // password and the key of the stored secrets are the shell's own.
  // A Git server's token, named on the Modules page, is not a connector's either.
  secrets: () => {
    const servers = new Set(gitHosts.secrets());
    return secrets.names().filter((n) => !shellSecrets.has(n) && !servers.has(n));
  },
  instances: () => core.instances(),
  graphFile: graphFileControls(graphFile, core, (v) => secrets.redactDeep(v)),
  restart: () => void end('restart'),
  build,
  // A module is removed only while no node of the saved graph uses its plugins (D68).
  modules: moduleControls(
    modules,
    () => loaded,
    gitModules,
    () => graphFile.nodes(),
    gitHosts
  ),
});
const control = http.createServer(controlApi).listen(port('CONTROL_PORT', 8081), '127.0.0.1');
// The shell's health endpoint, for a container's healthcheck (GET /health: 200 as soon as it
// serves, D143; where the start is and each connector's status as detail), on HEALTH_PORT, every
// interface; off unless it is set (the image sets 8080).
const healthPort = port('HEALTH_PORT', 0);
const healthy =
  healthPort === 0 ? undefined : healthServer(core.controls).listen(healthPort, '0.0.0.0');
if (healthy !== undefined) console.log(`health: on port ${healthPort}`);
// The web UI, on every interface for a reverse proxy, only with the owner's password (the
// `web_ui_password` secret, docs/bot-os.md D40): without it, no listener at all.
const web = startWebUi({
  secrets,
  api: controlApi,
  // The sessions, kept across restarts in the core's own store (`<data>/core/web-sessions.json`).
  store: new Stores(dataDir).open(CORE_STORE),
  now: () => clock.now(),
  port: port('WEB_PORT', 8082),
  print: (line) => console.log(line),
});
const release = `megabottron1999 ${build.version}${build.commit === undefined ? '' : ` (${build.commit.slice(0, 7)})`}`;
console.log(`${release}: serving; loading the plugins`);

// The plugins, then the nodes, in the background (D143): each package and module on its own.
void bootstrap({
  core,
  packages,
  modules: async (reserved) =>
    (loaded = await loadModules({ dir: modules.dir, host: import.meta.url, reserved })),
  // The graph's history (D61): the file kept as a version if none holds it, marked as run or
  // refused.
  loaded: () => graphFile.started(core),
  print: (line) => console.log(line),
}).then((b) => {
  console.log(
    `${release}: started, ${core.nodes().length} plugin instance(s) in the graph` +
      (b.failures.length === 0 ? '' : `, ${b.failures.length} failed to load`)
  );
  // Modules from repository links, checked for updates from now on (D67, D102).
  gitModules.start();
});

// The end, at a signal or the owner's restart: the core stops first, its plugins' state kept, then
// the process exits 0, for Docker's `restart: unless-stopped` to start it again after a restart.
const end = shutdown({
  stop: (why) => core.stop(why),
  close: () => {
    gitModules.stop();
    control.close();
    healthy?.close();
    web?.close();
  },
  exit: (code) => process.exit(code),
  clock,
  print: (line) => console.log(line),
});
process.on('SIGTERM', () => void end('SIGTERM'));
process.on('SIGINT', () => void end('SIGINT'));
