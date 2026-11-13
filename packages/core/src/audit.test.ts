/**
 * The config keys a manifest audits (bot-os.md D75): each save or rollback of the graph that
 * changes one records who wrote it, when, and its SHA-256 in the event log, never its value.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type BusEvent } from './bus.ts';
import { VirtualClock } from './clock.ts';
import { ACTOR_HEADER, controlServer } from './control-server.ts';
import { Core, type CoreRecord } from './core.ts';
import { type GraphInput } from './graph.ts';
import { GraphFile, graphFileControls } from './graph-file.ts';
import { definePlugin, type Plugin } from './plugin.ts';

/** A made-up plugin whose `code` is audited, through its nodes' own manifests. */
const scripted: Plugin = definePlugin({
  manifest: {
    id: 'scripted',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'Runs code',
    config: z.object({ code: z.string().default('') }),
    audit: ['code'],
    node: () => ({
      id: 'scripted',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'Runs code',
      config: z.object({ code: z.string().default('') }),
      audit: ['code'],
    }),
  },
  create: () => ({}),
});
const plain: Plugin = definePlugin({
  manifest: { id: 'plain', version: '0.1.0', kinds: ['stats'], description: 'Plain' },
  create: () => ({}),
});

const graph = (code?: string): GraphInput => ({
  version: 2,
  nodes: [
    { id: 'look', plugin: 'scripted', ...(code === undefined ? {} : { config: { code } }) },
    { id: 'p', plugin: 'plain' },
  ],
  edges: [],
});
const hash = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function instance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbt-audit-'));
  const clock = new VirtualClock(Date.UTC(2026, 10, 12, 10));
  const records: (CoreRecord | BusEvent)[] = [];
  const file = new GraphFile(dir, () => clock.now());
  const core = new Core({ clock, dataDir: dir, graphFile: file, record: (r) => records.push(r) });
  core.register(scripted, plain);
  await core.start();
  server = controlServer({
    controls: core.controls,
    settings: core.settings,
    graphFile: graphFileControls(file, core),
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const call = async (p: string, method: string, payload?: unknown, by?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      ...(by === undefined ? {} : { headers: { [ACTOR_HEADER]: by } }),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return res.status;
  };
  const audited = () => records.filter((r) => r.type === 'core.config');
  return { core, call, audited, clock };
}

describe('a save of the graph', () => {
  it('records each audited key it changes: who, when, the hash; never the value', async () => {
    const { core, call, audited } = await instance();
    expect(
      await call('/graph/file', 'PUT', graph('on("a.b", f)'), 'the web UI (session 1a2b3c4d)')
    ).toBe(200);
    expect(audited()).toEqual([
      {
        type: 'core.config',
        t: Date.UTC(2026, 10, 12, 10),
        event: 'saved',
        node: 'look',
        plugin: 'scripted',
        key: 'code',
        sha256: hash('on("a.b", f)'),
        by: 'the web UI (session 1a2b3c4d)',
        source: 'save',
        version: '2026-11-12T10-00-00.000Z',
      },
    ]);
    expect(JSON.stringify(audited())).not.toContain('on(');
    // The same code saved again, and a change elsewhere: nothing more.
    expect(
      await call('/graph/file', 'PUT', {
        ...graph('on("a.b", f)'),
        nodes: [graph('on("a.b", f)').nodes[0]],
      })
    ).toBe(200);
    expect(audited()).toHaveLength(1);
    // Rolled back to the version before: the code changes back, through the loopback.
    expect(await call('/graph/rollback', 'POST')).toBe(200);
    expect(audited()).toHaveLength(1);
    expect(await call('/graph/file', 'PUT', graph())).toBe(200);
    expect(audited()[1]).toMatchObject({
      event: 'removed',
      node: 'look',
      by: 'the control API (loopback)',
      source: 'save',
    });
    expect(audited()[1]).not.toHaveProperty('sha256');
    await core.stop();
  });

  it('records a node removed, and a key changed by a rollback', async () => {
    const { core, call, audited } = await instance();
    await call('/graph/file', 'PUT', graph('one'));
    await call('/graph/file', 'PUT', graph('two'));
    expect(await call('/graph/rollback', 'POST', undefined, 'the web UI (session 00000000)')).toBe(
      200
    );
    expect(audited().map((r) => [r['event'], r['sha256'], r['source'], r['by']])).toEqual([
      ['saved', hash('one'), 'save', 'the control API (loopback)'],
      ['saved', hash('two'), 'save', 'the control API (loopback)'],
      ['saved', hash('one'), 'rollback', 'the web UI (session 00000000)'],
    ]);
    await call('/graph/file', 'PUT', { version: 2, nodes: [], edges: [] });
    expect(audited()[3]).toMatchObject({ event: 'removed', node: 'look', source: 'save' });
    // A node of a plugin the instance does not offer audits nothing.
    core.written(
      { nodes: [{ id: 'x', plugin: 'gone', config: { code: 'a' } }] },
      { version: 2, nodes: [], edges: [] },
      { source: 'save' }
    );
    expect(audited()).toHaveLength(4);
    await core.stop();
  });
});
