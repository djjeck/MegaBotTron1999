/**
 * Two bots played in one group by one person (bot-os.md D139): @QuestBot and @LoreBot, each with
 * its parser and its player, both players sharing alice's attention and sending in the group. A
 * bare `/play` reaches both bots, so one send takes both turns; addressed, each its own.
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
import { type Readiness, turnParserPlugin, type TurnReading } from '#src/turn-parser.ts';

const T0 = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const GROUP = '-1001000000001';
const BOTS = ['QuestBot', 'LoreBot'];

/** A bot's parser: "Found an apple." rests it 15 minutes, "Too soon: N minutes." N. */
function parser(id: string, bot: string) {
  return turnParserPlugin({
    id,
    bot,
    description: `@${bot}'s answers to the owner's turns`,
    turnCommands: ['/play'],
    read: (m): TurnReading => {
      if (!m.answers) return undefined;
      if (m.text === 'Found an apple.') return { outcome: { kind: 'gain', bot }, restMs: 15 * MIN };
      const soon = /^Too soon: (\d+) minutes\.$/u.exec(m.text);
      if (soon !== null)
        return {
          outcome: { kind: 'nothing', bot, reason: 'cooldown' },
          restMs: Number(soon[1]) * MIN,
        };
      return { unread: true };
    },
  });
}

/**
 * alice's account in the group, where both bots see every command (admins): each answers, a
 * second later and in reply, a `/play` bare or addressed to it.
 */
class Group extends FakeConnector {
  private readonly clock: Clock;
  private n = 500;
  private readonly rest = new Map<string, number>();
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

  /** alice plays `text` by hand: heard as her own, and answered. */
  byHand(chat: string, text: string): void {
    const id = String(this.n++);
    this.hear({ chat, sender: 'alice', own: true, time: this.clock.now(), id, text });
    this.clock.setTimeout(() => this.answer(chat, text, id), 1000);
  }

  private answer(chat: string, text: string, replyTo: string): void {
    const t = this.clock.now();
    for (const bot of BOTS) {
      if (text !== '/play' && text !== `/play@${bot}`) continue;
      const until = this.rest.get(bot) ?? 0;
      const reply =
        t < until ? `Too soon: ${Math.ceil((until - t) / MIN)} minutes.` : 'Found an apple.';
      if (t >= until) this.rest.set(bot, t + 15 * MIN);
      this.replies.push({ bot, text: reply });
      this.hear({ chat, sender: bot, time: t, id: String(this.n++), replyTo, text: reply });
    }
  }
}

async function run(o: {
  addressed?: boolean;
  attention?: Record<string, unknown>;
  listen?: boolean;
}) {
  const steps: BusEvent[] = [];
  const play = o.addressed === true ? { command: '/play', addressed: true } : { command: '/play' };
  const kit = new DevKit({
    start: T0,
    graph: (d): GraphInput => ({
      ...d,
      nodes: [
        ...d.nodes.filter((n) => n.id === TELEGRAM_USER),
        { id: 'quest', plugin: 'quest' },
        { id: 'lore', plugin: 'lore' },
        { id: 'alice', plugin: ATTENTION, config: { seed: 3, skipChance: 0, ...o.attention } },
        { id: 'quest-player', plugin: PLAYER, config: { commands: [play] } },
        { id: 'lore-player', plugin: PLAYER, config: { commands: [play] } },
      ],
      edges: [
        ...['quest', 'lore'].flatMap((p, i) => [
          {
            from: `${TELEGRAM_USER}.chat`,
            to: `${p}.chat`,
            type: 'chat-in' as const,
            reads: [`@${BOTS[i] as string}`, GROUP],
          },
          { from: `${p}.interface`, to: `${p}-player.parser`, type: 'interface' as const },
          { from: 'alice.attention', to: `${p}-player.attention`, type: 'attention' as const },
          {
            from: `${p}-player.chat`,
            to: `${TELEGRAM_USER}.chat`,
            type: 'chat-out' as const,
            sends: [GROUP],
            commands: [o.addressed === true ? `/play@${BOTS[i] as string}` : '/play'],
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
  kit.core.register(
    fakeConnectorPlugin(TELEGRAM_USER, group),
    parser('quest', 'QuestBot'),
    parser('lore', 'LoreBot'),
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
  const turn = (p: string) => read<Record<string, Readiness>>(p, 'ready')['/play'];
  const sent = (player: string) =>
    steps.filter((e) => e['player'] === player && e['event'] === 'sent').map((e) => e['detail']);
  return { kit, group, until, read, turn, sent };
}

describe('two bots in one group, one person (D139)', () => {
  it('sends a bare turn once: both bots take it, both turns held, no second send', async () => {
    const r = await run({});
    const first = r.read<AttentionStatus>('alice', 'status').next as number;
    await r.until(first + 5 * MIN);
    // One send, in the group, which both bots answered.
    expect(r.group.sent.map((s) => `${s.chat} ${s.text}`)).toEqual([`${GROUP} /play`]);
    expect(r.group.replies).toEqual([
      { bot: 'QuestBot', text: 'Found an apple.' },
      { bot: 'LoreBot', text: 'Found an apple.' },
    ]);
    // Both parsers read their bot's answer to it: both turns rest.
    expect(r.turn('quest')).toMatchObject({ ready: false, sent: { byHand: false } });
    expect(r.turn('lore')).toMatchObject({ ready: false, sent: { byHand: false } });
    // One player sent it; the other heard, waited for its answer, and sent nothing.
    expect([...r.sent('quest-player'), ...r.sent('lore-player')]).toEqual(['/play #500']);
    await r.kit.stop();
  });

  it('sends a turn addressed to each bot: each its own, the other untouched', async () => {
    const r = await run({ addressed: true });
    const first = r.read<AttentionStatus>('alice', 'status').next as number;
    await r.until(first + 5 * MIN);
    expect(r.group.sent.map((s) => s.text).sort()).toEqual(['/play@LoreBot', '/play@QuestBot']);
    expect(r.group.replies.map((x) => x.text)).toEqual(['Found an apple.', 'Found an apple.']);
    expect(r.turn('quest')).toMatchObject({ ready: false });
    expect(r.turn('lore')).toMatchObject({ ready: false });
    await r.kit.stop();
  });

  it('follows your bare turn by hand in the group: both turns yours, none sent (D129, D138)', async () => {
    const r = await run({
      attention: { scheduled: false, followsMyPlay: true, listen: [GROUP] },
      listen: true,
    });
    await r.until(T0 + 10 * MIN);
    r.group.byHand(GROUP, '/play');
    await r.until(T0 + 20 * MIN);
    expect(r.group.sent).toEqual([]);
    expect(r.turn('quest')).toMatchObject({ ready: false, sent: { byHand: true } });
    expect(r.turn('lore')).toMatchObject({ ready: false, sent: { byHand: true } });
    expect(r.read<AttentionStatus>('alice', 'status')).toMatchObject({ byHand: true });
    await r.kit.stop();
  });
});
