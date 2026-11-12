/**
 * The first start since modes were replaced by states (bot-os.md D64), on a data volume of the
 * release before: a turn-actor and a reactor whose instances kept the mode `dry-run`, and a second
 * reactor kept `live`. Every node comes out enabled, the dry-run ones' chat-out edges dry runs, the
 * live one's live; the instances' modes are gone, the graph rewritten once, as a version of its
 * history, and the turn-actor goes on logging its turns without sending them.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  Core,
  type CoreRecord,
  FakeConnector,
  fakeConnectorPlugin,
  GraphFile,
  graphFileControls,
  VirtualClock,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUEST, questPlugin } from '#test/quest.ts';
import { REACTOR, reactorPlugin } from './reactor.ts';
import { TURN_ACTOR, turnActorPlugin } from './turn-actor.ts';

const T0 = Date.UTC(2026, 10, 12, 12);
const BOT = '@QuestBot';

/** The graph file as the release before saved it: no states, the reactor `look` with a mode. */
const BEFORE = {
  version: 2,
  nodes: [
    { id: 'tg', plugin: TELEGRAM_USER, account: 'telegram:alice' },
    { id: QUEST, plugin: QUEST },
    { id: 'quest-turns', plugin: TURN_ACTOR, config: { chat: BOT, seed: 3 } },
    {
      id: 'look',
      plugin: REACTOR,
      // The mode a fresh instance started in: the instance's own kept mode wins over it.
      mode: 'live',
      config: { on: 'quest.turn', chat: BOT, send: '/look {outcome.item}' },
    },
    {
      id: 'shout',
      plugin: REACTOR,
      instance: 'shout-old',
      config: { on: 'quest.turn', chat: '#lobby', send: 'found {outcome.item}' },
    },
  ],
  edges: [
    { from: 'tg.chat', to: `${QUEST}.chat`, type: 'chat-in', reads: [BOT] },
    { from: 'tg.chat', to: 'quest-turns.chat', type: 'chat-in', reads: [BOT] },
    {
      from: 'quest-turns.chat',
      to: 'tg.chat',
      type: 'chat-out',
      sends: [BOT],
      commands: ['/play'],
    },
    { from: `${QUEST}.interface`, to: 'quest-turns.parser', type: 'interface' },
    { from: `${QUEST}.events`, to: 'look.events', type: 'events' },
    { from: 'look.chat', to: 'tg.chat', type: 'chat-out', sends: [BOT], commands: ['/look'] },
    { from: `${QUEST}.events`, to: 'shout.events', type: 'events' },
    { from: 'shout.chat', to: 'tg.chat', type: 'chat-out', sends: ['#lobby'] },
  ],
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-migration-'));
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(BEFORE, null, 2));
  const keep = (instance: string, mode: string): void => {
    fs.mkdirSync(path.join(dir, 'instances', instance), { recursive: true });
    fs.writeFileSync(path.join(dir, 'instances', instance, '_mode.json'), JSON.stringify({ mode }));
  };
  keep('quest-turns', 'dry-run');
  keep('look', 'dry-run');
  keep('shout-old', 'live');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function start(clock: VirtualClock) {
  const file = new GraphFile(dir, () => clock.now());
  const records: CoreRecord[] = [];
  const account = new FakeConnector({ account: 'telegram:alice' });
  const core = new Core({
    clock,
    dataDir: dir,
    graphFile: file,
    record: (r) => records.push(r as CoreRecord),
  });
  core.register(
    fakeConnectorPlugin(TELEGRAM_USER, account),
    questPlugin(),
    turnActorPlugin(),
    reactorPlugin()
  );
  return { core, file, records, account };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the first start since modes became states (D64)', () => {
  it('enables every node, and folds each kept mode into its chat-out edges, once', async () => {
    const clock = new VirtualClock(T0);
    const { core, file, records, account } = start(clock);
    await core.start();
    file.started(core);
    expect(core.graphProblems()).toEqual([]);
    expect(core.status().map((s) => `${s.id} ${s.state}`)).toEqual([
      'tg running',
      `${QUEST} running`,
      'quest-turns running',
      'look running',
      'shout running',
    ]);
    const saved = JSON.parse(fs.readFileSync(file.file, 'utf8')) as typeof BEFORE;
    expect(
      saved.nodes.map((n) => Object.keys(n).filter((k) => k === 'mode' || k === 'disabled'))
    ).toEqual([[], [], [], [], []]);
    const out = (from: string) => saved.edges.find((e) => e.from === from) as object;
    expect(out('quest-turns.chat')).toMatchObject({ type: 'chat-out', dryRun: true });
    expect(out('look.chat')).toMatchObject({ type: 'chat-out', dryRun: true });
    expect(out('shout.chat')).not.toHaveProperty('dryRun');
    // The instances' modes are gone.
    for (const instance of ['quest-turns', 'look', 'shout-old'])
      expect(fs.existsSync(path.join(dir, 'instances', instance, '_mode.json'))).toBe(false);
    // The change is a version of the history, its text saying `dry-run` where it is one.
    expect(file.history.list().map((v) => [v.source, v.summary])).toEqual([
      [
        'migrated',
        // The version found is read as it would load: `look`'s own mode (live) folded already.
        '~ edge quest-turns.chat → tg.chat: dryRun; ~ edge look.chat → tg.chat: dryRun',
      ],
      [
        // The file the release before wrote, taken into the history first.
        'migrated',
        '+ node tg; + node quest; + node quest-turns; + node look; + node shout; + edge tg.chat → quest.chat; + edge tg.chat → quest-turns.chat; + edge quest-turns.chat → tg.chat; … 5 more',
      ],
    ]);
    const text = (graphFileControls(file, core).file() as { text: string }).text;
    expect(text).toContain(
      '  quest-turns.chat → tg.chat (chat-out): sends @QuestBot; commands /play; dry-run'
    );
    expect(text).toContain('  shout.chat → tg.chat (chat-out): sends #lobby\n');
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'core.graph',
        event: 'migrated',
        modes: {
          tg: 'read-only',
          [QUEST]: 'read-only',
          'quest-turns': 'dry-run',
          look: 'dry-run',
          shout: 'live',
        },
      })
    );
    // The turn-actor logs its turns, through its dry-run edge, and sends none.
    account.open();
    clock.advanceTo(T0 + 30 * 60_000);
    await flush();
    expect(records).toContainEqual(
      expect.objectContaining({
        type: `${TURN_ACTOR}.step`,
        event: 'sent',
        detail: '/play (dry run)',
      })
    );
    expect(account.sent).toEqual([]);
    await core.stop();

    // Once: the next start rewrites nothing.
    const versions = file.history.list().length;
    const again = start(clock);
    await again.core.start();
    again.file.started(again.core);
    expect(again.file.history.list()).toHaveLength(versions);
    expect(again.records.some((r) => r['event'] === 'migrated')).toBe(false);
    await again.core.stop();
  });

  it('takes the graph before the last change of a release before the history in first', async () => {
    const previous = { ...BEFORE, nodes: BEFORE.nodes.filter((n) => n.id !== 'shout') };
    fs.writeFileSync(
      path.join(dir, 'graph.previous.json'),
      JSON.stringify({
        ...previous,
        edges: BEFORE.edges.filter((e) => !e.to.startsWith('shout') && !e.from.startsWith('shout')),
      })
    );
    const { core, file } = start(new VirtualClock(T0));
    await core.start();
    file.started(core);
    expect(fs.existsSync(path.join(dir, 'graph.previous.json'))).toBe(false);
    expect(file.history.list().map((v) => v.source)).toEqual(['migrated', 'migrated', 'migrated']);
    expect(file.history.list()[0]?.summary).toContain('dryRun');
    expect(file.history.list()[1]?.summary).toContain('+ node shout');
    await core.stop();
  });

  it('migrates nothing on a fresh volume, and only marks it done', async () => {
    fs.rmSync(path.join(dir, 'graph.json'));
    const { core, file, records } = start(new VirtualClock(T0));
    await core.start();
    expect(file.read()).toEqual({ exists: false });
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'core.graph', event: 'migrated', modes: {} })
    );
    expect(fs.existsSync(path.join(dir, 'core', 'node-states.json'))).toBe(true);
    await core.stop();
  });
});
