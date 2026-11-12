/**
 * A folder of modules, as the owner picks it (`<input type="file" webkitdirectory>`) or drops it on
 * the Modules page (`DataTransferItem.webkitGetAsEntry`), read in the browser (docs/bot-os-api.md
 * §7.4, bot-os.md D67). It may be one module's folder or a repository's root with several: its
 * paths and its `module.json` files go to `POST /modules/plan`, which finds the modules (vendored
 * copies and tests aside) and the files each installs; then only those files of the modules the
 * owner checks are read and sent, one module per `POST /modules`. What is under `.git` or
 * `node_modules` is never read nor listed.
 */
import type { ModuleCandidate, TreeListing } from '@megabottron1999/core';

/** A file of the folder: its path from the folder picked (its name first), and the file. */
export interface FolderFile {
  path: string;
  file: File;
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

/** The folder's name: the first part its files share, as a folder picked gives it. */
export function folderName(files: readonly FolderFile[]): string {
  const top = new Set(files.map((f) => f.path.split('/')[0] ?? ''));
  return top.size === 1 ? ([...top][0] ?? '') : '';
}

/**
 * What `POST /modules/plan` reads: every path, and the text of each `module.json` (but those
 * under a `vendor` directory, which are never the owner's modules).
 */
export async function listing(files: readonly FolderFile[]): Promise<TreeListing> {
  const manifests: Record<string, string> = {};
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.at(-1) === 'module.json' && !parts.slice(0, -1).includes('vendor'))
      manifests[f.path] = await f.file.text();
  }
  return { paths: files.map((f) => f.path), manifests };
}

/** A module's files among the folder's, as the plan names them, and their size. */
export function moduleFiles(
  m: ModuleCandidate,
  files: readonly FolderFile[]
): { files: FolderFile[]; bytes: number } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const mine = m.files.map((p) => byPath.get(p)).filter((f): f is FolderFile => f !== undefined);
  return { files: mine, bytes: mine.reduce((n, f) => n + f.file.size, 0) };
}

/** A module's path in the folder, for the owner: from inside the folder picked, `.` for itself. */
export function shownPath(path: string, folder: string): string {
  const inside =
    folder !== '' && (path === folder || path.startsWith(`${folder}/`))
      ? path.slice(folder.length)
      : path;
  return inside.replace(/^\/+/u, '') || '.';
}
