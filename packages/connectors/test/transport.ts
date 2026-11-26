/**
 * A transport over a connector's chat, for tests: the IRC client's channel, played by a connector
 * (a `FakeConnector`) rather than a server.
 */
import { type Connector } from '@megabottron1999/core';
import {
  type Transport,
  type TransportEvents,
  type TransportStatus,
} from '#src/transport/transport.ts';

/**
 * The client's transport over a connector (packages/core/src/connector.ts), or the way to
 * find it once the core runs it, and one of its chats: its lines in, and lines to it out. The
 * connector is started and stopped by the core, so `start` and `stop` only attach and detach the
 * client; the status the client first hears is the connector's at once.
 */
export function transportOver(
  over: Connector | (() => Connector | undefined),
  chat: string
): (events: TransportEvents) => Transport {
  const get = typeof over === 'function' ? over : () => over;
  return (events) => {
    const off: (() => void)[] = [];
    return {
      start: () => {
        const connector = get();
        if (connector === undefined) {
          events.status('closed', 'no connector');
          return;
        }
        off.push(
          connector.onMessage((m) => {
            if (m.chat.toLowerCase() !== chat.toLowerCase()) return;
            events.line({ nick: m.sender, text: m.text, time: m.time, playback: m.playback });
          }),
          connector.onStatus((s) => events.status(s.phase as TransportStatus, s.detail))
        );
        const now = connector.status();
        if (now.state !== 'closed') events.status(now.phase as TransportStatus, now.detail);
      },
      say: (text) => get()?.send(chat, text) ?? false,
      stop: () => {
        for (const f of off.splice(0)) f();
      },
    };
  };
}
