/**
 * A turn parser on the owner's faked Telegram account, in a dev kit, with the state that keeps its
 * bot's readiness when one is given (bot-os.md D141): what it publishes and drifts, and what the
 * state offers through its contract (docs/bot-os-api.md §5), for the tests of any game's parser.
 */
import { TELEGRAM_USER } from '@megabottron1999/connectors/plugins/telegram-user.ts';
import {
  type BusEvent,
  DevKit,
  FakeConnector,
  fakeConnectorPlugin,
  type Heard,
  type Plugin,
} from '@megabottron1999/core';
import { type Readiness } from '#src/readiness.ts';
import { type SentCommand } from '#src/turn-parser.ts';

export const T0 = Date.parse('2026-11-06T12:00:00Z');

/**
 * A parser on alice's faked account: what it publishes, drifts and, through `state` (its readiness
 * state, bound to it), offers. `group`: its edge reads the game's group too; `documents`, what
 * each node's store starts with (a restart's), by node.
 */
export async function runParser(
  plugin: Plugin,
  config: Record<string, unknown> = {},
  group?: string,
  documents?: Record<string, Record<string, unknown>>,
  state?: Plugin
) {
  const account = new FakeConnector({ account: 'telegram:alice' });
  /** Its turns' and other commands' answers, and every event of its namespace. */
  const events: BusEvent[] = [];
  const all: BusEvent[] = [];
  const kit = new DevKit({
    start: T0,
    plugins: [
      fakeConnectorPlugin(TELEGRAM_USER, account),
      plugin,
      ...(state === undefined ? [] : [state]),
    ],
    config: { [plugin.manifest.id]: config },
    ...(documents === undefined ? {} : { documents }),
    graph: (defaults) => ({
      ...defaults,
      edges: defaults.edges.map((e) =>
        group === undefined || e.to !== `${plugin.manifest.id}.chat`
          ? e
          : { ...e, reads: Array.isArray(e.reads) ? [...e.reads, group] : e.reads }
      ),
    }),
    record: (r) => {
      if (!r.type.startsWith(`${plugin.manifest.id}.`)) return;
      all.push(r as BusEvent);
      if (r.type.endsWith('.turn') || r.type.endsWith('.answer')) events.push(r as BusEvent);
    },
  });
  await kit.start();
  account.open();
  const id = plugin.manifest.id;
  let n = 1000;
  const hear = (m: Partial<Heard> & { text: string }): string => {
    const msgId = String(n++);
    account.hear({ chat: '@x', senderUsername: 'x', time: kit.clock.now(), id: msgId, ...m });
    return msgId;
  };
  const ready = (): Record<string, Readiness> => {
    if (state === undefined) throw new Error('runParser: no state given');
    const r = kit.core.controls.read(state.manifest.id, 'ready');
    return ('value' in r ? r.value : r) as Record<string, Readiness>;
  };
  // The contract as a player uses it, through the owner's controls (the same instances): the
  // state's readiness, and a send told to the parser.
  const iface = {
    ready,
    /** The turn's hold (its first command's), as the state's readiness says: its rest. */
    rest: (): { until: number; why: string } | undefined => {
      const [turn] = Object.values(ready());
      return turn === undefined || turn.ready || turn.until === undefined
        ? undefined
        : { until: turn.until, why: turn.why ?? '' };
    },
    sent: (turn: SentCommand) => kit.core.controls.act(id, 'sent', turn),
  };
  const outcomes = () => events.map((e) => (e['outcome'] as { kind: string }).kind);
  const drift = () => kit.core.drift().find((d) => d.parser === id);
  return { kit, account, hear, iface, events, all, outcomes, drift };
}
