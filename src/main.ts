/**
 * The image's entry point (the Dockerfile's CMD): the core, with the connectors registered, the
 * owner's control API and the web UI, and no game. Everything it calls is tested; this file is
 * wiring, left out of coverage.
 *
 * The connectors are registered, so the image offers them, but the graph is empty: no plugin
 * instance runs until the owner adds one (docs/bot-os.md D50).
 *
 * TODO(loader): this is where the next step loads the instance from the data volume:
 * - the modules installed under `/data/modules/<id>/` (docs/bot-os.md D49), each registered beside
 *   the connectors, through a resolve hook that maps `@megabottron1999/*` and `zod` to this image's
 *   copies;
 * - the graph from `/data/graph.json` (D50), which today's empty graph stands in for, with the
 *   plugins' kept state belonging to instances apart from the nodes.
 */
import { anthropicPlugin } from '@megabottron1999/connectors/plugins/anthropic.ts';
import { ircPlugin } from '@megabottron1999/connectors/plugins/irc.ts';
import { telegramBotPlugin } from '@megabottron1999/connectors/plugins/telegram-bot.ts';
import { telegramUserPlugin } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  controlHandler,
  Core,
  CoreEventLog,
  Secrets,
  StartError,
  wallClock,
} from '@megabottron1999/core';
import { startWebUi } from '@megabottron1999/web/server/web-server.ts';
import http from 'node:http';
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
  // TODO(loader): the graph from /data/graph.json (D50); until then, an empty one.
  graph: { version: 1, nodes: [], edges: [] },
  print: (line) => console.log(line),
  record: (r) => events.write(secrets.redactDeep(r)),
});
// The connectors the image offers (docs/bot-os-api.md §5). The names they hold are placeholders
// until a node of the graph gives each its own account.
core.register(
  ircPlugin({ nick: env['IRC_NICK'] || 'megabottron' }),
  telegramBotPlugin(),
  telegramUserPlugin({ self: env['TELEGRAM_USER'] || 'owner' }),
  anthropicPlugin()
);
// TODO(loader): register the modules of /data/modules here, before the load.
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
