/**
 * A person and their player on the dev kit (bot-os.md D133, D134): alice's faked account, a clone of
 * @QuestBot answering on it, @QuestBot's parser with its other commands, its readiness state
 * (`quest-ready`, D141), an `attention` node (`alice`) and a `player` (`quest-player`), on a
 * virtual clock, run step by step.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  type BusEvent,
  DevKit,
  fakeConnectorPlugin,
  type GraphInput,
  type Store,
} from '@megabottron1999/core';
import { ATTENTION, attentionPlugin, type AttentionStatus } from '#src/attention.ts';
import { PLAYER, playerPlugin, type PlayerStatus } from '#src/player.ts';
import { QUEST, QUEST_READY, QUESTBOT, questGamePlugin, questReadyPlugin } from '#test/quest.ts';
import { QuestClone } from '#test/quest-clone.ts';

export const T0 = Date.parse('2026-11-06T12:00:00Z'); // 13:00 in Rome
export const CHAT = `@${QUESTBOT}`;
export const COMMANDS = ['/play', '/chest', '/daily', '/coffee'];

export interface RunOptions {
  /** The person's config; no skipped sittings unless it says. */
  attention?: Record<string, unknown>;
  /** The player's config; by default every command, `/coffee` only while `/play` rests. */
  player?: Record<string, unknown>;
  /** Its chat-out edge a dry run (the editor's default for a new edge, D64). */
  dryRun?: boolean;
  /** Its account left closed. */
  closed?: boolean;
  start?: number;
  /** Each node's store's documents, as a restart finds them. */
  documents?: Record<string, Record<string, unknown>>;
  /** The graph, changed. */
  graph?: (g: GraphInput) => GraphInput;
}

export const PLAYS = [
  { command: '/play' },
  { command: '/chest' },
  { command: '/daily' },
  { command: '/coffee', whileHeld: '/play' },
];

export function sittingsGraph(o: RunOptions = {}) {
  return (d: GraphInput): GraphInput => {
    const g: GraphInput = {
      ...d,
      nodes: [
        ...d.nodes.filter((n) => n.id !== ATTENTION && n.id !== PLAYER && n.id !== QUEST_READY),
        { id: QUEST_READY, plugin: QUEST_READY },
        {
          id: 'alice',
          plugin: ATTENTION,
          config: { seed: 3, skipChance: 0, ...o.attention },
        },
        { id: 'quest-player', plugin: PLAYER, config: { commands: PLAYS, ...o.player } },
      ],
      edges: [
        ...(d.edges ?? []).filter(
          (e) =>
            !/^(attention|player|quest-ready)\./u.test(e.from) &&
            !/^(attention|player|quest-ready)\./u.test(e.to)
        ),
        { from: `${QUEST}.events`, to: `${QUEST_READY}.events`, type: 'events' },
        { from: `${QUEST}.interface`, to: `${QUEST_READY}.parser`, type: 'interface' },
        { from: 'alice.attention', to: 'quest-player.attention', type: 'attention' },
        { from: `${QUEST_READY}.interface`, to: 'quest-player.state', type: 'interface' },
        {
          from: 'quest-player.chat',
          to: `${TELEGRAM_USER}.chat`,
          type: 'chat-out',
          sends: [CHAT],
          commands: COMMANDS,
          ...(o.dryRun === true ? { dryRun: true } : {}),
        },
      ],
    };
    return o.graph?.(g) ?? g;
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

export async function runSittings(o: RunOptions = {}) {
  const events: BusEvent[] = [];
  const stores = new Map<string, Store>();
  const kit = new DevKit({
    start: o.start ?? T0,
    graph: sittingsGraph(o),
    ...(o.documents === undefined ? {} : { documents: o.documents }),
    record: (r) => {
      if (r.type === `${ATTENTION}.step` || r.type === `${PLAYER}.step`) events.push(r as BusEvent);
    },
  });
  const account = new QuestClone(kit.clock);
  const keepStore = (p: ReturnType<typeof playerPlugin>): ReturnType<typeof playerPlugin> => ({
    ...p,
    create: (ctx) => {
      stores.set(ctx.id, ctx.store);
      return p.create(ctx);
    },
  });
  kit.core.register(
    fakeConnectorPlugin(TELEGRAM_USER, account),
    keepStore(questGamePlugin()),
    keepStore(questReadyPlugin()),
    keepStore(attentionPlugin()),
    keepStore(playerPlugin())
  );
  await kit.start();
  if (o.closed !== true) account.open();
  /** Runs the clock to `t`, one timer at a time, each send's answer awaited. */
  const until = async (t: number): Promise<void> => {
    await flush();
    for (let at = kit.clock.nextAt(); at !== undefined && at <= t; at = kit.clock.nextAt()) {
      kit.clock.runNext();
      await flush();
    }
    kit.clock.advanceTo(t);
    await flush();
  };
  const read = <T>(node: string, what = 'status'): T => {
    const r = kit.core.controls.read(node, what);
    return ('value' in r ? r.value : r) as T;
  };
  const status = () => read<PlayerStatus>('quest-player');
  const person = () => read<AttentionStatus>('alice');
  /** The sittings started, by when. */
  const sittings = (): number[] =>
    events
      .filter((e) => e.type === `${ATTENTION}.step` && e['event'] === 'sitting')
      .map((e) => e.t);
  const steps = (type: string) =>
    events
      .filter((e) => e.type === type)
      .map((e) => `${String(e['event'])}: ${String(e['detail'])}`);
  /** The sends, each with its time and the sitting it went in (its index in `sittings()`). */
  const sends = () => {
    const starts = sittings();
    return account.replies.map((r) => ({
      ...r,
      sitting: starts.filter((s) => s <= r.t).length - 1,
    }));
  };
  const summary = (node: string): string[] | undefined =>
    kit.core.summary({ since: 0, until: kit.clock.now() + 1 }).find((s) => s.node === node)?.lines;
  return {
    kit,
    account,
    events,
    stores,
    until,
    status,
    person,
    sittings,
    steps,
    sends,
    summary,
    read,
  };
}
