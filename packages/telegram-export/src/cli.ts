/**
 * The command line of the readers (tools/telegram-export.ts): reads export folders and JSON files
 * and prints their messages, merged and in time order, one JSON object per line (JSON Lines); with
 * a mapping, as the `Inbound`s a replay feeds (inbound.ts). The warnings and the summary go to the
 * error stream. A module's own replay tool builds on its output, or on the same functions.
 */
import * as fs from 'node:fs';
import { readExportPaths } from './files.ts';
import { type ReplayMapping, toInbounds } from './inbound.ts';

export const USAGE = [
  'Usage: telegram-export [--time-zone <IANA zone>] [--inbounds <mapping.json>] [--playback] <path>...',
  '',
  'Prints the messages of Telegram Desktop exports (folders of HTML or JSON exports, or result.json',
  "files) as JSON Lines, merged and in time order. With --inbounds, as the Inbounds the owner's",
  'account (telegram-user) would have delivered, by the mapping given (docs/telegram-export.md',
  '§14); --playback marks them history. --time-zone: where a macOS export was made, for its dates.',
].join('\n');

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** A file's text: the mapping. */
  readFile?(path: string): string;
}

/** Runs the command line; its exit code. */
export function exportCli(args: readonly string[], io: CliIo): number {
  const paths: string[] = [];
  let timeZone: string | undefined;
  let mappingFile: string | undefined;
  let playback = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--time-zone' || a === '--inbounds') {
      const value = args[++i];
      if (value === undefined) {
        io.err(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--time-zone') timeZone = value;
      else mappingFile = value;
    } else if (a === '--playback') playback = true;
    else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith('--')) {
      io.err(`unknown option ${a}\n${USAGE}`);
      return 2;
    } else paths.push(a);
  }
  if (paths.length === 0) {
    io.err(USAGE);
    return 2;
  }
  try {
    const read = io.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
    const mapping =
      mappingFile === undefined ? undefined : (JSON.parse(read(mappingFile)) as ReplayMapping);
    const { messages } = readExportPaths(paths, (l) => io.err(l), {
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    const rows = mapping === undefined ? messages : toInbounds(messages, mapping, { playback });
    for (const r of rows) io.out(JSON.stringify(r));
    return 0;
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
