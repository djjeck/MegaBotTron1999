import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineSimulator, DevKit, FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { ManifestError } from './manifest.ts';
import { definePlugin, type PluginContext } from './plugin.ts';
import { type MigrationStore } from './store.ts';

/** An actor that answers `ping` with `!pong`, every 10 s on its clock, keeping a count. */
function pinger() {
  let ctx: PluginContext | undefined;
  const plugin = definePlugin({
    manifest: {
      id: 'pinger',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'answers ping',
      inputs: { fake: { type: 'chat-in', bind: { node: 'fake', reads: ['#test'] } } },
      outputs: {
        fake: { type: 'chat-out', bind: { node: 'fake', sends: ['#test'], commands: ['!pong'] } },
      },
      config: z.object({ every: z.number().default(10_000) }),
      settings: z.object({ loud: z.boolean().default(false) }),
    },
    create: (c) => {
      ctx = c;
      const out = c.outbox(c.connector('fake').account);
      let count = c.store.read<number>('count') ?? 0;
      const answer = (): void => {
        out.send('#test', c.settings.kept().loud === true ? '!pong PONG' : '!pong');
        c.store.write('count', ++count);
      };
      const every = (c.config as { every: number }).every;
      const tick = (): void => {
        c.clock.setTimeout(tick, every);
        answer();
      };
      return {
        start: () => {
          c.connector('fake').onMessage((m) => {
            if (m.text === 'ping') answer();
          });
        },
        ready: () => {
          c.clock.setTimeout(tick, every);
        },
      };
    },
  });
  return { plugin, ctx: () => ctx };
}

describe('FakeConnector', () => {
  it('hears what it is told, sends where it is told, and keeps its account and limits', () => {
    const said: string[] = [];
    const c = new FakeConnector({
      account: 'irc:alice',
      limits: { minIntervalMs: 1000, maxPerHour: 60 },
      onSend: (chat, text) => {
        said.push(`${chat} ${text}`);
        return chat === '#test';
      },
    });
    expect([c.account, c.network, c.self(), c.status().state]).toEqual([
      'irc:alice',
      'irc',
      'alice',
      'closed',
    ]);
    const heard: unknown[] = [];
    c.onMessage((m) => heard.push(m));
    c.open('joined');
    expect(c.status()).toEqual({ state: 'connected', phase: 'joined' });
    c.hear({ chat: '#test', sender: 'Bot', text: 'hi', time: 5 });
    expect(heard).toEqual([
      {
        account: 'irc:alice',
        network: 'irc',
        chat: '#test',
        sender: 'Bot',
        text: 'hi',
        time: 5,
        playback: false,
      },
    ]);
    expect([c.send('#test', 'a'), c.send('#other', 'b')]).toEqual([true, false]);
    expect(said).toEqual(['#test a', '#other b']);
    expect(c.sent).toHaveLength(2);
    expect(c.limits).toEqual({ minIntervalMs: 1000, maxPerHour: 60 });
    c.connecting('retrying');
    expect(c.status()).toEqual({ state: 'connecting', phase: 'retrying' });
    c.close('bye');
    expect(c.status()).toEqual({ state: 'closed', phase: 'closed', detail: 'bye' });
    const plain = new FakeConnector({ account: 'telegram:me', self: 'Me' });
    expect([plain.self(), plain.send('x', 'y'), plain.limits]).toEqual(['Me', true, undefined]);
    expect(() => new FakeConnector({ account: 'nobody' })).toThrow('not an account');
  });

  it('keeps the photos it sends, with their caption and reply, or has none (D150)', async () => {
    const c = new FakeConnector({ account: 'telegram:me', onSend: (chat) => chat !== '#closed' });
    const bytes = { data: new Uint8Array([1]), mime: 'image/png' };
    await expect(
      c.deliverPhoto?.('#lobby', bytes, { caption: 'A *card*', format: 'markdown', replyTo: '9' })
    ).resolves.toEqual({ id: 'm1', photo: 'photo-1' });
    await expect(c.deliverPhoto?.('#lobby', 'photo-1')).resolves.toEqual({
      id: 'm2',
      photo: 'photo-1',
    });
    await expect(c.deliverPhoto?.('#closed', bytes)).rejects.toThrow('not sent');
    expect(c.sent).toEqual([
      {
        chat: '#lobby',
        text: 'A *card*',
        photo: bytes,
        format: 'markdown',
        replyTo: '9',
        id: 'photo-1',
      },
      { chat: '#lobby', text: '', photo: 'photo-1', id: 'photo-1' },
    ]);
    expect(new FakeConnector({ account: 'irc:me', noPhotos: true }).deliverPhoto).toBeUndefined();
  });
});

describe('DevKit', () => {
  it('hears an edit it is told, to its listeners of edits alone, by default when it was said (D144)', () => {
    const c = new FakeConnector({ account: 'telegram:alice' });
    const heard: unknown[] = [];
    const edits: unknown[] = [];
    c.onMessage((m) => heard.push(m));
    c.onEdit((m) => edits.push(m));
    c.hearEdit({ chat: '@QuestBot', sender: 'QuestBot', text: 'chosen', time: 5, id: '3' });
    c.hearEdit({
      chat: '@QuestBot',
      sender: 'QuestBot',
      text: 'again',
      time: 5,
      id: '3',
      edited: 9,
    });
    expect(heard).toEqual([]);
    expect(edits).toMatchObject([
      { text: 'chosen', edited: 5, playback: false },
      { text: 'again', edited: 9 },
    ]);
  });

  it('runs a plugin on a virtual clock, with its configuration, settings and documents', async () => {
    const records: { type: string }[] = [];
    const fake = new FakeConnector({ account: 'irc:alice' });
    const p = pinger();
    const kit = new DevKit({
      start: 1000,
      plugins: [fakeConnectorPlugin('fake', fake), p.plugin],
      config: { pinger: { every: 5000 } },
      settings: { pinger: { loud: true } },
      documents: { pinger: { count: 41 } },
      record: (r) => records.push(r),
      validateEvents: true,
    });
    await kit.start();
    fake.open();
    fake.hear({ chat: '#test', sender: 'Bot', text: 'ping', time: 1000 });
    expect(fake.sent).toEqual([{ chat: '#test', text: '!pong PONG' }]);
    kit.runUntil(11_000);
    expect(kit.clock.now()).toBe(11_000);
    expect(fake.sent).toHaveLength(3);
    expect(p.ctx()?.store.read('count')).toBe(44);
    expect(records.some((r) => r.type === 'core.send')).toBe(true);
    await kit.stop();
    expect(kit.core.state('pinger')?.state).toBe('stopped');
  });

  it('migrates the documents given, and keeps the settings given through the migration', async () => {
    let seen: unknown;
    const migrating = definePlugin({
      manifest: {
        id: 'migrating',
        version: '0.1.0',
        kinds: ['stats'],
        description: 'migrates',
        settings: z.object({ n: z.number().default(0) }),
        state: { migrations: [(s: MigrationStore) => s.write('new', { from: s.read('old') })] },
      },
      create: (c) => {
        seen = [c.store.read('new'), c.settings.kept()];
        return {};
      },
    });
    const kit = new DevKit({
      plugins: [migrating],
      documents: { migrating: { old: 7 } },
      settings: { migrating: { n: 3 } },
    });
    await kit.start();
    expect(seen).toEqual([{ from: 7 }, { n: 3 }]);
    expect(kit.core.settings.set('migrating.n', 4)).toBeUndefined();
    expect(kit.core.settings.kept()).toEqual({ n: 4 });
  });

  it('keeps a plugin’s files in memory, with the limits the kit is given (D149)', async () => {
    let ctx: PluginContext | undefined;
    const painter = definePlugin({
      manifest: { id: 'card-painter', version: '0.1.0', kinds: ['stats'], description: 'paints' },
      create: (c) => {
        ctx = c;
        return {};
      },
    });
    const kit = new DevKit({ plugins: [painter], start: 5000, fileLimits: { total: 4 } });
    await kit.start();
    const files = (ctx as PluginContext).store.files;
    files.write('card-42.png', Uint8Array.from([1, 2, 3]));
    expect([...(files.read('card-42.png') as Uint8Array)]).toEqual([1, 2, 3]);
    expect(files.list()).toEqual([
      { name: 'card-42.png', size: 3, type: 'image/png', written: 5000 },
    ]);
    expect(() => files.write('more', Uint8Array.from([1, 2]))).toThrow('an instance may keep');
    expect(kit.core.controls.files('card-painter')?.used).toBe(3);
    await kit.stop();
  });

  it('sends nothing through a dry-run edge, and logs it as sent (D64)', async () => {
    const fake = new FakeConnector({ account: 'irc:alice' });
    const records: { type: string; outcome?: unknown }[] = [];
    const kit = new DevKit({
      plugins: [fakeConnectorPlugin('fake', fake), pinger().plugin],
      graph: (g) => ({
        ...g,
        edges: g.edges.map((e) => (e.type === 'chat-out' ? { ...e, dryRun: true } : e)),
      }),
      record: (r) => records.push(r as { type: string }),
    });
    await kit.start();
    fake.open();
    fake.hear({ chat: '#test', sender: 'Bot', text: 'ping', time: 0 });
    expect(fake.sent).toEqual([]);
    expect(records.filter((r) => r.type === 'core.send').map((r) => r.outcome)).toEqual([
      'dry-run',
    ]);
  });

  it('refuses a run with a setting refused or a plugin failed', async () => {
    const fake = new FakeConnector({ account: 'irc:alice' });
    const bad = new DevKit({
      plugins: [fakeConnectorPlugin('fake', fake), pinger().plugin],
      settings: { pinger: { nope: 1 } },
    });
    await expect(bad.start()).rejects.toThrow('dev kit: setting pinger.nope');
    const failing = definePlugin({
      manifest: { id: 'broken', version: '0.1.0', kinds: ['actor'], description: 'fails' },
      create: () => {
        throw new Error('no');
      },
    });
    await expect(new DevKit({ plugins: [failing] }).start()).rejects.toThrow(
      'dev kit: broken failed (no)'
    );
  });
});

describe('defineSimulator', () => {
  it('checks the manifest, of kind simulator, and plays a run', async () => {
    const sim = defineSimulator({
      manifest: {
        id: 'toy-arena',
        version: '0.1.0',
        kinds: ['simulator'],
        description: 'a toy game',
        games: { consumes: ['toy'] },
      },
      run: async (n: number, o: { double: boolean }) => (o.double ? 2 * n : n),
    });
    expect(sim.manifest.inputs['toy-events']).toEqual({
      type: 'events',
      namespace: 'toy',
      optional: true,
    });
    expect(await sim.run(21, { double: true })).toBe(42);
    expect(() =>
      defineSimulator({
        manifest: { id: 'not-one', version: '0.1.0', kinds: ['actor'], description: 'x' },
        run: async () => 0,
      })
    ).toThrow(ManifestError);
    expect(() =>
      defineSimulator({
        manifest: { id: 'Bad', version: '0.1.0', kinds: ['simulator'], description: 'x' },
        run: async () => 0,
      })
    ).toThrow('bad manifest');
  });
});

describe('DevKit and archived plugins', () => {
  const archived = definePlugin({
    manifest: {
      id: 'old',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'an archive',
      archived: true,
    },
    create: () => ({}),
  });

  it('refuses an archived plugin unless the run allows it', async () => {
    await expect(new DevKit({ plugins: [archived] }).start()).rejects.toThrow('is archived');
    const kit = new DevKit({ plugins: [archived], allowArchived: true });
    await kit.start();
    expect(kit.core.status()).toEqual([{ id: 'old', state: 'running' }]);
  });
});
