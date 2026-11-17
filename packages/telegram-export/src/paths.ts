/**
 * Path strings in POSIX form, as the readers print and order them. Pure functions, no Node APIs.
 *
 * Paths are normalised (repeated `/` and `.` components collapsed, no trailing slash, `"."` for the
 * empty path) so that the same file is always written the same way in outputs and messages, and
 * they are ordered component by component (a folder before its subfolders, siblings by name), the
 * order in which files.ts walks folders.
 */
import { compareStringLists } from './text.ts';

/** Root and components of a POSIX path. */
function splitPosix(p: string): [root: string, parts: string[]] {
  let root = '';
  if (p.startsWith('/')) root = p.startsWith('//') && !p.startsWith('///') ? '//' : '/';
  const parts = p.split('/').filter((x) => x !== '' && x !== '.');
  return [root, parts];
}

/** Normalised form: collapses `//` and `.` components, drops trailing slashes; `""` is `"."`. */
export function normalizePath(p: string): string {
  const [root, parts] = splitPosix(p);
  const s = root + parts.join('/');
  return s === '' ? '.' : s;
}

/** Normalised parent directory (`"."` for a bare file name). */
export function pathParent(p: string): string {
  const [root, parts] = splitPosix(p);
  if (parts.length === 0) return normalizePath(p);
  const s = root + parts.slice(0, -1).join('/');
  return s === '' ? '.' : s;
}

/** Last component, `""` for a root or empty path. */
export function pathName(p: string): string {
  const parts = splitPosix(p)[1];
  return parts.length === 0 ? '' : (parts[parts.length - 1] as string);
}

/** Extension of the last component, with its dot (`""` for none, a dotfile, or a trailing dot). */
export function pathSuffix(p: string): string {
  const name = pathName(p);
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

/** Orders paths by their lists of components, not as strings (`a/b` before `a-c/x`). */
export function comparePaths(a: string, b: string): number {
  return compareStringLists(normalizePath(a).split('/'), normalizePath(b).split('/'));
}
