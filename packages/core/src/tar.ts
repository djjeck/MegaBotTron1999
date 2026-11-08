/**
 * A tarball's files, for installing a module from an upload (module-store.ts): ustar, with the pax
 * and GNU long names that `tar` and `git archive` write, gzipped or not. Only files and directories
 * are taken; a link, a device or a path that leaves the directory (absolute, or through `..`)
 * refuses the whole archive. Small on purpose, so that the shell needs no tar package and runs no
 * `tar` binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** The largest archive unpacked: a module is source code. */
export const MAX_UNPACKED = 256 * 2 ** 20;

const BLOCK = 512;

const text = (b: Uint8Array, from: number, length: number): string => {
  const raw = b.subarray(from, from + length);
  const end = raw.indexOf(0);
  return Buffer.from(end === -1 ? raw : raw.subarray(0, end)).toString('utf8');
};

const octal = (b: Uint8Array, from: number, length: number): number => {
  const s = text(b, from, length).trim();
  return s === '' ? 0 : Number.parseInt(s, 8);
};

/** The `path` of a pax header's records, if it has one. */
function paxPath(data: Uint8Array): string | undefined {
  let out: string | undefined;
  const s = Buffer.from(data).toString('utf8');
  let at = 0;
  while (at < s.length) {
    const space = s.indexOf(' ', at);
    const length = Number.parseInt(s.slice(at, space), 10);
    if (space === -1 || !Number.isInteger(length) || length <= 0) break;
    const record = s.slice(space + 1, at + length - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') out = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/** A member's path, relative and inside the archive's root; throws for any other. */
function safePath(name: string): string {
  const parts = name.replace(/\\/gu, '/').split('/');
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name) || parts.includes('..'))
    throw new Error(`tar: ${name} leaves the archive's directory`);
  return parts.filter((p) => p !== '' && p !== '.').join('/');
}

/** Unpacks `archive` (a .tar or a .tar.gz) into `dest`, which it creates. */
export function extractTar(archive: Uint8Array, dest: string): void {
  const gzipped = archive[0] === 0x1f && archive[1] === 0x8b;
  const tar = gzipped ? zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED }) : archive;
  fs.mkdirSync(dest, { recursive: true });
  let at = 0;
  let longName: string | undefined;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((x) => x === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (data.length < size) throw new Error('tar: the archive is cut short');
    if (type === 'x') {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === 'L') {
      longName = text(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    const prefix = text(header, 345, 155);
    const short = text(header, 0, 100);
    const name = longName ?? (prefix === '' ? short : `${prefix}/${short}`);
    longName = undefined;
    const rel = safePath(name);
    // macOS's tar adds its metadata as `._name` files.
    if (rel === '' || path.posix.basename(rel).startsWith('._')) continue;
    const target = path.join(dest, ...rel.split('/'));
    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    } else throw new Error(`tar: ${name} is not a file or a directory (type ${type})`);
  }
}
