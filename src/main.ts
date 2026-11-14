/**
 * The image's entry point (the Dockerfile's CMD): the core, with the connectors registered, the
 * owner's control API and the web UI, and no game. Everything it calls is tested; this file is
 * wiring, left out of coverage.
 *
 * The connectors, the turn-actor, the reactor and the script node are registered, and so are the plugins of the modules installed under
 * `/data/modules/<id>/` (docs/bot-os.md D49, docs/bot-os-api.md §7), so the image offers them; the
 * graph is the saved one, `/data/graph.json` (D50, docs/bot-os-api.md §2.3), each node's state in
 * its instance under `/data/instances/`. No file: no node runs until the owner adds one. A file
 * refused: no node runs, and the owner is told why.
 */
import { anthropicPlugin } from '@megabottron1999/connectors/plugins/anthropic.ts';
import { ircPlugin } from '@megabottron1999/connectors/plugins/irc.ts';
import { telegramBotPlugin } from '@megabottron1999/connectors/plugins/telegram-bot.ts';
import { telegramUserPlugin } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  controlHandler,
  Core,
  CORE_STORE,
  CoreEventLog,
  GitHub,
  GitHubModules,
  GraphFile,
  graphFileControls,
  healthServer,
  KEY_SECRET,
  loadModules,
  moduleControls,
  ModuleStore,
  type Plugin,
  Secrets,
  shutdown,
  StartError,
  Stores,
  wallClock,
} from '@megabottron1999/core';
import { reactorPlugin } from '@megabottron1999/turns/reactor.ts';
import { scriptPlugin } from '@megabottron1999/turns/script-plugin.ts';
import { turnActorPlugin } from '@megabottron1999/turns/turn-actor.ts';
import { startWebUi } from '@megabottron1999/web/server/web-server.ts';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { format } from 'node:util';

const env = process.env;
// The release it runs (the root package.json's version) and the commit its image was built from
// (BUILD_COMMIT, the Dockerfile's build argument, set by the Publish workflow), for GET /instance
// and the web UI's bottom bar.
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
const events = new CoreEventLog(dataDir);
const clock = wallClock();
// The instance's composition, saved in the volume (D50): read at load, edited by the owner.
const graphFile = new GraphFile(dataDir, () => clock.now());

const core = new Core({
  clock,
  dataDir,
  secrets,
  graphFile,
  // What the plugins read back of the log: a replay of recent history, a fresh instance's first
  // reading of the whole log (ctx.events).
  events,
  print: (line) => console.log(line),
  record: (r) => events.write(secrets.redactDeep(r)),
});
// The connectors the image offers (docs/bot-os-api.md §5), each built from its node's config alone;
// a node gives each its own account.
// The turn-actor too, built from its config alone, as many nodes as there are bots (each on its own
// instance); its parsers are a game's, from the game's grammar, so they come from a module. And the
// reactor, one node per reaction, each from its config alone.
const image: Plugin[] = [
  ircPlugin(),
  telegramBotPlugin(),
  telegramUserPlugin(),
  anthropicPlugin(),
  turnActorPlugin(),
  reactorPlugin(),
  // Script nodes (docs/bot-os.md D76): the owner's code, each in a worker thread of its own.
  scriptPlugin(),
];
core.register(...image);
// The modules (docs/bot-os-api.md §7): each one refused is named, with why, and the others load.
const modules = new ModuleStore(path.join(dataDir, 'modules'), () => clock.now());
const loaded = await loadModules({
  dir: modules.dir,
  host: import.meta.url,
  reserved: image.map((p) => p.manifest.id),
});
for (const m of loaded.modules)
  console.log(
    `megabottron1999: module ${m.id} ${m.version}: ${m.plugins.join(', ') || 'no plugins'}`
  );
for (const f of loaded.failures)
  console.error(`megabottron1999: module ${f.id} refused: ${f.reason}`);
for (const m of loaded.modules)
  core.registerModule(
    m.id,
    loaded.plugins.filter((p) => p.module === m.id).map((p) => p.plugin)
  );
try {
  core.load();
} catch (e) {
  if (e instanceof StartError) {
    console.error(`megabottron1999: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
// The graph's history (D61): the file kept as a version if none holds it, marked as run or refused.
try {
  graphFile.started(core);
} catch (e) {
  console.error(`megabottron1999: the graph's history: ${String(e)}`);
}
await core.start();

// Modules from GitHub links, checked for updates at the start and every 6 hours; only the owner
// installs one (docs/bot-os.md D67). A token is optional: the `github_token` secret, or
// `GITHUB_TOKEN`, raises the API's limit of 60 requests an hour.
const GITHUB_TOKEN_SECRET = 'github_token';
const githubToken = secrets.read(GITHUB_TOKEN_SECRET) ?? (env['GITHUB_TOKEN'] || undefined);
if (githubToken !== undefined) secrets.remember(githubToken);
const githubModules = new GitHubModules(
  modules,
  new GitHub({
    ...(githubToken === undefined ? {} : { token: githubToken }),
    now: () => clock.now(),
  }),
  () => clock.now()
);
githubModules.start();

// The owner's control API (packages/core/src/control-server.ts): one handler, served on the
// container's loopback, and under `/api/` by the web UI, only behind its login.
const controlApi = controlHandler({
  controls: core.controls,
  settings: core.settings,
  graph: () => secrets.redactDeep(core.graph()),
  records: (from, to) => events.recordsSince(from, to),
  available: () => core.available(),
  // The names of the Docker secrets a connector's config may name, never their values; the UI's
  // password and the key of the stored secrets are the shell's own.
  secrets: () =>
    secrets
      .names()
      .filter((n) => n !== 'web_ui_password' && n !== KEY_SECRET && n !== GITHUB_TOKEN_SECRET),
  instances: () => core.instances(),
  graphFile: graphFileControls(graphFile, core, (v) => secrets.redactDeep(v)),
  restart: () => void end('restart'),
  build,
  // A module is removed only while no node of the saved graph uses its plugins (D68).
  modules: moduleControls(modules, loaded, githubModules, () => graphFile.nodes()),
});
const control = http.createServer(controlApi).listen(port('CONTROL_PORT', 8081), '127.0.0.1');
// The shell's health endpoint, for a container's healthcheck (GET /health: 200 while every enabled
// connector is connected, 503 otherwise), on HEALTH_PORT, every interface; off unless it is set
// (the image sets 8080).
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
console.log(
  `megabottron1999 ${build.version}${build.commit === undefined ? '' : ` (${build.commit.slice(0, 7)})`}: ` +
    `started, ${core.nodes().length} plugin instance(s) in the graph`
);

// The end, at a signal or the owner's restart: the core stops first, its plugins' state kept, then
// the process exits 0, for Docker's `restart: unless-stopped` to start it again after a restart.
const end = shutdown({
  stop: () => core.stop(),
  close: () => {
    githubModules.stop();
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
