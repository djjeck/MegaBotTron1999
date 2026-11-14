import {
  type Core,
  definePlugin,
  describePlugin,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type GraphInput,
  parseManifest,
  type PluginContext,
  StartError,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REACTOR, reactorConfig, reactorPlugin } from './reactor.ts';

const T0 = Date.UTC(2026, 10, 8, 12);
const BOT = '@QuestBot';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A made-up game's parser, `quest`, publishing `quest.turn` as a turn parser does. */
function questParser(seen: { ctx?: PluginContext }) {
  return definePlugin({
    manifest: {
      id: 'quest',
      version: '0.1.0',
      kinds: ['parser'],
      description: 'reads @QuestBot',
      games: { registers: ['quest'] },
      events: {
        'quest.turn': z.object({ chat: z.string(), outcome: z.record(z.string(), z.unknown()) }),
      },
    },
    create: (ctx) => {
      seen.ctx = ctx;
      return {};
    },
  });
}

/**
 * The graph file of the editor: alice's account, the parser, and one reactor node `look`, its
 * chat-out edge a dry run (as the editor draws a new one, D64) unless `live`.
 */
const graph = (config: Record<string, unknown>, events = true, live = false): GraphInput => ({
  version: 2,
  nodes: [
    { id: 'tg', plugin: 'tg', account: 'telegram:alice' },
    { id: 'quest', plugin: 'quest' },
    { id: 'look', plugin: REACTOR, config },
  ],
  edges: [
    // It reads only with match (its chat-in is there only then), and always sends.
    ...('match' in config
      ? [{ from: 'tg.chat', to: 'look.chat', type: 'chat-in' as const, reads: [BOT] }]
      : []),
    {
      from: 'look.chat',
      to: 'tg.chat',
      type: 'chat-out',
      sends: [BOT],
      commands: ['/look'],
      ...(live ? {} : { dryRun: true }),
    },
    ...(events ? [{ from: 'quest.events', to: 'look.events', type: 'events' as const }] : []),
  ],
});

const ON_GAIN = {
  on: 'quest.turn',
  when: { 'outcome.kind': 'gain', 'outcome.sure': true },
  chat: BOT,
  send: '/look {outcome.item}',
};

async function run(config: Record<string, unknown>, o: { live?: boolean; events?: boolean } = {}) {
  const account = new FakeConnector({ account: 'telegram:alice' });
  const seen: { ctx?: PluginContext } = {};
  const kit = new DevKit({
    start: T0,
    graph: graph(config, o.events, o.live),
    plugins: [fakeConnectorPlugin('tg', account), questParser(seen), reactorPlugin()],
  });
  await kit.start();
  account.open();
  const reactions = () =>
    kit.log
      .recordsSince(0, Number.MAX_SAFE_INTEGER)
      .filter((r) => r.type === `${REACTOR}.reaction`)
      .map(
        (r) =>
          `${String(r['outcome'])}${r['reason'] === undefined ? '' : ` (${String(r['reason'])})`}`
      );
  return { kit, core: kit.core as Core, account, quest: seen.ctx as PluginContext, reactions };
}

const gain = (item: string, sure = true) => ({
  chat: BOT,
  outcome: { kind: 'gain', bot: 'QuestBot', item, rarity: 'common', tags: [], sure },
});

describe('the reactor', () => {
  it('sends a command when its event is heard and the payload matches', async () => {
    const { quest, account, reactions } = await run(ON_GAIN, { live: true });
    quest.bus.publish('quest.turn', gain('lantern'));
    quest.bus.publish('quest.turn', gain('rope', false));
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look lantern' }]);
    expect(reactions()).toEqual(['sent']);
  });

  it('skips an event played back, at any age, and an old one only with maxAgeS', async () => {
    const { quest, account, reactions } = await run(ON_GAIN, { live: true });
    quest.bus.publish('quest.turn', { ...gain('rope'), playback: true });
    quest.bus.publish('quest.turn', gain('lantern'), T0 - 3_600_000);
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look lantern' }]);
    expect(reactions()).toEqual(['skipped (played back: history, not news)', 'sent']);
    const limited = await run({ ...ON_GAIN, maxAgeS: 60 }, { live: true });
    limited.quest.bus.publish('quest.turn', gain('lantern'), T0 - 3_600_000);
    await flush();
    expect(limited.account.sent).toEqual([]);
    expect(limited.reactions()).toEqual([
      `skipped (an event of ${new Date(T0 - 3_600_000).toISOString()}, too old)`,
    ]);
  });

  it('through a dry-run edge, as a new one is drawn, logs what it sends and sends nothing', async () => {
    const { quest, account, reactions } = await run(ON_GAIN);
    quest.bus.publish('quest.turn', gain('lantern'));
    await flush();
    expect(account.sent).toEqual([]);
    expect(reactions()).toEqual(['dry-run']);
  });

  it('has an events port of its event type’s namespace, which the graph checks', async () => {
    const { core } = await run(ON_GAIN);
    expect(core.graph()?.edges).toContainEqual({
      from: 'quest.events',
      to: 'look.events',
      type: 'events',
    });
    const other = new DevKit({
      graph: graph({ ...ON_GAIN, on: 'dice.roll' }),
      plugins: [
        fakeConnectorPlugin('tg', new FakeConnector({ account: 'telegram:alice' })),
        questParser({}),
        reactorPlugin(),
      ],
    });
    let refused: unknown;
    try {
      other.core.load();
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(StartError);
    expect((refused as Error).message).toContain(
      'node look: input port events: events of quest cannot bind events of dice'
    );
  });

  it('is refused on events that no edge binds, which it would never hear', () => {
    const kit = new DevKit({
      graph: graph(ON_GAIN, false),
      plugins: [
        fakeConnectorPlugin('tg', new FakeConnector({ account: 'telegram:alice' })),
        questParser({}),
        reactorPlugin(),
      ],
    });
    let refused: unknown;
    try {
      kit.core.load();
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(StartError);
    expect((refused as Error).message).toContain(
      'node look: input port events (events of quest) is not bound'
    );
  });

  it('reacts to a message that matches, with no events port', async () => {
    const config = {
      match: 'the (?<prize>\\w+) draw opens',
      ignoreCase: true,
      in: BOT,
      chat: BOT,
      send: '/look {prize}',
    };
    const { core, account, reactions } = await run(config, { live: true, events: false });
    expect(core.nodes().find((n) => n.id === 'look')?.ports).not.toHaveProperty('events');
    account.hear({ chat: BOT, sender: 'QuestBot', text: 'The GOLD draw opens', time: T0 });
    account.hear({ chat: BOT, sender: 'QuestBot', text: 'the gold draw is shut', time: T0 });
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look GOLD' }]);
    expect(reactions()).toEqual(['sent']);
  });

  it('matches with case, in every chat its edge reads, without in', async () => {
    const config = { match: 'the draw opens', chat: BOT, send: '/look' };
    const { account } = await run(config, { live: true, events: false });
    account.hear({ chat: BOT, sender: 'QuestBot', text: 'The draw opens', time: T0 });
    account.hear({ chat: BOT, sender: 'QuestBot', text: 'now the draw opens', time: T0 });
    await flush();
    expect(account.sent).toEqual([{ chat: BOT, text: '/look' }]);
  });

  it('stops reacting when it stops', async () => {
    const { kit, quest, account } = await run(ON_GAIN, { live: true });
    await kit.stop();
    quest.bus.publish('quest.turn', gain('lantern'));
    await flush();
    expect(account.sent).toEqual([]);
  });

  it('checks its config: one trigger, a pattern that compiles, an event type', () => {
    const problems = (c: Record<string, unknown>) =>
      reactorConfig.safeParse(c).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(problems(ON_GAIN)).toBeUndefined();
    expect(reactorConfig.parse(ON_GAIN)).toMatchObject({ ignoreCase: false });
    expect(reactorConfig.parse(ON_GAIN)).not.toHaveProperty('maxAgeS');
    expect(problems({ chat: BOT, send: '/look' })).toEqual([
      'on: set either on (an event) or match (a message), not both',
    ]);
    expect(problems({ ...ON_GAIN, match: 'x' })).toEqual([
      'on: set either on (an event) or match (a message), not both',
    ]);
    expect(problems({ chat: BOT, send: '/look', match: '(' })).toEqual([
      'match: expected a regular expression',
    ]);
    expect(problems({ ...ON_GAIN, on: 'Quest turn' })).toEqual([
      'on: expected an event type, <namespace>.<name>, or a namespace',
    ]);
  });

  it('describes its config for the editor’s form: a field per key, chat and send required', () => {
    const view = describePlugin(parseManifest(reactorPlugin().manifest));
    const schema = view.configSchema as {
      properties: Record<string, { type?: string; description?: string }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      'on',
      'match',
      'in',
      'ignoreCase',
      'when',
      'chat',
      'send',
      'maxAgeS',
    ]);
    expect(schema.required).toEqual(['chat', 'send']);
    expect(schema.properties['on']?.type).toBe('string');
    expect(schema.properties['ignoreCase']?.type).toBe('boolean');
    expect(schema.properties['when']?.type).toBe('object');
    expect(schema.properties['send']?.description).toContain('{path}');
    expect(view.inputs['events']).toMatchObject({
      type: 'events',
      config: 'on',
      when: 'on',
      optional: false,
    });
    expect(view.kinds).toEqual(['actor']);
  });
});
