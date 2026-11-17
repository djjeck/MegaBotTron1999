/**
 * Prints the messages of Telegram Desktop chat exports as JSON Lines, or with a mapping the
 * `Inbound`s a replay feeds (packages/telegram-export/src/cli.ts, docs/telegram-export.md).
 *
 * Usage: node packages/telegram-export/tools/telegram-export.ts [--time-zone <zone>]
 *   [--inbounds <mapping.json>] [--playback] <export folder or result.json>...
 */
import { exportCli } from '#src/cli.ts';

process.exitCode = exportCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
