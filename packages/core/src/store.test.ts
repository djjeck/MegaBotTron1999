import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MigrationStore, Stores } from './store.ts';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Stores, on disk', () => {
  it('keeps each plugin its documents, in its own directory', () => {
    const stores = new Stores(dataDir);
    const a = stores.open('a');
    expect(a.read('state')).toBeUndefined();
    a.write('state', { last: 5 });
    a.write('other', [1, 2]);
    stores.open('b').write('state', 'b');
    expect(stores.open('a').read('state')).toEqual({ last: 5 });
    expect(a.names()).toEqual(['other', 'state']);
    expect(fs.readFileSync(path.join(dataDir, 'instances', 'a', 'state.json'), 'utf8')).toBe(
      '{"last":5}\n'
    );
    expect(fs.statSync(path.join(dataDir, 'instances', 'a', 'state.json')).mode & 0o777).toBe(
      0o600
    );
    a.remove('other');
    expect(a.names()).toEqual(['state']);
    expect(stores.open('nobody').names()).toEqual([]);
    expect(stores.dirOf('a')).toBe(path.join(dataDir, 'instances', 'a'));
  });

  it('refuses a name that would leave the directory, or is the core’s', () => {
    const a = new Stores(dataDir).open('a');
    for (const name of ['../b/state', 'a/b', '..', '_meta', '', '.hidden'])
      expect(() => a.write(name, 1)).toThrow('not a document name');
    expect(() => a.read('../x')).toThrow('not a document name');
    expect(() => a.remove('_restore')).toThrow('not a document name');
  });

  it('says which document is not JSON, and passes other errors on', () => {
    const stores = new Stores(dataDir);
    stores.open('a').write('state', 1);
    fs.writeFileSync(path.join(dataDir, 'instances', 'a', 'state.json'), '{half');
    expect(() => stores.open('a').read('state')).toThrow('document state is not JSON');
    fs.mkdirSync(path.join(dataDir, 'instances', 'a', 'dir.json'));
    expect(() => stores.open('a').read('dir')).toThrow();
  });

  it('migrates from the version kept', async () => {
    const stores = new Stores(dataDir);
    stores.open('ledger').write('state', { last: 1234 });
    const steps = [
      () => {},
      (s: MigrationStore) => {
        const old = s.read<{ last: number }>('state');
        s.write('state', { ...old, v: 2 });
        expect(s.names()).toEqual(['state']);
      },
    ];
    await stores.migrate('ledger', steps);
    expect(stores.version('ledger')).toBe(2);
    expect(stores.open('ledger').read('state')).toEqual({ last: 1234, v: 2 });
    // Nothing to do at the next start; a third step runs alone.
    await stores.migrate('ledger', steps);
    await stores.migrate('ledger', [
      ...steps,
      (s) => {
        s.remove('state');
      },
    ]);
    expect(stores.open('ledger').names()).toEqual([]);
    expect(stores.version('ledger')).toBe(3);
    expect(fs.readdirSync(path.join(dataDir, 'instances'))).toEqual(['ledger']);
  });

  it('leaves the store as it was when a migration fails', async () => {
    const stores = new Stores(dataDir);
    stores.open('a').write('state', { kept: true });
    await expect(
      stores.migrate('a', [
        (s) => {
          s.write('state', { x: 1 });
          s.write('extra', 1);
        },
        () => Promise.reject(new Error('nope')),
      ])
    ).rejects.toThrow('migration 1 → 2 failed: nope');
    expect(stores.open('a').read('state')).toEqual({ kept: true });
    expect(stores.open('a').names()).toEqual(['state']);
    expect(stores.version('a')).toBe(0);
    expect(fs.readdirSync(path.join(dataDir, 'instances'))).toEqual(['a']);
    await expect(
      stores.migrate('a', [
        () => {
          throw 'a string';
        },
      ])
    ).rejects.toThrow('migration 0 → 1 failed: a string');
  });

  it('refuses a store newer than the plugin', async () => {
    const stores = new Stores(dataDir);
    await stores.migrate('a', [() => {}, () => {}]);
    await expect(stores.migrate('a', [() => {}])).rejects.toThrow(
      'its store is at version 2, newer than the 1 it knows'
    );
  });
});

describe('Stores, in memory', () => {
  it('keeps documents and migrates them', async () => {
    const stores = new Stores();
    expect(stores.dirOf('a')).toBeUndefined();
    stores.open('a').write('state', 1);
    expect(stores.open('a').read('state')).toBe(1);
    await stores.migrate('a', [(s) => expect(s.read('state')).toBe(1)]);
    expect(stores.version('a')).toBe(1);
    expect(stores.open('a').read('state')).toBe(1);
    await expect(
      stores.migrate('a', [
        () => {},
        (s) => {
          s.write('state', 2);
          throw new Error('half');
        },
      ])
    ).rejects.toThrow('half');
    expect(stores.open('a').read('state')).toBe(1);
  });

  it('shows a migration to a store opened before it', async () => {
    const stores = new Stores();
    const before = stores.open('b');
    before.write('state', 1);
    await stores.migrate('b', [(s) => s.write('state', 2)]);
    expect(before.read('state')).toBe(2);
  });
});

describe('Stores, after a crash', () => {
  it('brings back a store moved aside by a commit cut short, and migrates it again', async () => {
    const stores = new Stores(dataDir);
    stores.open('a').write('state', { kept: 1 });
    await stores.migrate('a', [() => {}]);
    // The crash: the store moved aside, the staged copy not moved in yet.
    const dir = path.join(dataDir, 'instances', 'a');
    fs.renameSync(dir, `${dir}.old`);
    fs.mkdirSync(`${dir}.migrating`);
    await stores.migrate('a', [() => {}, (s) => s.write('v2', true)]);
    expect(stores.open('a').read('state')).toEqual({ kept: 1 });
    expect(stores.open('a').read('v2')).toBe(true);
    expect(stores.version('a')).toBe(2);
    expect(fs.readdirSync(path.join(dataDir, 'instances'))).toEqual(['a']);
  });
});

describe('a store’s files (D149)', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('keeps bytes by name, atomically, mode 600, with their type and time', () => {
    let t = 1000;
    const stores = new Stores(dataDir, { now: () => t });
    const files = stores.open('card-painter').files;
    expect(files.read('card-42.png')).toBeUndefined();
    expect(files.list()).toEqual([]);
    files.write('card-42.png', png);
    t = 2000;
    files.write('notes', new TextEncoder().encode('hi'), { type: 'Text/Plain' });
    files.write('blob.bin', Buffer.from([1]));
    expect(Buffer.from(files.read('card-42.png') as Uint8Array)).toEqual(Buffer.from(png));
    expect(files.list()).toEqual([
      { name: 'blob.bin', size: 1, type: 'application/octet-stream', written: 2000 },
      { name: 'card-42.png', size: 7, type: 'image/png', written: 1000 },
      { name: 'notes', size: 2, type: 'text/plain', written: 2000 },
    ]);
    const dir = path.join(dataDir, 'instances', 'card-painter', 'files');
    expect(fs.statSync(path.join(dir, 'card-42.png')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // No temporary left behind, and the documents are not the files.
    expect(fs.readdirSync(dir).sort()).toEqual(['.meta', 'blob.bin', 'card-42.png', 'notes']);
    expect(stores.open('card-painter').names()).toEqual([]);
    // Replaced whole.
    files.write('card-42.png', Uint8Array.from([9]));
    expect([...(files.read('card-42.png') as Uint8Array)]).toEqual([9]);
    files.delete('card-42.png');
    files.delete('never');
    expect(files.read('card-42.png')).toBeUndefined();
    expect(files.list().map((f) => f.name)).toEqual(['blob.bin', 'notes']);
    // Put back by hand, with nothing kept of it: its type from its name, its time from the disk.
    fs.writeFileSync(path.join(dir, 'put.gif'), 'GIF');
    fs.mkdirSync(path.join(dir, 'a-dir'));
    expect(files.list().find((f) => f.name === 'put.gif')).toMatchObject({
      size: 3,
      type: 'image/gif',
      written: expect.any(Number),
    });
    expect(files.list().map((f) => f.name)).not.toContain('a-dir');
    expect(new Stores(dataDir).open('nobody').files.list()).toEqual([]);
    // Gone with its store.
    stores.delete('card-painter');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses a name with a path, a type that is none, and what is not bytes', () => {
    const files = new Stores(dataDir).open('a').files;
    for (const name of ['../b', 'a/b', '..', '_meta', '', '.hidden', 'x'.repeat(201)])
      expect(() => files.write(name, png)).toThrow('not a file name');
    expect(() => files.read('../x')).toThrow('not a file name');
    expect(() => files.delete('_x')).toThrow('not a file name');
    expect(() => files.write('a', png, { type: 'png' })).toThrow('file a: not a media type: "png"');
    expect(() => files.write('a', png, { type: `image/${'x'.repeat(130)}` })).toThrow(
      'not a media type'
    );
    expect(() => files.write('a', 'text' as unknown as Uint8Array)).toThrow('file a: not bytes');
    expect(files.write('x'.repeat(200), png)).toBeUndefined();
  });

  it('refuses a file over the size a file may be, or the instance’s total, with why', () => {
    const stores = new Stores(dataDir, { fileLimits: { file: 3000, total: 4000 } });
    expect(stores.fileLimits).toEqual({ file: 3000, total: 4000 });
    const files = stores.open('a').files;
    expect(() => files.write('big', new Uint8Array(3001))).toThrow(
      'file big is 2.9 KB, over the 2.9 KB a file may be'
    );
    files.write('one', new Uint8Array(2500));
    expect(() => files.write('two', new Uint8Array(2000))).toThrow(
      'file two (2.0 KB) would take the files to 4.4 KB, over the 3.9 KB an instance may keep'
    );
    // A file replaced counts once.
    files.write('one', new Uint8Array(3000));
    files.write('two', new Uint8Array(1000));
    expect(() => files.write('three', new Uint8Array(1))).toThrow('1 B');
    expect(new Stores(dataDir).fileLimits).toEqual({ file: 16 * 2 ** 20, total: 256 * 2 ** 20 });
    expect(() =>
      new Stores(dataDir, { fileLimits: { file: 20 * 2 ** 20 } })
        .open('b')
        .files.write('x', new Uint8Array(17 * 2 ** 20))
    ).not.toThrow();
    expect(() =>
      new Stores(dataDir, { fileLimits: { file: 2 ** 21 } })
        .open('b')
        .files.write('x', new Uint8Array(2 ** 21 + 1))
    ).toThrow('file x is 2.0 MB, over the 2.0 MB a file may be');
  });

  it('migrates them hard-linked, never copied, the store’s own left as they were', async () => {
    const stores = new Stores(dataDir, { now: () => 5 });
    const store = stores.open('a');
    store.files.write('keep.png', png);
    store.files.write('gone.png', png);
    store.files.write('changed', Uint8Array.from([1]));
    const dir = path.join(dataDir, 'instances', 'a', 'files');
    const inode = fs.statSync(path.join(dir, 'keep.png')).ino;
    let staged: number | undefined;
    const steps = [
      (s: MigrationStore) => {
        staged = fs.statSync(
          path.join(`${dataDir}/instances/a.migrating`, 'files', 'keep.png')
        ).ino;
        expect(s.files.list().map((f) => f.name)).toEqual(['changed', 'gone.png', 'keep.png']);
        s.files.delete('gone.png');
        s.files.write('changed', Uint8Array.from([2]));
        s.files.write('new', Uint8Array.from([3]));
        // The store's own, untouched while it runs.
        expect([...(store.files.read('changed') as Uint8Array)]).toEqual([1]);
        expect(store.files.read('gone.png')).toBeDefined();
      },
    ];
    // A failed one leaves every file as it was.
    await expect(
      stores.migrate('a', [
        ...steps,
        () => {
          throw new Error('nope');
        },
      ])
    ).rejects.toThrow('nope');
    expect(staged).toBe(inode);
    expect(store.files.list().map((f) => f.name)).toEqual(['changed', 'gone.png', 'keep.png']);
    expect([...(store.files.read('changed') as Uint8Array)]).toEqual([1]);
    expect(fs.existsSync(`${dataDir}/instances/a.migrating`)).toBe(false);
    expect(fs.statSync(path.join(dir, 'keep.png')).nlink).toBe(1);
    // One that succeeds: what it made is the store's.
    await stores.migrate('a', steps);
    expect(store.files.list().map((f) => f.name)).toEqual(['changed', 'keep.png', 'new']);
    expect([...(store.files.read('changed') as Uint8Array)]).toEqual([2]);
    expect(fs.statSync(path.join(dir, 'keep.png'))).toMatchObject({ ino: inode, nlink: 1 });
    expect(store.files.list().find((f) => f.name === 'keep.png')?.written).toBe(5);
    expect(fs.readdirSync(path.join(dataDir, 'instances'))).toEqual(['a']);
  });

  it('keeps them in memory without a data directory, a migration’s seen by a store opened before', async () => {
    const stores = new Stores(undefined, { now: () => 7 });
    const before = stores.open('a');
    before.files.write('a.png', png);
    const read = before.files.read('a.png') as Uint8Array;
    // What the plugin changes of what it read, or of what it wrote, is not kept.
    read[0] = 0;
    expect((before.files.read('a.png') as Uint8Array)[0]).toBe(0x89);
    expect(before.files.list()).toEqual([
      { name: 'a.png', size: 7, type: 'image/png', written: 7 },
    ]);
    await expect(
      stores.migrate('a', [
        (s) => {
          s.files.delete('a.png');
          throw new Error('half');
        },
      ])
    ).rejects.toThrow('half');
    expect(before.files.list()).toHaveLength(1);
    await stores.migrate('a', [(s) => s.files.write('b', Uint8Array.from([1]))]);
    expect(before.files.list().map((f) => f.name)).toEqual(['a.png', 'b']);
    before.files.delete('a.png');
    expect(before.files.read('a.png')).toBeUndefined();
    stores.delete('a');
    expect(stores.open('a').files.list()).toEqual([]);
  });
});
