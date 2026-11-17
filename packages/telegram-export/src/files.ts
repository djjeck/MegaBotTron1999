/**
 * Node adapter of the readers: lists the entries of input folders on disk and reads their HTML
 * pages, their JSON exports and the text files they link to; which entries are pages or JSON
 * exports, which files a page links to, and the warnings, are decided by listing.ts. Folders and
 * `.json` files only: zip input is not supported.
 *
 * Directory walks are depth-first, take the entries of every folder sorted by name (code point
 * order) and do not follow symlinked folders. A folder comes before its subfolders, which are
 * visited in name order: the same order as comparePaths.
 */
import * as fs from 'node:fs';
import { jsonTextFiles, readJsonExport } from './json.ts';
import {
  decodeText,
  type ExportEntry,
  listExport,
  notAFolderWarning,
  withTextFiles,
  zipWarning,
} from './listing.ts';
import {
  type ExportRecord,
  mergeExports,
  type MergeOptions,
  type MergeResult,
  readHtmlExport,
  splitExports,
  summaryLine,
} from './merge.ts';
import { type Page } from './messages.ts';
import { normalizePath, pathParent, pathSuffix } from './paths.ts';
import { compareCodePoints } from './text.ts';

export type Log = (line: string) => void;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Directory entries sorted by name (code point order); empty if the folder cannot be read. */
function readDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => compareCodePoints(a.name, b.name));
  } catch {
    return [];
  }
}

/** Every entry under the folder `root` (any kind; symlinked folders are not followed). */
function* walkEntries(root: string): Generator<ExportEntry> {
  const dir = root.endsWith('/') ? root : root + '/';
  for (const e of readDirEntries(dir)) {
    const p = normalizePath(dir + e.name);
    yield { path: p, isFile: () => isFile(p) };
    if (e.isDirectory()) yield* walkEntries(dir + e.name + '/');
  }
}

/** A text file: strict UTF-8, BOM kept, `\r\n` and `\r` turned into `\n` (decodeText). */
function readText(p: string): string {
  return decodeText(fs.readFileSync(p));
}

/** One JSON export on disk, with the attached text files it links to that the export holds. */
export function readJsonFile(file: string): ExportRecord {
  const json = JSON.parse(readText(file)) as unknown;
  const files = new Map<string, string>();
  for (const link of jsonTextFiles(json)) {
    const p = normalizePath(`${pathParent(file)}/${link}`);
    if (!isFile(p)) continue;
    try {
      files.set(link, readText(p));
    } catch {
      // Not UTF-8: not a file the readers read.
    }
  }
  return readJsonExport(json, normalizePath(file), files);
}

/** What an input path holds: its HTML pages, in order, and its JSON exports. */
export interface InputExports {
  pages: Page[];
  json: string[];
}

/**
 * The HTML pages under a folder, in (folder, page number) order, with their text files, and its
 * JSON exports; a `.json` file is a JSON export. Anything else is warned of and skipped.
 */
export function listInput(path: string, log: Log): InputExports {
  const p = normalizePath(path);
  if (isDir(p)) {
    const { pages, json, warnings } = listExport([...walkEntries(p)]);
    for (const w of warnings) log(w);
    return {
      pages: pages.map((f) =>
        withTextFiles({ label: f, html: readText(f) }, (t) =>
          isFile(t) ? fs.readFileSync(t) : null
        )
      ),
      json,
    };
  }
  const suffix = pathSuffix(p).toLowerCase();
  if (isFile(p) && suffix === '.json') return { pages: [], json: [p] };
  log(isFile(p) && suffix === '.zip' ? zipWarning(p) : notAFolderWarning(p));
  return { pages: [], json: [] };
}

/** Every HTML page under a folder, in (folder, page number) order, with its text files. */
export function iterPages(path: string, log: Log): Page[] {
  return listInput(path, log).pages;
}

/**
 * Reads the exports of all paths (each HTML export, then each JSON export, path by path), merges
 * them (de-duplicated and sorted, mergeExports), and logs the warnings and the summary line.
 */
export function readExportPaths(
  paths: readonly string[],
  log: Log,
  options: MergeOptions = {}
): MergeResult {
  const records: ExportRecord[] = [];
  for (const path of paths) {
    const { pages, json } = listInput(path, log);
    for (const exp of splitExports(pages)) records.push(readHtmlExport(exp));
    for (const file of json) records.push(readJsonFile(file));
  }
  const result = mergeExports(records, options);
  for (const line of result.warnings) log(line);
  log(summaryLine(result));
  return result;
}
