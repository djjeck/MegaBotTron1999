import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { FakeConnector } from './devkit.ts';
import { type GraphInput } from './graph.ts';
import { type Notice, Notices, NOTICES_KEPT } from './notices.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const T0 = Date.UTC(2026, 10, 14, 9);

describe('Notices', () => {
  it('hands a new subscriber what was raised so far, then each as it is raised', () => {
    const feed = new Notices();
    feed.raise({ kind: 'failed', t: 1, node: 'a', text: 'a failed: x' });
    const heard: string[] = [];
    const stop = feed.subscribe('w', (n) => heard.push(n.text));
    feed.raise({ kind: 'warning', t: 2, text: 'the graph warns' });
    stop();
    feed.raise({ kind: 'warning', t: 3, text: 'not heard' });
    expect(heard).toEqual(['a failed: x', 'the graph warns']);
    expect(feed.recent().map((n) => n.t)).toEqual([1, 2, 3]);
  });

  it('keeps the newest, redacts, refuses a bad kind, drops a node and logs a handler that throws', () => {
    const errors: string[] = [];
    const feed = new Notices({
      error: (plugin, line) => errors.push(`${plugin}: ${line}`),
      redact: (t) => t.replace('s3cret', '***'),
    });
    for (let i = 0; i <= NOTICES_KEPT; i++) feed.raise({ kind: 'other-kind', t: i, text: `n${i}` });
    expect(feed.recent()).toHaveLength(NOTICES_KEPT);
    expect(feed.recent()[0]?.t).toBe(1);
    expect(() => feed.raise({ kind: 'Bad Kind', t: 0, text: 'x' })).toThrow('not a notice kind');
    const heard: Notice[] = [];
    feed.subscribe('w', (n) => heard.push(n));
    feed.subscribe('bad', () => {
      throw new Error('boom');
    });
    feed.drop('w');
    feed.raise({ kind: 'failed', t: 9, text: 'token s3cret leaked' });
    expect(heard).toHaveLength(NOTICES_KEPT);
    expect(feed.recent().at(-1)?.text).toBe('token *** leaked');
    expect(errors.at(-1)).toBe("bad: a notice's handler: boom");
  });
});

const contexts = new Map<string, PluginContext>();
const keep = (ctx: PluginContext) => (contexts.set(ctx.id, ctx), {});

/** A connector that monitors the chats its config lists (D89), so that the check may warn. */
const tg = (connector: FakeConnector) =>
  definePlugin({
    manifest: {
      id: 'tg',
      version: '0.1.0',
      kinds: ['connector'],
      description: 'a fake account that monitors its chats',
      account: connector.account,
      config: z.object({ chats: z.array(z.string()).default(['#lobby']) }),
      monitors: { config: 'chats' },
    },
    create: () => ({ connector }),
  });

const parser = definePlugin({
  manifest: {
    id: 'parser',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'reads #lobby',
    drift: { unreadAt: 1, windowMin: 10 },
    inputs: { chat: { type: 'chat-in' } },
    interface: { state: { count: { help: 'how many', output: z.number() } } },
  },
  create: (ctx) => (keep(ctx), { interface: { state: { count: () => 1 } } }),
});

/** An acting node on the parser; `follower` requires it. */
const actor = definePlugin({
  manifest: {
    id: 'actor',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'acts',
    inputs: { parser: { type: 'interface', plugin: 'parser', members: ['state.count'] } },
    outputs: { chat: { type: 'chat-out' } },
    interface: { state: { busy: { help: 'busy', output: z.boolean() } } },
  },
  create: (ctx) => (keep(ctx), { interface: { state: { busy: () => false } } }),
});

const follower = definePlugin({
  manifest: {
    id: 'follower',
    version: '0.1.0',
    kinds: ['stats'],
    description: 'follows the actor',
    inputs: { actor: { type: 'interface', plugin: 'actor', members: [] } },
  },
  create: () => ({}),
});

/** Another sender, which hears no notices. */
const other = definePlugin({
  manifest: {
    id: 'other',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'sends too',
    outputs: { chat: { type: 'chat-out' } },
  },
  create: keep,
});

/** The node that hears the notices. */
const watcher = (heard: Notice[]) =>
  definePlugin({
    manifest: {
      id: 'watcher',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'hears the notices',
      notices: true,
    },
    create: (ctx) => ({
      start: () => void ctx.notices?.subscribe((n) => heard.push(n)),
    }),
  });

const graph: GraphInput = {
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg', account: 'tg:me' },
    { id: 'parser', plugin: 'parser' },
    { id: 'actor', plugin: 'actor' },
    { id: 'follower', plugin: 'follower' },
    { id: 'other', plugin: 'other' },
    { id: 'watcher', plugin: 'watcher' },
  ],
  edges: [
    // #elsewhere is not among tg's chats: the check warns (D89).
    { from: 'tg.chat', to: 'parser.chat', type: 'chat-in', reads: ['#lobby', '#elsewhere'] },
    { from: 'parser.interface', to: 'actor.parser' },
    { from: 'actor.interface', to: 'follower.actor' },
    { from: 'actor.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
    { from: 'other.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
  ],
};

describe("the core's notices (D91)", () => {
  it('raises each kind where it acts, and gives them to a node that declares notices', async () => {
    contexts.clear();
    const account = new FakeConnector({ account: 'tg:me', limits: { minIntervalMs: 2000 } });
    const heard: Notice[] = [];
    const core = new Core({ clock: new VirtualClock(T0), graph });
    core.register(tg(account), parser, actor, follower, other, watcher(heard));
    await core.start();
    account.open();
    const ctx = (id: string) => contexts.get(id) as PluginContext;
    // Only a node that declares them hears the notices.
    expect(ctx('other').notices).toBeUndefined();
    // Coalesced: another node's same text, waiting for the same chat (D73).
    ctx('actor').outbox('chat').enqueue('#lobby', '/inventory');
    ctx('actor').outbox('chat').enqueue('#lobby', '/inventory');
    ctx('other').outbox('chat').enqueue('#lobby', '/inventory');
    // A plugin's own.
    ctx('other').notice('refused', 'other refused game.gain: no room', { event: 'game.gain' });
    // Drift past the threshold: the actor is stopped, and the follower made inactive (D65).
    ctx('parser').drift.unread({ text: 'what is this' });
    ctx('parser').drift.unread({ text: 'and this' });
    // A failure at runtime, as a script's watchdog makes it.
    ctx('other').fail('its script hung: a handler of game.tick spent over 1000 ms of CPU');
    expect(heard.map((n) => [n.kind, n.node, n.text])).toEqual([
      [
        'warning',
        'parser',
        expect.stringContaining('reads #elsewhere, which tg does not monitor') as string,
      ],
      ['coalesced', 'other', 'other queued "/inventory" to #lobby, as actor had: sent once'],
      ['refused', 'other', 'other refused game.gain: no room'],
      ['cascade', 'follower', 'follower is inactive: needs actor (stopped)'],
      [
        'drift',
        'parser',
        'drift: parser could not read 2 messages in 10 minutes; stopped actor until you clear the stop in the editor',
      ],
      [
        'failed',
        'other',
        'other failed: its script hung: a handler of game.tick spent over 1000 ms of CPU',
      ],
    ]);
    expect(heard[1]?.detail).toEqual({
      account: 'tg:me',
      chat: '#lobby',
      text: '/inventory',
      with: ['actor'],
    });
    expect(heard.every((n) => n.t === T0)).toBe(true);
    expect(core.notices()).toEqual(heard);
    await core.stop();
  });

  it('says a drift stopped nothing, and the node down hears no more', async () => {
    contexts.clear();
    const account = new FakeConnector({ account: 'tg:me' });
    const heard: Notice[] = [];
    const core = new Core({
      clock: new VirtualClock(T0),
      graph: {
        version: 2,
        nodes: [
          { id: 'tg', plugin: 'tg', account: 'tg:me' },
          { id: 'parser', plugin: 'parser' },
          { id: 'watcher', plugin: 'watcher' },
        ],
        edges: [{ from: 'tg.chat', to: 'parser.chat', type: 'chat-in', reads: ['#lobby'] }],
      },
    });
    core.register(tg(account), parser, watcher(heard));
    await core.start();
    const p = contexts.get('parser') as PluginContext;
    p.drift.unread({ text: 'x' });
    p.drift.unread({ text: 'y' });
    expect(heard.map((n) => n.text)).toEqual([
      'drift: parser could not read 2 messages in 10 minutes; nothing that acts depends on it',
    ]);
    await core.stop();
    p.notice('other', 'after the stop');
    expect(heard).toHaveLength(1);
  });
});
