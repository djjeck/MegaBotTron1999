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
    expect(fs.readFileSync(path.join(dataDir, 'plugins', 'a', 'state.json'), 'utf8')).toBe(
      '{"last":5}\n'
    );
    expect(fs.statSync(path.join(dataDir, 'plugins', 'a', 'state.json')).mode & 0o777).toBe(0o600);
    a.remove('other');
    expect(a.names()).toEqual(['state']);
    expect(stores.open('nobody').names()).toEqual([]);
    expect(stores.dirOf('a')).toBe(path.join(dataDir, 'plugins', 'a'));
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
    fs.writeFileSync(path.join(dataDir, 'plugins', 'a', 'state.json'), '{half');
    expect(() => stores.open('a').read('state')).toThrow('document state is not JSON');
    fs.mkdirSync(path.join(dataDir, 'plugins', 'a', 'dir.json'));
    expect(() => stores.open('a').read('dir')).toThrow();
  });

  it('migrates from the version kept, adopting a file of the root, renamed once done', async () => {
    fs.writeFileSync(path.join(dataDir, 'ledger.json'), '{"last":1234}\n');
    const stores = new Stores(dataDir);
    const steps = [
      (s: MigrationStore) => {
        expect(s.adopt('ledger.json', 'state')).toBe(true);
        expect(s.adopt('missing.json', 'none')).toBe(false);
      },
      (s: MigrationStore) => {
        const old = s.read<{ last: number }>('state');
        s.write('state', { ...old, v: 2 });
        expect(s.names()).toEqual(['state']);
      },
    ];
    await stores.migrate('ledger', steps);
    expect(stores.version('ledger')).toBe(2);
    expect(stores.open('ledger').read('state')).toEqual({ last: 1234, v: 2 });
    expect(fs.existsSync(path.join(dataDir, 'ledger.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'ledger.json.migrated'))).toBe(true);
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
    expect(fs.readdirSync(path.join(dataDir, 'plugins'))).toEqual(['ledger']);
  });

  it('leaves the store as it was when a migration fails', async () => {
    fs.writeFileSync(path.join(dataDir, 'old.json'), '{"x":1}');
    const stores = new Stores(dataDir);
    stores.open('a').write('state', { kept: true });
    await expect(
      stores.migrate('a', [
        (s) => {
          s.adopt('old.json', 'state');
          s.write('extra', 1);
        },
        () => Promise.reject(new Error('nope')),
      ])
    ).rejects.toThrow('migration 1 → 2 failed: nope');
    expect(stores.open('a').read('state')).toEqual({ kept: true });
    expect(stores.open('a').names()).toEqual(['state']);
    expect(stores.version('a')).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'old.json'))).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, 'plugins'))).toEqual(['a']);
    await expect(
      stores.migrate('a', [
        () => {
          throw 'a string';
        },
      ])
    ).rejects.toThrow('migration 0 → 1 failed: a string');
  });

  it('refuses a store newer than the plugin, and an adopted path outside the root', async () => {
    const stores = new Stores(dataDir);
    await stores.migrate('a', [() => {}, () => {}]);
    await expect(stores.migrate('a', [() => {}])).rejects.toThrow(
      'its store is at version 2, newer than the 1 it knows'
    );
    await expect(
      stores.migrate('b', [
        (s) => {
          s.adopt('../etc/passwd', 'x');
        },
      ])
    ).rejects.toThrow('not a file of the app of before the core: "../etc/passwd"');
    for (const file of ['/etc/passwd', 'plugins/c/x.json', 'map/./x.json', '.hidden'])
      await expect(
        stores.migrate('b', [
          (s) => {
            s.adopt(file, 'x');
          },
        ])
      ).rejects.toThrow('not a file of the app of before the core');
  });

  it('adopts a file in a folder of the volume, read as JSON or by its own reader', async () => {
    fs.mkdirSync(path.join(dataDir, 'map'));
    fs.writeFileSync(path.join(dataDir, 'map', 'm.json'), '{"pairs":[]}');
    fs.writeFileSync(path.join(dataDir, 'map', 'map.png'), Buffer.from([0x89, 0x50, 0x4e]));
    const stores = new Stores(dataDir);
    await stores.migrate('u', [
      (s) => {
        expect(s.adopt('map/m.json', 'measurements')).toBe(true);
        expect(
          s.adopt('map/map.png', 'png', (bytes) => ({ base64: bytes.toString('base64') }))
        ).toBe(true);
        expect(s.adopt('map/none.png', 'none', () => 1)).toBe(false);
      },
    ]);
    expect(stores.open('u').read('measurements')).toEqual({ pairs: [] });
    expect(stores.open('u').read('png')).toEqual({ base64: 'iVBO' });
    expect(fs.readdirSync(path.join(dataDir, 'map')).sort()).toEqual([
      'm.json.migrated',
      'map.png.migrated',
    ]);
  });
});

describe('Stores, in memory', () => {
  it('keeps documents and migrates them, with nothing to adopt', async () => {
    const stores = new Stores();
    expect(stores.dirOf('a')).toBeUndefined();
    stores.open('a').write('state', 1);
    expect(stores.open('a').read('state')).toBe(1);
    await stores.migrate('a', [(s) => expect(s.adopt('x.json', 'x')).toBe(false)]);
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
    const dir = path.join(dataDir, 'plugins', 'a');
    fs.renameSync(dir, `${dir}.old`);
    fs.mkdirSync(`${dir}.migrating`);
    await stores.migrate('a', [() => {}, (s) => s.write('v2', true)]);
    expect(stores.open('a').read('state')).toEqual({ kept: 1 });
    expect(stores.open('a').read('v2')).toBe(true);
    expect(stores.version('a')).toBe(2);
    expect(fs.readdirSync(path.join(dataDir, 'plugins'))).toEqual(['a']);
  });
});
