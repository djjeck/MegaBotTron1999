/**
 * The image's entry point (the Dockerfile's CMD): the core, with the connectors registered, the
 * owner's control API and the web UI, and no game. Everything it calls is tested; this file is
 * wiring, left out of coverage.
 *
 * The connectors are registered, and so are the plugins of the modules installed under
 * `/data/modules/<id>/` (docs/bot-os.md D49, docs/bot-os-api.md §7), so the image offers them, but
 * the graph is empty: no plugin instance runs until the owner adds one (docs/bot-os.md D50).
 *
 * TODO(graph): the next step reads the graph from `/data/graph.json` (D50), which today's empty
 * graph stands in for, with the plugins' kept state belonging to instances apart from the nodes.
 */
import { anthropicPlugin } from '@megabottron1999/connectors/plugins/anthropic.ts';
import { ircPlugin } from '@megabottron1999/connectors/plugins/irc.ts';
import { telegramBotPlugin } from '@megabottron1999/connectors/plugins/telegram-bot.ts';
import { telegramUserPlugin } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  controlHandler,
  Core,
  CoreEventLog,
  loadModules,
  ModuleStore,
  type Plugin,
  Secrets,
  StartError,
  wallClock,
} from '@megabottron1999/core';
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

const core = new Core({
  clock: wallClock(),
  dataDir,
  secrets,
  // TODO(graph): the graph from /data/graph.json (D50); until then, an empty one.
  graph: { version: 1, nodes: [], edges: [] },
  print: (line) => console.log(line),
  record: (r) => events.write(secrets.redactDeep(r)),
});
// The connectors the image offers (docs/bot-os-api.md §5). The names they hold are placeholders
// until a node of the graph gives each its own account.
const image: Plugin[] = [
  ircPlugin({ nick: env['IRC_NICK'] || 'megabottron' }),
  telegramBotPlugin(),
  telegramUserPlugin({ self: env['TELEGRAM_USER'] || 'owner' }),
  anthropicPlugin(),
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

function shutdown(): void {
  void core.stop();
  control.close();
  web?.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
