/**
 * The send-queue watchdog in the core (bot-os.md D93): which sends it watches, what it hears as an
 * answer, the stop it makes, the notice it raises, and the owner's way back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VirtualClock } from './clock.ts';
import { Core } from './core.ts';
import { FakeConnector, fakeConnectorPlugin } from './devkit.ts';
import { type GraphInput } from './graph.ts';
import { type Notice } from './notices.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const T0 = Date.UTC(2026, 10, 14, 9);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const contexts = new Map<string, PluginContext>();
const keep = (ctx: PluginContext) => (contexts.set(ctx.id, ctx), {});
const ctx = (id: string) => contexts.get(id) as PluginContext;

/** A parser of #lobby: an event for each message it hears. */
const parser = definePlugin({
  manifest: {
    id: 'parser',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'reads #lobby',
    inputs: { chat: { type: 'chat-in' } },
    games: { registers: ['quest'] },
    events: { 'quest.answer': z.object({ text: z.string() }) },
  },
  create: (c) => {
    keep(c);
    return {
      start: () =>
        void c.connector('chat').onMessage((m) => c.bus.publish('quest.answer', { text: m.text })),
    };
  },
});

/** A sender: `kind` says whether it acts. */
const sender = (id: string, kind: 'actor' | 'stats') =>
  definePlugin({
    manifest: {
      id,
      version: '0.1.0',
      kinds: [kind],
      description: 'sends',
      outputs: { chat: { type: 'chat-out' } },
    },
    create: keep,
  });

/** What depends on the actor: made inactive by its stop. */
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

const watcher = (heard: Notice[]) =>
  definePlugin({
    manifest: {
      id: 'watcher',
      version: '0.1.0',
      kinds: ['stats'],
      description: 'hears the notices',
      notices: true,
    },
    create: (c) => ({ start: () => void c.notices?.subscribe((n) => heard.push(n)) }),
  });

const graph: GraphInput = {
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg', account: 'tg:me' },
    { id: 'parser', plugin: 'parser' },
    { id: 'actor', plugin: 'actor' },
    { id: 'notifier', plugin: 'notifier' },
    { id: 'follower', plugin: 'follower' },
    { id: 'watcher', plugin: 'watcher' },
  ],
  edges: [
    { from: 'tg.chat', to: 'parser.chat', type: 'chat-in', reads: ['#lobby'] },
    { from: 'actor.chat', to: 'tg.chat', type: 'chat-out', sends: ['#LOBBY', '#quiet'] },
    { from: 'notifier.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
    { from: 'actor.interface', to: 'follower.actor' },
  ],
};

function instance(heard: Notice[]) {
  contexts.clear();
  const account = new FakeConnector({ account: 'tg:me', limits: { unansweredAt: 2 } });
  const clock = new VirtualClock(T0);
  const core = new Core({ clock, graph, dataDir: dir });
  core.register(
    fakeConnectorPlugin('tg', account),
    parser,
    sender('actor', 'actor'),
    sender('notifier', 'stats'),
    follower,
    watcher(heard)
  );
  return { account, clock, core };
}

describe('the send-queue watchdog in the core (D93)', () => {
  it("watches an actor's sends to a chat a parser reads, and stops it as drift does", async () => {
    const heard: Notice[] = [];
    const { account, clock, core } = instance(heard);
    await core.start();
    account.open();
    const out = ctx('actor').outbox('chat');
    const lobby = () => out.send('#LOBBY', '/inventory');
    // Answered: an event read from the chat, by a name of its own case.
    expect(lobby().outcome).toBe('sent');
    expect(lobby().outcome).toBe('sent');
    account.hear({ chat: '#lobby', sender: 'QuestBot', text: 'you have 3 apples', time: T0 });
    expect(lobby().outcome).toBe('sent');
    // No answer: its own message, history, or an event not read from a message.
    account.hear({ chat: '#lobby', sender: 'me', own: true, text: '/inventory', time: T0 });
    account.hear({ chat: '#lobby', sender: 'QuestBot', text: 'old', time: T0, playback: true });
    ctx('parser').bus.publish('quest.answer', { text: 'on its own' });
    expect(lobby().outcome).toBe('sent');
    // Not watched: a node that does not act, and a chat no parser reads.
    for (let i = 0; i < 5; i++) {
      expect(ctx('notifier').outbox('chat').send('#lobby', '/inventory').outcome).toBe('sent');
      expect(out.send('#quiet', '/inventory').outcome).toBe('sent');
    }
    clock.advance(60_000);
    const reason = 'stalled: 2 sends of /inventory to #LOBBY went unanswered';
    expect(lobby()).toEqual({
      text: '/inventory',
      outcome: 'refused',
      reason: `stopped: ${reason}`,
    });
    expect(core.state('actor')).toMatchObject({
      state: 'stopped',
      reason,
      stop: { reason, source: 'stalled' },
    });
    expect(core.state('follower')).toMatchObject({ state: 'inactive' });
    expect(lobby().reason).toBe(`stopped: ${reason}`);
    expect(heard.map((n) => [n.kind, n.node, n.text])).toEqual([
      ['cascade', 'follower', 'follower is inactive: needs actor (stopped)'],
      [
        'stalled',
        'actor',
        'actor sent /inventory to #LOBBY 2 times with no answer read from it; stopped until you clear the stop in the editor',
      ],
    ]);
    // Counted in the owner's summary, by kind (D92).
    expect(core.summary({ since: T0, until: clock.now() + 1 })).toContainEqual({
      title: 'Notices',
      lines: ['1 cascade, 1 stalled'],
    });
    await core.stop();

    // Kept across a restart, until the owner clears it; then it runs again, its count new.
    const again = instance([]);
    await again.core.start();
    expect(again.core.state('actor')).toMatchObject({
      state: 'stopped',
      stop: { source: 'stalled' },
    });
    expect(again.core.clearStop('actor')).toBe(true);
    await again.core.stop();
    const third = instance([]);
    await third.core.start();
    third.account.open();
    expect(third.core.state('actor')?.state).toBe('running');
    expect(ctx('actor').outbox('chat').send('#LOBBY', '/inventory').outcome).toBe('sent');
    await third.core.stop();
  });
});
