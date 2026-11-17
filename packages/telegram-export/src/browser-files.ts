/**
 * Browser adapter of the readers: the files a folder picker gives (`<input type="file"
 * webkitdirectory>`, one `File` per file of the picked folder, its path in `webkitRelativePath`)
 * become input folders like the folders files.ts reads on disk, and their HTML pages are read,
 * with the text files they link to. Which files are pages, which files a page links to, and the
 * warnings, are decided by listing.ts, as on disk.
 *
 * No DOM types: a file is anything with a relative path and its bytes (FileLike), so the adapter
 * also runs in Node, on objects built by the tests.
 */
import {
  decodeText,
  type ExportEntry,
  type ExportListing,
  linkedTextFiles,
  listExport,
  withTextFiles,
} from './listing.ts';
import { type Page } from './messages.ts';
import { normalizePath } from './paths.ts';

/** What the adapter needs of a browser `File`. */
export interface FileLike {
  readonly name: string;
  /** `picked folder/sub/name`; empty for a file not picked as part of a folder. */
  readonly webkitRelativePath: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** One input folder: what a folder on disk is to files.ts. */
export interface InputFolder {
  /** The folder's name, as warnings and page labels show it. */
  name: string;
  /** Path under the folder (with the folder's name first) -> file. */
  files: Map<string, FileLike>;
}

/** The path a picked file has, starting with its top folder's name. */
function relativePath(f: FileLike): string {
  return normalizePath(f.webkitRelativePath || f.name);
}

/** The top folder of a relative path; `.` for a loose file. */
function topFolder(p: string): string {
  const i = p.indexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/**
 * The input folders of one or more picks, in pick order: each top folder of each pick is
 * one input folder (a pick usually has one). A folder whose name an earlier one already
 * has, picked again or another folder with the same name, is renamed `name (2)`,
 * `name (3)`…, so that two folders never share page labels. The same files picked twice
 * are two copies of one export, which the merge de-duplicates.
 */
export function inputFolders(picks: readonly (readonly FileLike[])[]): InputFolder[] {
  const out: InputFolder[] = [];
  const taken = new Set<string>();
  for (const pick of picks) {
    const byTop = new Map<string, Map<string, FileLike>>();
    for (const f of pick) {
      const p = relativePath(f);
      const top = topFolder(p);
      let files = byTop.get(top);
      if (files === undefined) byTop.set(top, (files = new Map()));
      files.set(p, f);
    }
    for (const [top, files] of byTop) {
      let name = top;
      for (let n = 2; taken.has(name); n++) name = `${top} (${n})`;
      taken.add(name);
      if (name === top) {
        out.push({ name, files });
        continue;
      }
      const renamed = new Map<string, FileLike>();
      for (const [p, f] of files)
        renamed.set(top === '.' ? `${name}/${p}` : name + p.slice(top.length), f);
      out.push({ name, files: renamed });
    }
  }
  return out;
}

/** The page paths, JSON exports and warnings of an input folder. */
export function listFolder(folder: InputFolder): ExportListing {
  const entries: ExportEntry[] = [...folder.files.keys()].map((path) => ({
    path,
    isFile: () => true, // a picker gives files only
  }));
  return listExport(entries);
}

/**
 * Reads the pages of an input folder, in order, with the text files they link to, as
 * files.ts reads them from disk (decodeText, withTextFiles); `onPage` is called
 * after each page. Throws on a page that is not UTF-8.
 */
export async function readFolderPages(
  folder: InputFolder,
  pages: readonly string[],
  onPage: (label: string) => void = () => {}
): Promise<Page[]> {
  const out: Page[] = [];
  for (const label of pages) {
    const file = folder.files.get(label) as FileLike;
    const html = decodeText(new Uint8Array(await file.arrayBuffer()));
    const bytes = new Map<string, Uint8Array>();
    for (const { path } of linkedTextFiles(label, html)) {
      const f = folder.files.get(path);
      if (f !== undefined) bytes.set(path, new Uint8Array(await f.arrayBuffer()));
    }
    out.push(withTextFiles({ label, html }, (p) => bytes.get(p) ?? null));
    onPage(label);
  }
  return out;
}
