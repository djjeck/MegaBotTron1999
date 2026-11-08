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
