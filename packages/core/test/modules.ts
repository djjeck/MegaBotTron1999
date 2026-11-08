/** Synthetic modules for tests: directories in a temporary one, and tarballs made by hand. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh temporary directory. */
export function tempDir(prefix = 'modules-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A module's manifest as tests write it: the essentials, filled in. */
export function manifestOf(
  id: string,
  more: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, version: '0.1.0', api: '1', provides: `@example/${id}`, ...more };
}

/**
 * Writes a module into `<root>/<dir>/`: its `module.json` (`manifest`, or the raw text given) and
 * its files, by path. Returns its directory.
 */
export function writeModule(
  root: string,
  dir: string,
  manifest: Record<string, unknown> | string,
  files: Record<string, string> = {}
): string {
  const at = path.join(root, dir);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(
    path.join(at, 'module.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  );
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
    fs.writeFileSync(path.join(at, file), text);
  }
  return at;
}

/** A plugin entry's source: `plugins`, one per id, each a minimal plugin. */
export function entrySource(...ids: string[]): string {
  return `export const plugins = [${ids
    .map(
      (id) =>
        `{ manifest: { id: '${id}', version: '0.1.0', kinds: ['stats'], description: 'A test plugin' }, create: () => ({}) }`
    )
    .join(', ')}];\n`;
}

export interface TarMember {
  name: string;
  /** The contents of a file; none for a directory. */
  data?: string;
  /** The tar type flag: '0' a file, '5' a directory, '2' a symlink, 'x' a pax header, 'L' a GNU long name. */
  type?: string;
  /** The ustar prefix field. */
  prefix?: string;
}

const pad = (n: number): number => Math.ceil(n / 512) * 512;

/** A tarball of `members`, in order, as tar writes one. */
export function tarOf(members: readonly TarMember[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const m of members) {
    const data = Buffer.from(m.data ?? '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(m.name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(m.type ?? (m.data === undefined ? '5' : '0'), 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    if (m.prefix !== undefined) header.write(m.prefix, 345);
    blocks.push(header, Buffer.concat([data, Buffer.alloc(pad(data.length) - data.length)]));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A pax header's record of `key=value`, as its length-prefixed line. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
  return `${length}${body}`;
}
