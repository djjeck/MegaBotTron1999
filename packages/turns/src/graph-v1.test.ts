/**
 * A graph saved before chat edges were split (bot-os.md D60), with the shell's own plugins: a
 * connector's three chat edges, all empty, to a parser, a turn-actor and a reactor on events. It
 * converts on load, runs, and is shown as version 2; and, at the first start since the modes went
 * (bot-os.md D64), its senders, which kept no mode (`read-only`), send through dry-run edges.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  Core,
  FakeConnector,
  fakeConnectorPlugin,
  GraphFile,
  graphFileControls,
  VirtualClock,
} from '@megabottron1999/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEST, questPlugin } from '#test/quest.ts';
import { REACTOR, reactorPlugin } from './reactor.ts';
import { TURN_ACTOR, turnActorPlugin } from './turn-actor.ts';

const chat = (to: string) => ({
  from: `${TELEGRAM_USER}.chat`,
  to: `${to}.chat`,
  type: 'chat',
  reads: [],
  sends: [],
});

const V1 = {
  version: 1,
  nodes: [
    { id: TELEGRAM_USER, plugin: TELEGRAM_USER },
    { id: QUEST, plugin: QUEST },
    { id: 'quest-turns', plugin: TURN_ACTOR, config: { chat: '@QuestBot' } },
    {
      id: 'look',
      plugin: REACTOR,
      config: { on: 'quest.turn', chat: '@QuestBot', send: '/look {outcome.item}' },
    },
  ],
  edges: [
    chat(QUEST),
    chat('quest-turns'),
    chat('look'),
    { from: `${QUEST}.interface`, to: 'quest-turns.parser', type: 'interface' },
    { from: `${QUEST}.events`, to: 'look.events', type: 'events' },
  ],
};

describe('a version 1 graph of the shell’s plugins', () => {
  it('converts on load: the parser reads, the turn-actor reads and sends, the reactor sends', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-v1-'));
    try {
      fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(V1));
      const file = new GraphFile(dir);
      const core = new Core({ clock: new VirtualClock(Date.UTC(2026, 10, 12)), graphFile: file });
      core.register(
        fakeConnectorPlugin(TELEGRAM_USER, new FakeConnector({ account: 'telegram:alice' })),
        questPlugin(),
        turnActorPlugin(),
        reactorPlugin()
      );
      await core.start();
      expect(core.graphProblems()).toEqual([]);
      expect(core.status().map((s) => `${s.id} ${s.state}`)).toEqual([
        `${TELEGRAM_USER} running`,
        `${QUEST} running`,
        'quest-turns running',
        'look running',
      ]);
      const edges = [
        { from: `${TELEGRAM_USER}.chat`, to: `${QUEST}.chat`, type: 'chat-in', reads: [] },
        { from: `${TELEGRAM_USER}.chat`, to: 'quest-turns.chat', type: 'chat-in', reads: [] },
        {
          from: 'quest-turns.chat',
          to: `${TELEGRAM_USER}.chat`,
          type: 'chat-out',
          sends: [],
          dryRun: true,
        },
        {
          from: 'look.chat',
          to: `${TELEGRAM_USER}.chat`,
          type: 'chat-out',
          sends: [],
          dryRun: true,
        },
        { from: `${QUEST}.interface`, to: 'quest-turns.parser', type: 'interface' },
        { from: `${QUEST}.events`, to: 'look.events', type: 'events' },
      ];
      expect(core.graph()).toEqual({ version: 2, nodes: V1.nodes, edges });
      // `GET /graph/file` shows it as version 2, what runs.
      expect(graphFileControls(file, core).file()).toEqual({
        exists: true,
        graph: { version: 2, nodes: V1.nodes, edges },
        text: expect.stringContaining(`  ${QUEST}.interface → quest-turns.parser (interface)`),
        differs: false,
      });
      await core.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
