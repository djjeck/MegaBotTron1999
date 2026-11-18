/**
 * Command answers in the core (bot-os.md D98, #59): a parser's declared answers paired with a
 * node's queued send, the cooldowns they set, the retry-loop guard in `GET /status`, and what is
 * never an answer.
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
import { parseManifest } from './manifest.ts';
import { definePlugin, type PluginContext } from './plugin.ts';

const T0 = Date.UTC(2026, 10, 14, 9);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const contexts = new Map<string, PluginContext>();
const ctx = (id: string) => contexts.get(id) as PluginContext;

/**
 * A parser of @QuestBot's private chat: `ok` gives, `no <why>` refuses, `wait <s>` is a
 * cooldown; anything else it reads as news, no answer.
 */
const parser = definePlugin({
  manifest: {
    id: 'parser',
    version: '0.1.0',
    kinds: ['parser'],
    description: 'reads @QuestBot',
    inputs: { chat: { type: 'chat-in' } },
    games: { registers: ['quest'] },
    events: {
      'quest.give': z.object({
        result: z.string(),
        why: z.string().optional(),
        until: z.number().optional(),
        playback: z.literal(true).optional(),
      }),
      'quest.news': z.object({ text: z.string() }),
    },
    answers: [
      {
        event: 'quest.give',
        commands: ['/give'],
        when: { result: 'wait' },
        status: 'refused',
        reason: 'cooldown',
      },
      {
        event: 'quest.give',
        commands: ['/give'],
        when: { result: 'no' },
        status: 'refused',
        reasonFrom: 'why',
      },
      { event: 'quest.give', commands: ['/give'], status: 'ok', withinS: 60 },
    ],
  },
  create: (c) => {
    contexts.set(c.id, c);
    return {
      start: () =>
        void c.connector('chat').onMessage((m) => {
          const [word = '', arg = ''] = m.text.split(' ');
          const old = m.playback ? { playback: true as const } : {};
          if (word === 'ok') c.bus.publish('quest.give', { result: 'ok', ...old }, m.time);
          else if (word === 'no') c.bus.publish('quest.give', { result: 'no', why: arg, ...old });
          else if (word === 'wait')
            c.bus.publish('quest.give', { result: 'wait', until: m.time + Number(arg) * 1000 });
          else c.bus.publish('quest.news', { text: m.text });
        }),
    };
  },
});

const actor = definePlugin({
  manifest: {
    id: 'actor',
    version: '0.1.0',
    kinds: ['actor'],
    description: 'gives',
    outputs: { chat: { type: 'chat-out' } },
  },
  create: (c) => (contexts.set(c.id, c), {}),
});

const graph: GraphInput = {
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg', account: 'tg:me' },
    { id: 'parser', plugin: 'parser' },
    { id: 'actor', plugin: 'actor' },
  ],
  edges: [
    { from: 'tg.chat', to: 'parser.chat', type: 'chat-in', reads: ['@QuestBot'] },
    { from: 'actor.chat', to: 'tg.chat', type: 'chat-out', sends: ['@QuestBot', '#lobby'] },
  ],
};

async function instance() {
  contexts.clear();
  const account = new FakeConnector({ account: 'tg:me' });
  const clock = new VirtualClock(T0);
  const core = new Core({ clock, graph, dataDir: dir });
  core.register(fakeConnectorPlugin('tg', account), parser, actor);
  await core.start();
  account.open();
  const bot = (text: string, o: { playback?: boolean; own?: boolean } = {}) =>
    account.hear({
      chat: '@QuestBot',
      sender: o.own === true ? 'me' : 'QuestBot',
      text,
      time: clock.now(),
      ...o,
    });
  return { account, clock, core, bot, out: ctx('actor').outbox('chat') };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('command answers in the core (D98)', () => {
  it("settles a node's queued command with its parser's answer, its event carried", async () => {
    const { bot, clock, core, out } = await instance();
    const q = out.enqueue('@QuestBot', '/give alice sword');
    await flush();
    // Not answers: its own message, news, history.
    bot('/give alice sword', { own: true });
    bot('the sun rises');
    bot('no missing', { playback: true });
    expect(q.status()).toBe('sent');
    bot('no missing');
    await expect(q).resolves.toEqual({
      text: '/give alice sword',
      outcome: 'sent',
      answer: {
        status: 'refused',
        reason: 'missing',
        event: { type: 'quest.give', t: clock.now(), result: 'no', why: 'missing' },
      },
    });
    // A command to a chat no parser of answers reads: settled as it goes.
    await expect(out.enqueue('#lobby', '/give')).resolves.toEqual({
      text: '/give',
      outcome: 'sent',
    });
    // Past the parser's window (the longest of its declarations for the command), unanswered.
    const silent = out.enqueue('@QuestBot', '/give bob');
    await flush();
    clock.advance(119_999);
    await flush();
    expect(silent.status()).toBe('sent');
    clock.advance(1);
    await expect(silent).resolves.toMatchObject({ answer: { status: 'unanswered' } });
    await core.stop();
  });

  it('holds no command back for a "too soon": readiness is a state\'s (D142)', async () => {
    const { bot, core, out } = await instance();
    const q = out.enqueue('@QuestBot', '/give alice');
    await flush();
    bot('wait 30');
    const a = await q;
    expect(a.answer).toMatchObject({ status: 'refused', reason: 'cooldown' });
    expect(a.answer).not.toHaveProperty('retryAt');
    // Its wait stays in the event, for a state to reduce.
    expect(a.answer?.event?.['until']).toBe(T0 + 30_000);
    expect(out.held('@QuestBot', '/give')).toBeUndefined();
    const again = out.enqueue('@QuestBot', '/give alice');
    await flush();
    bot('ok');
    await expect(again).resolves.toMatchObject({ answer: { status: 'ok' } });
    await core.stop();
  });

  it('backs off a node refused again and again for one reason, shown in its status', async () => {
    const { bot, core, out } = await instance();
    for (let i = 0; i < 3; i++) {
      out.send('@QuestBot', '/give alice');
      bot('no invalid');
    }
    const status = core.controls.status().plugins.find((p) => p.id === 'actor');
    expect(status?.backoff).toEqual([
      {
        account: 'tg:me',
        chat: '@QuestBot',
        command: '/give',
        reason: 'invalid',
        count: 3,
        until: T0 + 60_000,
      },
    ]);
    expect(out.send('@QuestBot', '/give alice').reason).toBe(
      'backed off: refused 3 times in a row (invalid), 60 s more'
    );
    expect(core.controls.status().plugins.find((p) => p.id === 'parser')?.backoff).toBeUndefined();
    await core.stop();
  });
});

describe('a manifest of answers', () => {
  it('answers only with events of its own', () => {
    const base = { version: '0.1.0', kinds: ['parser'], description: 'reads' };
    expect(() =>
      parseManifest({
        ...base,
        id: 'reader',
        games: { registers: ['quest'] },
        answers: [{ event: 'quest.give', commands: ['/give'], status: 'ok' }],
      })
    ).toThrow('answers.0.event: quest.give is not among its events');
  });
});
