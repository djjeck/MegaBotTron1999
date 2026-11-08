/**
 * The image's entry point (the Dockerfile's CMD): the core, with the connectors registered, the
 * owner's control API and the web UI, and no game. Everything it calls is tested; this file is
 * wiring, left out of coverage.
 *
 * The connectors, the turn-actor and the reactor are registered, and so are the plugins of the modules installed under
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
  CoreEventLog,
  GraphFile,
  graphFileControls,
  KEY_SECRET,
  LEGACY_DIR,
  LegacyImport,
  loadModules,
  ModuleStore,
  type Plugin,
  Secrets,
  shutdown,
  StartError,
  wallClock,
} from '@megabottron1999/core';
import { reactorPlugin } from '@megabottron1999/turns/reactor.ts';
import { turnActorPlugin } from '@megabottron1999/turns/turn-actor.ts';
import { startWebUi } from '@megabottron1999/web/server/web-server.ts';
import http from 'node:http';
import path from 'node:path';
import { format } from 'node:util';

const env = process.env;
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
const graphFile = new GraphFile(dataDir);

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
];
core.register(...image);
// The modules (docs/bot-os-api.md §7): each one refused is named, with why, and the others load.
const modules = new ModuleStore(path.join(dataDir, 'modules'));
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
await core.start();

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
  secrets: () => secrets.names().filter((n) => n !== 'web_ui_password' && n !== KEY_SECRET),
  instances: () => core.instances(),
  graphFile: graphFileControls(graphFile, core, (v) => secrets.redactDeep(v)),
  restart: () => void end('restart'),
  // An older MegaBotTron1999 data directory, mounted read-only, to import from (§8).
  legacy: new LegacyImport({
    dir: env['LEGACY_DIR'] || LEGACY_DIR,
    dataDir,
    now: () => clock.now(),
    plugins: () => core.available().map((p) => p.id),
    eventTypes: () => core.available().flatMap((p) => p.events),
  }),
  modules: {
    report: () => modules.report(loaded),
    install: (source) => modules.install(source),
    rollback: (id) => modules.rollback(id),
  },
});
const control = http.createServer(controlApi).listen(port('CONTROL_PORT', 8081), '127.0.0.1');
// The web UI, on every interface for a reverse proxy, only with the owner's password (the
// `web_ui_password` secret, docs/bot-os.md D40): without it, no listener at all.
const web = startWebUi({
  secrets,
  api: controlApi,
  port: port('WEB_PORT', 8082),
  print: (line) => console.log(line),
});
console.log(`megabottron1999: started, ${core.nodes().length} plugin instance(s) in the graph`);

// The end, at a signal or the owner's restart: the core stops first, its plugins' state kept, then
// the process exits 0, for Docker's `restart: unless-stopped` to start it again after a restart.
const end = shutdown({
  stop: () => core.stop(),
  close: () => {
    control.close();
    web?.close();
  },
  exit: (code) => process.exit(code),
  clock,
  print: (line) => console.log(line),
});
process.on('SIGTERM', () => void end('SIGTERM'));
process.on('SIGINT', () => void end('SIGINT'));
