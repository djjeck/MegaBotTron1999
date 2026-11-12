/**
 * A module's folder, as the owner picks it (`<input type="file" webkitdirectory>`) or drops it on
 * the Modules page (`DataTransferItem.webkitGetAsEntry`), read in the browser before it is sent to
 * `POST /modules` as `{"files": [{path, content}]}` (docs/bot-os-api.md §7.4). What is under `.git`
 * or `node_modules` is left out here as the server leaves it out, so that it is not uploaded.
 */

/** A file of the folder: its path from the folder picked (its name first), and the file. */
export interface FolderFile {
  path: string;
  file: File;
}

/** What the module's `module.json` says, as the page shows it before the install. */
export interface FolderManifest {
  id: string;
  version: string;
  description?: string;
}

/** A folder read: its files, and its module's manifest or why there is none. */
export interface ModuleFolder {
  /** The folder's name, as picked. */
  name: string;
  files: FolderFile[];
  /** Their size, in bytes. */
  bytes: number;
  manifest?: FolderManifest;
  error?: string;
}

/** The largest module uploaded, in bytes, as the control API takes it (`MAX_UPLOAD`). */
export const MAX_MODULE_BYTES = 64 * 2 ** 20;

const SKIPPED = new Set(['.git', 'node_modules']);

/** Whether a path is a repository's own or its dependencies', never uploaded. */
export const skipped = (path: string): boolean => path.split('/').some((p) => SKIPPED.has(p));

/** The files of a folder picked with `webkitdirectory`, each at its `webkitRelativePath`. */
export function pickedFiles(list: Iterable<File>): FolderFile[] {
  return [...list]
    .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    .filter((f) => !skipped(f.path));
}

/** The files under the entries dropped, walking each directory (but `.git` and `node_modules`). */
export async function droppedFiles(entries: readonly FileSystemEntry[]): Promise<FolderFile[]> {
  const out: FolderFile[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (SKIPPED.has(entry.name)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      out.push({ path: entry.fullPath.replace(/^\/+/u, ''), file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries gives a directory's entries in batches, until an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

/**
 * Where the module's `module.json` is among the files: at their root, or in the one directory they
 * all are in (a folder picked gives its name first), as the server looks for it.
 */
export function manifestFile(files: readonly FolderFile[]): FolderFile | undefined {
  const at = (p: string) => files.find((f) => f.path === p);
  const top = new Set(files.map((f) => f.path.split('/')[0]));
  const only = top.size === 1 ? [...top][0] : undefined;
  return at('module.json') ?? (only === undefined ? undefined : at(`${only}/module.json`));
}

/** What the folder holds: its module's manifest, read here, or why it is not a module's folder. */
export async function readFolder(files: FolderFile[]): Promise<ModuleFolder> {
  const name = files[0]?.path.split('/')[0] ?? '';
  const bytes = files.reduce((n, f) => n + f.file.size, 0);
  const folder = { name, files, bytes };
  if (files.length === 0) return { ...folder, error: 'the folder is empty' };
  const file = manifestFile(files);
  if (file === undefined) {
    const inside = files
      .filter((f) => f.path.endsWith('/module.json'))
      .map((f) => f.path.slice(0, -'/module.json'.length));
    return {
      ...folder,
      error:
        inside.length === 0
          ? `no module.json in ${name}: choose the module's own folder, the one that holds its module.json`
          : `${name} is not a module's folder, but holds modules: choose one of ${inside.join(', ')}`,
    };
  }
  let m: unknown;
  try {
    m = JSON.parse(await file.file.text());
  } catch (e) {
    return { ...folder, error: `${file.path} is not JSON: ${(e as Error).message}` };
  }
  const o = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
  const { id, version, description } = o;
  if (typeof id !== 'string' || typeof version !== 'string')
    return { ...folder, error: `${file.path} has no id or version` };
  const manifest: FolderManifest = {
    id,
    version,
    ...(typeof description === 'string' ? { description } : {}),
  };
  if (bytes > MAX_MODULE_BYTES)
    return { ...folder, manifest, error: `the folder is over ${MAX_MODULE_BYTES} bytes` };
  return { ...folder, manifest };
}
