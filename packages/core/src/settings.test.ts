import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { definePlugin, type Plugin } from './plugin.ts';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const onOff = z
  .union([z.boolean(), z.enum(['on', 'off'])])
  .transform((v) => v === true || v === 'on')
  .describe('a switch');
const count = z.coerce.number().int().min(0).max(9).describe('a count');

function plugin(id: string, settings: z.ZodObject, seen: string[] = []): Plugin {
  return definePlugin({
    manifest: { id, version: '0.1.0', kinds: ['stats'], description: id, settings },
    create: () => ({ settingsChanged: () => seen.push(`${id} changed`) }),
  });
}

function core(extra: Partial<ConstructorParameters<typeof Core>[0]> = {}) {
  const lines: string[] = [];
  return {
    core: new Core({ clock: new VirtualClock(), dataDir, print: (l) => lines.push(l), ...extra }),
    lines,
  };
}

describe('settings in the core', () => {
  it('are each plugin’s, kept in its store, set by bare names or plugin.key', async () => {
    const live: Record<string, unknown> = {};
    const seen: string[] = [];
    const { core: c } = core({ settings: z.object({ every: count }) });
    c.register(
      plugin('a', z.object({ on: onOff, n: count }), seen),
      plugin('b', z.object({ on: onOff }), seen)
    );
    c.load();
    c.settings.serve({
      apply: (p, k, v) => (live[`${p}.${k}`] = v),
      read: (p, k) => live[`${p}.${k}`] as never,
    });
    await c.start();
    expect(c.settings.keys()).toEqual(['every', 'a.on', 'n', 'b.on']);
    expect(c.settings.set('on', 'on')).toBe('on is a setting of a and b: name it plugin.on');
    expect(c.settings.set('a.on', 'on')).toBeUndefined();
    expect(c.settings.set('n', '12')).toMatch(/^Too big/u);
    expect(c.settings.set('n', '3')).toBeUndefined();
    expect(c.settings.set('every', 2)).toBeUndefined();
    expect(c.settings.set('x.n', 1)).toMatch(/^no setting x\.n: every, a\.on, n, b\.on$/u);
    expect(c.settings.current()).toEqual({ every: 2, 'a.on': true, n: 3, 'b.on': undefined });
    expect(seen).toEqual(['a changed', 'a changed']);
    expect(c.settings.of('a')?.help('on')).toBe('a switch');
    expect(c.settings.owner('n')).toBe('a');
    expect(c.settings.owner('on')).toBeUndefined();
    // Kept across a restart, in each plugin's store.
    const again = core().core;
    again.register(
      plugin('a', z.object({ on: onOff, n: count })),
      plugin('b', z.object({ on: onOff }))
    );
    again.load();
    expect(again.settings.kept()).toEqual({ 'a.on': true, n: 3 });
    const applied: string[] = [];
    again.settings.serve({
      apply: (p, k, v) => applied.push(`${p}.${k}=${String(v)}`),
      read: () => undefined,
    });
    again.settings.putInForce();
    expect(applied).toEqual(['a.on=true', 'a.n=3']);
  });

  it('migrate the settings file of before the core, once, keeping what no plugin has', () => {
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ n: 4, every: 1, gone: true, on: true })
    );
    const { core: c, lines } = core({
      legacySettings: 'settings.json',
      settings: z.object({ every: count }),
    });
    c.register(
      plugin('a', z.object({ n: count, on: onOff })),
      plugin('b', z.object({ on: onOff }))
    );
    c.load();
    c.load();
    expect(c.settings.kept()).toEqual({ every: 1, n: 4 });
    expect(fs.existsSync(path.join(dataDir, 'settings.json.migrated'))).toBe(true);
    expect(lines).toEqual([
      'core: settings.json migrated into a, core; no plugin has gone, on, kept in settings.json.migrated',
    ]);
    // A later start does nothing more; and the store's own settings win over an old file.
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ n: 9 }));
    const later = core({ legacySettings: 'settings.json' });
    later.core.register(plugin('a', z.object({ n: count, on: onOff })));
    later.core.load();
    expect(later.core.settings.kept()).toEqual({ n: 4 });
    expect(fs.readFileSync(path.join(dataDir, 'settings.json.migrated'), 'utf8')).toContain('gone');
    expect(fs.existsSync(path.join(dataDir, 'settings.json.migrated.0'))).toBe(true);
    const none = core({ legacySettings: 'missing.json' });
    none.core.load();
    expect(none.lines).toEqual([]);
  });

  it('log a plugin whose settingsChanged throws, and keep the setting', async () => {
    const { core: c, lines } = core();
    c.register(
      definePlugin({
        manifest: {
          id: 'a',
          version: '0.1.0',
          kinds: ['stats'],
          description: 'a',
          settings: z.object({ n: count }),
        },
        create: () => ({
          settingsChanged: () => {
            throw new Error('bad');
          },
        }),
      })
    );
    await c.start();
    expect(c.settings.set('n', 1)).toBeUndefined();
    expect(c.settings.kept()).toEqual({ n: 1 });
    expect(lines).toEqual(['a: error: settingsChanged: bad']);
  });

  it('give a plugin its configuration, or an empty one', async () => {
    const got: unknown[] = [];
    const { core: c } = core({ config: { a: { port: '8080' } } });
    for (const id of ['a', 'b'])
      c.register(
        definePlugin({
          manifest: {
            id,
            version: '0.1.0',
            kinds: ['stats'],
            description: id,
            config: z.object({ port: z.coerce.number().default(1) }),
          },
          create: (ctx) => {
            got.push(ctx.config);
            return {};
          },
        })
      );
    await c.start();
    expect(got).toEqual([{ port: 8080 }, { port: 1 }]);
  });
});
