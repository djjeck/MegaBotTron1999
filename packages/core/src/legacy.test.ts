import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { controlServer } from './control-server.ts';
import { Core } from './core.ts';
import { EventLog } from './event-log.ts';
import { LegacyError, LegacyImport } from './legacy.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const T0 = Date.UTC(2026, 10, 5, 12);

/** A plugin whose store the older directory kept. */
function counter(seen: PluginContext[]) {
  return definePlugin({
    manifest: {
      id: 'counter',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'counts',
      games: { registers: ['dice'] },
      settings: z.object({ step: z.coerce.number().default(1) }),
      state: { migrations: [() => {}] },
    },
    create: (ctx) => {
      seen.push(ctx);
      return {};
    },
  });
}

let root: string;
let legacy: string;
let data: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  legacy = path.join(root, 'legacy');
  data = path.join(root, 'data');
  const store = path.join(legacy, 'plugins', 'counter');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'state.json'), '{"count":41}\n');
  fs.writeFileSync(path.join(store, '_meta.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(store, '_settings.json'), '{"step":2}\n');
  fs.writeFileSync(path.join(store, '_timers.json'), '{"tick":{"at":1,"late":"fire"}}\n');
  fs.writeFileSync(path.join(store, 'notes.txt'), 'not a document');
  fs.symlinkSync('/etc/hosts', path.join(store, 'link.json'));
  fs.mkdirSync(path.join(store, 'sub.json'));
  fs.mkdirSync(path.join(legacy, 'plugins', 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(legacy, 'plugins', 'core', 'modes.json'),
    '{"counter":"live","other":"x"}'
  );
  fs.mkdirSync(path.join(legacy, 'plugins', 'empty'));
  fs.writeFileSync(path.join(legacy, 'plugins', 'empty', '_timers.json'), '[half');
  fs.writeFileSync(
    path.join(legacy, 'events-2026-11-04.jsonl'),
    [
      JSON.stringify({ type: 'roll', t: T0 - 86_400_000, value: 3 }),
      JSON.stringify({ type: 'dice.roll', t: T0 - 86_400_000 + 1, value: 4 }),
      JSON.stringify({ type: 'line', t: T0 - 86_400_000 + 2 }),
      '{"cut sho',
      'null',
      JSON.stringify({ type: 'dice.roll', value: 5 }),
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(legacy, 'events-2026-11-05.jsonl'),
    `${JSON.stringify({ type: 'dice.roll', t: T0, value: 6 })}\n`
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every file of a directory, with its contents: the older directory, before and after. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(e.parentPath, e.name);
    if (e.isFile()) out[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
    else out[path.relative(dir, file)] = e.isSymbolicLink() ? 'link' : 'dir';
  }
  return out;
}

const importer = (dir = legacy, eventTypes?: string[]): LegacyImport =>
  new LegacyImport({
    dir,
    dataDir: data,
    now: () => T0,
    plugins: () => ['counter', 'other'],
    ...(eventTypes === undefined ? {} : { eventTypes: () => eventTypes }),
  });

describe('the import from an older data directory', () => {
  it('lists its stores and its log, and copies a store into a fresh instance', async () => {
    const before = snapshot(legacy);
    const imp = importer();
    expect(imp.report()).toEqual({
      dir: legacy,
      stores: [
        {
          id: 'counter',
          documents: ['state'],
          version: 1,
          timers: ['tick'],
          settings: true,
          mode: 'live',
        },
        { id: 'empty', documents: [], version: 0, timers: [], settings: false },
      ],
      events: { days: 2, first: '2026-11-04', last: '2026-11-05' },
    });
    expect(imp.importStore({ from: 'counter', instance: 'tally' })).toEqual({
      instance: 'tally',
      plugin: 'counter',
      documents: ['state'],
    });
    const dir = path.join(data, 'instances', 'tally');
    expect(fs.readdirSync(dir).sort()).toEqual([
      '_instance.json',
      '_meta.json',
      '_settings.json',
      '_timers.json',
      'state.json',
    ]);
    expect(fs.statSync(path.join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(() => imp.importStore({ from: 'counter', instance: 'tally' })).toThrow(
      new LegacyError('the instance tally exists already', 409)
    );
    expect(() => imp.importStore({ from: 'counter', plugin: 'nobody' })).toThrow(
      'this instance offers no plugin nobody'
    );
    expect(() => imp.importStore({ from: 'counter', plugin: 'other', instance: 'Bad' })).toThrow(
      'an instance is named in lower-case words and dashes'
    );
    expect(() => imp.importStore({ from: 'core' })).toThrow('give the store to import');
    expect(() => imp.importStore(null)).toThrow('give the store to import');
    expect(() => imp.importStore({ from: 'gone', plugin: 'counter' })).toThrow(
      `${legacy} has no store gone`
    );
    // A node of its plugin runs on it: its documents, settings and timers, not its mode.
    const seen: PluginContext[] = [];
    const core = new Core({
      clock: new VirtualClock(T0),
      dataDir: data,
      graph: { version: 2, nodes: [{ id: 'c', plugin: 'counter', instance: 'tally' }], edges: [] },
    });
    core.register(counter(seen));
    await core.start();
    expect(seen[0]?.store.read('state')).toEqual({ count: 41 });
    expect(seen[0]?.settings.kept()).toEqual({ step: 2 });
    expect(seen[0]?.scheduler.names()).toEqual(['tick']);
    expect(core.modes.get('c')).toBe('read-only');
    await core.stop();
    expect(snapshot(legacy)).toEqual(before);
  });

  it('merges its event log into this one, each record once, its old types renamed', () => {
    const before = snapshot(legacy);
    const log = new EventLog(data);
    log.write({ type: 'dice.roll', t: T0 - 86_400_000 + 1, value: 4 } as never);
    log.write({ type: 'core.plugin', t: T0 - 86_400_000 + 5 });
    const imp = importer();
    expect(imp.importEvents({ types: { roll: 'dice.roll' } })).toEqual({
      days: 2,
      imported: 2,
      present: 1,
      skipped: { line: 1 },
    });
    expect(log.recordsSince(T0 - 2 * 86_400_000, T0).map((r) => [r.type, r['value']])).toEqual([
      ['dice.roll', 3],
      ['dice.roll', 4],
      ['core.plugin', undefined],
      ['dice.roll', 6],
    ]);
    expect(imp.importEvents({ types: { roll: 'dice.roll' } })).toMatchObject({
      imported: 0,
      present: 3,
    });
    expect(imp.importEvents({ since: T0 })).toEqual({
      days: 1,
      imported: 0,
      present: 1,
      skipped: {},
    });
    expect(() => imp.importEvents({ types: { roll: 'plain' } })).toThrow(
      'types: roll → plain: expected <namespace>.<name>'
    );
    expect(() => imp.importEvents({ types: [] })).toThrow('types is a table');
    expect(() => imp.importEvents({ since: 'yesterday' })).toThrow('since is a time');
    expect(imp.importEvents(undefined)).toMatchObject({ days: 2 });
    expect(snapshot(legacy)).toEqual(before);
  });

  it('names the types an import would skip, with the registered ones they may become', () => {
    fs.writeFileSync(
      path.join(legacy, 'events-2026-11-03.jsonl'),
      [
        JSON.stringify({ type: 'roll', t: 1 }),
        JSON.stringify({ type: 'message', t: 2 }),
        '{"not',
        'null',
        JSON.stringify({ t: 3 }),
      ].join('\n')
    );
    const imp = importer(legacy, ['dice.roll', 'quest.message', 'dice.message', 'dice.other']);
    expect(imp.eventTypes()).toEqual({
      types: {
        roll: { count: 2, suggest: ['dice.roll'] },
        message: { count: 1, suggest: ['quest.message', 'dice.message'] },
        line: { count: 1, suggest: [] },
      },
    });
    expect(importer().eventTypes().types['roll']?.suggest).toEqual([]);
  });

  it('says when no older directory is mounted, and serves all this on the control API', async () => {
    const none = importer(path.join(root, 'nowhere'));
    expect(none.mounted()).toBe(false);
    expect(() => none.report()).toThrow(
      new LegacyError(`no older data directory is mounted at ${path.join(root, 'nowhere')}`, 404)
    );
    fs.writeFileSync(path.join(root, 'file'), '');
    expect(importer(path.join(root, 'file')).mounted()).toBe(false);
    // A directory without stores or log offers nothing.
    fs.mkdirSync(path.join(root, 'bare'));
    expect(importer(path.join(root, 'bare')).report()).toEqual({
      dir: path.join(root, 'bare'),
      stores: [],
      events: { days: 0 },
    });
    const core = new Core({ clock: new VirtualClock(T0) });
    await core.start();
    const serve = async (imp: LegacyImport) => {
      const server: http.Server = controlServer({
        controls: core.controls,
        settings: core.settings,
        legacy: imp,
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as { port: number };
      const call = async (p: string, payload?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, {
          ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
        });
        return [res.status, await res.json()] as const;
      };
      return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
    };
    const on = await serve(importer());
    expect((await on.call('/legacy'))[1]).toMatchObject({ stores: [{ id: 'counter' }, {}] });
    expect((await on.call('/legacy/events'))[1]).toMatchObject({ types: { roll: { count: 1 } } });
    expect(await on.call('/instances/import', { from: 'counter' })).toEqual([
      200,
      { instance: 'counter', plugin: 'counter', documents: ['state'] },
    ]);
    expect((await on.call('/instances/import', { from: 'counter' }))[0]).toBe(409);
    expect((await on.call('/instances/import', {}))[0]).toBe(400);
    expect((await on.call('/legacy/events/import', {}))[1]).toMatchObject({ imported: 2 });
    await on.close();
    const off = await serve(none);
    expect((await off.call('/legacy'))[0]).toBe(404);
    await off.close();
    await core.stop();
  });
});
