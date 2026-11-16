import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { secretsWith } from '#test/secrets.ts';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { type LogEntry } from './event-log.ts';
import { GraphFile, graphFileControls } from './graph-file.ts';
import { describeNodes, graphText } from './graph-view.ts';
import { definePlugin } from './plugin.ts';
import { Sealer } from './secrets.ts';
import { HIDDEN, hideSensitive, isHidden, openSensitive, sealSensitive } from './sensitive.ts';

const KEY = 'a-key-made-up-for-the-tests-only';
const TOKEN = 'sensitive-made-up-value-1';
const OTHER = 'sensitive-made-up-value-2';

/** A plugin with a sensitive config key, `token`, that keeps the config it ran with. */
function keeper(seen: unknown[]) {
  return definePlugin({
    manifest: {
      id: 'keeper',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'keeps a token',
      config: z.object({ token: z.string().optional(), label: z.string().optional() }),
      configSensitive: ['token'],
    },
    create: (ctx) => (seen.push(ctx.config), {}),
  });
}

const graphOf = (token: unknown) => ({
  version: 2,
  nodes: [{ id: 'k', plugin: 'keeper', config: { token, label: 'shown' } }],
  edges: [],
});

/** Every file under a directory, as one text. */
function everything(dir: string): string {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => fs.readFileSync(path.join(d.parentPath, d.name), 'utf8'))
    .join('\n');
}

describe('sensitive config values (D124)', () => {
  const keys = (plugin: string) => (plugin === 'keeper' ? ['token'] : []);

  it('are hidden, sealed and opened by one function each, whatever the graph’s shape', () => {
    const sealer = new Sealer(secretsWith({ bot_os_key: KEY }));
    const hidden = hideSensitive(graphOf(TOKEN), keys);
    expect(hidden.nodes[0]?.config).toEqual({ token: HIDDEN, label: 'shown' });
    expect(hideSensitive('not a graph', keys)).toBe('not a graph');
    const plain = { version: 2, nodes: [{ id: 'x', plugin: 'other', config: { token: TOKEN } }] };
    expect(hideSensitive(plain, keys)).toBe(plain);
    const sealed = sealSensitive(graphOf(TOKEN), keys, sealer);
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(sealSensitive(sealed, keys, sealer)).toEqual(sealed);
    expect(sealSensitive(graphOf(TOKEN), keys, undefined)).toEqual(graphOf(TOKEN));
    expect(openSensitive(sealed, keys, sealer)).toEqual({ raw: graphOf(TOKEN), warnings: [] });
    // HIDDEN takes the saved value; none to take, or one that does not open: left out, with why.
    expect(openSensitive(graphOf(HIDDEN), keys, sealer, sealed).raw).toEqual(graphOf(TOKEN));
    const lost = openSensitive(graphOf(HIDDEN), keys, sealer, graphOf(HIDDEN));
    expect(lost.raw).toEqual({
      ...graphOf(TOKEN),
      nodes: [{ id: 'k', plugin: 'keeper', config: { label: 'shown' } }],
    });
    expect(lost.warnings).toEqual(['node k: config token: no value saved to keep: set it again']);
    const other = new Sealer(secretsWith({ bot_os_key: `${KEY}-2` }));
    expect(openSensitive(sealed, keys, other).warnings[0]).toMatch(
      /^node k: config token: its sealed value does not open \(it does not open with this bot_os_key/u
    );
    expect(openSensitive(sealed, keys, undefined).warnings[0]).toMatch(
      /there is no key to open it/u
    );
    expect(isHidden(HIDDEN)).toBe(true);
    expect(graphText(sealed as never)).toContain('config.token: [sensitive]');
    expect(graphText(hidden as never)).toContain('config.label: "shown"');
  });

  it('are sealed in the file and its history, opened for the node, never shown back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-'));
    const secrets = secretsWith({ bot_os_key: KEY });
    const records: LogEntry[] = [];
    const seen: unknown[] = [];
    const clock = new VirtualClock(1_793_000_000_000);
    const start = async () => {
      const file = new GraphFile(dir, () => clock.now());
      const core = new Core({
        clock,
        dataDir: dir,
        graphFile: file,
        secrets,
        record: (r) => records.push(r),
      });
      core.register(keeper(seen));
      await core.start();
      return { core, file, controls: graphFileControls(file, core) };
    };
    // A graph saved by hand, in clear, before D124: hidden in every view, sealed at the next save.
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graphOf(TOKEN)));
    let { core, file, controls } = await start();
    file.started(core);
    expect(seen.at(-1)).toEqual({ token: TOKEN, label: 'shown' });
    const shown: unknown[] = [
      controls.file(),
      controls.check(graphOf(OTHER)),
      controls.check(graphOf(HIDDEN)),
      controls.history(),
      describeNodes(core.nodes(), core.hideSensitive(core.graph() as never)),
      core.hideSensitive(core.graph()),
    ];
    const first = file.history.list()[0]?.id as string;
    shown.push(controls.version(first));
    for (const v of shown) {
      expect(JSON.stringify(v)).not.toContain(TOKEN);
      expect(JSON.stringify(v)).not.toContain(OTHER);
    }
    expect(controls.check(graphOf(HIDDEN))).toMatchObject({ ok: true, warnings: [] });
    // Saved from the editor, unchanged (HIDDEN): the saved value kept, sealed.
    clock.advance(1000);
    controls.save({
      ...graphOf(HIDDEN),
      nodes: [{ ...graphOf(HIDDEN).nodes[0], config: { token: HIDDEN, label: 'renamed' } }],
    });
    expect(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')).not.toContain(TOKEN);
    await core.stop();
    ({ core, file, controls } = await start());
    expect(seen.at(-1)).toEqual({ token: TOKEN, label: 'renamed' });
    // Replaced: the new value sealed; rolling back to the clear version prints neither.
    clock.advance(1000);
    controls.save(graphOf(OTHER));
    const back = controls.rollbackTo(first);
    for (const v of [back, controls.version(first), controls.file(), controls.history()]) {
      expect(JSON.stringify(v)).not.toContain(TOKEN);
      expect(JSON.stringify(v)).not.toContain(OTHER);
    }
    await core.stop();
    expect(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(JSON.stringify(records)).not.toContain(OTHER);
    // The history keeps the version saved in clear by hand until it ages out; every other is sealed.
    expect(everything(path.join(dir, 'graph-history')).split(TOKEN)).toHaveLength(2);
    expect(everything(dir)).not.toContain(OTHER);
  });

  it('do not open with another key: the node runs without, and the check says why', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-'));
    const sealed = sealSensitive(
      graphOf(TOKEN),
      keys,
      new Sealer(secretsWith({ bot_os_key: KEY }))
    );
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(sealed));
    const seen: unknown[] = [];
    const file = new GraphFile(dir);
    const core = new Core({
      clock: new VirtualClock(1),
      dataDir: dir,
      graphFile: file,
      secrets: secretsWith({ bot_os_key: `${KEY}-2` }),
    });
    core.register(keeper(seen));
    await core.start();
    expect(seen).toEqual([{ label: 'shown' }]);
    expect(core.check(sealed).warnings?.map((w) => w.text)).toEqual([
      expect.stringMatching(/^node k: config token: its sealed value does not open/u),
    ]);
    await core.stop();
  });
});
