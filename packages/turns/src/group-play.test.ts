/**
 * Three bots played in one group by one person (bot-os.md D139, D140): @QuestBot and @DuelBot,
 * whose turn is `/play`, and @LoreBot, whose turn is `/play` with the alias `/quest`, and whose
 * `/boost` (alias `/b`) ends its turn's rest; each bot with its parser, its readiness state (D141)
 * and its player, the players sharing alice's attention and sending in the group. A bare `/play` reaches every bot; `/quest`,
 * or a command addressed to its bot, only that bot. Each player sends a command as the form that
 * plays the most ready turns at once.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  type BusEvent,
  type Clock,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type GraphInput,
} from '@megabottron1999/core';
import { describe, expect, it } from 'vitest';
import { ATTENTION, attentionPlugin, type AttentionStatus } from '#src/attention.ts';
import { PLAYER, playerPlugin } from '#src/player.ts';
import { type Readiness } from '#src/readiness.ts';
import { readinessPlugin, STATE_DOC } from '#src/state-plugin.ts';
import { turnParserPlugin, type TurnReading } from '#src/turn-parser.ts';

const T0 = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const GROUP = '-1001000000001';
/** Each bot, its parser's id, its turn's names and its other commands. */
const BOTS = [
  { id: 'quest', bot: 'QuestBot', turn: ['/play'] },
  { id: 'duel', bot: 'DuelBot', turn: ['/play'] },
  { id: 'lore', bot: 'LoreBot', turn: ['/play', '/quest'], boost: ['/boost', '/b'] },
] as const;
type Bot = (typeof BOTS)[number];

/** A bot's vocabulary: its turn, and LoreBot's boost. */
const vocabularyOf = (b: Bot) => ({
  bot: b.bot,
  turnCommands: b.turn,
  ...('boost' in b ? { commands: { '/boost': { aliases: ['/b'] } } } : {}),
});

/**
 * A bot's parser: "Found an apple." rests it 15 minutes, "Too soon: N minutes." N, "Boosted." ends
 * the rest, as the bot says (its effect names the turn by its alias, `/quest`).
 */
function parser(b: Bot) {
  return turnParserPlugin({
    id: b.id,
    description: `@${b.bot}'s answers to the owner's turns`,
    ...vocabularyOf(b),
    read: (m): TurnReading => {
      if (!m.answers) return undefined;
      if (m.text === 'Found an apple.')
        return { outcome: { kind: 'gain', bot: b.bot }, restMs: 15 * MIN };
      if (m.text === 'Boosted.')
        return {
          outcome: { kind: 'boost', bot: b.bot },
          effects: [{ command: '/quest', clear: true }],
        };
      const soon = /^Too soon: (\d+) minutes\.$/u.exec(m.text);
      if (soon !== null)
        return {
          outcome: { kind: 'nothing', bot: b.bot, reason: 'cooldown' },
          restMs: Number(soon[1]) * MIN,
        };
      return { unread: true };
    },
  });
}

/** A bot's readiness state (D141): LoreBot's boost, once an hour, ends its turn's rest. */
function state(b: Bot) {
  return readinessPlugin({
    id: `${b.id}-ready`,
    parser: { id: b.id, ...vocabularyOf(b) },
    ...('boost' in b
      ? {
          mechanics: {
            '/boost': { cooldownMin: 60, effects: [{ command: '/quest', clear: true as const }] },
          },
        }
      : {}),
  });
}

/**
 * alice's account in the group, where every bot sees every command (admins): each answers, a
 * second later and in reply, a command it takes, bare or addressed to it.
 */
class Group extends FakeConnector {
  private readonly clock: Clock;
  private n = 500;
  readonly rest = new Map<string, number>();
  readonly replies: { bot: string; text: string }[] = [];

  constructor(clock: Clock) {
    super({ account: 'telegram:alice' });
    this.clock = clock;
  }

  deliver(chat: string, text: string): Promise<{ id?: string }> {
    this.send(chat, text);
    const id = String(this.n++);
    this.clock.setTimeout(() => this.answer(chat, text, id), 1000);
    return Promise.resolve({ id });
  }

  /** alice writes `text` by hand: heard as her own, and answered. */
  byHand(chat: string, text: string): void {
    const id = String(this.n++);
    this.hear({ chat, sender: 'alice', own: true, time: this.clock.now(), id, text });
    this.clock.setTimeout(() => this.answer(chat, text, id), 1000);
  }

  private answer(chat: string, text: string, replyTo: string): void {
    const t = this.clock.now();
    const [word = '', to] = text.split('@');
    for (const b of BOTS) {
      if (to !== undefined && to !== b.bot) continue;
      const boost = 'boost' in b && (b.boost as readonly string[]).includes(word);
      if (!boost && !(b.turn as readonly string[]).includes(word)) continue;
      const until = this.rest.get(b.bot) ?? 0;
      let reply: string;
      if (boost) {
        this.rest.delete(b.bot);
        reply = 'Boosted.';
      } else if (t < until) reply = `Too soon: ${Math.ceil((until - t) / MIN)} minutes.`;
      else {
        this.rest.set(b.bot, t + 15 * MIN);
        reply = 'Found an apple.';
      }
      this.replies.push({ bot: b.bot, text: reply });
      this.hear({ chat, sender: b.bot, time: t, id: String(this.n++), replyTo, text: reply });
    }
  }
}

interface RunOptions {
  /** Each player's config, by its parser's id; unset, its turn alone. */
  players?: Partial<Record<Bot['id'], Record<string, unknown>>>;
  attention?: Record<string, unknown>;
  /** The players on another person, `bob`, who never sits down. */
  bob?: Bot['id'][];
  /** alice's attention listens to the group (D138). */
  listen?: boolean;
  /** Each bot resting until then, as its state and the bot know it. */
  resting?: Partial<Record<Bot['id'], number>>;
}

async function run(o: RunOptions = {}) {
  const steps: BusEvent[] = [];
  const turnOnly = (b: Bot) => ({ commands: [{ command: b.turn[0] }] });
  const kit = new DevKit({
    start: T0,
    documents: Object.fromEntries(
      Object.entries(o.resting ?? {}).map(([id, until]) => [
        `${id}-ready`,
        {
          [STATE_DOC]: {
            state: {
              readiness: {
                commands: { '/play': { readyAt: until, why: 'its rest after a turn' } },
                holds: {},
              },
            },
            cursor: {},
            freshness: {},
            batch: 0,
            unannounced: [],
          },
        },
      ])
    ),
    graph: (d): GraphInput => ({
      ...d,
      nodes: [
        ...d.nodes.filter((n) => n.id === TELEGRAM_USER),
        ...BOTS.flatMap((b) => [
          { id: b.id, plugin: b.id },
          { id: `${b.id}-ready`, plugin: `${b.id}-ready` },
        ]),
        { id: 'alice', plugin: ATTENTION, config: { seed: 3, skipChance: 0, ...o.attention } },
        { id: 'bob', plugin: ATTENTION, config: { scheduled: false } },
        ...BOTS.map((b) => ({
          id: `${b.id}-player`,
          plugin: PLAYER,
          config: o.players?.[b.id] ?? turnOnly(b),
        })),
      ],
      edges: [
        ...BOTS.flatMap((b) => [
          {
            from: `${TELEGRAM_USER}.chat`,
            to: `${b.id}.chat`,
            type: 'chat-in' as const,
            reads: [`@${b.bot}`, GROUP],
          },
          { from: `${b.id}.events`, to: `${b.id}-ready.events`, type: 'events' as const },
          { from: `${b.id}.interface`, to: `${b.id}-ready.parser`, type: 'interface' as const },
          {
            from: `${b.id}-ready.interface`,
            to: `${b.id}-player.state`,
            type: 'interface' as const,
          },
          {
            from: `${o.bob?.includes(b.id) === true ? 'bob' : 'alice'}.attention`,
            to: `${b.id}-player.attention`,
            type: 'attention' as const,
          },
          {
            from: `${b.id}-player.chat`,
            to: `${TELEGRAM_USER}.chat`,
            type: 'chat-out' as const,
            sends: [GROUP],
            // Every form of its commands (the editor keeps it to those its checklist allows).
            commands: [...b.turn, ...('boost' in b ? b.boost : [])].flatMap((c) => [
              c,
              `${c}@${b.bot}`,
            ]),
          },
        ]),
        ...(o.listen === true
          ? [
              {
                from: `${TELEGRAM_USER}.chat`,
                to: 'alice.listen',
                type: 'chat-in' as const,
                reads: [GROUP],
              },
            ]
          : []),
      ],
    }),
    record: (r) => {
      if (r.type === `${PLAYER}.step`) steps.push(r as BusEvent);
    },
  });
  const group = new Group(kit.clock);
  for (const [id, until] of Object.entries(o.resting ?? {}))
    group.rest.set(BOTS.find((b) => b.id === id)?.bot as string, until);
  kit.core.register(
    fakeConnectorPlugin(TELEGRAM_USER, group),
    ...BOTS.map(parser),
    ...BOTS.map(state),
    attentionPlugin(),
    playerPlugin()
  );
  await kit.start();
  group.open();
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const until = async (t: number): Promise<void> => {
    await flush();
    for (let at = kit.clock.nextAt(); at !== undefined && at <= t; at = kit.clock.nextAt()) {
      kit.clock.runNext();
      await flush();
    }
    kit.clock.advanceTo(t);
    await flush();
  };
  const read = <T>(node: string, what: string): T => {
    const r = kit.core.controls.read(node, what);
    return ('value' in r ? r.value : r) as T;
  };
  const ready = (p: Bot['id']) => read<Record<string, Readiness>>(`${p}-ready`, 'ready');
  const turn = (p: Bot['id']) => ready(p)[BOTS.find((b) => b.id === p)?.turn[0] as string];
  const sent = (player: string) =>
    steps.filter((e) => e['player'] === player && e['event'] === 'sent').map((e) => e['detail']);
  const texts = () => group.sent.map((s) => s.text);
  const first = () => read<AttentionStatus>('alice', 'status').next as number;
  return { kit, group, until, read, ready, turn, sent, texts, first };
}

describe('three bots in one group, one person: each command as the form of widest reach (D140)', () => {
  it('all ready: one bare send, every turn held, no second send', async () => {
    const r = await run();
    await r.until(r.first() + 5 * MIN);
    expect(r.group.sent.map((s) => `${s.chat} ${s.text}`)).toEqual([`${GROUP} /play`]);
    expect(r.group.replies).toEqual([
      { bot: 'QuestBot', text: 'Found an apple.' },
      { bot: 'DuelBot', text: 'Found an apple.' },
      { bot: 'LoreBot', text: 'Found an apple.' },
    ]);
    for (const p of ['quest', 'duel', 'lore'] as const)
      expect(r.turn(p)).toMatchObject({ ready: false, sent: { byHand: false } });
    // The alias shares its command's state: one turn, whichever name.
    expect(Object.keys(r.ready('lore'))).toEqual(['/play', '/boost']);
    // One player sent it; the others heard, waited for its answer, and sent nothing.
    expect([...r.sent('quest-player'), ...r.sent('duel-player'), ...r.sent('lore-player')]).toEqual(
      ['/play #500']
    );
    await r.kit.stop();
  });

  it('one ready after a reset ended its rest: its own bare alias, not an addressed form', async () => {
    const r = await run({ players: { lore: {} } });
    await r.until(r.first() + 5 * MIN);
    // The turn for all; LoreBot's boost while its turn rests; its turn again as /quest, which only
    // it declares: on a tie in reach, every bare alias comes before any addressed form.
    expect(r.texts()).toEqual(['/play', '/boost', '/quest']);
    expect(r.group.replies.some((x) => x.text.startsWith('Too soon'))).toBe(false);
    expect(r.ready('lore')['/boost']).toMatchObject({ ready: false });
    await r.kit.stop();
  });

  it('never sends a form its checklist unticked', async () => {
    const r = await run({
      players: {
        lore: {
          commands: [
            { command: '/quest', forms: ['/play', '/play@LoreBot', '/quest@LoreBot'] },
            { command: '/b' },
          ],
        },
      },
    });
    await r.until(r.first() + 5 * MIN);
    expect(r.texts()).toEqual(['/play', '/boost', '/play@LoreBot']);
    await r.kit.stop();
  });

  it('two ready, the third resting: each its own, addressed, never the bare form', async () => {
    const r = await run({ resting: { lore: T0 + 5 * 60 * MIN } });
    await r.until(r.first() + 5 * MIN);
    expect(r.texts()).toEqual(['/play@QuestBot', '/play@DuelBot']);
    expect(r.turn('quest')).toMatchObject({ ready: false });
    expect(r.turn('duel')).toMatchObject({ ready: false });
    expect(r.turn('lore')).toMatchObject({ until: T0 + 5 * 60 * MIN });
    expect(r.group.replies.some((x) => x.text.startsWith('Too soon'))).toBe(false);
    await r.kit.stop();
  });

  it('a player of another person, not in a sitting: the bare form is not allowed', async () => {
    const r = await run({ bob: ['duel'] });
    await r.until(r.first() + 5 * MIN);
    expect(r.texts()).toEqual(['/play@QuestBot', '/quest']);
    expect(r.turn('duel')).toMatchObject({ ready: true });
    await r.kit.stop();
  });

  it('settles: waits for a turn ready 4 s later, then one bare send plays all three', async () => {
    // A sitting 3 s after alice writes; each player's first look 4 s after the last's.
    const m = T0 + 10 * MIN;
    const r = await run({
      attention: {
        scheduled: false,
        followsMyPlay: true,
        listen: [GROUP],
        reaction: { minS: 4, maxS: 4, longChance: 0 },
      },
      listen: true,
      // DuelBot rests until 4 s after QuestBot's player's first look.
      resting: { duel: m + 11_000 },
    });
    await r.until(m);
    r.group.byHand(GROUP, 'hello');
    await r.until(m + 5 * MIN);
    expect(r.texts()).toEqual(['/play']);
    expect(r.group.sent).toHaveLength(1);
    const at = r.kit.clock.now();
    expect(at).toBeGreaterThan(m + 11_000);
    for (const p of ['quest', 'duel', 'lore'] as const)
      expect(r.turn(p)).toMatchObject({ ready: false, sent: { t: m + 11_000 } });
    await r.kit.stop();
  });

  it('follows your bare turn by hand in the group: every turn yours, none sent (D129, D138)', async () => {
    const r = await run({
      attention: { scheduled: false, followsMyPlay: true, listen: [GROUP] },
      listen: true,
    });
    await r.until(T0 + 10 * MIN);
    r.group.byHand(GROUP, '/play');
    await r.until(T0 + 20 * MIN);
    expect(r.group.sent).toEqual([]);
    for (const p of ['quest', 'duel', 'lore'] as const)
      expect(r.turn(p)).toMatchObject({ ready: false, sent: { byHand: true } });
    expect(r.read<AttentionStatus>('alice', 'status')).toMatchObject({ byHand: true });
    await r.kit.stop();
  });
});
