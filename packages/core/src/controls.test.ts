import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { type Answer, type AnswerOptions, type ChatCommand, tapOf } from './commands.ts';
import { controlServer } from './control-server.ts';
import { KILLED } from './controls.ts';
import { Core, type CoreRecord } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { lamp, showValue } from './owner-commands.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

/** An actor that sends to `#chat` on the fake account, with its controls declared. */
function actor(seen: string[], grab: (ctx: PluginContext) => void = () => {}) {
  let count = 0;
  return definePlugin({
    manifest: {
      id: 'actor',
      version: '0.1.0',
      kinds: ['actor'],
      description: 'acts',
      requires: ['chat'],
      reach: [{ connector: 'chat', sends: ['#chat'] }],
      settings: z.object({
        loud: z.preprocess((v) => (v === 'on' ? true : v === 'off' ? false : v), z.boolean()),
        level: z.coerce.number(),
      }),
      interface: {
        state: {
          status: { help: 'how it is', output: z.object({ count: z.number() }) },
          broken: { help: 'throws', output: z.number() },
          absent: { help: 'not offered', output: z.number() },
        },
        actions: {
          bump: { help: 'counts up', input: z.object({ by: z.number().int() }) },
          refuse: { help: 'always refuses', input: z.object({}) },
        },
        commands: {
          poke: { help: 'pokes it', owner: true },
          tac: { help: 'a button', owner: true, hidden: true },
        },
      },
    },
    create: (ctx) => {
      grab(ctx);
      ctx.mode.onChange((m) => seen.push(`mode ${m}`));
      const values: Record<string, unknown> = { loud: false, level: 1 };
      return {
        settings: {
          apply: (key, value) => {
            values[key] = value;
          },
          read: (key) => values[key] as boolean,
        },
        interface: {
          state: {
            status: () => ({ count }),
            broken: () => {
              throw new Error('no way');
            },
          },
          actions: {
            bump: (input: { by: number }) => (count += input.by),
            refuse: () => Promise.reject(new Error('not now')),
          },
        },
        commands: {
          poke: { run: (a: Answer) => a.text('poked') },
          tac: { run: (a: Answer, r) => a.text(`tac ${r.args}`) },
        },
        off: () => seen.push('off'),
        on: () => 'actor back',
        kill: () => ({ text: 'actor stopped', buttons: [[{ label: 'On', action: 'master:on' }]] }),
        pause: (why) => seen.push(`pause ${why}`),
        resume: () => seen.push('resume'),
      };
    },
  });
}

/** A plugin whose hooks throw, and one with no controls at all. */
const broken = definePlugin({
  manifest: { id: 'broken', version: '0.1.0', kinds: ['stats'], description: 'breaks' },
  create: () => ({
    off: () => {
      throw new Error('cannot stop');
    },
    kill: () => 'broken stopped',
  }),
});

function instance(more: Partial<ConstructorParameters<typeof Core>[0]> = {}) {
  const seen: string[] = [];
  const told: string[] = [];
  const records: CoreRecord[] = [];
  const lines: string[] = [];
  let ctx: PluginContext | undefined;
  const core = new Core({
    clock: new VirtualClock(1000),
    notify: (t, b) => told.push(b === undefined ? t : `${t} [${b.flat().map((x) => x.label)}]`),
    record: (r) => records.push(r as CoreRecord),
    print: (l) => lines.push(l),
    home: { label: '← Status', action: 'status' },
    ...more,
  });
  core.register(
    fakeConnectorPlugin('chat', new FakeConnector({ account: 'chat:me' })),
    actor(seen, (c) => (ctx = c)),
    broken
  );
  return {
    core,
    seen,
    told,
    records,
    lines,
    ctx: () => ctx as PluginContext,
  };
}

/** Runs a command and keeps what it answered. */
async function ask(command: ChatCommand | undefined, args = '') {
  const said: { text: string; options?: AnswerOptions }[] = [];
  await command?.run(
    {
      text: (text, _format, options) => {
        said.push({ text, ...(options === undefined ? {} : { options }) });
        return Promise.resolve();
      },
      photo: () => Promise.resolve(undefined),
    },
    { args }
  );
  return said;
}

describe('tapOf', () => {
  it('reads a button’s action as a command and its text', () => {
    expect(tapOf('/report 8')).toEqual({ name: 'report', args: '8' });
    expect(tapOf('opt:fast:on')).toEqual({ name: 'opt', args: 'fast:on' });
    expect(tapOf('kill')).toEqual({ name: 'kill', args: '' });
    expect(tapOf('not a command')).toBeUndefined();
  });
});

describe('Controls', () => {
  it('shows each plugin with its state, mode, settings, reads, actions and own status', async () => {
    const { core } = instance();
    await core.start();
    expect(core.controls.status()).toEqual({
      off: false,
      plugins: [
        expect.objectContaining({ id: 'chat', state: 'running', settings: {}, reads: [] }),
        {
          id: 'actor',
          plugin: 'actor',
          description: 'acts',
          kinds: ['actor'],
          state: 'running',
          mode: 'read-only',
          settings: { loud: false, level: 1 },
          reads: ['status', 'broken', 'absent'],
          actions: ['bump', 'refuse'],
          status: { count: 0 },
        },
        expect.objectContaining({ id: 'broken', state: 'running' }),
      ],
    });
    expect(core.controls.hasMode('chat')).toBe(false);
  });

  it('sets modes, resumes, reads and acts as the owner, refusing what is not declared', async () => {
    const { core, seen, ctx } = instance();
    await core.start();
    expect(core.controls.setMode('actor', 'live')).toBeUndefined();
    expect(ctx().mode.get()).toBe('live');
    expect(seen).toContain('mode live');
    expect(core.controls.setMode('actor', 'loud')).toBe('mode must be read-only, dry-run or live');
    expect(core.controls.setMode('chat', 'live')).toBe('chat sends nothing: it has no mode');
    expect(core.controls.setMode('nobody', 'live')).toBe('no plugin nobody');
    expect(ctx().mode.set('live', 'safety')).toBe('only the owner raises a mode');
    expect(core.controls.resume('actor')).toBe('actor is not paused');
    expect(core.controls.resume('nobody')).toBe('no plugin nobody');
    core.pause('actor', 'drift');
    expect(core.controls.resume('actor')).toBeUndefined();
    core.pause('actor', 'drift');
    expect(ctx().resume()).toBe(true);
    expect(ctx().resume()).toBe(false);
    expect(seen.filter((s) => s === 'resume')).toHaveLength(2);
    expect(core.controls.read('actor', 'status')).toEqual({ value: { count: 0 } });
    expect(core.controls.read('actor', 'broken')).toEqual({ error: 'no way' });
    expect(core.controls.read('actor', 'absent')).toEqual({ error: 'actor is not running' });
    expect(core.controls.read('actor', 'secret')).toEqual({
      error: 'actor declares no read secret',
    });
    expect(core.controls.read('nobody', 'x')).toEqual({ error: 'no plugin nobody' });
    expect(await core.controls.act('actor', 'bump', { by: 2 })).toEqual({ output: 2 });
    expect(await core.controls.act('actor', 'bump', { by: 'x' })).toEqual({
      error: 'by: Invalid input: expected number, received string',
    });
    expect(await core.controls.act('actor', 'refuse', {})).toEqual({
      error: 'not now',
      refused: true,
    });
    expect(await core.controls.act('actor', 'fly', {})).toEqual({
      error: 'actor declares no action fly',
    });
    expect(await core.controls.act('nobody', 'fly', {})).toEqual({ error: 'no plugin nobody' });
    await core.stop();
    expect(await core.controls.act('actor', 'bump', { by: 1 })).toEqual({
      error: 'actor is not running',
    });
  });

  it('turns the instance off and on, kept, logged, heard, and silent meanwhile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controls-'));
    const { core, seen, told, records, lines, ctx } = instance({ dataDir: dir });
    await core.start();
    expect(core.controls.turnOff()).toBe('off');
    expect(core.controls.turnOff()).toBe('already off');
    expect(ctx().off()).toBe(true);
    expect(seen).toContain('off');
    expect(lines).toContain('broken: error: cannot stop');
    ctx().notify('nobody hears this');
    expect(core.controls.setMode('actor', 'live')).toBe('the bot is off: `cli.ts on` first');
    expect(core.controls.resume('actor')).toBe('the bot is off: `cli.ts on` first');
    expect(told).toEqual([]);
    // Kept across a restart.
    await core.stop();
    const again = instance({ dataDir: dir });
    await again.core.start();
    expect(again.core.controls.off).toBe(true);
    expect(again.core.controls.turnOn()).toBe('actor back');
    expect(again.core.controls.turnOn()).toBe('already on');
    again.ctx().notify('heard', [[{ label: 'Go', action: 'go' }]]);
    expect(again.told).toEqual(['heard [Go]']);
    expect(
      [...records, ...again.records].filter((r) => r.type === 'core.power').map((r) => r['off'])
    ).toEqual([true, false]);
    await again.core.stop();
  });

  it('shows each account with its connection, and each parser’s drift', async () => {
    const connector = new FakeConnector({ account: 'chat:me', self: 'me_' });
    const key = definePlugin({
      manifest: {
        id: 'key',
        version: '0.1.0',
        kinds: ['connector'],
        description: 'fails to make its connector',
        account: 'api:me',
      },
      create: () => ({}),
    });
    const core = new Core({ clock: new VirtualClock(1000) });
    core.register(fakeConnectorPlugin('chat', connector), key);
    expect(core.controls.accounts()).toEqual([]);
    await core.start();
    connector.open('joined');
    expect(core.controls.accounts()).toEqual([
      {
        id: 'chat',
        plugin: 'chat',
        account: 'chat:me',
        state: 'running',
        network: 'chat',
        self: 'me_',
        connection: { state: 'connected', phase: 'joined' },
      },
      {
        id: 'key',
        plugin: 'key',
        account: 'api:me',
        state: 'failed',
        reason: 'a connector plugin offers no connector',
      },
    ]);
    expect(core.controls.drift()).toEqual(core.drift());
  });

  it('pulls the kill switch: each plugin’s own, with their ways on', async () => {
    const { core } = instance();
    await core.start();
    expect(core.controls.kill()).toEqual({
      text: 'Killed: actor stopped; broken stopped',
      buttons: [[{ label: 'On', action: 'master:on' }], [{ label: 'Kill', action: 'kill' }]],
    });
  });
});

describe('a node’s kill (D44)', () => {
  it('runs its own safety stop, pauses it as killed, and its resume reinstates it', async () => {
    const { core, seen, records, ctx } = instance();
    await core.start();
    expect(core.controls.setMode('actor', 'live')).toBeUndefined();
    expect(core.controls.killNode('actor')).toEqual({ result: 'actor killed: actor stopped' });
    expect(seen).toContain(`pause ${KILLED}`);
    expect(core.controls.status().plugins[1]).toMatchObject({
      id: 'actor',
      state: 'paused',
      reason: KILLED,
      killed: true,
      // Its mode is as its own stop left it; the core does not lower it.
      mode: 'live',
    });
    // The other nodes go on, and the killed one's settings and mode can still be changed.
    expect(core.controls.status().plugins[0]).toMatchObject({ id: 'chat', state: 'running' });
    expect(core.settings.set('level', 4)).toBeUndefined();
    expect(core.controls.setMode('actor', 'dry-run')).toBeUndefined();
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'core.plugin',
        plugin: 'actor',
        state: 'paused',
        reason: KILLED,
      })
    );
    expect(ctx().resume()).toBe(true);
    expect(core.controls.status().plugins[1]).not.toHaveProperty('killed');
    expect(core.controls.killNode('actor')).toMatchObject({ result: expect.any(String) });
    expect(core.controls.resume('actor')).toBeUndefined();
    expect(core.controls.status().plugins[1]).toMatchObject({ state: 'running' });
  });

  it('kills a node a drift paused, and one with no stop of its own, its error logged', async () => {
    const quiet = definePlugin({
      manifest: { id: 'quiet', version: '0.1.0', kinds: ['stats'], description: 'no stop' },
      create: () => ({}),
    });
    const throws = definePlugin({
      manifest: { id: 'throws', version: '0.1.0', kinds: ['stats'], description: 'bad stop' },
      create: () => ({
        kill: () => {
          throw new Error('cannot stop');
        },
      }),
    });
    const lines: string[] = [];
    const core = new Core({ clock: new VirtualClock(1000), print: (l) => lines.push(l) });
    core.register(quiet, throws);
    await core.start();
    expect(core.controls.killNode('quiet')).toEqual({ result: 'quiet killed' });
    expect(core.controls.killNode('throws')).toEqual({ result: 'throws killed' });
    expect(lines).toContain('throws: error: cannot stop');
    core.pause('quiet', 'drift');
    expect(core.controls.status().plugins[0]).toMatchObject({ killed: true });
    expect(core.controls.killNode('nobody')).toEqual({ error: 'no plugin nobody' });
    await core.stop();
    expect(core.controls.killNode('quiet')).toEqual({ error: 'quiet is not running' });
    expect(core.killNode('quiet')).toBe(false);
    expect(core.killNode('nobody')).toBe(false);
  });

  it('replaces a drift’s pause with the kill', async () => {
    const { core, seen } = instance();
    await core.start();
    core.pause('actor', 'drift');
    core.controls.killNode('actor');
    expect(core.controls.status().plugins[1]).toMatchObject({ reason: KILLED, killed: true });
    expect(seen.filter((s) => s.startsWith('pause'))).toEqual(['pause drift']);
  });
});

describe('the core’s commands', () => {
  const named = (core: Core, name: string) => core.commands().find((c) => c.name === name);

  it('are the owner’s, after the plugins’, the buttons’ in no menu', async () => {
    const { core } = instance();
    await core.start();
    const commands = core.commands();
    expect(commands.map((c) => `${c.plugin} ${c.name}${c.hidden ? ' (hidden)' : ''}`)).toEqual([
      'actor poke',
      'actor tac (hidden)',
      'core plugins',
      'core kill',
      'core settings',
      'core set',
      'core mode (hidden)',
      'core resume (hidden)',
      'core off (hidden)',
      'core on (hidden)',
    ]);
    for (const c of commands) {
      expect(c.allow?.({ id: '1', owner: true })).toBe(true);
      expect(c.allow?.({ id: '2' })).toBe(false);
    }
    expect(await ask(named(core, 'tac'), 'evade:on')).toEqual([{ text: 'tac evade:on' }]);
  });

  it('show the plugins and each one, and change their modes and the off switch', async () => {
    const { core } = instance();
    await core.start();
    const [list] = await ask(named(core, 'plugins'));
    expect(list?.text).toBe(
      [
        'The bot is on. Its plugins, with their modes:',
        '🟢 chat: running',
        '🟢 actor: running · read-only',
        '🟢 broken: running',
      ].join('\n')
    );
    expect(list?.options?.buttons).toEqual([
      [{ label: '🔴 Turn the bot off', action: 'off' }],
      [
        { label: 'chat', action: 'plugins:chat' },
        { label: 'actor', action: 'plugins:actor' },
      ],
      [{ label: 'broken', action: 'plugins:broken' }],
      [{ label: '← Status', action: 'status' }],
    ]);
    core.pause('actor', 'drift');
    const [one] = await ask(named(core, 'plugins'), 'actor');
    expect(one?.text).toBe(
      [
        '⏸️ actor: acts',
        'State: paused (drift)',
        'Mode: read-only',
        'loud: off',
        'level: 1',
        'Reads: status, broken, absent',
        'Actions: bump, refuse',
      ].join('\n')
    );
    expect(one?.options?.buttons?.slice(0, 2)).toEqual([
      [
        { label: '✅ read-only', action: 'mode:actor:read-only' },
        { label: '⬜ dry-run', action: 'mode:actor:dry-run' },
        { label: '⬜ live', action: 'mode:actor:live' },
      ],
      [{ label: '▶️ Resume', action: 'resume:actor' }],
    ]);
    expect((await ask(named(core, 'plugins'), 'nobody'))[0]?.text).toMatch(
      /^Refused: no plugin nobody\nThe bot is on/u
    );
    expect((await ask(named(core, 'resume'), 'actor'))[0]?.text).toMatch(/^🟢 actor: acts/u);
    expect((await ask(named(core, 'mode'), 'actor:live'))[0]?.text).toContain('Mode: live');
    expect((await ask(named(core, 'mode'), 'actor loud'))[0]?.text).toMatch(/^Refused: mode must/u);
    const [off] = await ask(named(core, 'off'));
    expect(off?.text).toMatch(/^The bot is off\./u);
    expect(off?.options?.buttons?.[0]).toEqual([{ label: '🟢 Turn the bot on', action: 'on' }]);
    expect((await ask(named(core, 'off')))[0]?.text).toMatch(/^Refused: already off/u);
    expect((await ask(named(core, 'kill')))[0]).toEqual({
      text: 'The bot is off: `cli.ts on` first',
      options: { keep: true },
    });
    expect((await ask(named(core, 'on')))[0]?.text).toMatch(/^actor back\nThe bot is on\./u);
    expect((await ask(named(core, 'kill')))[0]).toMatchObject({
      text: 'Killed: actor stopped; broken stopped',
      options: { keep: true },
    });
  });

  it('show the settings by plugin, with a switch for each on or off, and set them', async () => {
    const { core } = instance({ settings: z.object({ every: z.number().default(30) }) });
    await core.start();
    const [card] = await ask(named(core, 'settings'));
    expect(card?.text).toBe(
      [
        'The settings (/set <key> <value>), by plugin:',
        'core:',
        '  every: ?',
        'actor:',
        '  loud: off',
        '  level: 1',
      ].join('\n')
    );
    expect(card?.options?.buttons).toEqual([
      [{ label: '🔴 loud', action: 'set:loud:on' }],
      [{ label: '← Status', action: 'status' }],
    ]);
    expect((await ask(named(core, 'set'), 'loud:on'))[0]?.text).toContain('loud: on');
    expect((await ask(named(core, 'set'), 'level 3'))[0]?.text).toContain('level: 3');
    expect((await ask(named(core, 'set'), 'nothing'))[0]?.text).toMatch(/^Refused: no setting/u);
  });

  it('show values as the cards do', () => {
    expect([showValue(undefined), showValue(true), showValue([]), showValue(['a', 'b'])]).toEqual([
      '?',
      'on',
      'none',
      'a, b',
    ]);
    expect([lamp(true), lamp(false), lamp(undefined)]).toEqual(['🟢', '🔴', '⚪']);
  });
});

describe('controlServer', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('serves the controls as JSON', async () => {
    const { core } = instance();
    await core.start();
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      graph: () => core.graph(),
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const call = async (p: string, payload?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        ...(payload === undefined
          ? {}
          : {
              method: 'POST',
              body: typeof payload === 'string' ? payload : JSON.stringify(payload),
            }),
      });
      return [res.status, await res.json()] as const;
    };
    expect((await call('/status'))[1]).toMatchObject({ off: false });
    expect((await call('/graph'))[1]).toMatchObject({
      version: 1,
      nodes: [{ id: 'chat' }, { id: 'actor' }, { id: 'broken' }],
    });
    const [, view] = await call('/graph/view');
    expect(view).toMatchObject({
      graph: { version: 1, edges: [{ from: 'chat.chat', to: 'actor.chat', type: 'chat' }] },
      portTypes: { chat: { shape: 'circle' }, events: { shape: 'diamond' } },
      nodes: [
        { id: 'chat', outputs: { chat: { type: 'chat', network: 'chat' } } },
        {
          id: 'actor',
          inputs: { chat: { type: 'chat', optional: false } },
          settingsSchema: { type: 'object' },
          interface: { actions: [{ name: 'bump' }, { name: 'refuse' }] },
        },
        { id: 'broken' },
      ],
    });
    expect(await call('/plugins/actor/mode', { mode: 'dry-run' })).toEqual([
      200,
      { mode: 'dry-run' },
    ]);
    expect(await call('/plugins/actor/mode', { mode: 'x' })).toEqual([
      409,
      { error: 'mode must be read-only, dry-run or live' },
    ]);
    expect(await call('/plugins/actor/resume', {})).toEqual([
      409,
      { error: 'actor is not paused' },
    ]);
    core.pause('actor', 'drift');
    expect(await call('/plugins/actor/resume', {})).toEqual([200, { resumed: 'actor' }]);
    expect(await call('/plugins/actor/kill', {})).toEqual([
      200,
      { result: 'actor killed: actor stopped' },
    ]);
    expect(await call('/plugins/nobody/kill', {})).toEqual([409, { error: 'no plugin nobody' }]);
    expect(await call('/plugins/actor/resume', {})).toEqual([200, { resumed: 'actor' }]);
    expect(await call('/plugins/actor/state/status')).toEqual([200, { count: 0 }]);
    expect(await call('/plugins/actor/state/nope')).toEqual([
      404,
      { error: 'actor declares no read nope' },
    ]);
    expect(await call('/plugins/actor/actions/bump', { by: 3 })).toEqual([200, 3]);
    expect((await call('/plugins/actor/actions/bump', { by: 'x' }))[0]).toBe(400);
    expect(await call('/plugins/actor/actions/refuse', {})).toEqual([409, { error: 'not now' }]);
    expect(await call('/plugins/actor/actions/bump', 'not json')).toEqual([
      400,
      { error: expect.stringContaining('SyntaxError') },
    ]);
    expect(await call('/settings', { key: 'level', value: 5 })).toEqual([
      200,
      { loud: false, level: 5 },
    ]);
    expect((await call('/settings', { key: 'nope', value: 5 }))[0]).toBe(400);
    expect((await call('/settings'))[1]).toEqual({ loud: false, level: 5 });
    expect(await call('/kill', {})).toEqual([
      200,
      { result: 'Killed: actor stopped; broken stopped' },
    ]);
    expect(await call('/off', {})).toEqual([200, { off: true, result: 'off' }]);
    expect(await call('/on', {})).toEqual([200, { off: false, result: 'actor back' }]);
    expect(await call('/elsewhere')).toEqual([404, { error: 'not found' }]);
    expect(await call('/events')).toEqual([404, { error: 'not found' }]);
  });

  it('has no graph view before the graph is loaded, nor without one', async () => {
    const { core } = instance();
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      graph: () => core.graph(),
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/graph/view`);
    expect(await res.json()).toBeNull();
  });

  it('serves the instance’s health, its accounts, drift and the event log’s latest', async () => {
    const { core } = instance();
    await core.start();
    const records = [
      { type: 'core.power', t: 1000, off: true },
      { type: 'game.move', t: 2000 },
      { type: 'core.drift', t: 3000, plugin: 'p', event: 'unread' },
      { type: 'core.power', t: 4000, off: false },
    ];
    const spans: number[][] = [];
    server = controlServer({
      controls: core.controls,
      settings: core.settings,
      records: (from, to) => {
        spans.push([from, to]);
        return records;
      },
      now: () => 10 * 3_600_000,
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const get = async (p: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      return [res.status, await res.json()] as const;
    };
    const [, health] = await get('/instance');
    expect(health).toMatchObject({
      off: false,
      node: process.version,
      plugins: { running: 3 },
      accounts: { closed: 1 },
    });
    expect(typeof (health as { uptimeS: unknown }).uptimeS).toBe('number');
    expect((await get('/accounts'))[1]).toMatchObject([{ id: 'chat', account: 'chat:me' }]);
    expect(await get('/drift')).toEqual([200, []]);
    expect((await get('/events'))[1]).toEqual([...records].reverse());
    expect(spans.at(-1)).toEqual([10 * 3_600_000 - 24 * 3_600_000, 10 * 3_600_000]);
    expect((await get('/events?type=core.&limit=2&hours=2'))[1]).toEqual([records[3], records[2]]);
    expect(spans.at(-1)).toEqual([8 * 3_600_000, 10 * 3_600_000]);
    expect((await get('/events?limit=nope&hours=-1'))[1]).toHaveLength(4);
    expect(spans.at(-1)?.[0]).toBe(10 * 3_600_000 - 24 * 3_600_000);
    expect((await get('/plugins/act%6Fr/state/st%61tus'))[1]).toEqual({ count: 0 });
  });
});
