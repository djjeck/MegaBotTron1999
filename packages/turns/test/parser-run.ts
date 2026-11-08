/**
 * A turn parser on the owner's faked Telegram account, in a dev kit: what it publishes, drifts and
 * offers through its contract (docs/bot-os-api.md §5), for the tests of any game's parser.
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
import { type TurnParserInterface } from '#src/turn-parser.ts';

export const T0 = Date.parse('2026-11-06T12:00:00Z');

/**
 * A parser on alice's faked account: what it publishes, drifts and offers. `group`: its edge reads
 * the game's group too.
 */
export async function runParser(
  plugin: Plugin,
  config: Record<string, unknown> = {},
  group?: string
) {
  const account = new FakeConnector({ account: 'telegram:alice' });
  const events: BusEvent[] = [];
  const kit = new DevKit({
    start: T0,
    plugins: [fakeConnectorPlugin(TELEGRAM_USER, account), plugin],
    config: { [plugin.manifest.id]: config },
    graph: (defaults) => ({
      ...defaults,
      edges: defaults.edges.map((e) =>
        group === undefined || e.to !== `${plugin.manifest.id}.chat`
          ? e
          : { ...e, reads: [...(e.reads ?? []), group] }
      ),
    }),
    record: (r) => {
      if (r.type.endsWith('.turn')) events.push(r as BusEvent);
    },
  });
  await kit.start();
  account.open();
  const id = plugin.manifest.id;
  let n = 1000;
  const hear = (m: Partial<Heard> & { text: string }): string => {
    const msgId = String(n++);
    account.hear({ chat: '@x', sender: 'x', time: kit.clock.now(), id: msgId, ...m });
    return msgId;
  };
  // The contract as the actor uses it, through the owner's controls (the same instance).
  const iface = {
    rest: (): unknown => {
      const r = kit.core.controls.read(id, 'rest');
      return 'value' in r ? r.value : r;
    },
    sent: (turn: Parameters<TurnParserInterface['actions']['sent']>[0]) =>
      kit.core.controls.act(id, 'sent', turn),
  };
  const outcomes = () => events.map((e) => (e['outcome'] as { kind: string }).kind);
  const drift = () => kit.core.drift().find((d) => d.parser === id);
  return { kit, account, hear, iface, events, outcomes, drift };
}
